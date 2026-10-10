import { describe, expect, it, vi } from "vitest";
import type { OidcTransaction } from "../../../packages/core/src/oidc";
import type {
  NativeOidcPending,
  NativeOidcPlugin,
  NativeOidcRouting,
} from "../../mobile/src/native-oidc";
import {
  NativeOidcCoordinator,
  nativeOidcRedirect,
  type NativeOidcDeployment,
} from "./nativeOidcCoordinator";

const epoch = Date.parse("2026-10-09T12:00:00Z");
const deployment: NativeOidcDeployment = {
  serverUrl: "https://books.test",
  appUrl: "https://bookorbit.test",
  redirectUri: "avid://oauth2-callback",
  providers: ["personal"],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let now = epoch,
    generation = "vault-a",
    sequence = 0;
  let stored:
    | {
        transaction: OidcTransaction;
        routing: NativeOidcRouting;
        generation: string;
        callbackUrl?: string;
      }
    | undefined;
  const listeners = new Set<() => void>();
  const plugin = {
    capabilities: vi.fn(async () => ({
      redirectUri: "avid://oauth2-callback",
      secureTransactions: true,
    })),
    save: vi.fn(
      async (input: {
        transaction: OidcTransaction;
        routing: NativeOidcRouting;
      }) => {
        if (stored) throw new Error("An attempt is already pending.");
        stored = { ...structuredClone(input), generation };
      },
    ),
    take: vi.fn(async ({ state }: { state: string }) => {
      if (!stored || stored.transaction.state !== state) return {};
      const value = stored;
      stored = undefined;
      return value.generation === generation
        ? { transaction: value.transaction }
        : {};
    }),
    pending: vi.fn(async (): Promise<{ pending?: NativeOidcPending }> => {
      if (!stored) return {};
      if (stored.generation !== generation) {
        stored = undefined;
        return {};
      }
      return {
        pending: structuredClone({
          generation: stored.generation,
          state: stored.transaction.state,
          expiresAt: stored.transaction.expiresAt,
          routing: stored.routing,
          callbackUrl: stored.callbackUrl,
        }),
      };
    }),
    open: vi.fn(async (_options: { state: string; url: string }) => {}),
    cancel: vi.fn(async (options?: { state?: string }) => {
      if (!options?.state || stored?.transaction.state === options.state)
        stored = undefined;
    }),
    addListener: vi.fn(
      async (_event: "callbackAvailable", listener: () => void) => {
        listeners.add(listener);
        return {
          remove: async () => {
            listeners.delete(listener);
          },
        };
      },
    ),
  } satisfies NativeOidcPlugin;
  const transport = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/login-options"))
      return Response.json({
        passwordLoginEnabled: true,
        allowRegistration: false,
        oidcProviders: [
          {
            slug: "personal",
            displayName: "Personal",
            enabled: true,
            clientId: "avid",
            scopes: "openid profile",
          },
        ],
      });
    if (url.endsWith("/personal/state"))
      return Response.json({
        state: `state-${++sequence}`,
        authorizationEndpoint: "https://identity.test/authorize",
      });
    if (url.endsWith("/oidc/callback"))
      return Response.json({
        mode: "login",
        accessToken: "fixture-access",
        user: { id: 7, username: "reader" },
      });
    throw new Error(`Unexpected mocked route ${url}`);
  });
  const options = {
    deployment,
    plugin,
    clientOptions: () => ({ fetch: transport, clientKind: "native" as const }),
    now: () => now,
  };
  const coordinator = new NativeOidcCoordinator(options);
  const profile = {
    id: "book-server",
    name: "Books",
    url: "https://BOOKS.test/api/v1/",
    username: "",
  };
  return {
    coordinator,
    options,
    plugin,
    transport,
    profile,
    stored: () => stored,
    changeVault: () => {
      generation = "vault-b";
    },
    setNow: (value: number) => {
      now = value;
    },
    callback: (params = "code=authorization-code") => {
      if (!stored) throw new Error("No fixture attempt");
      const url = `${deployment.redirectUri}?${params}&state=${stored.transaction.state}`;
      stored.callbackUrl = url;
      listeners.forEach((listener) => listener());
      return url;
    },
  };
}
const exchanges = (f: ReturnType<typeof fixture>) =>
  f.transport.mock.calls.filter(([url]) =>
    String(url).endsWith("/oidc/callback"),
  );

describe("native provider sign-in coordinator", () => {
  it("binds a recovered code exchange to the generation saved with the native attempt", async () => {
    const f = fixture();
    const clientOptions = vi.fn((_url: string, _generation?: string) => ({
      fetch: f.transport,
    }));
    const first = new NativeOidcCoordinator({ ...f.options, clientOptions });
    await first.begin(f.profile, "personal", true);
    expect(clientOptions).toHaveBeenLastCalledWith(
      "https://books.test",
      undefined,
    );
    f.callback();
    await new NativeOidcCoordinator({ ...f.options, clientOptions }).resume();
    expect(clientOptions).toHaveBeenLastCalledWith(
      "https://books.test",
      "vault-a",
    );
  });
  it("pins server, provider, and exact private callback before making a request", async () => {
    const f = fixture();
    expect(() =>
      nativeOidcRedirect(
        {
          ...deployment,
          redirectUri: "https://avid.test/oauth2-callback",
        } as unknown as NativeOidcDeployment,
        deployment.serverUrl,
        "personal",
      ),
    ).toThrow("not configured");
    await expect(
      f.coordinator.begin(
        { ...f.profile, url: "https://elsewhere.test" },
        "personal",
        true,
      ),
    ).rejects.toThrow("not configured");
    await expect(
      f.coordinator.begin(f.profile, "unconfigured", true),
    ).rejects.toThrow("not configured");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.plugin.save).not.toHaveBeenCalled();
  });
  it("refuses hosts without the secure transaction capability", async () => {
    const f = fixture();
    f.plugin.capabilities.mockResolvedValue({
      redirectUri: deployment.redirectUri,
      secureTransactions: false,
    });
    await expect(
      f.coordinator.begin(f.profile, "personal", true),
    ).rejects.toThrow("securely");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.plugin.save).not.toHaveBeenCalled();
  });
  it("normalizes routing and saves PKCE only in native storage before opening the system browser", async () => {
    const f = fixture();
    const launch = await f.coordinator.begin(f.profile, "personal", true);
    const saved = f.stored()!;
    expect(saved.routing).toMatchObject({
      profile: { url: deployment.serverUrl },
      provider: "personal",
      readOnly: true,
      createdAt: epoch,
    });
    expect(saved.transaction).toMatchObject({
      serverUrl: deployment.serverUrl,
      clientKind: "web",
      expiresAt: epoch + 300_000,
    });
    expect(saved.transaction.codeVerifier).toHaveLength(43);
    expect(f.plugin.save.mock.invocationCallOrder[0]).toBeLessThan(
      f.plugin.open.mock.invocationCallOrder[0],
    );
    const authorization = new URL(launch.authorizationUrl);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      deployment.redirectUri,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(launch.authorizationUrl).not.toContain(
      saved.transaction.codeVerifier,
    );
  });
  it("resumes after process recreation and exchanges once with web cookie credentials", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    const callback = f.callback();
    const recovered = new NativeOidcCoordinator(f.options);
    const first = recovered.resume(),
      repeated = recovered.resume();
    expect(first).toBe(repeated);
    const result = await first;
    expect(result).toMatchObject({
      readOnly: true,
      session: { userId: "7", clientKind: "web" },
    });
    expect(await recovered.resume()).toBe(result);
    expect(recovered.complete(callback)).toBe(recovered.complete(callback));
    expect(f.stored()).toBeUndefined();
    expect(f.plugin.take).toHaveBeenCalledTimes(1);
    expect(exchanges(f)).toHaveLength(1);
    expect(exchanges(f)[0][1]?.credentials).toBe("include");
    expect(JSON.parse(String(exchanges(f)[0][1]?.body))).toMatchObject({
      clientKind: "web",
      redirectUri: deployment.redirectUri,
    });
  });
  it("waits without consuming until the native callback inbox has a callback", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", false);
    expect(await f.coordinator.resume()).toBeNull();
    expect(await f.coordinator.pending()).toMatchObject({ state: "state-1" });
    expect(f.plugin.take).not.toHaveBeenCalled();
    const notified = vi.fn();
    const listener = await f.coordinator.subscribe(notified);
    f.callback();
    expect(notified).toHaveBeenCalledWith();
    expect(await f.coordinator.resume()).toMatchObject({ readOnly: false });
    await listener.remove();
  });
  it("rejects an injected callback, mismatched state, or callback not persisted by the native host", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    await expect(
      f.coordinator.complete(
        `${deployment.redirectUri}?code=untrusted&state=state-1`,
      ),
    ).rejects.toMatchObject({ reason: "binding" });
    const callback = f.callback();
    await expect(
      f.coordinator.complete(
        callback.replace(
          "avid://oauth2-callback",
          "https://attacker.test/oauth2-callback",
        ),
      ),
    ).rejects.toMatchObject({ reason: "binding" });
    await expect(
      f.coordinator.complete(`${callback}&state=duplicate`),
    ).rejects.toMatchObject({ reason: "binding" });
    expect(f.plugin.take).not.toHaveBeenCalled();
    expect(exchanges(f)).toHaveLength(0);
  });
  it("does not reconstruct an attempt whose vault generation changed", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    f.callback();
    f.changeVault();
    expect(await new NativeOidcCoordinator(f.options).resume()).toBeNull();
    expect(f.plugin.take).not.toHaveBeenCalled();
    expect(exchanges(f)).toHaveLength(0);
  });
  it("expires at five minutes and never exchanges an expired authorization code", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    const callback = f.callback();
    f.setNow(epoch + 300_000);
    await expect(f.coordinator.complete(callback)).rejects.toMatchObject({
      reason: "expired",
    });
    expect(f.plugin.cancel).toHaveBeenLastCalledWith({ state: "state-1" });
    expect(exchanges(f)).toHaveLength(0);
  });
  it("consumes denied callbacks and retains one failed completion promise", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    const callback = f.callback("error=access_denied");
    const first = f.coordinator.complete(callback);
    await expect(first).rejects.toMatchObject({ reason: "denied" });
    expect(f.coordinator.complete(callback)).toBe(first);
    await expect(f.coordinator.resume()).rejects.toMatchObject({
      reason: "denied",
    });
    expect(f.plugin.take).toHaveBeenCalledTimes(1);
    expect(exchanges(f)).toHaveLength(0);
  });
  it("consumes before exchange, and never retries an uncertain exchange", async () => {
    const f = fixture(),
      original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation((input, init) =>
      String(input).endsWith("/oidc/callback")
        ? Promise.reject(new Error("Offline during exchange"))
        : original(input, init),
    );
    await f.coordinator.begin(f.profile, "personal", false);
    const callback = f.callback();
    const first = f.coordinator.complete(callback);
    await expect(first).rejects.toThrow("Offline");
    expect(f.plugin.take.mock.invocationCallOrder[0]).toBeLessThan(
      f.transport.mock.invocationCallOrder.at(-1)!,
    );
    expect(f.coordinator.complete(callback)).toBe(first);
    expect(exchanges(f)).toHaveLength(1);
    expect(f.stored()).toBeUndefined();
  });
  it("prevents a late superseded attempt from saving or opening over the newer attempt", async () => {
    const f = fixture(),
      original = f.transport.getMockImplementation()!,
      delayed = deferred<Response>();
    let stateCalls = 0;
    f.transport.mockImplementation((input, init) =>
      String(input).endsWith("/personal/state") && ++stateCalls === 1
        ? delayed.promise
        : original(input, init),
    );
    const old = f.coordinator.begin(f.profile, "personal", true);
    const oldResult = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(stateCalls).toBe(1));
    await f.coordinator.begin(f.profile, "personal", false);
    delayed.resolve(
      Response.json({
        state: "old-state",
        authorizationEndpoint: "https://identity.test/authorize",
      }),
    );
    await oldResult;
    expect(f.plugin.open).toHaveBeenCalledTimes(1);
    expect(f.stored()?.routing.readOnly).toBe(false);
    expect(await f.coordinator.complete(f.callback())).toMatchObject({
      readOnly: false,
    });
  });
  it("cancels its own saved state when the UI becomes inactive during native save", async () => {
    const f = fixture(),
      original = f.plugin.save.getMockImplementation()!,
      gate = deferred<void>();
    let active = true;
    f.plugin.save.mockImplementation(async (value) => {
      await original(value);
      await gate.promise;
    });
    const begin = f.coordinator.begin(f.profile, "personal", true, {
      isActive: () => active,
    });
    const result = expect(begin).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(f.plugin.save).toHaveBeenCalledTimes(1));
    active = false;
    gate.resolve();
    await result;
    expect(f.plugin.open).not.toHaveBeenCalled();
    expect(f.plugin.cancel).toHaveBeenCalledWith({ state: "state-1" });
    expect(f.stored()).toBeUndefined();
  });
  it("cancels a possibly committed native save whose bridge response failed", async () => {
    const f = fixture(),
      original = f.plugin.save.getMockImplementation()!;
    f.plugin.save.mockImplementation(async (value) => {
      await original(value);
      throw new Error("Native response lost");
    });
    await expect(
      f.coordinator.begin(f.profile, "personal", true),
    ).rejects.toThrow("response lost");
    expect(f.plugin.cancel).toHaveBeenCalledWith({ state: "state-1" });
    expect(f.plugin.open).not.toHaveBeenCalled();
    expect(f.stored()).toBeUndefined();
  });
  it("does not invalidate a newer completion when canceling a different old state", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    await f.coordinator.cancel("superseded-state");
    expect(await f.coordinator.complete(f.callback())).toMatchObject({
      readOnly: true,
    });
    expect(exchanges(f)).toHaveLength(1);
  });
  it("rejects a late exchanged session after explicit cancellation", async () => {
    const f = fixture(),
      original = f.transport.getMockImplementation()!,
      response = deferred<Response>();
    f.transport.mockImplementation((input, init) =>
      String(input).endsWith("/oidc/callback")
        ? response.promise
        : original(input, init),
    );
    await f.coordinator.begin(f.profile, "personal", true);
    const completion = f.coordinator.complete(f.callback());
    const result = expect(completion).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(exchanges(f)).toHaveLength(1));
    await f.coordinator.cancel();
    response.resolve(
      Response.json({
        mode: "login",
        accessToken: "late-token",
        user: { id: 7, username: "reader" },
      }),
    );
    await result;
  });
});
