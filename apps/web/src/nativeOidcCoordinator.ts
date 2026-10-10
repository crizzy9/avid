import { z } from "zod";
import {
  normalizeServerUrl,
  type ClientOptions,
} from "../../../packages/core/src/bookorbit";
import {
  OidcLoginError,
  OidcLoginFlow,
  type OidcTransactionStorage,
} from "../../../packages/core/src/oidc";
import type { ServerProfile, Session } from "../../../packages/core/src/types";
import {
  getNativeOidc,
  NATIVE_OIDC_REDIRECT_URI,
  type NativeOidcPlugin,
  type NativeOidcPending,
  type NativeOidcRouting,
} from "../../mobile/src/native-oidc";

const MAX_AGE_MS = 300_000;
const pendingSchema = z.object({
  generation: z.string().min(1),
  state: z.string().min(1).max(512),
  expiresAt: z.number().finite(),
  routing: z.object({
    profile: z.object({
      id: z.string().min(1),
      name: z.string(),
      url: z.string().url(),
      username: z.string().optional(),
      version: z.string().optional(),
    }),
    provider: z.string().min(1),
    readOnly: z.boolean(),
    createdAt: z.number().finite(),
  }),
  callbackUrl: z.string().min(1).max(8192).optional(),
});
export interface NativeOidcDeployment {
  serverUrl: string;
  appUrl: string;
  /** Must be configured on BookOrbit and the selected provider, not merely in Avid. */
  redirectUri: typeof NATIVE_OIDC_REDIRECT_URI;
  providers: readonly string[];
}
export function configuredNativeOidc(): NativeOidcDeployment | undefined {
  const serverUrl = import.meta.env.VITE_OIDC_SERVER_URL;
  const appUrl = import.meta.env.VITE_OIDC_APP_URL;
  const redirectUri = import.meta.env.VITE_OIDC_NATIVE_REDIRECT_URI;
  const providers = String(import.meta.env.VITE_OIDC_NATIVE_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !serverUrl ||
    !appUrl ||
    redirectUri !== NATIVE_OIDC_REDIRECT_URI ||
    !providers.length
  )
    return undefined;
  return { serverUrl, appUrl, redirectUri, providers };
}
export function nativeOidcRedirect(
  deployment: NativeOidcDeployment,
  serverUrl: string,
  provider?: string,
): typeof NATIVE_OIDC_REDIRECT_URI {
  if (
    deployment.redirectUri !== NATIVE_OIDC_REDIRECT_URI ||
    normalizeServerUrl(serverUrl) !==
      normalizeServerUrl(deployment.serverUrl) ||
    !deployment.providers.length ||
    (provider !== undefined && !deployment.providers.includes(provider))
  ) {
    throw new OidcLoginError(
      "configuration",
      "Native provider sign-in is not configured for this server and provider.",
    );
  }
  return NATIVE_OIDC_REDIRECT_URI;
}
export interface NativeOidcResult {
  session: Session;
  readOnly: boolean;
}
const cancelled = () =>
  new DOMException("Provider sign-in cancelled.", "AbortError");
let configuredCoordinator: NativeOidcCoordinator | undefined;
/** One completion owner survives StrictMode and component remounts. */
export function getConfiguredNativeOidcCoordinator(
  clientOptions: (serverUrl: string, generation?: string) => ClientOptions,
): NativeOidcCoordinator | null {
  if (configuredCoordinator) return configuredCoordinator;
  const deployment = configuredNativeOidc(),
    plugin = getNativeOidc();
  if (!deployment || !plugin) return null;
  configuredCoordinator = new NativeOidcCoordinator({
    deployment,
    plugin,
    clientOptions,
  });
  return configuredCoordinator;
}

/** System-browser login with encrypted native recovery; no browser-storage fallback. */
export class NativeOidcCoordinator {
  private generation = 0;
  private bridgeQueue: Promise<void> = Promise.resolve();
  private completion?: { url: string; promise: Promise<NativeOidcResult> };
  private resumeFlight?: Promise<NativeOidcResult | null>;
  private activeState?: string;
  private readonly now: () => number;
  constructor(
    private readonly options: {
      deployment: NativeOidcDeployment;
      plugin: NativeOidcPlugin;
      clientOptions: (serverUrl: string, generation?: string) => ClientOptions;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  private async capabilities() {
    const value = await this.options.plugin.capabilities();
    if (
      value.redirectUri !== NATIVE_OIDC_REDIRECT_URI ||
      value.secureTransactions !== true
    )
      throw new OidcLoginError(
        "configuration",
        "This native host cannot securely complete provider sign-in.",
      );
  }
  /** Serialize mutations so cancellation of a late old attempt cannot erase its successor. */
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const task = this.bridgeQueue.catch(() => {}).then(action);
    this.bridgeQueue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private flow(
    routing: NativeOidcRouting,
    storage: OidcTransactionStorage,
    launch: (url: string) => Promise<void>,
    generation?: string,
  ) {
    return new OidcLoginFlow({
      profile: routing.profile,
      redirectUri: nativeOidcRedirect(
        this.options.deployment,
        routing.profile.url,
        routing.provider,
      ),
      redirectPolicy: {
        appUrl: this.options.deployment.appUrl,
        nativeRedirectUri: NATIVE_OIDC_REDIRECT_URI,
      },
      storage,
      launchAuthorization: launch,
      now: this.now,
      // BookOrbit's web exchange seeds native HTTP/WebView cookies needed for streaming.
      clientOptions: {
        ...this.options.clientOptions(routing.profile.url, generation),
        clientKind: "web",
      },
    });
  }
  async begin(
    profile: ServerProfile,
    provider: string,
    readOnly: boolean,
    options: { isActive?: () => boolean } = {},
  ) {
    nativeOidcRedirect(this.options.deployment, profile.url, provider);
    const generation = ++this.generation;
    const active = () =>
      generation === this.generation && options.isActive?.() !== false;
    const assertActive = () => {
      if (!active()) throw cancelled();
    };
    this.completion = undefined;
    this.resumeFlight = undefined;
    this.activeState = undefined;
    await this.capabilities();
    assertActive();
    await this.mutate(async () => {
      assertActive();
      await this.options.plugin.cancel();
    });
    assertActive();
    const routing: NativeOidcRouting = {
      profile: { ...profile, url: normalizeServerUrl(profile.url) },
      provider,
      readOnly,
      createdAt: this.now(),
    };
    let state: string | undefined;
    const storage: OidcTransactionStorage = {
      save: (transaction) =>
        this.mutate(async () => {
          assertActive();
          // The core flow starts its expiry after discovery. Use that same timestamp
          // for routing so native validation and process-restart validation agree.
          routing.createdAt = transaction.createdAt;
          state = transaction.state;
          await this.options.plugin.save({ transaction, routing });
          if (!active()) {
            await this.options.plugin.cancel({ state });
            throw cancelled();
          }
          this.activeState = state;
        }),
      take: async (value) =>
        (await this.mutate(() => this.options.plugin.take({ state: value })))
          .transaction,
    };
    try {
      return await this.flow(routing, storage, async (url) => {
        assertActive();
        if (!state)
          throw new OidcLoginError(
            "missing",
            "The provider attempt was not saved.",
          );
        await this.mutate(async () => {
          assertActive();
          await this.options.plugin.open({ state: state!, url });
        });
        assertActive();
      }).begin(provider);
    } catch (error) {
      if (state)
        await this.mutate(() => this.options.plugin.cancel({ state })).catch(
          () => {},
        );
      throw error;
    }
  }
  async pending(): Promise<NativeOidcPending | null> {
    await this.capabilities();
    const value = (await this.options.plugin.pending()).pending;
    if (!value) return null;
    const parsed = pendingSchema.safeParse(value);
    if (!parsed.success)
      throw new OidcLoginError(
        "binding",
        "The saved native sign-in attempt is invalid. Start again.",
      );
    const pending = parsed.data;
    nativeOidcRedirect(
      this.options.deployment,
      pending.routing.profile.url,
      pending.routing.provider,
    );
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      now < pending.routing.createdAt ||
      now >= pending.expiresAt ||
      pending.expiresAt <= pending.routing.createdAt ||
      pending.expiresAt - pending.routing.createdAt > MAX_AGE_MS
    ) {
      await this.mutate(() =>
        this.options.plugin.cancel({ state: pending.state }),
      );
      throw new OidcLoginError(
        "expired",
        "This native sign-in attempt has expired. Start again.",
      );
    }
    return pending;
  }
  complete(url: string): Promise<NativeOidcResult> {
    if (this.completion?.url === url) return this.completion.promise;
    const generation = this.generation;
    const promise = this.finish(url, generation);
    this.completion = { url, promise };
    return promise;
  }
  private async finish(
    url: string,
    generation: number,
  ): Promise<NativeOidcResult> {
    const pending = await this.pending();
    if (generation !== this.generation) throw cancelled();
    if (!pending)
      throw new OidcLoginError(
        "missing",
        "This native sign-in attempt is missing, expired or already used.",
      );
    this.activeState = pending.state;
    let callback: URL;
    try {
      callback = new URL(url);
    } catch {
      throw new OidcLoginError(
        "callback",
        "The native sign-in callback is invalid.",
      );
    }
    if (
      url.split("?")[0] !== NATIVE_OIDC_REDIRECT_URI ||
      callback.hash ||
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.get("state") !== pending.state ||
      pending.callbackUrl !== url
    )
      throw new OidcLoginError(
        "binding",
        "This callback does not belong to the saved native sign-in attempt.",
      );
    const storage: OidcTransactionStorage = {
      save: async () => {
        throw new Error("Cannot start a new attempt while completing sign-in.");
      },
      take: (state) =>
        this.mutate(async () => {
          if (generation !== this.generation) throw cancelled();
          return (await this.options.plugin.take({ state })).transaction;
        }),
    };
    const session = await this.flow(
      pending.routing,
      storage,
      async () => {},
      pending.generation,
    ).complete(pending.routing.provider, url);
    if (generation !== this.generation) throw cancelled();
    return { session, readOnly: pending.routing.readOnly };
  }
  /** Call before restoring/refreshing a saved session: vault mutation invalidates pending attempts. */
  resume(): Promise<NativeOidcResult | null> {
    if (this.resumeFlight) return this.resumeFlight;
    if (this.completion) return this.completion.promise;
    const generation = this.generation;
    const task = (async () => {
      const pending = await this.pending();
      if (generation !== this.generation) throw cancelled();
      return pending?.callbackUrl ? this.complete(pending.callbackUrl) : null;
    })();
    this.resumeFlight = task;
    void task
      .finally(() => {
        if (this.resumeFlight === task) this.resumeFlight = undefined;
      })
      .catch(() => {});
    return task;
  }
  async cancel(state?: string): Promise<void> {
    if (state === undefined || state === this.activeState) {
      this.generation++;
      this.completion = undefined;
      this.resumeFlight = undefined;
      this.activeState = undefined;
    }
    await this.mutate(() =>
      this.options.plugin.cancel(state === undefined ? undefined : { state }),
    );
  }
  subscribe(listener: () => void) {
    return this.options.plugin.addListener("callbackAvailable", listener);
  }
}
