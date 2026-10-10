import { z } from "zod";
import {
  normalizeServerUrl,
  type ClientOptions,
} from "../../../packages/core/src/bookorbit";
import {
  OidcLoginFlow,
  createSessionOidcStorage,
} from "../../../packages/core/src/oidc";
import type { ServerProfile, Session } from "../../../packages/core/src/types";

const routingKey = "avid.oidc.routing.v1";
const routingSchema = z.object({
  profile: z.object({
    id: z.string().min(1),
    name: z.string(),
    url: z.string().url(),
    username: z.string(),
  }),
  provider: z.string().min(1),
  readOnly: z.boolean(),
  createdAt: z.number(),
});
export interface WebOidcDeployment {
  serverUrl: string;
  appUrl: string;
}
export function configuredWebOidc(): WebOidcDeployment | undefined {
  const serverUrl = import.meta.env.VITE_OIDC_SERVER_URL;
  const appUrl = import.meta.env.VITE_OIDC_APP_URL;
  return serverUrl && appUrl ? { serverUrl, appUrl } : undefined;
}
export function webOidcCallback(
  deployment: WebOidcDeployment,
  serverUrl: string,
  pageUrl: string,
): string {
  if (
    normalizeServerUrl(deployment.serverUrl) !== normalizeServerUrl(serverUrl)
  )
    throw new Error(
      "Provider sign-in is not configured for this server in this Avid deployment.",
    );
  const app = new URL(deployment.appUrl);
  const page = new URL(pageUrl);
  if (
    !["http:", "https:"].includes(app.protocol) ||
    app.username ||
    app.password ||
    app.search ||
    app.hash ||
    app.origin !== page.origin ||
    (app.pathname !== "/" && app.pathname !== "")
  )
    throw new Error(
      "Avid must own the configured BookOrbit web callback origin.",
    );
  return new URL("/oauth2-callback", app).href;
}
export class WebOidcCoordinator {
  private beginGeneration = 0;
  private completion?: {
    url: string;
    promise: Promise<{ session: Session; readOnly: boolean }>;
  };
  constructor(
    private readonly options: {
      deployment: WebOidcDeployment;
      storage: Storage;
      pageUrl: () => string;
      launch: (url: string) => void;
      clearCallback: () => void;
      clientOptions: (serverUrl: string) => ClientOptions;
    },
  ) {}
  private flow(profile: ServerProfile, launch = this.options.launch) {
    return new OidcLoginFlow({
      profile,
      redirectUri: webOidcCallback(
        this.options.deployment,
        profile.url,
        this.options.pageUrl(),
      ),
      redirectPolicy: { appUrl: this.options.deployment.appUrl },
      storage: createSessionOidcStorage(this.options.storage),
      launchAuthorization: launch,
      clientOptions: {
        ...this.options.clientOptions(profile.url),
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
    const generation = ++this.beginGeneration;
    const active = () =>
      generation === this.beginGeneration && options.isActive?.() !== false;
    const flow = this.flow(profile, (url) => {
      if (!active())
        throw new DOMException("Provider sign-in cancelled.", "AbortError");
      this.options.launch(url);
    });
    const routing = JSON.stringify({
      profile,
      provider,
      readOnly,
      createdAt: Date.now(),
      attemptId: crypto.randomUUID(),
    });
    if (!active())
      throw new DOMException("Provider sign-in cancelled.", "AbortError");
    this.options.storage.setItem(routingKey, routing);
    try {
      await flow.begin(provider);
    } catch (error) {
      // A late failure from an older attempt must not erase a newer route.
      if (this.options.storage.getItem(routingKey) === routing)
        this.options.storage.removeItem(routingKey);
      throw error;
    }
  }
  complete(url: string): Promise<{ session: Session; readOnly: boolean }> {
    if (this.completion?.url === url) return this.completion.promise;
    // Retain one shared promise through StrictMode/remounts; no second code exchange.
    const promise = this.finish(url);
    this.completion = { url, promise };
    return promise;
  }
  private async finish(url: string) {
    const raw = this.options.storage.getItem(routingKey);
    this.options.storage.removeItem(routingKey);
    this.options.clearCallback();
    const parsed = routingSchema.safeParse(raw ? JSON.parse(raw) : null);
    if (!parsed.success)
      throw new Error(
        "This provider sign-in was not started in this tab. Please start again.",
      );
    const { profile, provider, readOnly, createdAt } = parsed.data;
    if (Date.now() < createdAt || Date.now() - createdAt >= 300_000)
      throw new Error("Provider sign-in expired. Please start again.");
    const session = await this.flow(profile).complete(provider, url);
    return { session, readOnly };
  }
}
