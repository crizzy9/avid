import { useI18n } from "../../../packages/i18n/src";
import {
  BookOpen,
  Headphones,
  Plus,
  Check,
  Clock3,
  MoreHorizontal,
} from "lucide-react";
import type {
  Book,
  Collection,
  Annotation,
  BookOrbitReadStatus,
} from "../../../packages/core/src/types";
import { Cover } from "./ui";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import { BookCollections } from "./BookCollections";
import { useState } from "react";

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
  const { t, locale, setLocale } = useI18n();

  const queued =
    book.serverStatus === "want_to_read" ||
    collections.find((c) => c.id === "queue")?.bookIds.includes(book.id);
  const hasAudio = book.files.some((f) => f.format === "AUDIO");
  const readableFiles = book.files.filter((file) => file.format !== "AUDIO");
  const [selectedFile, setSelectedFile] = useState(readableFiles[0]?.id);
  return (
    <div className="book-details">
      <div
        className="detail-hero"
        style={{ "--book-color": book.color } as React.CSSProperties}
      >
        <Cover book={book} large />
        <div className="detail-heading">
          <span className="eyebrow">
            {book.format === "AUDIO"
              ? t("common.audiobook")
              : t("library.title")}
          </span>
          <h2>{book.title}</h2>
          <p>
            {t("detail.by", {
              author: book.authors.join(", ") || t("common.unknownAuthor"),
            })}
          </p>
          {book.series && (
            <p className="series-link">
              {book.series}
              {book.seriesIndex
                ? ` · ${t("detail.seriesBook", { number: book.seriesIndex })}`
                : ""}
            </p>
          )}
          <div className="detail-actions">
            {book.files.some((f) => f.format !== "AUDIO") && (
              <button
                className="primary-button"
                onClick={() => onRead(selectedFile)}
              >
                <BookOpen size={17} />
                {book.progress > 0 ? t("detail.resume") : t("detail.start")}
              </button>
            )}
            {hasAudio && (
              <button
                className={
                  book.format === "AUDIO"
                    ? "primary-button"
                    : "secondary-button"
                }
                onClick={onListen}
              >
                <Headphones size={17} />
                {t("common.listen")}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="detail-body">
        {readableFiles.length > 1 && (
          <label className="edition-select">
            {t("detail.edition")}
            <select
              value={selectedFile}
              onChange={(event) => setSelectedFile(event.target.value)}
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
        <div className="detail-secondary">
          <button
            className="secondary-button"
            disabled={readOnly}
            onClick={onQueue}
          >
            {queued ? <Check size={16} /> : <Plus size={16} />}{" "}
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
              onChange={(e) => onStatus(e.target.value as BookOrbitReadStatus)}
            >
              <option value="unread">{t("status.unread")}</option>
              <option value="want_to_read">{t("status.want_to_read")}</option>
              <option value="reading">{t("status.reading")}</option>
              <option value="on_hold">{t("status.on_hold")}</option>
              <option value="rereading">{t("status.rereading")}</option>
              <option value="read">{t("status.read")}</option>
              <option value="skimmed">{t("status.skimmed")}</option>
              <option value="abandoned">{t("status.abandoned")}</option>
            </select>
          </label>
        </div>
        {readOnly && <p className="field-hint">{t("detail.readOnly")}</p>}
        {client && !book.id.startsWith("local-") && (
          <BookCollections client={client} bookId={book.id} />
        )}
        <div className="detail-description">
          <h3>{t("detail.about")}</h3>
          <p>
            {book.description.replace(/<[^>]*>/g, "") ||
              t("detail.noDescription")}
          </p>
        </div>
        <div className="genre-tags">
          {book.genres.map((g) => (
            <span key={g}>{g}</span>
          ))}
        </div>
        <div className="book-info">
          <div>
            <small>{t("detail.format")}</small>
            <strong>
              {[...new Set(book.files.map((f) => f.format))].join(" + ") ||
                book.format}
            </strong>
          </div>
          <div>
            <small>{t("detail.progress")}</small>
            <strong>{Math.round(book.progress * 100)}%</strong>
          </div>
          <div>
            <small>{t("detail.added")}</small>
            <strong>
              {new Date(book.addedAt).toLocaleDateString(locale, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </strong>
          </div>
        </div>
        <div className="section-heading">
          <h3>{t("detail.notes")}</h3>
          <button className="text-button" onClick={onShowNotes}>
            {t("detail.openNotebook")}
            <MoreHorizontal size={18} />
          </button>
        </div>
        {annotations.length ? (
          <div className="detail-notes">
            {annotations.slice(0, 2).map((note) => (
              <blockquote key={note.id}>{note.quote || note.text}</blockquote>
            ))}
          </div>
        ) : (
          <p className="muted">{t("detail.notesHint")}</p>
        )}
        {book.id.startsWith("demo-") && (
          <p className="demo-disclosure">{t("detail.sample")}</p>
        )}
      </div>
    </div>
  );
}
