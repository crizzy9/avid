import { useEffect, useState } from "react";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { LibraryRepository } from "../../../packages/core/src/repository";
import type { Book } from "../../../packages/core/src/types";

export interface HomeShelves {
  continuing: Book[];
  queue: Book[];
  recent: Book[];
}
const empty: HomeShelves = { continuing: [], queue: [], recent: [] };
export const uniqueBooks = (books: Book[]) => [
  ...new Map(books.map((book) => [book.id, book])).values(),
];

/** Independent bounded shelves include books outside the first catalog page. */
export async function loadHomeShelves(
  client: Pick<BookOrbitClient, "listBooks">,
  repo: Pick<LibraryRepository, "getAnchors" | "getBook" | "putBooks">,
  signal: AbortSignal,
): Promise<HomeShelves> {
  const [continuing, queue, recent, anchors] = await Promise.all([
    client.listBooks(
      {
        size: 12,
        sort: "lastReadAt",
        direction: "desc",
        readStatuses: ["reading", "rereading", "on_hold"],
      },
      signal,
    ),
    client.listBooks(
      {
        size: 12,
        sort: "addedAt",
        direction: "desc",
        readStatuses: ["want_to_read"],
      },
      signal,
    ),
    client.listBooks({ size: 12, sort: "addedAt", direction: "desc" }, signal),
    repo.getAnchors(),
  ]);
  signal.throwIfAborted();
  const latest = new Map<string, (typeof anchors)[number]>();
  for (const anchor of anchors.sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  ))
    if (!latest.has(anchor.bookId)) latest.set(anchor.bookId, anchor);
  const local = await Promise.all(
    [...latest.values()]
      .filter((anchor) => anchor.progress > 0 && anchor.progress < 0.995)
      .slice(0, 12)
      .map((anchor) => repo.getBook(anchor.bookId)),
  );
  signal.throwIfAborted();
  const present = (book: Book): Book => {
    const anchor = latest.get(book.id);
    return anchor
      ? {
          ...book,
          progress: anchor.progress,
          status: anchor.progress >= 0.995 ? "finished" : "reading",
        }
      : book;
  };
  const result: HomeShelves = {
    continuing: uniqueBooks([
      ...local.filter((book): book is Book => !!book),
      ...continuing.items,
    ])
      .map(present)
      .filter((book) => book.progress < 0.995)
      .slice(0, 12),
    queue: queue.items.map(present),
    recent: recent.items.map(present),
  };
  await repo.putBooks(
    uniqueBooks([...result.continuing, ...result.queue, ...result.recent]),
  );
  signal.throwIfAborted();
  return result;
}

export function useHomeShelves(
  client: BookOrbitClient | null,
  repo: LibraryRepository,
  active: boolean,
  revision: number,
) {
  const [state, setState] = useState<{
    client: BookOrbitClient | null;
    shelves: HomeShelves;
    error: string;
  }>({ client: null, shelves: empty, error: "" });
  useEffect(() => {
    if (!client || !active) return;
    const abort = new AbortController();
    void loadHomeShelves(client, repo, abort.signal)
      .then((shelves) => {
        if (!abort.signal.aborted) setState({ client, shelves, error: "" });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setState((previous) => ({
            client,
            shelves: previous.client === client ? previous.shelves : empty,
            error: error instanceof Error ? error.message : String(error),
          }));
      });
    return () => abort.abort();
  }, [client, repo, active, revision]);
  return state.client === client
    ? { ...state.shelves, error: state.error }
    : { ...empty, error: "" };
}
