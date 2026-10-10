import { describe, expect, it, vi } from "vitest";
import { WebOidcCoordinator, webOidcCallback } from "./webOidc";

const deployment = {
  serverUrl: "https://api.books.test",
  appUrl: "https://avid.books.test",
};
function fixture() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const launch = vi.fn<(url: string) => void>(),
    clearCallback = vi.fn();
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
            scopes: "openid",
          },
        ],
      });
    if (url.endsWith("/personal/state"))
      return Response.json({
        state: "random-state",
        authorizationEndpoint: "https://id.test/authorize",
      });
    if (url.endsWith("/oidc/callback"))
      return Response.json({
        mode: "login",
        accessToken: "test-token",
        user: { id: 2, username: "reader" },
      });
    throw new Error("Unexpected route");
  });
  const options = {
    deployment,
    storage,
    pageUrl: () => deployment.appUrl,
    launch,
    clearCallback,
    clientOptions: () => ({ fetch: transport }),
  };
  const coordinator = new WebOidcCoordinator(options);
  const profile = {
    id: "configured-server",
    name: "Books",
    url: deployment.serverUrl,
    username: "",
  };
  const callback = `${deployment.appUrl}/oauth2-callback?code=code&state=random-state`;
  return {
    coordinator,
    profile,
    callback,
    options,
    transport,
    values,
    launch,
    clearCallback,
  };
}
describe("web provider routing", () => {
  it("cancels a delayed provider launch and removes its routing and PKCE state", async () => {
    const f = fixture(),
      original = f.transport.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((done) => {
      resolve = done;
    });
    f.transport.mockImplementation((input, init) =>
      String(input).endsWith("/personal/state")
        ? response
        : original(input, init),
    );
    let active = true;
    const pending = f.coordinator.begin(f.profile, "personal", true, {
      isActive: () => active,
    });
    await vi.waitFor(() =>
      expect(
        f.transport.mock.calls.some(([url]) => String(url).endsWith("/state")),
      ).toBe(true),
    );
    active = false;
    resolve(
      Response.json({
        state: "cancelled-state",
        authorizationEndpoint: "https://id.test/authorize",
      }),
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.values.size).toBe(0);
  });
  it("does not let a canceled old launch erase a newer sign-in route", async () => {
    const f = fixture(),
      original = f.transport.getMockImplementation()!;
    let resolve!: (response: Response) => void,
      count = 0;
    const response = new Promise<Response>((done) => {
      resolve = done;
    });
    f.transport.mockImplementation((input, init) =>
      String(input).endsWith("/personal/state")
        ? ++count === 1
          ? response
          : Promise.resolve(
              Response.json({
                state: "second-state",
                authorizationEndpoint: "https://id.test/authorize",
              }),
            )
        : original(input, init),
    );
    const old = f.coordinator.begin(f.profile, "personal", true);
    await vi.waitFor(() => expect(count).toBe(1));
    await f.coordinator.begin(f.profile, "personal", false);
    resolve(
      Response.json({
        state: "first-state",
        authorizationEndpoint: "https://id.test/authorize",
      }),
    );
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(f.launch).toHaveBeenCalledOnce();
    const result = await f.coordinator.complete(
      `${deployment.appUrl}/oauth2-callback?code=code&state=second-state`,
    );
    expect(result.readOnly).toBe(false);
    expect(f.values.size).toBe(0);
  });
  it("restores the initiating profile/provider after redirect and preserves read-only choice", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    const restored = new WebOidcCoordinator(f.options);
    const result = await restored.complete(f.callback);
    expect(result.readOnly).toBe(true);
    expect(result.session.userId).toBe("2");
    expect(f.clearCallback).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(0);
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it("shares callback completion through remounts without exchanging twice", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", false);
    const a = f.coordinator.complete(f.callback),
      b = f.coordinator.complete(f.callback);
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(
      f.transport.mock.calls.filter(([url]) =>
        String(url).endsWith("/callback"),
      ),
    ).toHaveLength(1);
  });
  it("refuses callbacks without initiating context and removes callback parameters", async () => {
    const f = fixture();
    await expect(f.coordinator.complete(f.callback)).rejects.toThrow(
      "not started",
    );
    expect(f.clearCallback).toHaveBeenCalledOnce();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("does not route login to an unconfigured server or another app origin", () => {
    expect(() =>
      webOidcCallback(deployment, "https://other.test", deployment.appUrl),
    ).toThrow("not configured");
    expect(() =>
      webOidcCallback(deployment, deployment.serverUrl, "https://other.test"),
    ).toThrow("own");
    expect(() =>
      webOidcCallback(
        { ...deployment, appUrl: "https://avid.books.test/subpath" },
        deployment.serverUrl,
        deployment.appUrl,
      ),
    ).toThrow("own");
  });
  it("does not accept callback-supplied provider or server routing", async () => {
    const f = fixture();
    await f.coordinator.begin(f.profile, "personal", true);
    await f.coordinator.complete(
      `${f.callback}&provider=attacker&server=https://evil.test`,
    );
    expect(
      f.transport.mock.calls.every(([url]) =>
        String(url).startsWith(deployment.serverUrl),
      ),
    ).toBe(true);
  });
});
