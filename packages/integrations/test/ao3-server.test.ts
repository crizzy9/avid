import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { Ao3SessionService, createAo3Companion } from "../companion/ao3Server";
import { greeting, loginForm, subscriptions, workPage } from "./fixtures/ao3";

const html = (body: string, headers: HeadersInit = {}) =>
  new Response(body, { headers: { "Content-Type": "text/html", ...headers } });
function archiveFixture() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/login" && init?.method === "POST")
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/users/reader",
          "Set-Cookie":
            "_otwarchive_session=authenticated; Path=/; Secure; HttpOnly",
        },
      });
    if (url.pathname === "/users/login")
      return html(loginForm, {
        "Set-Cookie": "_otwarchive_session=prelogin; Path=/; Secure; HttpOnly",
      });
    if (url.pathname === "/users/reader") return html(greeting());
    if (url.pathname === "/users/reader/subscriptions")
      return html(subscriptions());
    if (url.pathname === "/works/123") return html(workPage());
    if (url.pathname.startsWith("/downloads/123/"))
      return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
        headers: { "Content-Type": "application/epub+zip" },
      });
    throw new Error("Unexpected controlled fixture request.");
  });
}
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
});
describe("AO3 companion boundaries and source-verified session contract", () => {
  it("uses CSRF and a private cookie jar, then permits only scoped reads and observed EPUB URLs", async () => {
    const transport = archiveFixture(),
      service = new Ao3SessionService({
        fetch: transport,
        minimumIntervalMs: 0,
      });
    const session = await service.login("reader", "fixture-password");
    expect(session.username).toBe("reader");
    const post = transport.mock.calls.find(
      ([, init]) => init?.method === "POST",
    )!;
    expect(String(post[0])).toBe("https://archiveofourown.org/users/login");
    const fields = new URLSearchParams(String(post[1]?.body));
    expect(Object.fromEntries(fields)).toEqual({
      authenticity_token: "csrf+token==",
      "user[login]": "reader",
      "user[password]": "fixture-password",
      "user[remember_me]": "0",
    });
    expect(new Headers(post[1]?.headers).get("Cookie")).toBe(
      "_otwarchive_session=prelogin",
    );
    expect(new Headers(post[1]?.headers).get("Authorization")).toBeNull();
    const before = transport.mock.calls.length;
    await expect(
      service.page(
        session.sessionId,
        "https://evil.example/works/123?view_full_work=true",
      ),
    ).rejects.toThrow("allowed routes");
    await expect(
      service.page(session.sessionId, "/users/other/subscriptions?type=works"),
    ).rejects.toThrow("allowed routes");
    await expect(
      service.epub(
        session.sessionId,
        "/downloads/123/A_Lantern.epub?updated_at=10",
      ),
    ).rejects.toThrow("Check this followed work");
    expect(transport).toHaveBeenCalledTimes(before);
    await service.page(
      session.sessionId,
      "/users/reader/subscriptions?type=works&page=1",
    );
    expect(
      new Headers(transport.mock.calls.at(-1)?.[1]?.headers).get("Cookie"),
    ).toBe("_otwarchive_session=authenticated");
    await service.page(session.sessionId, "/works/123?view_full_work=true");
    expect(
      await service.epub(
        session.sessionId,
        "/downloads/123/A_Lantern.epub?updated_at=10",
      ),
    ).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
    service.disconnect(session.sessionId);
    await expect(
      service.page(session.sessionId, "/users/reader/subscriptions?type=works"),
    ).rejects.toThrow("expired");
  });
  it("expires changed identities without exposing another account page", async () => {
    const transport = archiveFixture(),
      service = new Ao3SessionService({
        fetch: transport,
        minimumIntervalMs: 0,
      });
    const session = await service.login("reader", "fixture");
    transport.mockResolvedValueOnce(html(subscriptions("other")));
    await expect(
      service.page(session.sessionId, "/users/reader/subscriptions?type=works"),
    ).rejects.toMatchObject({ status: 401 });
    const calls = transport.mock.calls.length;
    await expect(
      service.page(session.sessionId, "/users/reader/subscriptions?type=works"),
    ).rejects.toMatchObject({ status: 401 });
    expect(transport).toHaveBeenCalledTimes(calls);
  });
  it("does not forward credentials or cookies to a redirect outside AO3", async () => {
    const transport = archiveFixture();
    transport.mockResolvedValueOnce(
      html(loginForm, { "Set-Cookie": "_otwarchive_session=prelogin; Path=/" }),
    );
    transport.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/collect" },
      }),
    );
    const service = new Ao3SessionService({
      fetch: transport,
      minimumIntervalMs: 0,
    });
    await expect(service.login("reader", "fixture")).rejects.toThrow("outside");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      transport.mock.calls.every(
        ([input]) =>
          new URL(String(input)).origin === "https://archiveofourown.org",
      ),
    ).toBe(true);
  });
  it("honors upstream Retry-After without retry loops", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
      );
    const service = new Ao3SessionService({
      fetch: transport,
      minimumIntervalMs: 0,
    });
    await expect(service.login("reader", "fixture")).rejects.toMatchObject({
      status: 429,
      retryAfter: 120,
    });
    await expect(service.login("reader", "fixture")).rejects.toMatchObject({
      status: 429,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("requires allowed origin and random pairing credential before any upstream request", async () => {
    const transport = archiveFixture(),
      pairing = "a".repeat(48),
      origin = "http://127.0.0.1:5173";
    server = createAo3Companion({
      pairingToken: pairing,
      origins: [origin],
      service: new Ao3SessionService({
        fetch: transport,
        minimumIntervalMs: 0,
      }),
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server failed.");
    const url = `http://127.0.0.1:${address.port}/v1/session`;
    const request = (requestOrigin: string, token: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          Origin: requestOrigin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ login: "reader", password: "fixture" }),
      });
    expect((await request("https://unrelated.example", pairing)).status).toBe(
      403,
    );
    expect((await request(origin, "wrong")).status).toBe(401);
    expect(transport).not.toHaveBeenCalled();
    const accepted = await request(origin, pairing);
    expect(accepted.status).toBe(200);
    const result = await accepted.json();
    expect(result.username).toBe("reader");
    expect(JSON.stringify(result)).not.toContain("authenticated");
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
  });
});
