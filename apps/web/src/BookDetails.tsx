import { useEffect, useId, useState, type CSSProperties } from "react";
import { useI18n } from "../../../packages/i18n/src";
import {
  BookOpen,
  Headphones,
  Plus,
  Check,
  Clock3,
  MoreHorizontal,
  Star,
} from "lucide-react";
import type {
  Book,
  Collection,
  Annotation,
  BookOrbitReadStatus,
} from "../../../packages/core/src/types";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import { Cover } from "./ui";
import { BookCollections } from "./BookCollections";
import { useAppI18n } from "./appMessages";
import { descriptionToPlainText } from "./descriptionText";
import "./book-details.css";

const providerNames: Record<string, string> = {
  goodreads: "Goodreads",
  hardcover: "Hardcover",
  openLibrary: "Open Library",
  itunes: "iTunes",
  google: "Google Books",
  amazon: "Amazon",
  audible: "Audible",
  ranobedb: "RanobeDB",
};
export function BookDetails({
  book,
  collections,
  annotations,
  readOnly,
  onRead,
  onListen,
  onQueue,
  onStatus,
  onShowNotes,
  client,
}: {
  book: Book;
  collections: Collection[];
  annotations: Annotation[];
  readOnly: boolean;
  onRead: (fileId?: string) => void;
  onListen: () => void;
  onQueue: () => void;
  onStatus: (status: BookOrbitReadStatus) => void;
  onShowNotes: () => void;
  client: BookOrbitClient | null;
}) {
  const { t, locale } = useI18n();
  const { t: message } = useAppI18n();
  const id = useId();
  const [more, setMore] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<{
    bookId: string;
    fileId: string;
  }>();
  const [detail, setDetail] = useState<{
    client: BookOrbitClient;
    scope: string;
    book: Book;
  }>();
  const scope = client
    ? JSON.stringify([client.baseUrl, client.session.userId])
    : "local";
  useEffect(() => {
    let active = true;
    setMore(false);
    setExpanded(false);
    setSelection(undefined);
    setDetail(undefined);
    // Cards omit provider ratings. Hydrate metadata only; actions retain current props.
    if (client && /^\d+$/.test(book.id)) {
      void client
        .getBook(book.id)
        .then((value) => {
          if (
            active &&
            value.id === book.id &&
            JSON.stringify([client.baseUrl, client.session.userId]) === scope
          )
            setDetail({ client, scope, book: value });
        })
        .catch(() => {
          /* Existing local card metadata remains available offline. */
        });
    }
    return () => {
      active = false;
    };
  }, [client, book.id, scope]);
  const metadata =
    detail?.client === client &&
    detail.scope === scope &&
    detail.book.id === book.id
      ? detail.book
      : book;
  const queued =
    book.serverStatus === "want_to_read" ||
    collections.find((c) => c.id === "queue")?.bookIds.includes(book.id);
  const hasAudio = book.files.some((file) => file.format === "AUDIO");
  const readableFiles = book.files.filter((file) => file.format !== "AUDIO");
  const selectedFile =
    readableFiles.find(
      (file) => selection?.bookId === book.id && file.id === selection.fileId,
    )?.id ?? readableFiles[0]?.id;
  const description = descriptionToPlainText(metadata.description || book.description);
  const expandable =
    description.length > 420 || description.split("\n").length > 7;
  const rating = metadata.rating;
  const hasRating =
    rating !== undefined &&
    Number.isFinite(rating) &&
    rating >= 0 &&
    rating <= 5;
  const community =
    metadata.communityRatings?.filter(
      (item) =>
        item.provider.trim() &&
        Number.isFinite(item.rating) &&
        item.rating >= 0 &&
        item.rating <= 5,
    ) ?? [];
  const number = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const formats =
    [...new Set(book.files.map((file) => file.format))].join(" + ") ||
    book.format;

  return (
    <article
      className="book-details"
      style={{ "--book-color": book.color } as CSSProperties}
    >
      <div className="book-detail-handle" aria-hidden="true" />
      <div className="book-detail-hero">
        <div className="book-detail-cover">
          <Cover book={book} large />
          {hasRating && (
            <div
              className="book-detail-personal-rating"
              role="img"
              aria-label={message("detailYourRating", {
                rating: number(rating),
              })}
            >
              <span className="book-detail-stars" aria-hidden="true">
                {Array.from({ length: 5 }, (_, index) => (
                  <Star key={index} size={23} strokeWidth={1.2} />
                ))}
              </span>
              <span
                className="book-detail-stars book-detail-stars-filled"
                style={{ width: `${(rating / 5) * 100}%` }}
                aria-hidden="true"
              >
                {Array.from({ length: 5 }, (_, index) => (
                  <Star key={index} size={23} strokeWidth={1.2} />
                ))}
              </span>
            </div>
          )}
        </div>
        <div className="book-detail-heading">
          <h2>{book.title}</h2>
          <p className="book-detail-author">
            {t("detail.by", {
              author: book.authors.join(", ") || t("common.unknownAuthor"),
            })}
          </p>
          {book.series && (
            <p className="book-detail-series">
              {book.series}
              {book.seriesIndex !== undefined
                ? ` · ${t("detail.seriesBook", { number: book.seriesIndex })}`
                : ""}
            </p>
          )}
          <div className="book-detail-actions">
            <button
              className="book-detail-more"
              aria-label={t("common.more")}
              aria-expanded={more}
              aria-controls={`${id}-actions`}
              onClick={() => setMore((value) => !value)}
            >
              <MoreHorizontal size={21} />
            </button>
            {readableFiles.length > 0 && (
              <button
                className="primary-button book-detail-read"
                onClick={() => onRead(selectedFile)}
              >
                <BookOpen size={17} />
                {book.progress > 0 ? t("detail.resume") : t("detail.start")}
              </button>
            )}
            {hasAudio && (
              <button
                className={`${readableFiles.length ? "secondary-button" : "primary-button"} book-detail-read`}
                onClick={onListen}
              >
                <Headphones size={17} />
                {t("common.listen")}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="book-detail-body">
        {more && (
          <section
            className="book-detail-tools"
            id={`${id}-actions`}
            aria-label={t("common.more")}
          >
            {readableFiles.length > 1 && (
              <label className="edition-select">
                {t("detail.edition")}
                <select
                  value={selectedFile}
                  onChange={(event) =>
                    setSelection({
                      bookId: book.id,
                      fileId: event.target.value,
                    })
                  }
                >
                  {readableFiles.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.name}
                    </option>
                  ))}
                </select>
                <span className="field-hint">{t("detail.editionHint")}</span>
              </label>
            )}
            <div className="book-detail-management">
              <button
                className="secondary-button"
                disabled={readOnly}
                onClick={onQueue}
              >
                {queued ? <Check size={16} /> : <Plus size={16} />}
                {queued ? t("detail.queued") : t("detail.queue")}
              </button>
              <label className="status-select">
                <Clock3 size={15} />
                <select
                  aria-label={t("detail.status")}
                  value={
                    book.serverStatus ??
                    (book.status === "finished" ? "read" : book.status)
                  }
                  disabled={readOnly}
                  onChange={(event) =>
                    onStatus(event.target.value as BookOrbitReadStatus)
                  }
                >
                  {(
                    [
                      "unread",
                      "want_to_read",
                      "reading",
                      "on_hold",
                      "rereading",
                      "read",
                      "skimmed",
                      "abandoned",
                    ] as const
                  ).map((status) => (
                    <option key={status} value={status}>
                      {t(`status.${status}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {readOnly && <p className="field-hint">{t("detail.readOnly")}</p>}
            {client && /^\d+$/.test(book.id) && (
              <BookCollections
                key={`${scope}:${book.id}`}
                client={client}
                bookId={book.id}
              />
            )}
            <div className="book-detail-reading-info">
              <span>
                {t("detail.progress")} · {number(book.progress * 100)}%
              </span>
              <span>
                {t("detail.added")} ·{" "}
                {new Date(book.addedAt).toLocaleDateString(locale, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </div>
            <button className="text-button" onClick={onShowNotes}>
              {t("detail.openNotebook")}
              <MoreHorizontal size={18} />
            </button>
          </section>
        )}
        <div className="book-detail-summary">
          <section
            className="book-detail-description"
            aria-label={t("detail.about")}
          >
            <p
              id={`${id}-description`}
              className={
                !expanded && expandable ? "book-detail-description-preview" : ""
              }
            >
              {description || t("detail.noDescription")}
            </p>
            {expandable && (
              <button
                className="text-button"
                aria-expanded={expanded}
                aria-controls={`${id}-description`}
                onClick={() => setExpanded((value) => !value)}
              >
                {message(expanded ? "detailShowLess" : "detailReadMore")}
              </button>
            )}
          </section>
          {book.genres.length > 0 && (
            <aside
              className="book-detail-genres"
              aria-label={message("detailGenres")}
            >
              <h3>{message("detailGenres")}</h3>
              <div>
                {book.genres.map((genre) => (
                  <span key={genre}>{genre}</span>
                ))}
              </div>
            </aside>
          )}
        </div>
        {community.length > 0 && (
          <section
            className="book-detail-community"
            aria-labelledby={`${id}-community`}
          >
            <h3 id={`${id}-community`}>{message("detailCommunityRatings")}</h3>
            <dl className="book-detail-metadata-grid">
              {community.map((item, index) => (
                <div key={`${item.provider}:${index}`}>
                  <dt>{providerNames[item.provider] ?? item.provider}</dt>
                  <dd className="book-detail-community-score">
                    <Star size={15} fill="currentColor" aria-hidden="true" />
                    {number(item.rating)}
                  </dd>
                  {item.ratingCount !== undefined && (
                    <dd className="book-detail-rating-count">
                      {message("detailRatingCount", {
                        count: item.ratingCount,
                      })}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </section>
        )}
        <section
          className="book-detail-information"
          aria-labelledby={`${id}-information`}
        >
          <h3 id={`${id}-information`}>{message("detailInformation")}</h3>
          <dl className="book-detail-metadata-grid">
            {metadata.publishedYear !== undefined && (
              <div>
                <dt>{message("detailPublished")}</dt>
                <dd>{metadata.publishedYear}</dd>
              </div>
            )}
            <div>
              <dt>{t("detail.format")}</dt>
              <dd>{formats}</dd>
            </div>
            {metadata.publisher && (
              <div>
                <dt>{message("detailPublisher")}</dt>
                <dd>{metadata.publisher}</dd>
              </div>
            )}
          </dl>
        </section>
        {annotations.length > 0 && (
          <section className="book-detail-notes">
            <div className="section-heading">
              <h3>{t("detail.notes")}</h3>
              <button className="text-button" onClick={onShowNotes}>
                {t("detail.openNotebook")}
              </button>
            </div>
            {annotations.slice(0, 2).map((note) => (
              <blockquote key={note.id}>{note.quote || note.text}</blockquote>
            ))}
          </section>
        )}
        {book.id.startsWith("demo-") && (
          <p className="demo-disclosure">{t("detail.sample")}</p>
        )}
      </div>
    </article>
  );
}
