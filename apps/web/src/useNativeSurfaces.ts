import { useCallback, useEffect, useRef } from "react";
import type {
  Book,
  BookFile,
  ReadingAnchor,
} from "../../../packages/core/src/types";
import { readerKindForFile } from "../../../packages/readers/src/bookFile";
import {
  getNativeSystemSurfaces,
  type NativeNavigation,
  type SystemBook,
} from "../../mobile/src/native-surfaces";

function systemBook(
  book: Book,
  file: BookFile,
  anchor?: ReadingAnchor,
): SystemBook {
  let audioPosition: number | undefined;
  if (anchor?.kind === "audio")
    try {
      audioPosition = JSON.parse(anchor.locator).time;
    } catch {
      /* Text and non-audio metadata remain usable. */
    }
  return {
    bookId: book.id,
    fileId: file.id,
    title: book.title,
    author: book.authors.join(", "),
    kind: readerKindForFile(file),
    progress: anchor?.progress ?? book.progress,
    audioPosition,
  };
}
/** Publish account-scoped metadata only; never credentials, book bytes, or annotation text. */
export function useNativeSurfaces(
  scope: string,
  connected: boolean,
  books: Book[],
  onNavigate: (request: NativeNavigation) => void,
  onError: (message: string) => void,
) {
  const surfaces = useRef(getNativeSystemSurfaces());
  const current = useRef({ scope, connected, onNavigate, onError });
  current.current = { scope, connected, onNavigate, onError };
  const queue = useRef(Promise.resolve());
  const lastPublished = useRef({ key: "", time: 0 });
  const wasConnected = useRef(false);
  const run = useCallback(
    (owner: string, operation: () => Promise<unknown>) => {
      queue.current = queue.current
        .then(async () => {
          if (current.current.scope === owner) await operation();
        })
        .catch((error) => {
          if (current.current.scope === owner)
            current.current.onError(
              error instanceof Error
                ? error.message
                : "Native library shortcuts could not be updated.",
            );
        });
    },
    [],
  );
  useEffect(() => {
    const plugin = surfaces.current;
    if (!plugin) return;
    if (connected) {
      wasConnected.current = true;
      run(scope, () => plugin.activateAccount({ accountScope: scope }));
    } else if (wasConnected.current) {
      wasConnected.current = false;
      run(scope, () => plugin.clearAccount());
    }
    if (!connected) return;
    let active = true;
    const consume = async () => {
      try {
        const response = await plugin.consumeNavigation();
        if (!active || !response.book || current.current.scope !== scope)
          return;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(scope),
        );
        const hash = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join("");
        if (
          active &&
          current.current.scope === scope &&
          response.book.scopeHash === hash
        )
          current.current.onNavigate(response.book);
      } catch (error) {
        if (active)
          current.current.onError(
            error instanceof Error
              ? error.message
              : "The native book shortcut could not be opened.",
          );
      }
    };
    const listener = plugin.addListener("navigationAvailable", () => {
      void consume();
    });
    run(scope, consume);
    return () => {
      active = false;
      void listener.then((handle) => handle.remove()).catch(() => {});
    };
  }, [scope, connected, run]);
  // Cover URL refreshes do not repeatedly reindex unchanged titles.
  const indexKey = JSON.stringify(
    books
      .filter((book) => !book.id.startsWith("local-"))
      .flatMap((book) =>
        book.files
          .filter(
            (file) =>
              file.format !== "AUDIO" ||
              file.id ===
                book.files.find((item) => item.format === "AUDIO")?.id,
          )
          .map((file) => systemBook(book, file)),
      ),
  );
  useEffect(() => {
    const plugin = surfaces.current;
    if (!plugin || !connected) return;
    const entries = JSON.parse(indexKey) as SystemBook[];
    if (entries.length)
      run(scope, async () => {
        for (let start = 0; start < entries.length; start += 500) {
          if (current.current.scope !== scope) return;
          await plugin.indexBooks({
            accountScope: scope,
            books: entries.slice(start, start + 500),
          });
        }
      });
  }, [scope, connected, indexKey, run]);
  return useCallback(
    (book: Book, file: BookFile, anchor?: ReadingAnchor) => {
      const plugin = surfaces.current,
        owner = current.current;
      if (!plugin || !owner.connected || book.id.startsWith("local-")) return;
      const key = `${owner.scope}:${book.id}:${file.id}`,
        time = Date.now();
      if (
        lastPublished.current.key === key &&
        time - lastPublished.current.time < 5000
      )
        return;
      lastPublished.current = { key, time };
      run(owner.scope, () =>
        plugin.publishRecent({
          accountScope: owner.scope,
          book: systemBook(book, file, anchor),
        }),
      );
    },
    [run],
  );
}
