import { useEffect, useRef, useState } from "react";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import {
  bookRequestWork,
  missingBookRequestMedia,
  type BookRequestCapabilities,
  type BookRequestAvailability,
  type BookRequestItem,
  type BookRequestPage,
  type BookRequestSubmitResult,
  type BookRequestMediaKind,
} from "../../../packages/core/src/bookRequests";
import type { Book } from "../../../packages/core/src/types";
import { useI18n } from "../../../packages/i18n/src";
import { formatRequestT as t } from "./formatRequestMessages";
import "./BookFormatRequests.css";
export interface BookFormatRequestsProps {
  client: BookOrbitClient | null;
  book?: Book;
  onOpenBook?: (id: string) => void;
}
export function BookFormatRequests(props: BookFormatRequestsProps) {
  const { client, book } = props;
  if (
    book &&
    (!missingBookRequestMedia(book) ||
      !/^\d+$/.test(book.id) ||
      !Number.isSafeInteger(Number(book.id)) ||
      Number(book.id) < 1)
  )
    return null;
  return (
    <RequestForm
      key={JSON.stringify([client?.baseUrl, client?.session.userId, book?.id])}
      {...props}
    />
  );
}
function RequestForm({ client, book, onOpenBook }: BookFormatRequestsProps) {
  useI18n();
  const [cap, setCap] = useState<{
      client: BookOrbitClient;
      value: BookRequestCapabilities;
    }>(),
    [title, setTitle] = useState(book?.title ?? ""),
    [authors, setAuthors] = useState(book?.authors.join("\n") ?? ""),
    [note, setNote] = useState(""),
    [kind, setKind] = useState<BookRequestMediaKind | "both">("ebook");
  const [availability, setAvailability] = useState<BookRequestAvailability[]>(),
    [results, setResults] = useState<BookRequestSubmitResult[]>(),
    [list, setList] = useState<BookRequestPage>(),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState<"checking" | "sending" | null>("checking"),
    [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null),
    pending = useRef(false),
    owner = useRef(client);
  owner.current = client;
  const missing = book ? missingBookRequestMedia(book) : null,
    selected = book ? missing : kind,
    currentCap = cap?.client === client ? cap.value : undefined;
  useEffect(() => {
    const abort = new AbortController();
    operation.current?.abort();
    operation.current = abort;
    setCap(undefined);
    setList(undefined);
    setAvailability(undefined);
    setResults(undefined);
    setError("");
    pending.current = true;
    setBusy("checking");
    if (client)
      void client
        .getBookRequestCapabilities(abort.signal)
        .then(async (value) => {
          if (abort.signal.aborted || owner.current !== client) return;
          setCap({ client, value });
          if (!book && value.available) {
            const next = await client.listBookRequests(
              { size: 20, groupPairs: value.pairs },
              abort.signal,
            );
            if (!abort.signal.aborted && owner.current === client)
              setList(next);
          }
        })
        .catch((e) => {
          if (!abort.signal.aborted && owner.current === client)
            setError(String(e.message ?? e));
        })
        .finally(() => {
          if (!abort.signal.aborted) {
            setBusy(null);
            pending.current = false;
          }
        });
    else {
      setBusy(null);
      pending.current = false;
    }
    return () => {
      abort.abort();
      operation.current?.abort();
      pending.current = false;
    };
  }, [client, book?.id]);
  function changed() {
    setAvailability(undefined);
    setResults(undefined);
    setError("");
  }
  function start(mode: "checking" | "sending") {
    if (!client || pending.current) return;
    pending.current = true;
    operation.current?.abort();
    const abort = new AbortController();
    operation.current = abort;
    setBusy(mode);
    setError("");
    return { client, abort };
  }
  const canReview = Boolean(
    currentCap?.available &&
    selected &&
    (!book || currentCap.targetBook) &&
    (selected !== "both" || currentCap.pairs),
  );
  const canSubmit = canReview && Boolean(currentCap?.canSubmit);
  async function run(mode: "review" | "submit" | "list", nextPage = page) {
    const task = start(mode === "submit" ? "sending" : "checking");
    if (!task) return;
    const { client, abort } = task;
    try {
      if (mode === "list") {
        const next = await client.listBookRequests(
          { page: nextPage, size: 20, groupPairs: currentCap?.pairs },
          abort.signal,
        );
        if (!abort.signal.aborted && owner.current === client) {
          setList(next);
          setPage(nextPage);
        }
        return;
      }
      if (!canReview || !selected || (mode === "submit" && !canSubmit)) return;
      const work = {
        ...(book
          ? bookRequestWork(book)
          : {
              title: title.trim(),
              authors: authors
                .split("\n")
                .map((a) => a.trim())
                .filter(Boolean),
            }),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      const kinds: BookRequestMediaKind[] =
        selected === "both" ? ["ebook", "audiobook"] : [selected];
      if (mode === "review") {
        const next = await client.checkBookRequestAvailability(
          kinds.map((mediaKind) => ({
            title: work.title,
            author: work.authors?.[0],
            isbn13: work.isbn13,
            mediaKind,
          })),
          abort.signal,
        );
        if (!abort.signal.aborted && owner.current === client)
          setAvailability(next);
      } else {
        if (!availability) return;
        const value =
          selected === "both"
            ? Object.values(
                await client.createBookRequestPair(work, abort.signal),
              )
            : [
                await client.createBookRequest(
                  {
                    ...work,
                    mediaKind: selected,
                    ...(book ? { targetBookId: Number(book.id) } : {}),
                  },
                  abort.signal,
                ),
              ];
        if (!abort.signal.aborted && owner.current === client) {
          setResults(value);
          setAvailability(undefined);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted && owner.current === client)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!abort.signal.aborted) {
        setBusy(null);
        pending.current = false;
      }
    }
  }
  function requestRow(item: BookRequestItem) {
    return (
      <li key={item.id}>
        <strong>{item.title}</strong>
        <span>
          {item.mediaKind === "comic" ? t("ebook") : t(item.mediaKind)} ·{" "}
          {t(`status_${item.status}`)}
        </span>
        {item.statusReason && <small>{item.statusReason}</small>}
        {item.matchedBookId && onOpenBook && (
          <button onClick={() => onOpenBook(String(item.matchedBookId))}>
            {t("open")}
          </button>
        )}
      </li>
    );
  }
  if (!client) return <p>{t("connect")}</p>;
  if (
    book &&
    (!missing ||
      !/^\d+$/.test(book.id) ||
      !Number.isSafeInteger(Number(book.id)) ||
      Number(book.id) < 1)
  )
    return null;
  return (
    <section
      className="book-format-requests"
      aria-label={t(book ? "missing" : "title")}
    >
      <h3>{t(book ? "missing" : "title")}</h3>
      {!book && <p>{t("hint")}</p>}
      {currentCap?.reason && (
        <p role="status">
          {t(
            currentCap.reason === "read-only"
              ? "readonly"
              : currentCap.reason === "forbidden"
                ? "forbidden"
                : "unavailable",
          )}
        </p>
      )}
      {currentCap?.available &&
        ((book && !currentCap.targetBook) || (!book && !currentCap.pairs)) && (
          <p>{t("upgrade")}</p>
        )}
      {(!book || currentCap?.targetBook) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(availability ? "submit" : "review");
          }}
        >
          <fieldset disabled={Boolean(busy) || !canReview}>
            {!book && (
              <>
                <label>
                  {t("bookTitle")}
                  <input
                    required
                    maxLength={500}
                    value={title}
                    onChange={(e) => {
                      changed();
                      setTitle(e.target.value);
                    }}
                  />
                </label>
                <label>
                  {t("authors")}
                  <textarea
                    value={authors}
                    onChange={(e) => {
                      changed();
                      setAuthors(e.target.value);
                    }}
                  />
                </label>
                <label>
                  {t("format")}
                  <select
                    value={kind}
                    onChange={(e) => {
                      changed();
                      setKind(e.target.value as typeof kind);
                    }}
                  >
                    <option value="ebook">{t("ebook")}</option>
                    <option value="audiobook">{t("audiobook")}</option>
                    {currentCap?.pairs && (
                      <option value="both">{t("both")}</option>
                    )}
                  </select>
                </label>
              </>
            )}
            {book && missing && (
              <p>
                {t(missing)} · {book.title}
              </p>
            )}
            <label>
              {t("note")}
              <textarea
                maxLength={2000}
                value={note}
                onChange={(e) => {
                  changed();
                  setNote(e.target.value);
                }}
              />
            </label>
            {availability?.map((item, index) => (
              <p key={index}>
                {selected === "both"
                  ? t(index === 0 ? "ebook" : "audiobook")
                  : selected
                    ? t(selected)
                    : ""}
                :{" "}
                {item.ownedBookId
                  ? t("available")
                  : item.existingRequestId
                    ? canSubmit
                      ? t("existing")
                      : t("existingRequest")
                    : t("notAvailable")}
                {item.existingRequestStatus &&
                  ` · ${t(`status_${item.existingRequestStatus}`)}`}
                {item.ownedBookId && onOpenBook && (
                  <button
                    type="button"
                    onClick={() => onOpenBook(String(item.ownedBookId))}
                  >
                    {t("open")}
                  </button>
                )}
              </p>
            ))}
            <button
              type="submit"
              disabled={
                Boolean(results) ||
                Boolean(availability && !canSubmit) ||
                Boolean(
                  availability?.every((item) => item.ownedBookId !== null),
                )
              }
            >
              {busy === "sending"
                ? t("sending")
                : busy
                  ? t("pending")
                  : availability
                    ? t("submit")
                    : t("review")}
            </button>
            {availability && !canSubmit && (
              <button type="button" onClick={() => void run("review")}>
                {t("review")}
              </button>
            )}
          </fieldset>
        </form>
      )}
      {busy === "checking" && !currentCap && (
        <p role="status">{t("pending")}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {results && (
        <ul aria-live="polite">
          {results.map((result) => (
            <li key={result.request.id}>
              <strong>{t(result.subscribed ? "joined" : "requested")}</strong>
              <span>
                {t(
                  result.request.mediaKind === "comic"
                    ? "ebook"
                    : result.request.mediaKind,
                )}{" "}
                · {t(`status_${result.request.status}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!book && currentCap?.available && (
        <div>
          <h4>{t("recent")}</h4>
          <button disabled={Boolean(busy)} onClick={() => void run("list")}>
            {t("refresh")}
          </button>
          {list?.items.length ? (
            <ul>
              {list.items.flatMap((item) => [
                requestRow(item),
                ...(item.companion ? [requestRow(item.companion)] : []),
              ])}
            </ul>
          ) : (
            <p>{t("empty")}</p>
          )}
          {list && (
            <nav aria-label={t("recent")}>
              <button
                disabled={Boolean(busy) || page === 1}
                onClick={() => void run("list", page - 1)}
              >
                {t("previous")}
              </button>
              <span>{t("page", { page, total: list.total })}</span>
              <button
                disabled={Boolean(busy) || page * 20 >= list.total}
                onClick={() => void run("list", page + 1)}
              >
                {t("next")}
              </button>
            </nav>
          )}
        </div>
      )}
    </section>
  );
}
