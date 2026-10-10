import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  LoaderCircle,
} from "lucide-react";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { LibraryRepository } from "../../../packages/core/src/repository";
import type { Book } from "../../../packages/core/src/types";
import { useI18n } from "../../../packages/i18n/src";
import { CoverContext } from "./CoverContext";
import { BookCard } from "./ui";
import {
  loadReferenceLibraryShelves,
  partitionReferenceBooks,
  REFERENCE_SHELF_LIMIT,
  type ReferenceLibraryShelves,
  type ReferenceMedia,
} from "./referenceLibraryData";
import "./ReferenceLibrary.css";

const media: ReferenceMedia[] = ["audio", "books", "comics"];

/** Compact two-row shelves; the full catalog retains its existing virtualized browser. */
export function ReferenceLibrary({
  books,
  client,
  repo,
  enabled,
  resetKey,
  onBrowse,
  onSelect,
  onError,
  children,
}: {
  books: readonly Book[];
  client: Pick<BookOrbitClient, "listBooks"> | null;
  repo: Pick<LibraryRepository, "putBooks">;
  enabled: boolean;
  resetKey?: number;
  onBrowse: (media: ReferenceMedia | "all") => void;
  onSelect: (book: Book) => void;
  onError: (message: string) => void;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const coverCache = useContext(CoverContext);
  const [drilled, setDrilled] = useState(false);
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    repo: typeof repo;
    shelves: ReferenceLibraryShelves;
  }>();
  const [pending, setPending] = useState(false);
  const callbacks = useRef({ onBrowse, onError });
  callbacks.current = { onBrowse, onError };
  const partitions = useMemo(() => partitionReferenceBooks(books), [books]);

  useEffect(() => {
    setDrilled(false);
    if (enabled) callbacks.current.onBrowse("all");
  }, [enabled, client, repo, resetKey]);

  useEffect(() => {
    if (!enabled || drilled || !client) return;
    const abort = new AbortController();
    setPending(true);
    void loadReferenceLibraryShelves(client, abort.signal)
      .then(async (shelves) => {
        abort.signal.throwIfAborted();
        const unique = [
          ...new Map(
            media
              .flatMap((kind) => shelves[kind].books)
              .map((book) => [book.id, book]),
          ).values(),
        ];
        // Metadata stays available for later progress restoration; cover registration fetches no images.
        await repo.putBooks(unique);
        abort.signal.throwIfAborted();
        coverCache?.register(unique);
        setLoaded({ client, repo, shelves });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          callbacks.current.onError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setPending(false);
      });
    return () => abort.abort();
  }, [client, repo, coverCache, enabled, drilled]);

  const browse = (kind: ReferenceMedia) => {
    setDrilled(true);
    onBrowse(kind);
  };
  if (!enabled) return children;
  if (drilled)
    return (
      <div className="reference-library-drill">
        <button
          className="reference-library-back"
          onClick={() => {
            setDrilled(false);
            onBrowse("all");
          }}
        >
          <ArrowLeft size={16} />
          {t("library.title")}
        </button>
        {children}
      </div>
    );

  const labels = {
    audio: t("library.audiobooks"),
    books: t("library.books"),
    comics: t("library.comics"),
  };
  return (
    <div className="reference-library" aria-label={t("library.title")}>
      {pending && client && (
        <span className="reference-library-loading" role="status">
          <LoaderCircle size={12} className="spin" />
          {t("library.loading")}
        </span>
      )}
      {media.map((kind) => {
        const remote =
          client && loaded?.client === client && loaded.repo === repo
            ? loaded.shelves[kind]
            : undefined;
        const local = partitions[kind].filter((book) =>
          book.id.startsWith("local-"),
        );
        const rows = remote
          ? [
              ...new Map(
                [...remote.books, ...local].map((book) => [book.id, book]),
              ).values(),
            ]
          : partitions[kind];
        const current = new Map(
          partitions[kind].map((book) => [book.id, book]),
        );
        const shown = rows
          .slice(0, REFERENCE_SHELF_LIMIT)
          .map((book) => current.get(book.id) ?? book);
        const count =
          remote && Number.isSafeInteger(remote.total) && remote.total >= 0
            ? remote.total +
              local.filter(
                (book) => !remote.books.some((row) => row.id === book.id),
              ).length
            : client
              ? undefined
              : partitions[kind].length;
        const heading = `reference-library-${kind}`;
        return (
          <section
            className={`reference-library-shelf reference-library-${kind}`}
            aria-labelledby={heading}
            key={kind}
          >
            <header className="reference-library-heading">
              <h2 id={heading}>{labels[kind]}</h2>
              <button
                className="reference-library-see-all"
                onClick={() => browse(kind)}
                aria-label={`${t("common.seeAll")} ${labels[kind]}`}
              >
                {t("common.seeAll")}
                {count !== undefined && (
                  <span>{new Intl.NumberFormat(locale).format(count)}</span>
                )}
                <ChevronRight size={10} />
              </button>
            </header>
            <div
              className="reference-library-scroll"
              tabIndex={0}
              aria-label={labels[kind]}
            >
              <div
                className="reference-library-track"
                role="list"
                style={
                  {
                    "--reference-columns": Math.max(
                      1,
                      Math.ceil((shown.length + 1) / 2),
                    ),
                  } as CSSProperties
                }
              >
                {shown.map((book) => (
                  <div role="listitem" key={book.id}>
                    <BookCard book={book} onSelect={onSelect} />
                  </div>
                ))}
                <div role="listitem">
                  <button
                    className="reference-library-more"
                    onClick={() => browse(kind)}
                    aria-label={`${t("common.seeAll")} ${labels[kind]}`}
                  >
                    <ArrowRight size={16} />
                    <span>{t("common.seeAll")}</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
