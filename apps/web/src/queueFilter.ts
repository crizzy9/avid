import type { BookQuery } from "../../../packages/core/src/bookorbit";
import type { Book, Collection } from "../../../packages/core/src/types";

export function serverShelfFilter(
  id: string | null,
): Pick<BookQuery, "readStatuses"> & { collectionId?: string } {
  return id === "queue"
    ? { readStatuses: ["want_to_read"] }
    : { collectionId: id ?? undefined };
}
export function inReadingQueue(
  book: Book,
  collections: Collection[],
  connected: boolean,
): boolean {
  return (
    book.serverStatus === "want_to_read" ||
    (!connected &&
      !!collections
        .find((row) => row.id === "queue")
        ?.bookIds.includes(book.id))
  );
}
