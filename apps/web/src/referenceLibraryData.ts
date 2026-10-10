import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";

export type ReferenceMedia = "audio" | "books" | "comics";
export const REFERENCE_SHELF_LIMIT = 16;
export type ReferenceLibraryShelves = Record<
  ReferenceMedia,
  { books: Book[]; total: number }
>;
const media: readonly ReferenceMedia[] = ["audio", "books", "comics"];

/** A shelf may introduce a book outside the current catalog page. Keep confirmed changes visible. */
export function upsertCatalogBook(
  books: readonly Book[],
  updated: Book,
): Book[] {
  return books.some((book) => book.id === updated.id)
    ? books.map((book) => (book.id === updated.id ? updated : book))
    : [...books, updated];
}

/** A mixed edition belongs to every applicable shelf; rows retain their original metadata. */
export function partitionReferenceBooks(
  books: readonly Book[],
): Record<ReferenceMedia, Book[]> {
  const shelves: Record<ReferenceMedia, Book[]> = {
    audio: [],
    books: [],
    comics: [],
  };
  const seen = {
    audio: new Set<string>(),
    books: new Set<string>(),
    comics: new Set<string>(),
  };
  for (const book of books) {
    const formats = book.files.length
      ? book.files.map((file) => file.format)
      : [book.format];
    for (const format of formats) {
      const shelf: ReferenceMedia =
        format === "AUDIO"
          ? "audio"
          : ["CBZ", "CBR", "CB7"].includes(format)
            ? "comics"
            : "books";
      if (!seen[shelf].has(book.id)) {
        seen[shelf].add(book.id);
        shelves[shelf].push(book);
      }
    }
  }
  return shelves;
}

/** Three bounded catalog requests only: no media downloads or local repository writes. */
export async function loadReferenceLibraryShelves(
  client: Pick<BookOrbitClient, "listBooks">,
  signal?: AbortSignal,
): Promise<ReferenceLibraryShelves> {
  signal?.throwIfAborted();
  const pages = await Promise.all(
    media.map((kind) =>
      client.listBooks(
        {
          media: kind,
          size: REFERENCE_SHELF_LIMIT,
          sort: "addedAt",
          direction: "desc",
        },
        signal,
      ),
    ),
  );
  signal?.throwIfAborted();
  return Object.fromEntries(
    media.map((kind, index) => [
      kind,
      {
        books: partitionReferenceBooks(pages[index].items)[kind].slice(
          0,
          REFERENCE_SHELF_LIMIT,
        ),
        total: pages[index].total,
      },
    ]),
  ) as ReferenceLibraryShelves;
}
