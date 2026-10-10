import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDesktopBridge,
  type DesktopAction,
  type DesktopBridge,
  type DesktopRecent,
  type DesktopSnapshot,
} from "../../desktop/src/bridge";
import type { LibraryRepository } from "../../../packages/core/src/repository";
import type {
  Book,
  BookFile,
  ReadingAnchor,
} from "../../../packages/core/src/types";
import type { PlaybackTransport } from "../../mobile/src/native-transport";
import { readerKindForFile } from "../../../packages/readers/src/bookFile";

type Navigation = Required<Pick<DesktopAction, "bookId" | "fileId" | "kind">>;
export function applyDesktopAction(
  action: DesktopAction,
  scope: string | null,
  controller: PlaybackTransport,
  open: (request: Navigation) => void,
) {
  if (!scope || action.accountScope !== scope) return;
  if (action.action === "open") {
    if (
      action.bookId &&
      action.fileId &&
      ["epub", "pdf", "comic", "audio"].includes(action.kind ?? "")
    )
      open(action as DesktopAction & Navigation);
    return;
  }
  const book = controller.getBook(),
    state = controller.getSnapshot();
  if (!book || action.bookId !== book.bookId || action.fileId !== book.fileId)
    return;
  switch (action.action) {
    case "play":
      void controller.play();
      break;
    case "pause":
    case "stop":
      controller.pause();
      break;
    case "toggle":
      void controller.toggle();
      break;
    case "seek":
      if (Number.isFinite(action.position)) controller.seek(action.position!);
      break;
    case "next": {
      controller.remoteSkip(1);
      break;
    }
    case "previous": {
      controller.remoteSkip(-1);
    }
  }
}
function recent(
  book: Book,
  file: BookFile,
  anchor?: ReadingAnchor,
): DesktopRecent {
  return {
    bookId: book.id,
    fileId: file.id,
    title: book.title,
    author: book.authors.join(", "),
    kind: readerKindForFile(file),
    progress: anchor?.progress ?? book.progress,
  };
}
/** The native host receives scoped metadata and routes commands to the existing audio owner. */
export function useDesktopSurfaces(
  options: {
    repo: LibraryRepository;
    connected: boolean;
    controller: PlaybackTransport;
    mediaScope: string | null;
    onOpen: (request: Navigation) => void;
    onError: (message: string) => void;
  },
  bridge: DesktopBridge | null = getDesktopBridge(),
) {
  const current = useRef(options);
  current.current = options;
  const recents = useRef<{ scope: string; books: DesktopRecent[] }>({
    scope: options.repo.scope,
    books: [],
  });
  const mounted = useRef(false),
    queue = useRef(Promise.resolve());
  const [revision, setRevision] = useState(0);
  const snapshot = useCallback((): DesktopSnapshot => {
    const { repo, connected, controller, mediaScope } = current.current;
    if (!connected) return { accountScope: null, recents: [], media: null };
    const book = controller.getBook(),
      state = controller.getSnapshot();
    return {
      accountScope: repo.scope,
      recents:
        recents.current.scope === repo.scope ? recents.current.books : [],
      media:
        mediaScope === repo.scope && book && state.bookId === book.bookId
          ? {
              bookId: book.bookId,
              fileId: book.fileId,
              title: book.title,
              author: book.authors.join(", "),
              chapter: book.chapters?.[state.chapterIndex]?.title,
              position: state.currentTime,
              duration: state.duration,
              playing: state.status === "playing",
            }
          : null,
    };
  }, []);
  const publish = useCallback(() => {
    if (!bridge) return;
    queue.current = queue.current
      .then(async () => {
        if (mounted.current) await bridge.publish(snapshot());
      })
      .catch((error) => {
        if (mounted.current)
          current.current.onError(
            error instanceof Error ? error.message : String(error),
          );
      });
  }, [bridge, snapshot]);
  useEffect(() => {
    if (!bridge) return;
    mounted.current = true;
    const listener = bridge.onAction((action) => {
      if (!mounted.current) return;
      const value = current.current;
      if (action.action !== "open" && value.mediaScope !== value.repo.scope)
        return;
      applyDesktopAction(
        action,
        value.connected ? value.repo.scope : null,
        value.controller,
        value.onOpen,
      );
    });
    void listener.catch((error) => {
      if (mounted.current) current.current.onError(String(error));
    });
    // At most two metadata updates per second even while playback ticks faster.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = options.controller.subscribe(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        publish();
      }, 500);
    });
    publish();
    return () => {
      mounted.current = false;
      clearTimeout(timer);
      unsubscribe();
      void listener.then((remove) => remove()).catch(() => {});
      queue.current = queue.current
        .then(() =>
          bridge.publish({ accountScope: null, recents: [], media: null }),
        )
        .catch(() => {});
    };
  }, [bridge, options.controller, publish]);
  useEffect(() => {
    let active = true;
    const { repo, connected } = options;
    recents.current = { scope: repo.scope, books: [] };
    publish();
    if (bridge && connected)
      void (async () => {
        const anchors = (await repo.getAnchors()).sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        );
        const latest = [
          ...new Map(
            anchors
              .slice()
              .reverse()
              .map((anchor) => [anchor.bookId, anchor]),
          ).values(),
        ]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, 20);
        const saved = await Promise.all(
          latest.map(async (anchor) => {
            const book = await repo.getBook(anchor.bookId),
              file = book?.files.find((file) => file.id === anchor.fileId);
            return book && file && !book.id.startsWith("local-")
              ? recent(book, file, anchor)
              : null;
          }),
        );
        if (!active || current.current.repo !== repo) return;
        const existing = recents.current.books;
        recents.current.books = [
          ...existing,
          ...saved.filter(
            (entry): entry is DesktopRecent =>
              !!entry &&
              !existing.some((value) => value.bookId === entry.bookId),
          ),
        ].slice(0, 20);
        publish();
      })().catch((error) => {
        if (active) current.current.onError(String(error));
      });
    return () => {
      active = false;
    };
  }, [bridge, options.repo, options.connected, publish]);
  useEffect(() => {
    publish();
  }, [revision, publish]);
  return useCallback(
    (book: Book, file: BookFile, anchor?: ReadingAnchor) => {
      const { repo, connected } = current.current;
      if (!bridge || !connected || book.id.startsWith("local-")) return;
      const old =
        recents.current.scope === repo.scope ? recents.current.books : [];
      recents.current = {
        scope: repo.scope,
        books: [
          recent(book, file, anchor),
          ...old.filter((value) => value.bookId !== book.id),
        ].slice(0, 20),
      };
      setRevision((value) => value + 1);
    },
    [bridge],
  );
}
