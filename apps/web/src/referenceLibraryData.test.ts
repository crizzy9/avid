import { describe, expect, it, vi } from "vitest";
import type { Book, BookFormat } from "../../../packages/core/src/types";
import type {
  BookOrbitClient,
  BooksPage,
} from "../../../packages/core/src/bookorbit";
import {
  loadReferenceLibraryShelves,
  partitionReferenceBooks,
  REFERENCE_SHELF_LIMIT,
  upsertCatalogBook,
} from "./referenceLibraryData";

function book(
  id: string,
  formats: BookFormat[],
  primary: BookFormat = "EPUB",
): Book {
  return {
    id,
    title: id,
    authors: [],
    description: "",
    format: primary,
    files: formats.map((format, index) => ({
      id: `${id}-${index}`,
      name: `${id}-${index}`,
      format,
    })),
    color: "#123456",
    progress: 0,
    status: "unread",
    genres: [],
    addedAt: "2026-10-09T00:00:00Z",
  };
}
function page(items: Book[], total: number): BooksPage {
  return { items, total, page: 1, size: 16 };
}

describe("reference library shelf metadata", () => {
  it.each(["AUDIO", "EPUB", "CBZ"] as const)(
    "keeps mixed editions in every applicable drilldown when the primary format is %s",
    (primary) => {
      const mixed = book("mixed", ["AUDIO", "EPUB", "CBZ"], primary);
      const result = partitionReferenceBooks([mixed]);
      expect(result.audio).toEqual([mixed]);
      expect(result.books).toEqual([mixed]);
      expect(result.comics).toEqual([mixed]);
    },
  );
  it("promotes confirmed changes for an out-of-page shelf book and subsequently replaces it without duplication", () => {
    const visible = book("first-page", ["EPUB"]),
      outside = book("shelf-only", ["EPUB"]);
    const queued = { ...outside, serverStatus: "want_to_read" as const };
    const original = [visible];
    const promoted = upsertCatalogBook(original, queued);
    expect(promoted).toEqual([visible, queued]);
    expect(original).toEqual([visible]);
    const removed = { ...outside, serverStatus: "unread" as const };
    const result = upsertCatalogBook(promoted, removed);
    expect(result).toEqual([visible, removed]);
    expect(result.filter((item) => item.id === outside.id)).toHaveLength(1);
  });
  it("uses actual formats, includes mixed editions, and deduplicates each shelf in source order", () => {
    const mixed = book("mixed", ["AUDIO", "EPUB", "AUDIO", "CBZ"]);
    const input = [
      mixed,
      book("pdf", ["PDF"]),
      book("cbr", ["CBR"]),
      book("cb7", ["CB7"]),
      book("mobi", ["MOBI"]),
      mixed,
    ];
    const result = partitionReferenceBooks(input);
    expect(result.audio).toEqual([mixed]);
    expect(result.books.map((item) => item.id)).toEqual([
      "mixed",
      "pdf",
      "mobi",
    ]);
    expect(result.comics.map((item) => item.id)).toEqual([
      "mixed",
      "cbr",
      "cb7",
    ]);
    expect(result.books[0]).toBe(mixed);
    expect(input).toHaveLength(6);
  });
  it("falls back to the book format only when no edition files exist and does not cap local partitions", () => {
    const emptyAudio = book("audio", [], "AUDIO"),
      actualComic = book("comic", ["CBZ"], "AUDIO");
    const many = Array.from({ length: 20 }, (_, index) =>
      book(String(index), []),
    );
    const result = partitionReferenceBooks([emptyAudio, actualComic, ...many]);
    expect(result.audio).toEqual([emptyAudio]);
    expect(result.comics).toEqual([actualComic]);
    expect(result.books).toHaveLength(20);
  });
  it("starts three independent bounded catalog queries and preserves each server total", async () => {
    const responses: ((value: BooksPage) => void)[] = [];
    const listBooks = vi.fn<BookOrbitClient["listBooks"]>(
      () =>
        new Promise((resolve) => {
          responses.push(resolve);
        }),
    );
    const signal = new AbortController().signal;
    const pending = loadReferenceLibraryShelves({ listBooks }, signal);
    expect(listBooks).toHaveBeenCalledTimes(3);
    expect(listBooks.mock.calls).toEqual(
      ["audio", "books", "comics"].map((media) => [
        { media, size: 16, sort: "addedAt", direction: "desc" },
        signal,
      ]),
    );
    const audio = book("audio", ["AUDIO"]),
      epub = book("epub", ["EPUB"]),
      comic = book("comic", ["CBZ"]);
    responses[1](page([epub], 140));
    responses[0](page([audio], 51));
    responses[2](page([comic], 29));
    expect(await pending).toEqual({
      audio: { books: [audio], total: 51 },
      books: { books: [epub], total: 140 },
      comics: { books: [comic], total: 29 },
    });
  });
  it("bounds displayed remote items even if a server returns an oversized page", async () => {
    const listBooks = vi.fn<BookOrbitClient["listBooks"]>(async (query) =>
      page(
        Array.from({ length: 19 }, (_, index) =>
          book(`${query?.media}-${index}`, [
            query?.media === "audio"
              ? "AUDIO"
              : query?.media === "comics"
                ? "CBZ"
                : "EPUB",
          ]),
        ),
        100,
      ),
    );
    const result = await loadReferenceLibraryShelves({ listBooks });
    for (const shelf of Object.values(result)) {
      expect(shelf.books).toHaveLength(REFERENCE_SHELF_LIMIT);
      expect(shelf.total).toBe(100);
    }
  });
  it("rejects an already aborted load without querying metadata", async () => {
    const listBooks = vi.fn<BookOrbitClient["listBooks"]>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadReferenceLibraryShelves({ listBooks }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(listBooks).not.toHaveBeenCalled();
  });
  it("discards late metadata pages when cancellation occurs before completion", async () => {
    const responses: ((value: BooksPage) => void)[] = [];
    const listBooks = vi.fn<BookOrbitClient["listBooks"]>(
      () =>
        new Promise((resolve) => {
          responses.push(resolve);
        }),
    );
    const controller = new AbortController();
    const pending = loadReferenceLibraryShelves(
      { listBooks },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    responses.forEach((resolve) =>
      resolve(page([book("old-account", ["EPUB"])], 1)),
    );
    await rejected;
  });
});
