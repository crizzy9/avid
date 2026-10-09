import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Book } from "../../../packages/core/src/types";
import { useI18n } from "../../../packages/i18n/src";
import { BookCard } from "./ui";

export function virtualRange(
  count: number,
  columns: number,
  stride: number,
  top: number,
  height: number,
  focusedIndex: number | null = null,
  overscan = 2,
): number[] {
  const rows = Math.ceil(count / columns),
    first = Math.max(0, Math.floor(top / stride) - overscan),
    last = Math.min(rows, Math.ceil((top + height) / stride) + overscan);
  const indexes = new Set<number>();
  for (
    let index = first * columns;
    index < Math.min(count, last * columns);
    index++
  )
    indexes.add(index);
  if (focusedIndex !== null && focusedIndex >= 0 && focusedIndex < count)
    indexes.add(focusedIndex);
  return [...indexes].sort((a, b) => a - b);
}
/** Window-scrolling list with a stable DOM node for the focused book. */
export function VirtualBookGrid({
  books,
  list = false,
  onSelect,
}: {
  books: Book[];
  list?: boolean;
  onSelect: (book: Book) => void;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const [geometry, setGeometry] = useState({
    width: 1000,
    columns: list ? 1 : 6,
    gap: 30,
    rowGap: 30,
    cardHeight: list ? 114 : 270,
    top: 0,
    viewport: 800,
  });
  const focusedIndex =
    focused === null ? null : books.findIndex((book) => book.id === focused);
  const stride = geometry.cardHeight + geometry.rowGap;
  const indices = virtualRange(
    books.length,
    geometry.columns,
    stride,
    geometry.top,
    geometry.viewport,
    focusedIndex,
  );
  const cellWidth =
    (geometry.width - (geometry.columns - 1) * geometry.gap) / geometry.columns;
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect(),
        style = getComputedStyle(node);
      const tracks = style.gridTemplateColumns
        .split(" ")
        .filter((value) => /^\d/.test(value));
      const columns = list
        ? 1
        : Math.max(1, tracks.length || Math.floor((rect.width || 1000) / 165));
      const firstCard = node.querySelector<HTMLElement>(".book-card");
      const measured = firstCard?.getBoundingClientRect().height;
      const next = {
        width: rect.width || 1000,
        columns,
        gap: list ? 0 : parseFloat(style.columnGap) || 30,
        rowGap: list ? 0 : parseFloat(style.rowGap) || 30,
        cardHeight: measured && measured > 0 ? measured : 0,
        top: -rect.top,
        viewport: window.innerHeight || 800,
      };
      setGeometry((previous) => {
        if (!next.cardHeight) next.cardHeight = previous.cardHeight;
        return Object.keys(next).every(
          (key) =>
            previous[key as keyof typeof next] ===
            next[key as keyof typeof next],
        )
          ? previous
          : next;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(node);
    const first = node.querySelector(".book-card");
    if (first) observer?.observe(first);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [list, books.length, indices[0]]);
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const node = container.current?.querySelector<HTMLButtonElement>(
      `[data-book-index="${index}"] button`,
    );
    if (!node) return;
    pendingFocus.current = null;
    node.focus({ preventScroll: true });
    const rect = node.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight)
      node.scrollIntoView({ block: "nearest" });
  }, [focused, geometry, books]);
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const source = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-book-index]",
    );
    if (!source) return;
    const current = Number(source.dataset.bookIndex);
    let next = current;
    if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowLeft") next--;
    else if (event.key === "ArrowDown") next += geometry.columns;
    else if (event.key === "ArrowUp") next -= geometry.columns;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = books.length - 1;
    else if (event.key === "PageDown")
      next +=
        geometry.columns * Math.max(1, Math.floor(geometry.viewport / stride));
    else if (event.key === "PageUp")
      next -=
        geometry.columns * Math.max(1, Math.floor(geometry.viewport / stride));
    else return;
    event.preventDefault();
    next = Math.max(0, Math.min(books.length - 1, next));
    pendingFocus.current = next;
    setFocused(books[next].id);
  }
  const active =
    focusedIndex !== null && focusedIndex >= 0 ? focusedIndex : indices[0];
  return (
    <div
      ref={container}
      className={list ? "book-list" : "book-grid"}
      role="list"
      aria-label={t("library.title")}
      onKeyDown={keyboard}
      style={{
        position: "relative",
        height: Math.max(
          0,
          Math.ceil(books.length / geometry.columns) * stride - geometry.rowGap,
        ),
      }}
    >
      {indices.map((index) => (
        <div
          key={books[index].id}
          role="listitem"
          aria-posinset={index + 1}
          aria-setsize={books.length}
          data-book-index={index}
          style={{
            position: "absolute",
            top: Math.floor(index / geometry.columns) * stride,
            left: (index % geometry.columns) * (cellWidth + geometry.gap),
            width: cellWidth,
          }}
        >
          <BookCard
            book={books[index]}
            onSelect={onSelect}
            list={list}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setFocused(books[index].id)}
          />
        </div>
      ))}
    </div>
  );
}
