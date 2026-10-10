import { describe, expect, it, vi } from "vitest";
import { BookOrbitClient, ReadOnlyError } from "../src/bookorbit";
import type { Session } from "../src/types";

const original: Session = {
  profile: { id: "server", name: "Books", url: "https://books.test" },
  userId: "7",
  accessToken: "expired",
  clientKind: "web",
};
const fresh: Session = { ...original, accessToken: "fresh" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
function transport() {
  return vi.fn<typeof fetch>(async (_input, init) =>
    new Headers(init?.headers).get("Authorization") === "Bearer expired"
      ? Response.json({ message: "Expired" }, { status: 401 })
      : Response.json({ version: "3.3.0", features: [] }),
  );
}
describe("coordinated credential refresh", () => {
  it("uses one native refresh for concurrent 401s and awaits durable session adoption before retries", async () => {
    const fetch = transport(),
      saved = deferred<void>();
    const refreshSession = vi.fn(async () => structuredClone(fresh));
    const onSessionChange = vi.fn(() => saved.promise);
    const client = new BookOrbitClient(structuredClone(original), {
      fetch,
      refreshSession,
      onSessionChange,
    });
    const a = client.getServerInfo(),
      b = client.getServerInfo();
    await vi.waitFor(() => expect(onSessionChange).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    saved.resolve();
    await Promise.all([a, b]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/auth/refresh")),
    ).toBe(false);
  });
  it("does not rotate again for a delayed old-token 401 arriving after refresh completed", async () => {
    const delayed = deferred<Response>(),
      fetch = transport(),
      actual = fetch.getMockImplementation()!;
    let calls = 0;
    fetch.mockImplementation((input, init) =>
      ++calls === 1 ? delayed.promise : actual(input, init),
    );
    const refreshSession = vi.fn(async () => structuredClone(fresh));
    const client = new BookOrbitClient(structuredClone(original), {
      fetch,
      refreshSession,
    });
    const first = client.getServerInfo();
    await client.getServerInfo();
    delayed.resolve(Response.json({ message: "Expired" }, { status: 401 }));
    await first;
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(client.session.accessToken).toBe("fresh");
  });
  it.each([
    { ...fresh, userId: "other" },
    { ...fresh, profile: { ...fresh.profile, id: "other" } },
    { ...fresh, profile: { ...fresh.profile, url: "https://other.test" } },
    { ...fresh, clientKind: "native" as const },
    { ...fresh, accessToken: "" },
  ])(
    "rejects foreign or invalid refreshed identity before retrying",
    async (next) => {
      const fetch = transport(),
        onSessionChange = vi.fn();
      const client = new BookOrbitClient(structuredClone(original), {
        fetch,
        refreshSession: async () => next,
        onSessionChange,
      });
      await expect(client.getServerInfo()).rejects.toMatchObject({
        status: 401,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onSessionChange).not.toHaveBeenCalled();
      expect(client.session).toEqual(original);
    },
  );
  it("does not fall back to JS refresh after native failure", async () => {
    const fetch = transport();
    const client = new BookOrbitClient(structuredClone(original), {
      fetch,
      refreshSession: async () => {
        throw new Error("Vault generation changed");
      },
    });
    await expect(client.getServerInfo()).rejects.toThrow("generation changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry requests when awaited credential storage fails", async () => {
    const fetch = transport();
    const client = new BookOrbitClient(structuredClone(original), {
      fetch,
      refreshSession: async () => fresh,
      onSessionChange: async () => {
        throw new Error("Keychain unavailable");
      },
    });
    await expect(client.getServerInfo()).rejects.toThrow(
      "Keychain unavailable",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("blocks read-only mutations before either refresh path is invoked", async () => {
    const fetch = transport(),
      refreshSession = vi.fn(async () => fresh);
    const client = new BookOrbitClient(structuredClone(original), {
      fetch,
      refreshSession,
      readOnly: true,
    });
    await expect(client.setReadStatus("1", "reading")).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
