import { useEffect, useRef, useState } from "react";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";

type MetadataClient = Pick<BookOrbitClient, "getBook" | "baseUrl" | "session">;
const scopeOf = (client: MetadataClient) => JSON.stringify([client.baseUrl, client.session.userId]);
type Request = { client: MetadataClient; scope: string; bookId: string; promise: Promise<Book> };

/** Hydrate only the visible Home blurb. Transport/actions always retain the current catalog book. */
export function useCurrentBookDescription(client: MetadataClient | null, book: Book | undefined, active: boolean): string {
  const bookId = book?.id;
  const scope = client ? scopeOf(client) : "local";
  const request = useRef<Request | undefined>(undefined);
  const [loaded, setLoaded] = useState<{ client: MetadataClient; scope: string; bookId: string; description: string }>();

  useEffect(() => {
    if (!active || !client || !bookId || !/^[1-9]\d*$/.test(bookId) || !Number.isSafeInteger(Number(bookId))) return;
    let current = true;
    // The current getBook API has no AbortSignal. Reuse its one in-flight request during
    // StrictMode replay and ignore results after navigation/account changes.
    if (request.current?.client !== client || request.current.scope !== scope || request.current.bookId !== bookId)
      request.current = { client, scope, bookId, promise: client.getBook(bookId) };
    const pending = request.current;
    void pending.promise.then((detail) => {
      if (detail.id !== bookId || scopeOf(client) !== scope) {
        if (request.current === pending) request.current = undefined;
        return;
      }
      if (current) setLoaded({ client, scope, bookId, description: detail.description });
    }).catch(() => {
      if (request.current === pending) request.current = undefined;
      // Existing catalog/local metadata remains useful when the server is unavailable.
    });
    return () => { current = false; };
  }, [client, scope, bookId, active]);

  return loaded?.client === client && loaded.scope === scope && loaded.bookId === bookId
    ? loaded.description
    : book?.description ?? "";
}
