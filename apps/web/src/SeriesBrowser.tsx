import { useI18n } from "../../../packages/i18n/src";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Layers,
  LoaderCircle,
  Search,
} from "lucide-react";
import {
  BookOrbitClient,
  type SeriesSummary,
} from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";
import { BookCard } from "./ui";

export function SeriesBrowser({
  client,
  onBook,
}: {
  client: BookOrbitClient;
  onBook: (book: Book) => void;
}) {
  const { t, locale, setLocale } = useI18n();

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<SeriesSummary | null>(null);
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setSelected(null);
    setPage(1);
    setQuery("");
  }, [client]);
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    setBusy(true);
    setError("");
    setBooks([]);
    setSeries([]);
    setTotal(0);
    const timer = setTimeout(
      () => {
        async function load() {
          try {
            if (selected) {
              const result = await client.getSeriesBooks(
                selected.id,
                page,
                24,
                abort.signal,
              );
              if (abort.signal.aborted) return;
              setTotal(result.total);
              setBooks(
                result.items.map((book) => ({ ...book, coverUrl: undefined })),
              );
              let cursor = 0;
              await Promise.all(
                Array.from({ length: 4 }, async () => {
                  while (
                    cursor < result.items.length &&
                    !abort.signal.aborted
                  ) {
                    const book = result.items[cursor++];
                    if (!book.coverUrl) continue;
                    try {
                      const blob = await client.coverBlob(
                        book.id,
                        abort.signal,
                      );
                      if (abort.signal.aborted) return;
                      const url = URL.createObjectURL(blob);
                      urls.push(url);
                      setBooks((previous) =>
                        previous.map((item) =>
                          item.id === book.id
                            ? { ...item, coverUrl: url }
                            : item,
                        ),
                      );
                    } catch {
                      /* A text cover remains useful when one cover cannot load. */
                    }
                  }
                }),
              );
            } else {
              const result = await client.listSeries(
                { page, size: 24, query },
                abort.signal,
              );
              if (!abort.signal.aborted) {
                setSeries(result.items);
                setTotal(result.total);
              }
            }
          } catch (e) {
            if (!abort.signal.aborted)
              setError(e instanceof Error ? e.message : t("series.failed"));
          } finally {
            if (!abort.signal.aborted) setBusy(false);
          }
        }
        void load();
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
      urls.forEach(URL.revokeObjectURL);
    };
  }, [client, selected, page, query, retry]);
  return (
    <section className="series-browser">
      <div className="section-heading">
        <div>
          <h2>{selected?.name ?? t("browse.series")}</h2>
          <p>
            {selected
              ? t("series.summary", {
                  books: selected.bookCount,
                  finished: selected.readCount,
                })
              : t("series.hint")}
          </p>
        </div>
        {selected && (
          <button
            className="text-button"
            onClick={() => {
              setSelected(null);
              setPage(1);
            }}
          >
            <ArrowLeft size={16} />
            {t("series.all")}
          </button>
        )}
      </div>
      {!selected && (
        <div className="search-box compact">
          <Search size={17} />
          <input
            aria-label={t("series.search")}
            placeholder={t("series.searchHint")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setRetry((value) => value + 1)}>
            {t("common.tryAgain")}
          </button>
        </div>
      )}
      {busy && !books.length && !series.length ? (
        <p className="loading-label" role="status">
          <LoaderCircle className="spin" size={17} />
          {t("series.loading")}
        </p>
      ) : selected ? (
        <div className="book-grid">
          {books.map((book) => (
            <div key={book.id}>
              <BookCard book={book} onSelect={onBook} />
              <small className="series-volume">
                {book.seriesIndex !== undefined
                  ? t("series.volume", { number: book.seriesIndex })
                  : t("series.unnumbered")}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <div className="series-card-grid">
          {series.map((item) => (
            <button
              className="series-card"
              key={item.id}
              onClick={() => {
                setSelected(item);
                setPage(1);
              }}
            >
              <Layers size={25} />
              <strong>{item.name}</strong>
              <span>{item.authors.join(", ")}</span>
              <small>
                {t("series.summary", {
                  books: item.bookCount,
                  finished: item.readCount,
                })}
                {item.gapCount
                  ? ` · ${t("series.gaps", { count: item.gapCount })}`
                  : ""}
              </small>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      )}
      {!busy && !error && total === 0 && (
        <p className="muted">{t("series.none")}</p>
      )}
      {total > 24 && (
        <div className="pagination">
          <button
            className="secondary-button"
            disabled={page === 1 || busy}
            onClick={() => setPage((value) => value - 1)}
          >
            <ChevronLeft size={16} />
            {t("common.previous")}
          </button>
          <span>
            {t("common.page", { page, total: Math.ceil(total / 24) })}
          </span>
          <button
            className="secondary-button"
            disabled={page * 24 >= total || busy}
            onClick={() => setPage((value) => value + 1)}
          >
            {t("common.next")}
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </section>
  );
}
