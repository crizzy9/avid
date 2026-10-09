import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOrbitClient,
  type BookQuery,
} from "../../../packages/core/src/bookorbit";
import {
  AvidDatabase,
  LibraryRepository,
} from "../../../packages/core/src/repository";
import { SyncCoordinator } from "../../../packages/core/src/sync";
import type {
  Annotation,
  Book,
  Collection,
  ReadingAnchor,
  ReadingSession,
  Session,
} from "../../../packages/core/src/types";
import { demoBooks, demoCollections } from "./fixtures";
import { bookOrbitFetch, proxyBaseFor } from "./Connect";
import { BookCoverCache } from "./coverCache";

const db = new AvidDatabase();
const demoSession: Session = {
  profile: {
    id: "demo",
    name: "Sample library",
    url: "https://demo.avid.invalid",
  },
  accessToken: "",
  userId: "demo",
};
type LibraryQuery = Pick<
  BookQuery,
  "query" | "sort" | "direction" | "page" | "media" | "readStatuses"
> & { collectionId?: string };
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
const serverResource = (id: string) =>
  /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;

export function useLibrary() {
  const [client, setClient] = useState<BookOrbitClient | null>(null);
  const [repo, setRepo] = useState(
    () => new LibraryRepository(db, demoSession),
  );
  const [books, setBooks] = useState<Book[]>(demoBooks);
  const [collections, setCollections] = useState<Collection[]>(demoCollections);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [sessions, setSessions] = useState<ReadingSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(demoBooks.length);
  const [syncStatus, setSyncStatus] = useState("On this device");
  const context = useRef({ repo, client });
  const mounted = useRef(true);
  const connectionAttempt = useRef(0);
  const queryAttempt = useRef(0);
  const queryAbort = useRef<AbortController | null>(null);
  const annotationRead = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [coverCache, setCoverCache] = useState<BookCoverCache | null>(null);
  const coverStore = useRef<BookCoverCache | null>(null);
  const localProgress = useRef(new Map<string, ReadingAnchor>());
  const isCurrent = useCallback(
    (repository: LibraryRepository, activeClient: BookOrbitClient | null) =>
      mounted.current &&
      context.current.repo === repository &&
      context.current.client === activeClient,
    [],
  );
  const coordinator = useMemo(
    () =>
      client
        ? new SyncCoordinator(repo, client, {
            isActive: () => isCurrent(repo, client),
          })
        : null,
    [repo, client, isCurrent],
  );

  const clearMedia = useCallback(() => {
    coverStore.current?.dispose();
    coverStore.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connectionAttempt.current++;
      queryAbort.current?.abort();
      clearMedia();
    };
  }, [clearMedia]);
  useEffect(() => {
    let active = true;
    const notesRead = ++annotationRead.current;
    Promise.all([
      repo.getBooks(),
      repo.getAnnotations(),
      repo.getSessions(),
      repo.getCollections(),
    ])
      .then(async ([saved, notes, activity, shelves]) => {
        if (!active || !isCurrent(repo, client)) return;
        if (!client) {
          if (!saved.length) await repo.putBooks(demoBooks);
          if (!shelves.length) await repo.putCollections(demoCollections);
          if (!active || !isCurrent(repo, client)) return;
          setBooks(saved.length ? saved : demoBooks);
          setCollections(shelves.length ? shelves : demoCollections);
          setTotal(saved.length || demoBooks.length);
        }
        if (notesRead === annotationRead.current) setAnnotations(notes);
        setSessions(activity);
      })
      .catch((cause) => {
        if (active && isCurrent(repo, client))
          setError(
            `Local storage is unavailable: ${message(cause, "Unknown storage error")}`,
          );
      });
    return () => {
      active = false;
    };
  }, [repo, client, isCurrent]);

  const presentPage = useCallback((items: Book[], append: boolean) => {
    coverStore.current?.register(items);
    const presented = items.map((book) => {
      const anchor = localProgress.current.get(book.id);
      return {
        ...book,
        ...(anchor
          ? {
              progress: anchor.progress,
              status:
                anchor.progress >= 0.995
                  ? ("finished" as const)
                  : ("reading" as const),
            }
          : {}),
      };
    });
    setBooks((previous) =>
      append
        ? [
            ...new Map(
              [...previous, ...presented].map((book) => [book.id, book]),
            ).values(),
          ]
        : presented,
    );
  }, []);

  const connect = useCallback(
    async (session: Session, readOnly: boolean) => {
      const attempt = ++connectionAttempt.current;
      const nextClient = new BookOrbitClient(session, {
        readOnly,
        fetch: bookOrbitFetch,
        transportBaseUrl: proxyBaseFor(session.profile.url),
      });
      const nextRepo = new LibraryRepository(db, session);
      const [page, shelves, notes, activity] = await Promise.all([
        nextClient.listBooks({ size: 48 }),
        nextClient.listCollections(),
        nextRepo.getAnnotations(),
        nextRepo.getSessions(),
      ]);
      if (!mounted.current || attempt !== connectionAttempt.current) return;
      try {
        const info = await nextClient.getServerInfo();
        // Discovery may refresh the token; preserve that newer session.
        nextClient.session = {
          ...nextClient.session,
          profile: { ...nextClient.session.profile, version: info.version },
        };
      } catch {
        /* Older servers may not expose version discovery. */
      }
      if (!mounted.current || attempt !== connectionAttempt.current) return;
      await Promise.all([
        nextRepo.putBooks(page.items),
        nextRepo.putCollections(shelves),
      ]);
      if (!mounted.current || attempt !== connectionAttempt.current) return;
      queryAttempt.current++;
      queryAbort.current?.abort();
      clearMedia();
      localProgress.current.clear();
      context.current = { repo: nextRepo, client: nextClient };
      const nextCovers = new BookCoverCache((id, signal) =>
        nextClient.coverBlob(id, signal),
      );
      coverStore.current = nextCovers;
      setCoverCache(nextCovers);
      setClient(nextClient);
      setRepo(nextRepo);
      presentPage(page.items, false);
      setCollections(shelves);
      setAnnotations(notes);
      setSessions(activity);
      setTotal(page.total);
      setError("");
      setLoading(false);
      setSyncStatus(readOnly ? "Read-only server" : "Connected");
    },
    [clearMedia, presentPage],
  );
  const disconnect = useCallback(() => {
    connectionAttempt.current++;
    queryAttempt.current++;
    queryAbort.current?.abort();
    clearMedia();
    localProgress.current.clear();
    const nextRepo = new LibraryRepository(db, demoSession);
    context.current = { repo: nextRepo, client: null };
    setCoverCache(null);
    setClient(null);
    setRepo(nextRepo);
    setBooks(demoBooks);
    setAnnotations([]);
    setSessions([]);
    setCollections(demoCollections);
    setTotal(demoBooks.length);
    setSyncStatus("On this device");
    setError("");
    setLoading(false);
  }, [clearMedia]);
  const query = useCallback(
    async (options: LibraryQuery, signal?: AbortSignal) => {
      if (!client || !isCurrent(repo, client) || signal?.aborted) return;
      const attempt = ++queryAttempt.current;
      queryAbort.current?.abort();
      const abort = new AbortController();
      queryAbort.current = abort;
      const cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const current = () =>
        isCurrent(repo, client) && attempt === queryAttempt.current;
      setLoading(true);
      setError("");
      try {
        const page = options.collectionId
          ? await client.getCollectionBooks(
              options.collectionId,
              options.page ?? 1,
              48,
              options,
              abort.signal,
            )
          : await client.listBooks({ ...options, size: 48 }, abort.signal);
        if (!current() || abort.signal.aborted) return;
        await repo.putBooks(page.items);
        if (!current() || abort.signal.aborted) return;
        presentPage(page.items, (options.page ?? 1) > 1);
        setTotal(page.total);
      } catch (cause) {
        if (current() && !abort.signal.aborted)
          setError(message(cause, "Could not load the library."));
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (current()) setLoading(false);
      }
    },
    [client, repo, isCurrent, presentPage],
  );

  const flush = useCallback(async () => {
    if (!client || client.readOnly || !coordinator || !isCurrent(repo, client))
      return;
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setSyncStatus("Syncing…");
    try {
      const result = await coordinator.flush();
      if (!isCurrent(repo, client)) return;
      const notesRead = ++annotationRead.current;
      const [pending, notes] = await Promise.all([
        repo.pendingOperations(),
        repo.getAnnotations(),
      ]);
      if (!isCurrent(repo, client)) return;
      if (notesRead === annotationRead.current) setAnnotations(notes);
      setSyncStatus(
        result.conflicts || pending.some((item) => item.status === "conflict")
          ? "Needs review"
          : result.failed || pending.some((item) => item.status === "failed")
            ? "Sync failed"
            : pending.length
              ? "Changes pending"
              : "Synced",
      );
      // Reconnecting can precede an operation's backoff deadline. Keep it
      // pending and retry when eligible, without forcing a duplicate write.
      const retryAt = pending
        .filter(
          (operation) => !["conflict", "failed"].includes(operation.status),
        )
        .map((operation) =>
          Math.max(
            Date.parse(operation.nextAttemptAt ?? "") || 0,
            operation.status === "syncing"
              ? Date.parse(operation.leaseUntil ?? "") || 0
              : 0,
            // A previous connection's in-flight coordinator may have stopped
            // just before this connection joined it; retry its released work.
            Date.now() + 1000,
          ),
        )
        .sort((a, b) => a - b)[0];
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      if (retryAt !== undefined)
        retryTimer.current = setTimeout(
          () => {
            retryTimer.current = null;
            void flush();
          },
          Math.min(2_147_483_647, Math.max(1, retryAt - Date.now())),
        );
    } catch (cause) {
      if (isCurrent(repo, client)) {
        setSyncStatus("Sync failed");
        setError(
          message(cause, "Changes are saved locally; synchronization failed."),
        );
      }
    }
  }, [client, coordinator, repo, isCurrent]);
  useEffect(() => {
    if (!client || client.readOnly) return;
    const retry = () => {
      void flush();
    };
    retry();
    window.addEventListener("online", retry);
    return () => {
      window.removeEventListener("online", retry);
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [client, flush]);
  const localOnly = useCallback(
    (bookId: string, fileId: string) =>
      !client ||
      client.readOnly ||
      !serverResource(bookId) ||
      !serverResource(fileId),
    [client],
  );
  const saveAnchor = useCallback(
    async (anchor: ReadingAnchor) => {
      try {
        await repo.checkpoint(anchor, {
          readOnly: localOnly(anchor.bookId, anchor.fileId),
        });
        const stored = await repo.getAnchor(anchor);
        if (!stored || !isCurrent(repo, client)) return;
        const current = localProgress.current.get(anchor.bookId);
        if (
          !current ||
          Date.parse(current.updatedAt) <= Date.parse(stored.updatedAt)
        ) {
          localProgress.current.set(anchor.bookId, stored);
          setBooks((previous) =>
            previous.map((book) =>
              book.id === anchor.bookId
                ? {
                    ...book,
                    progress: stored.progress,
                    status: stored.progress >= 0.995 ? "finished" : "reading",
                  }
                : book,
            ),
          );
        }
        await flush();
      } catch (cause) {
        if (isCurrent(repo, client))
          setError(message(cause, "Position could not be saved."));
      }
    },
    [repo, client, localOnly, isCurrent, flush],
  );
  const refreshAnnotations = useCallback(async () => {
    if (!isCurrent(repo, client)) return;
    const notesRead = ++annotationRead.current;
    const notes = await repo.getAnnotations();
    if (isCurrent(repo, client) && notesRead === annotationRead.current)
      setAnnotations(notes);
  }, [repo, client, isCurrent]);
  const saveAnnotation = useCallback(
    async (annotation: Annotation) => {
      await repo.putAnnotation(annotation, {
        readOnly: localOnly(annotation.bookId, annotation.fileId),
      });
      await refreshAnnotations();
      await flush();
    },
    [repo, localOnly, refreshAnnotations, flush],
  );
  const recordSession = useCallback(
    async (
      activity: ReadingSession,
      fileId: string,
      options?: { endedAt: string },
    ) => {
      await repo.recordSession(activity, fileId, {
        readOnly: localOnly(activity.bookId, fileId),
        endedAt: options?.endedAt,
      });
      const activityRows = await repo.getSessions();
      if (!isCurrent(repo, client)) return;
      setSessions(activityRows);
      await flush();
    },
    [repo, client, localOnly, isCurrent, flush],
  );
  const updateDemoBook = useCallback(
    async (book: Book) => {
      if (client) return;
      await repo.putBooks([book]);
      if (isCurrent(repo, client))
        setBooks((previous) =>
          previous.map((item) => (item.id === book.id ? book : item)),
        );
    },
    [repo, client, isCurrent],
  );
  const saveCollections = useCallback(
    async (next: Collection[]) => {
      if (client) return;
      await repo.putCollections(next);
      if (isCurrent(repo, client)) setCollections(next);
    },
    [repo, client, isCurrent],
  );
  const createCollection = useCallback(
    async (name: string) => {
      const title = name.trim();
      if (!title) throw new Error("Enter a collection name.");
      const created = client
        ? await client.createCollection({ name: title })
        : { id: crypto.randomUUID(), name: title, bookIds: [] };
      const next = client
        ? await client.listCollections()
        : [...(await repo.getCollections()), created];
      await repo.putCollections(next);
      if (isCurrent(repo, client)) setCollections(next);
      return created;
    },
    [repo, client, isCurrent],
  );
  return {
    client,
    repo,
    coverCache,
    books,
    setBooks,
    collections,
    annotations,
    sessions,
    loading,
    error,
    setError,
    total,
    syncStatus,
    connect,
    disconnect,
    query,
    saveAnchor,
    saveAnnotation,
    recordSession,
    updateDemoBook,
    saveCollections,
    createCollection,
    refreshAnnotations,
  };
}
