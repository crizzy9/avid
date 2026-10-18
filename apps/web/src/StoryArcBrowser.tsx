import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Layers, Search } from "lucide-react";
import type { LibraryRepository } from "../../../packages/core/src/repository";
import type { Book } from "../../../packages/core/src/types";
import { useI18n } from "../../../packages/i18n/src";
import { CoverContext } from "./CoverContext";
import { BookCard } from "./ui";
import {
  groupStoryArcs,
  loadStoryArcPage,
  STORY_ARC_PAGE_SIZE,
  type StoryArcClient,
} from "./storyArcs";
import { storyArcT as t } from "./storyArcMessages";
import "./StoryArcBrowser.css";

export interface StoryArcBrowserProps {
  client: StoryArcClient | null;
  repo: Pick<LibraryRepository, "scope">;
  books: readonly Book[];
  onBook: (book: Book) => void;
}
export function StoryArcBrowser(props: StoryArcBrowserProps) {
  return <StoryArcs key={props.repo.scope} {...props} />;
}
function StoryArcs({ client, repo, books, onBook }: StoryArcBrowserProps) {
  const { t: common } = useI18n(),
    covers = useContext(CoverContext);
  const [loaded, setLoaded] = useState<{
    client: StoryArcClient;
    books: Book[];
    total: number;
    next: number;
  }>();
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [progress, setProgress] = useState({ count: 0, total: 0 });
  const [selected, setSelected] = useState<
      { name: string } | { ungrouped: true }
    >(),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const request = useRef<AbortController | null>(null),
    owner = useRef({ client, scope: repo.scope });
  owner.current = { client, scope: repo.scope };
  const current = loaded?.client === client ? loaded : undefined;
  useEffect(() => {
    setBusy(false);
    setFailed(false);
    setSelected(undefined);
    setPage(1);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [client, repo.scope]);
  const source = useMemo(() => {
    const rows = new Map(books.map((book) => [book.id, book]));
    for (const detail of current?.books ?? []) {
      const cached = rows.get(detail.id);
      rows.set(
        detail.id,
        cached
          ? { ...detail, ...cached, comicMetadata: detail.comicMetadata }
          : detail,
      );
    }
    return [...rows.values()];
  }, [books, current]);
  const grouped = useMemo(() => groupStoryArcs(source), [source]);
  const groups = grouped.groups.filter((group) =>
    group.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  const selectedBooks = selected
    ? "ungrouped" in selected
      ? grouped.ungrouped
      : (grouped.groups.find((group) => group.name === selected.name)?.books ??
        [])
    : [];
  const count = selected ? selectedBooks.length : groups.length,
    pages = Math.max(1, Math.ceil(count / STORY_ARC_PAGE_SIZE));
  const shownPage = Math.min(page, pages);
  async function load() {
    if (!client || busy) return;
    const abort = new AbortController();
    request.current?.abort();
    request.current = abort;
    const scope = repo.scope,
      active = () =>
        request.current === abort &&
        !abort.signal.aborted &&
        owner.current.client === client &&
        owner.current.scope === scope;
    setBusy(true);
    setFailed(false);
    setProgress({ count: 0, total: STORY_ARC_PAGE_SIZE });
    try {
      const result = await loadStoryArcPage(
        client,
        current?.next ?? 1,
        abort.signal,
        (count, total) => {
          if (active()) setProgress({ count, total });
        },
      );
      if (!active()) return;
      const rows = new Map(
        (current?.books ?? []).map((book) => [book.id, book]),
      );
      for (const book of result.books) rows.set(book.id, book);
      covers?.register(result.books);
      setLoaded({
        client,
        books: [...rows.values()],
        total: result.total,
        next: result.failedIds.length ? result.page : result.page + 1,
      });
      setFailed(result.failedIds.length > 0);
    } catch {
      if (active()) setFailed(true);
    } finally {
      if (active()) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  const hasMore =
    !current || (current.next - 1) * STORY_ARC_PAGE_SIZE < current.total;
  return (
    <section className="story-arcs" aria-label={t("title")}>
      <div className="section-heading">
        <div>
          <h2>
            {selected
              ? "ungrouped" in selected
                ? t("ungrouped")
                : selected.name
              : t("title")}
          </h2>
          <p>{t(selected ? "order" : "hint")}</p>
        </div>
        {selected && (
          <button
            className="text-button"
            onClick={() => {
              setSelected(undefined);
              setPage(1);
            }}
          >
            <ArrowLeft size={16} />
            {t("all")}
          </button>
        )}
      </div>
      {!selected && (
        <>
          <label className="search-box compact">
            <Search size={17} />
            <input
              aria-label={t("search")}
              placeholder={t("search")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {client && (
            <div className="story-arc-index">
              {current && (
                <p>
                  {t("indexed", {
                    count: current.books.length,
                    total: current.total,
                  })}
                </p>
              )}
              {busy ? (
                <>
                  <p role="status">{t("progress", progress)}</p>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      request.current?.abort();
                      request.current = null;
                      setBusy(false);
                    }}
                  >
                    {t("cancel")}
                  </button>
                </>
              ) : (
                (hasMore || failed) && (
                  <button
                    className="secondary-button"
                    onClick={() => void load()}
                  >
                    {t(failed ? "retry" : current ? "more" : "load", {
                      count: STORY_ARC_PAGE_SIZE,
                    })}
                  </button>
                )
              )}
              {failed && <p role="alert">{t("failed")}</p>}
            </div>
          )}
        </>
      )}
      {selected ? (
        <div className="story-arc-books">
          {selectedBooks
            .slice(
              (shownPage - 1) * STORY_ARC_PAGE_SIZE,
              shownPage * STORY_ARC_PAGE_SIZE,
            )
            .map((book) => (
              <div key={book.id}>
                <BookCard book={book} onSelect={onBook} />
                {book.comicMetadata?.issueNumber && (
                  <small>
                    {t("issue", { number: book.comicMetadata.issueNumber })}
                  </small>
                )}
              </div>
            ))}
        </div>
      ) : (
        <>
          <div className="story-arc-groups">
            {groups
              .slice(
                (shownPage - 1) * STORY_ARC_PAGE_SIZE,
                shownPage * STORY_ARC_PAGE_SIZE,
              )
              .map((group) => (
                <button
                  key={group.name}
                  onClick={() => {
                    setSelected({ name: group.name });
                    setPage(1);
                  }}
                >
                  <Layers size={22} />
                  <strong>{group.name}</strong>
                  <small>{t("count", { count: group.books.length })}</small>
                </button>
              ))}
          </div>
          {!groups.length && <p className="muted">{t("empty")}</p>}
          {!!grouped.ungrouped.length && (
            <button
              className="text-button"
              onClick={() => {
                setSelected({ ungrouped: true });
                setPage(1);
              }}
            >
              {t("ungrouped")} ·{" "}
              {t("count", { count: grouped.ungrouped.length })}
            </button>
          )}
        </>
      )}
      {pages > 1 && (
        <nav className="pagination" aria-label={t("title")}>
          <button
            className="secondary-button"
            disabled={shownPage === 1}
            onClick={() => setPage(shownPage - 1)}
          >
            {common("common.previous")}
          </button>
          <span>
            {common("common.page", { page: shownPage, total: pages })}
          </span>
          <button
            className="secondary-button"
            disabled={shownPage === pages}
            onClick={() => setPage(shownPage + 1)}
          >
            {common("common.next")}
          </button>
        </nav>
      )}
    </section>
  );
}
