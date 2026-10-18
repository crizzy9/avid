import { describe, it, expect, vi } from "vitest";
import { BookOrbitClient, ReadOnlyError } from "../src/bookorbit";
import { missingBookRequestMedia } from "../src/bookRequests";
import type { Book, Session } from "../src/types";
const session: Session = {
  profile: { id: "a", name: "Server", url: "https://books.example" },
  userId: "1",
  accessToken: "token",
};
const item = {
  id: 10,
  userId: 1,
  title: "Novel",
  authors: ["Author"],
  mediaKind: "ebook",
  status: "pending",
  note: null,
  matchedBookId: null,
  statusReason: null,
  createdAt: "2026-10-18",
  updatedAt: "2026-10-18",
};
function setup(features: string[] = [], readOnly = false) {
  const calls: { path: string; body: any; signal?: AbortSignal | null }[] = [];
  const fetcher = vi.fn(async (input: any, init: RequestInit = {}) => {
    const path = String(input).split("/api/v1/")[1];
    calls.push({
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal: init.signal,
    });
    return Response.json(
      path === "app-info"
        ? { version: "3.4.0", features }
        : path === "book-requests/pairs"
          ? {
              ebook: { request: item, subscribed: false },
              audiobook: {
                request: { ...item, id: 11, mediaKind: "audiobook" },
                subscribed: true,
              },
            }
          : path === "book-requests"
            ? { request: item, subscribed: false }
            : path === "book-requests/availability"
              ? [
                  {
                    ownedBookId: null,
                    existingRequestId: 10,
                    existingRequestStatus: "pending",
                    alreadySubscribed: false,
                  },
                ]
              : { items: [item], total: 1 },
    );
  });
  return {
    client: new BookOrbitClient(structuredClone(session), {
      fetch: fetcher,
      readOnly,
    }),
    calls,
    fetcher,
  };
}
describe("BookOrbit advertised request contract", () => {
  it("uses the exact single pair route and never two independent writes", async () => {
    const { client, calls } = setup(["book-request-pairs"]);
    const result = await client.createBookRequestPair({
      title: "Novel",
      authors: ["Author"],
    });
    expect(result.audiobook.subscribed).toBe(true);
    expect(calls.map((c) => c.path)).toEqual([
      "app-info",
      "book-requests/pairs",
    ]);
    expect(calls[1].body).toEqual({ title: "Novel", authors: ["Author"] });
  });
  it("rejects target IDs and pair writes without advertised capability, even with a new version", async () => {
    const { client, calls } = setup();
    await expect(
      client.createBookRequestPair({ title: "Novel" }),
    ).rejects.toThrow("advertise");
    await expect(
      client.createBookRequest({
        title: "Novel",
        mediaKind: "audiobook",
        targetBookId: 3,
      }),
    ).rejects.toThrow("advertise");
    expect(calls.every((c) => c.path === "app-info")).toBe(true);
  });
  it("allows older single requests without sending new fields", async () => {
    const { client, calls } = setup();
    await client.createBookRequest({ title: "Novel", mediaKind: "ebook" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "book-requests",
      body: { title: "Novel", mediaKind: "ebook" },
    });
  });
  it("read-only refuses all writes before any request but permits availability", async () => {
    const { client, fetcher } = setup(["book-request-pairs"], true);
    await expect(
      client.createBookRequestPair({ title: "Novel" }),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(
      client.createBookRequest({ title: "Novel", mediaKind: "ebook" }),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await client.checkBookRequestAvailability([
          { title: "Novel", mediaKind: "ebook" },
        ])
      )[0].existingRequestId,
    ).toBe(10);
    expect((await client.getBookRequestCapabilities()).canSubmit).toBe(false);
  });
  it("keeps one-based request pagination and advertised grouping", async () => {
    const { client, calls } = setup(["book-request-pairs"]);
    await client.listBookRequests({ page: 2, size: 20, groupPairs: true });
    expect(calls[1].path).toBe("book-requests?page=2&limit=20&groupPairs=true");
  });
  it("does not mask authentication, network or contract failures as unavailable", async () => {
    const { client, fetcher } = setup();
    fetcher.mockImplementation(async () =>
      Response.json({ message: "No" }, { status: 500 }),
    );
    await expect(client.getBookRequestCapabilities()).rejects.toMatchObject({
      status: 500,
    });
  });
  it.each([403, 404, 405])(
    "capability probe safely gates status %s",
    async (status) => {
      const fetcher = vi.fn(async () =>
        Response.json({ message: "No" }, { status }),
      );
      expect(
        await new BookOrbitClient(session, {
          fetch: fetcher,
        }).getBookRequestCapabilities(),
      ).toMatchObject({
        available: false,
        canSubmit: false,
        reason: status === 403 ? "forbidden" : "unsupported",
      });
    },
  );
  it("blocks a target submission if cancellation wins its capability lookup", async () => {
    const { client, fetcher, calls } = setup(["book-request-pairs"]);
    const abort = new AbortController();
    fetcher.mockImplementationOnce(async () => {
      abort.abort();
      return Response.json({
        version: "3.4.0",
        features: ["book-request-pairs"],
      });
    });
    await expect(
      client.createBookRequest(
        { title: "Novel", mediaKind: "ebook", targetBookId: 1 },
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
  it("counts all actual files including comics, independently of primary format", () => {
    const book = { files: [{ format: "AUDIO" }] } as Book;
    expect(missingBookRequestMedia(book)).toBe("ebook");
    expect(
      missingBookRequestMedia({
        ...book,
        files: [{ id: "1", name: "Comic", format: "CBZ" }],
      }),
    ).toBe("audiobook");
    expect(
      missingBookRequestMedia({
        ...book,
        files: [...book.files, { id: "2", name: "Novel", format: "EPUB" }],
      }),
    ).toBeNull();
    expect(missingBookRequestMedia({ ...book, files: [] })).toBeNull();
  });
});
