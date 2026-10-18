import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";

export const STORY_ARC_PAGE_SIZE = 24;
export const STORY_ARC_CONCURRENCY = 4;
export type StoryArcClient = Pick<BookOrbitClient, "listBooks" | "getBook">;
export interface StoryArcGroup {
  name: string;
  books: Book[];
}
export const isComic = (book: Book) =>
  !!book.comicMetadata ||
  [book.format, ...book.files.map((file) => file.format)].some((format) =>
    ["CBZ", "CBR", "CB7"].includes(format),
  );
const titleOrder = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** The contract supplies names, not arc sequence numbers. Order by real series/issue metadata. */
export function groupStoryArcs(books: readonly Book[]): {
  groups: StoryArcGroup[];
  ungrouped: Book[];
} {
  const groups = new Map<string, Map<string, Book>>(),
    ungrouped: Book[] = [];
  for (const book of new Map(
    books.filter(isComic).map((item) => [item.id, item]),
  ).values()) {
    const arcs = [
      ...new Set(
        (book.comicMetadata?.storyArcs ?? [])
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ];
    if (!arcs.length) ungrouped.push(book);
    for (const name of arcs) {
      const group = groups.get(name) ?? new Map();
      group.set(book.id, book);
      groups.set(name, group);
    }
  }
  const order = (a: Book, b: Book) =>
    titleOrder.compare(
      a.series ?? a.comicMetadata?.volumeName ?? "",
      b.series ?? b.comicMetadata?.volumeName ?? "",
    ) ||
    titleOrder.compare(
      a.comicMetadata?.issueNumber ?? String(a.seriesIndex ?? ""),
      b.comicMetadata?.issueNumber ?? String(b.seriesIndex ?? ""),
    ) ||
    titleOrder.compare(a.title, b.title) ||
    titleOrder.compare(a.id, b.id);
  return {
    groups: [...groups]
      .map(([name, rows]) => ({ name, books: [...rows.values()].sort(order) }))
      .sort((a, b) => titleOrder.compare(a.name, b.name)),
    ungrouped: ungrouped.sort(order),
  };
}

/** No invented arc endpoint. Catalog cards omit arcs; fetch the verified per-book detail DTO. */
export async function loadStoryArcPage(
  client: StoryArcClient,
  page: number,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<{
  books: Book[];
  failedIds: string[];
  total: number;
  page: number;
  count: number;
}> {
  signal.throwIfAborted();
  const catalog = await client.listBooks(
    {
      media: "comics",
      page,
      size: STORY_ARC_PAGE_SIZE,
      sort: "title",
      direction: "asc",
    },
    signal,
  );
  signal.throwIfAborted();
  const cards = catalog.items.slice(0, STORY_ARC_PAGE_SIZE),
    books: Book[] = [],
    failedIds: string[] = [];
  let cursor = 0,
    completed = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(STORY_ARC_CONCURRENCY, cards.length) },
      async () => {
        for (;;) {
          signal.throwIfAborted();
          const card = cards[cursor++];
          if (!card) return;
          try {
            const detail = await client.getBook(card.id, signal);
            signal.throwIfAborted();
            if (detail.id !== card.id)
              throw new Error("Book detail identity changed.");
            books.push(detail);
          } catch {
            signal.throwIfAborted();
            failedIds.push(card.id);
          }
          onProgress?.(++completed, cards.length);
        }
      },
    ),
  );
  signal.throwIfAborted();
  return { books, failedIds, total: catalog.total, page, count: cards.length };
}
