import { useI18n } from "../../../packages/i18n/src";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, BookOpen, Headphones, ChevronRight } from "lucide-react";
import type { Book } from "../../../packages/core/src/types";
import { useBookCover } from "./CoverContext";

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t, locale, setLocale } = useI18n();

  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Cover({
  book,
  large = false,
}: {
  book: Book;
  large?: boolean;
}) {
  const { t, locale, setLocale } = useI18n();
  const { ref, url } = useBookCover(book);
  const [failedUrl, setFailedUrl] = useState<string>();
  const channels = /^#[0-9a-f]{6}$/i.test(book.color)
    ? [1, 3, 5].map(
        (i) => Number.parseInt(book.color.slice(i, i + 2), 16) / 255,
      )
    : [0, 0, 0];
  const luminance = channels
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const fallbackInk = luminance > 0.179 ? "#000000" : "#ffffff";

  return (
    <div
      ref={ref}
      className={`cover ${large ? "large" : ""}`}
      style={{ background: book.color }}
    >
      {url && failedUrl !== url ? (
        <img
          key={url}
          src={url}
          alt=""
          loading={large ? "eager" : "lazy"}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <div className="cover-fallback" style={{ color: fallbackInk }}>
          <span>{book.title}</span>
          <BookOpen size={45} />
          <small>{book.authors.join(", ")}</small>
        </div>
      )}
      {book.format === "AUDIO" && (
        <span className="cover-format" aria-label={t("common.audiobook")}>
          <Headphones size={12} />
        </span>
      )}
      {book.progress > 0 && book.progress < 1 && (
        <>
          <span className="cover-percent">
            {Math.round(book.progress * 100)}%
          </span>
          <span
            className="cover-progress"
            style={{ width: `${book.progress * 100}%` }}
          />
        </>
      )}
    </div>
  );
}

export function BookCard({
  book,
  onSelect,
  list = false,
  tabIndex,
  onFocus,
}: {
  book: Book;
  onSelect: (book: Book) => void;
  list?: boolean;
  tabIndex?: number;
  onFocus?: () => void;
}) {
  const { t, locale, setLocale } = useI18n();

  return (
    <button
      tabIndex={tabIndex}
      onFocus={onFocus}
      style={{ width: "100%" }}
      className={`book-card ${list ? "list-card" : ""}`}
      data-format={book.format}
      onClick={() => onSelect(book)}
      aria-label={t("library.openLabel", {
        title: book.title,
        author: book.authors.join(", ") || t("common.unknownAuthor"),
      })}
    >
      <Cover book={book} />
      <div className="book-caption">
        <span className="book-title">{book.title}</span>
        <span className="book-author">
          {book.authors.join(", ") || t("common.unknownAuthor")}
        </span>
        {list && (
          <span className="book-list-meta">
            {book.format} ·{" "}
            {book.progress > 0
              ? t("common.complete", {
                  percent: Math.round(book.progress * 100),
                })
              : t("status.unread")}
          </span>
        )}
      </div>
      {list && <ChevronRight size={18} />}
    </button>
  );
}

export function Shelf({
  title,
  subtitle,
  books,
  onSelect,
  onSeeAll,
}: {
  title: string;
  subtitle?: string;
  books: Book[];
  onSelect: (book: Book) => void;
  onSeeAll?: () => void;
}) {
  const { t, locale, setLocale } = useI18n();

  if (!books.length) return null;
  return (
    <section className="shelf">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {onSeeAll && (
          <button className="text-button" onClick={onSeeAll}>
            {t("common.seeAll")}
            <ChevronRight size={15} />
          </button>
        )}
      </div>
      <div className="shelf-track">
        {books.map((book) => (
          <BookCard key={book.id} book={book} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

export function EmptyState({
  icon,
  heading,
  description,
  action,
}: {
  icon: ReactNode;
  heading: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{heading}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export const formatTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const h = Math.floor(safe / 3600),
    m = Math.floor((safe % 3600) / 60),
    s = Math.floor(safe % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};
