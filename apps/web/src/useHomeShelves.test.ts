import { describe, expect, it, vi } from "vitest";
import { loadHomeShelves } from "./useHomeShelves";
import { demoBooks } from "./fixtures";
import type { BookQuery } from "../../../packages/core/src/bookorbit";
describe("bounded home shelves", () => {
  it("retrieves older reading and queued books independently of recently added items", async () => {
    const old = { ...demoBooks[0]!, id: "5000" },
      queued = { ...demoBooks[1]!, id: "6000" },
      recent = { ...demoBooks[2]!, id: "9000" };
    const client = {
      listBooks: vi.fn(async (query: BookQuery) => ({
        items: query.readStatuses?.includes("reading")
          ? [old]
          : query.readStatuses?.includes("want_to_read")
            ? [queued]
            : [recent],
        total: 10000,
        page: 1,
        size: 12,
      })),
    };
    const repo = {
      getAnchors: vi.fn(async () => []),
      getBook: vi.fn(),
      putBooks: vi.fn(async () => {}),
    };
    const result = await loadHomeShelves(
      client,
      repo,
      new AbortController().signal,
    );
    expect(result.continuing.map((book) => book.id)).toEqual(["5000"]);
    expect(result.queue.map((book) => book.id)).toEqual(["6000"]);
    expect(result.recent.map((book) => book.id)).toEqual(["9000"]);
    expect(client.listBooks).toHaveBeenCalledTimes(3);
    for (const [query] of client.listBooks.mock.calls)
      expect(query.size).toBe(12);
  });
  it("retains device-only positions and excludes finished books from Continue", async () => {
    const book = { ...demoBooks[0]!, id: "5", progress: 0.1 };
    const client = {
      listBooks: vi.fn(async () => ({
        items: [book],
        total: 1,
        page: 1,
        size: 12,
      })),
    };
    const repo = {
      getAnchors: vi.fn(async () => [
        {
          bookId: "5",
          fileId: "1",
          kind: "epub" as const,
          locator: "chapter",
          progress: 0.6,
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ]),
      getBook: vi.fn(async () => book),
      putBooks: vi.fn(async () => {}),
    };
    expect(
      (await loadHomeShelves(client, repo, new AbortController().signal))
        .continuing[0]?.progress,
    ).toBe(0.6);
    repo.getAnchors.mockResolvedValue([
      {
        bookId: "5",
        fileId: "1",
        kind: "epub",
        locator: "end",
        progress: 1,
        updatedAt: "2026-10-02T00:00:00Z",
      },
    ]);
    expect(
      (await loadHomeShelves(client, repo, new AbortController().signal))
        .continuing,
    ).toEqual([]);
  });
  it("does not cache results when an account change aborts the request", async () => {
    const abort = new AbortController();
    const client = {
      listBooks: vi.fn(async () => {
        abort.abort();
        return { items: [demoBooks[0]!], total: 1, page: 1, size: 12 };
      }),
    };
    const repo = {
      getAnchors: vi.fn(async () => []),
      getBook: vi.fn(),
      putBooks: vi.fn(async () => {}),
    };
    await expect(
      loadHomeShelves(client, repo, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(repo.putBooks).not.toHaveBeenCalled();
  });
});
