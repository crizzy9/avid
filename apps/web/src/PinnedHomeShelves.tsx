import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Pin,
  X,
} from "lucide-react";
import type { Book, Collection } from "../../../packages/core/src/types";
import { useI18n } from "../../../packages/i18n/src";
import { BookCard } from "./ui";
import { CoverContext } from "./CoverContext";
import {
  changeHomePins,
  HOME_PIN_LIMIT,
  HomePinError,
  homePinKey,
  homePinOptions,
  loadHomePins,
  loadPinnedBooks,
  type HomePin,
  type HomePinClient,
  type HomePinRepository,
  type NamedHomePin,
} from "./homePins";
import { homePinT as t, type HomePinMessageKey } from "./homePinMessages";
import "./PinnedHomeShelves.css";

export interface PinnedHomeShelvesProps {
  client: HomePinClient | null;
  repo: HomePinRepository;
  collections: readonly Collection[];
  books: readonly Book[];
  onSelect: (book: Book) => void;
  revision?: number;
}

/** Device preferences and read-only library queries; never a server mutation. */
export function PinnedHomeShelves(props: PinnedHomeShelvesProps) {
  return <HomePins key={props.repo.scope} {...props} />;
}

function HomePins(props: PinnedHomeShelvesProps) {
  useI18n();
  const { client, repo, collections } = props;
  const [manage, setManage] = useState(false);
  const [drilled, setDrilled] = useState<HomePin>();
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HomePinMessageKey>();
  const [loaded, setLoaded] = useState<{
    repo: HomePinRepository;
    client: HomePinClient | null;
    pins: HomePin[];
    scopes: { id: string; name: string }[];
    ready: boolean;
  }>();
  const active = useRef({ client, repo });
  active.current = { client, repo };
  const current =
    loaded?.repo === repo && loaded.client === client ? loaded : undefined;
  const pins = current?.pins ?? [];
  const options = useMemo(
    () => homePinOptions(collections, current?.scopes ?? []),
    [collections, current?.scopes],
  );
  const byKey = new Map(options.map((item) => [homePinKey(item), item]));

  useEffect(() => {
    let live = true;
    setLoading(true);
    setBusy(false);
    setError(undefined);
    void Promise.allSettled([
      loadHomePins(repo),
      client?.listSmartScopes() ?? Promise.resolve([]),
    ]).then(([preferences, scopes]) => {
      if (!live) return;
      setLoaded({
        repo,
        client,
        ready: preferences.status === "fulfilled",
        pins: preferences.status === "fulfilled" ? preferences.value : [],
        scopes: scopes.status === "fulfilled" ? scopes.value : [],
      });
      setError(
        preferences.status === "rejected"
          ? preferences.reason instanceof HomePinError
            ? "invalid"
            : "loadError"
          : scopes.status === "rejected"
            ? "loadError"
            : undefined,
      );
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [repo, client, retry]);

  const change = async (operation: Parameters<typeof changeHomePins>[1]) => {
    if (!current?.ready || loading) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await changeHomePins(repo, operation);
      if (active.current.repo === repo && active.current.client === client)
        setLoaded((previous) =>
          previous?.repo === repo && previous.client === client
            ? { ...previous, pins: next }
            : previous,
        );
    } catch (cause) {
      if (active.current.repo === repo && active.current.client === client)
        setError(cause instanceof HomePinError ? cause.code : "saveError");
    } finally {
      if (active.current.repo === repo && active.current.client === client)
        setBusy(false);
    }
  };
  const named = (pin: HomePin): NamedHomePin =>
    byKey.get(homePinKey(pin)) ?? { ...pin, name: t("unavailable") };
  const selected = drilled && byKey.get(homePinKey(drilled));
  if (drilled)
    return (
      <section className="home-pins" aria-label={t("title")}>
        <button className="text-button" onClick={() => setDrilled(undefined)}>
          <ArrowLeft size={16} />
          {t("back")}
        </button>
        {selected ? (
          <PinnedBooks
            key={homePinKey(selected)}
            {...props}
            pin={selected}
            expanded
          />
        ) : (
          <p>{t("unavailable")}</p>
        )}
      </section>
    );

  return (
    <section className="home-pins" aria-label={t("title")}>
      <div className="section-heading">
        <h2>{t("title")}</h2>
        <button
          className="text-button"
          aria-expanded={manage}
          onClick={() => setManage(!manage)}
        >
          <Pin size={15} />
          {t(manage ? "done" : "manage")}
        </button>
      </div>
      {loading && <p role="status">{t("loading")}</p>}
      {error && (
        <div className="home-pins-error" role="alert">
          <span>{t(error, { count: HOME_PIN_LIMIT })}</span>
          <button
            className="text-button"
            disabled={loading || busy}
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {manage && (
        <div className="home-pins-manager">
          <p>{t("hint")}</p>
          <ol>
            {pins.map((pin, index) => {
              const item = named(pin);
              return (
                <li key={homePinKey(pin)}>
                  <span>
                    {item.name}
                    <small>{t(pin.kind)}</small>
                  </span>
                  <div className="home-pin-controls">
                    <button
                      disabled={busy || loading || index === 0}
                      aria-label={t("up", { name: item.name })}
                      onClick={() =>
                        void change({ type: "move", pin, direction: -1 })
                      }
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      disabled={busy || loading || index === pins.length - 1}
                      aria-label={t("down", { name: item.name })}
                      onClick={() =>
                        void change({ type: "move", pin, direction: 1 })
                      }
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button
                      disabled={busy || loading}
                      aria-label={t("unpin", { name: item.name })}
                      onClick={() => void change({ type: "unpin", pin })}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          {!pins.length && !loading && <p>{t("empty")}</p>}
          <h3>{t("available")}</h3>
          <div className="home-pin-options">
            {options
              .filter(
                (item) =>
                  !pins.some((pin) => homePinKey(pin) === homePinKey(item)),
              )
              .map((item) => (
                <button
                  key={homePinKey(item)}
                  className="secondary-button"
                  disabled={
                    !current?.ready ||
                    loading ||
                    busy ||
                    pins.length >= HOME_PIN_LIMIT
                  }
                  aria-label={t("pin", { name: item.name })}
                  onClick={() => void change({ type: "pin", pin: item })}
                >
                  <Pin size={14} />
                  <span>
                    {item.name}
                    <small>{t(item.kind)}</small>
                  </span>
                </button>
              ))}
          </div>
          {options.every((item) =>
            pins.some((pin) => homePinKey(pin) === homePinKey(item)),
          ) &&
            !loading && <p>{t("none")}</p>}
          {pins.length >= HOME_PIN_LIMIT && (
            <p role="status">{t("limit", { count: HOME_PIN_LIMIT })}</p>
          )}
        </div>
      )}
      {!manage && !pins.length && !loading && current?.ready && (
        <p className="muted">{t("empty")}</p>
      )}
      {pins.map((pin) => {
        const item = byKey.get(homePinKey(pin));
        return item ? (
          <PinnedBooks
            key={homePinKey(pin)}
            {...props}
            pin={item}
            onOpen={() => setDrilled(pin)}
          />
        ) : (
          <p key={homePinKey(pin)} className="muted">
            {t("unavailable")}
          </p>
        );
      })}
    </section>
  );
}

function PinnedBooks({
  pin,
  client,
  repo,
  collections,
  books,
  revision,
  onSelect,
  expanded,
  onOpen,
}: PinnedHomeShelvesProps & {
  pin: NamedHomePin;
  expanded?: boolean;
  onOpen?: () => void;
}) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<{
    client: HomePinClient | null;
    repo: HomePinRepository;
    page: number;
    items: Book[];
    total: number;
  }>();
  const coverCache = useContext(CoverContext);
  const size = expanded ? 40 : 12;
  const localBooks = client ? undefined : books;
  const localCollections = client ? undefined : collections;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(false);
    void loadPinnedBooks(
      pin,
      client,
      localCollections ?? [],
      localBooks ?? [],
      page,
      size,
      abort.signal,
    )
      .then((value) => {
        if (abort.signal.aborted) return;
        coverCache?.register(value.items);
        setResult({
          client,
          repo,
          page,
          items: value.items,
          total: value.total,
        });
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [
    pin.kind,
    pin.id,
    client,
    repo,
    localCollections,
    localBooks,
    page,
    size,
    revision,
    retry,
    coverCache,
  ]);
  const current =
    result?.client === client && result.repo === repo && result.page === page
      ? result
      : undefined;
  const currentBooks = new Map(books.map((book) => [book.id, book]));
  const rows =
    current?.items.map((book) => currentBooks.get(book.id) ?? book) ?? [];
  return (
    <section className="shelf home-pinned-shelf">
      <div className="section-heading">
        <h3>
          {onOpen ? (
            <button
              className="home-pin-heading"
              aria-label={t("open", { name: pin.name })}
              onClick={onOpen}
            >
              {pin.name}
              <ChevronRight size={17} />
            </button>
          ) : (
            pin.name
          )}
        </h3>
        <small>{t(pin.kind)}</small>
      </div>
      {loading && <p role="status">{t("loading")}</p>}
      {error && (
        <div className="home-pins-error" role="alert">
          <span>{t("loadError")}</span>
          <button
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {!loading && !error && !rows.length && (
        <p className="muted">{t("noBooks")}</p>
      )}
      <div
        className={expanded ? "home-pin-book-grid" : "shelf-track"}
        aria-busy={loading}
      >
        {rows.map((book) => (
          <BookCard key={book.id} book={book} onSelect={onSelect} />
        ))}
      </div>
      {expanded && (
        <nav className="home-pin-pages" aria-label={pin.name}>
          <button
            className="secondary-button"
            disabled={loading || page === 1}
            onClick={() => setPage((value) => value - 1)}
          >
            {t("previous")}
          </button>
          <span>{t("page", { page })}</span>
          <button
            className="secondary-button"
            disabled={loading || !current || page * size >= current.total}
            onClick={() => setPage((value) => value + 1)}
          >
            {t("next")}
          </button>
        </nav>
      )}
    </section>
  );
}
