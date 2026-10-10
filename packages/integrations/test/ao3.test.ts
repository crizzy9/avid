// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Ao3Client,
  Ao3FollowStore,
  normalizeAo3CompanionAddress,
  parseAo3ChapterIndex,
  parseAo3Edition,
  parseAo3Subscriptions,
} from "../src/ao3";
import { chapterIndex, subscriptions, workPage } from "./fixtures/ao3";
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const edition = (ids = ["11", "12"], changed = false) =>
  parseAo3Edition(
    workPage(ids, changed),
    "reader",
    "123",
    parseAo3ChapterIndex(chapterIndex(ids), "reader", "123"),
  );
describe("AO3 followed-work editions", () => {
  it("reads account-owned work subscriptions, validates next-page identity and preserves unavailable entries", () => {
    expect(
      parseAo3Subscriptions(subscriptions("reader", true), "reader"),
    ).toEqual({
      works: [{ workId: "123", title: "A Lantern at Sea", author: "writer" }],
      unavailable: 1,
      nextPage: 2,
    });
    expect(() =>
      parseAo3Subscriptions(subscriptions("other"), "reader"),
    ).toThrow("changed account");
    expect(() =>
      parseAo3Subscriptions(
        subscriptions("reader", true).replace("page=2", "page=5"),
        "reader",
      ),
    ).toThrow("pagination");
    expect(() =>
      parseAo3Subscriptions(
        subscriptions().replace(
          'href="/works/123"',
          'href="https://evil.example/works/123"',
        ),
        "reader",
      ),
    ).toThrow("outside");
  });
  it("deduplicates identical revisions but detects appended or edited chapters without changing prior edition identity", async () => {
    const first = await edition(),
      same = await edition(),
      added = await edition(["11", "12", "13"]),
      edited = await edition(["11", "12"], true);
    expect(same.revision).toBe(first.revision);
    expect(added.chapterIds).toEqual(["11", "12", "13"]);
    expect(added.revision).not.toBe(first.revision);
    expect(edited.chapterIds).toEqual(first.chapterIds);
    expect(edited.revision).not.toBe(first.revision);
    expect(first.chapterIds).toEqual(["11", "12"]);
    const store = new Ao3FollowStore("bookorbit-account-a", "reader");
    store.record(first, true);
    store.record(same, true);
    store.record(added);
    expect(store.all()[0].importedRevisions).toEqual([first.revision]);
    expect(store.all()[0].chapterIds).toEqual(added.chapterIds);
    store.record(added, true);
    expect(store.all()[0].importedRevisions).toEqual([
      first.revision,
      added.revision,
    ]);
    expect(new Ao3FollowStore("bookorbit-account-b", "reader").all()).toEqual(
      [],
    );
    expect(
      new Ao3FollowStore("bookorbit-account-a", "other-reader").all(),
    ).toEqual([]);
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain("Passage");
  });
  it("rejects mismatched chapter count/order and missing download contracts", async () => {
    const index = parseAo3ChapterIndex(chapterIndex(), "reader", "123");
    await expect(
      parseAo3Edition(workPage(["11"]), "reader", "123", index),
    ).rejects.toThrow("changed while checking");
    await expect(
      parseAo3Edition(workPage(["12", "11"]), "reader", "123", index),
    ).rejects.toThrow("order changed");
    await expect(
      parseAo3Edition(
        workPage().replace(".epub", ".mobi"),
        "reader",
        "123",
        index,
      ),
    ).rejects.toThrow("EPUB");
  });
  it("keeps pairing and session secrets out of URLs/storage and rejects an edition that changes during download", async () => {
    let changed = false;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/session" && init?.method === "POST")
        return Response.json({ username: "reader", sessionId: "s".repeat(64) });
      if (url.pathname === "/v1/epub") {
        changed = true;
        return new Response("PK-fixture", {
          headers: { "Content-Type": "application/epub+zip" },
        });
      }
      if (url.pathname === "/v1/page") {
        const path = url.searchParams.get("path")!;
        return Response.json({
          url: `https://archiveofourown.org${path}`,
          html: path.endsWith("/navigate")
            ? chapterIndex()
            : workPage(["11", "12"], changed),
        });
      }
      return Response.json({ disconnected: true });
    });
    const client = new Ao3Client(
      "http://127.0.0.1:43119",
      "pairing".repeat(8),
      { fetch: transport },
    );
    await client.connect("reader", "fixture-password");
    const current = await client.edition("123");
    await expect(client.download(current)).rejects.toThrow(
      "changed during download",
    );
    for (const [url, init] of transport.mock.calls) {
      expect(String(url)).not.toContain("fixture-password");
      expect(String(url)).not.toContain("pairing");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${"pairing".repeat(8)}`,
      );
    }
    expect(localStorage.length).toBe(0);
    await client.disconnect();
    expect(client.accountId).toBeNull();
    expect(
      () => new Ao3Client("http://remote.example", "pairing".repeat(8)),
    ).toThrow("local HTTP companion");
  });
});

describe("AO3 HTTPS and native web transport", () => {
  it("accepts canonical HTTPS companions and rejects insecure remote or ambiguous addresses", () => {
    expect(normalizeAo3CompanionAddress("https://companion.example")).toBe(
      "https://companion.example",
    );
    expect(
      normalizeAo3CompanionAddress("https://companion.example:8443/"),
    ).toBe("https://companion.example:8443");
    expect(normalizeAo3CompanionAddress("http://127.0.0.1:43119")).toBe(
      "http://127.0.0.1:43119",
    );
    for (const address of [
      "http://remote.example",
      "http://127.0.0.1",
      "https://name:secret@companion.example",
      "https://companion.example/path",
      "https://companion.example/../",
      "https://companion.example:0",
      "https://companion.example:443",
      "https://companion.example?token=x",
      "https://companion.example#x",
    ])
      expect(() => normalizeAo3CompanionAddress(address)).toThrow();
  });
  it("uses the original native WebView fetch with no redirects, credentials, cache or URL secrets", async () => {
    const patched = vi.fn<typeof fetch>(),
      original = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ username: "reader", sessionId: "s".repeat(48) }),
          ),
        );
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    vi.stubGlobal("CapacitorWebFetch", original);
    vi.stubGlobal("fetch", patched);
    const client = new Ao3Client("https://companion.example", "p".repeat(48));
    await expect(client.connect("reader", "private-password")).resolves.toBe(
      "reader",
    );
    expect(patched).not.toHaveBeenCalled();
    const [url, options] = original.mock.calls[0];
    expect(url).toBe("https://companion.example/v1/session");
    expect(options).toMatchObject({
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      `Bearer ${"p".repeat(48)}`,
    );
    vi.stubGlobal("CapacitorWebFetch", undefined);
    expect(
      () => new Ao3Client("https://companion.example", "p".repeat(48)),
    ).toThrow("native web transport");
  });
  it("applies timeout to stalled response bodies and cancels the reader without adopting a session", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(),
      transport = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"username":"reader",'),
              );
            },
            cancel,
          }),
        ),
      );
    const client = new Ao3Client("https://companion.example", "p".repeat(48), {
      fetch: transport,
      timeoutMs: 1000,
    });
    const result = client.connect("reader", "fixture");
    const rejected = expect(result).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(client.accountId).toBeNull();
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("cancels even a transport stalled before headers and bounds declared response size", async () => {
    const abort = new AbortController(),
      transport = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise(() => {}));
    const client = new Ao3Client("https://companion.example", "p".repeat(48), {
      fetch: transport,
    });
    const pending = client.connect("reader", "fixture", abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    await rejected;
    const cancel = vi.fn();
    transport.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Length": String(19 * 1024 * 1024) },
      }),
    );
    await expect(client.connect("reader", "fixture")).rejects.toThrow(
      "size limit",
    );
    expect(cancel).toHaveBeenCalled();
    expect(client.accountId).toBeNull();
  });
});
