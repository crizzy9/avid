import type { ReaderPageInfo } from "./contracts";

const interactive =
  'a,button,input,textarea,select,label,summary,[contenteditable],[role="button"],img,svg,canvas,video,audio,[data-reader-controls],.reader-selection-tools';
function elementFor(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  return node?.nodeType === 1
    ? (node as Element)
    : (node?.parentElement ?? null);
}

/** Observe taps without capturing pointers, suppressing clicks or touching selection. */
export function bindReadingTap(
  target: Document | HTMLElement,
  onTap: () => void,
): () => void {
  const doc =
    target.nodeType === 9
      ? (target as Document)
      : (target as HTMLElement).ownerDocument;
  let down: { x: number; y: number; at: number; pointer: number } | undefined;
  const blocked = (event: Event) =>
    Boolean(elementFor(event.target)?.closest(interactive)) ||
    Boolean(doc.getSelection()?.toString());
  const start = (event: Event) => {
    const pointer = event as PointerEvent;
    down =
      pointer.button === 0 && pointer.isPrimary !== false && !blocked(event)
        ? {
            x: pointer.clientX,
            y: pointer.clientY,
            at: pointer.timeStamp,
            pointer: pointer.pointerId,
          }
        : undefined;
  };
  const cancel = () => {
    down = undefined;
  };
  const move = (event: Event) => {
    const pointer = event as PointerEvent;
    if (
      down &&
      (pointer.pointerId !== down.pointer ||
        Math.hypot(pointer.clientX - down.x, pointer.clientY - down.y) > 8)
    )
      cancel();
  };
  const click = (event: Event) => {
    const point = down;
    down = undefined;
    const mouse = event as MouseEvent;
    if (
      !point ||
      event.defaultPrevented ||
      mouse.detail > 1 ||
      blocked(event) ||
      event.timeStamp - point.at > 350 ||
      Math.hypot(mouse.clientX - point.x, mouse.clientY - point.y) > 8
    )
      return;
    onTap();
  };
  target.addEventListener("pointerdown", start);
  target.addEventListener("pointermove", move);
  target.addEventListener("pointercancel", cancel);
  target.addEventListener("scroll", cancel, true);
  target.addEventListener("click", click);
  return () => {
    target.removeEventListener("pointerdown", start);
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointercancel", cancel);
    target.removeEventListener("scroll", cancel, true);
    target.removeEventListener("click", click);
  };
}

/** Foliate's location.current is byte-derived, so it must never become a page count. */
export function foliatePageInfo(
  view: {
    isFixedLayout?: boolean;
    book?: { sections?: unknown[] };
    renderer?: { scrolled?: boolean; page?: number; pages?: number };
  },
  detail: { pageItem?: { label?: string }; section?: { current?: number } },
): ReaderPageInfo {
  const info: ReaderPageInfo = {};
  const label = detail.pageItem?.label;
  if (typeof label === "string" && label.trim()) info.pageLabel = label.trim();
  const index = detail.section?.current;
  const count = view.book?.sections?.length;
  if (
    view.isFixedLayout &&
    Number.isInteger(index) &&
    count &&
    index! >= 0 &&
    index! < count
  ) {
    info.pageNumber = index! + 1;
    info.pageCount = count;
  } else if (!view.isFixedLayout && view.renderer && !view.renderer.scrolled) {
    // The paginator includes one empty edge screen at either end of a section.
    const page = view.renderer.page,
      pages = view.renderer.pages;
    if (
      Number.isInteger(page) &&
      Number.isInteger(pages) &&
      pages! > 2 &&
      page! >= 1 &&
      page! <= pages! - 2
    )
      info.sectionRemaining = pages! - 2 - page!;
  }
  return info;
}
