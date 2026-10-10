// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { bindReadingTap, foliatePageInfo } from "./readerChrome";
import { Reader } from "./Reader";
import type { Book, EngineProps } from "./contracts";
import { setLocale } from "../../i18n/src";

const fixture = vi.hoisted(() => ({
  props: undefined as EngineProps | undefined,
  next: vi.fn(),
  close: vi.fn(),
  selection: undefined as { quote: string; locator: string } | undefined,
}));
vi.mock("./EbookView", () => ({
  EbookView: (props: EngineProps) => {
    fixture.props = props;
    useEffect(() => {
      props.onReady(
        {
          next: fixture.next,
          prev: () => {},
          goTo: () => {},
          search: async () => [],
          selection: () => fixture.selection,
        },
        [],
      );
      props.onLocation("epubcfi(/6/2)", 0.3, "CHAPTER VIII.");
    }, []);
    return (
      <div className="publication-fixture">
        <p>Original selected passage</p>
        <a href="#note">A footnote</a>
        <img alt="Publication illustration" />
        <button>A publication button</button>
      </div>
    );
  },
}));
vi.mock("./PdfView", () => ({ PdfView: () => null }));
vi.mock("./ComicView", () => ({ ComicView: () => null }));
const book: Book = {
  id: "quiet-reader",
  title: "The Picture of Dorian Gray",
  authors: ["Oscar Wilde"],
  description: "",
  format: "EPUB",
  color: "",
  progress: 0.3,
  status: "reading",
  genres: [],
  addedAt: "",
  files: [{ id: "text", name: "book.epub", format: "EPUB" }],
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale("en");
  vi.clearAllMocks();
  fixture.selection = undefined;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.getSelection()?.removeAllRanges();
  host.remove();
  vi.useRealTimers();
});
const render = () =>
  act(async () =>
    root.render(
      <Reader
        book={book}
        annotations={[]}
        onClose={fixture.close}
        onAnchor={() => {}}
        onAnnotation={() => {}}
      />,
    ),
  );
const header = () => host.querySelector<HTMLElement>("#reader-controls")!;
const tap = async (element: Element, elapsed = 20, drag = 0) =>
  act(async () => {
    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    element.dispatchEvent(down);
    if (drag)
      element.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: 10 + drag,
          clientY: 10,
        }),
      );
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      clientX: 10,
      clientY: 10,
    });
    Object.defineProperty(click, "timeStamp", {
      value: down.timeStamp + elapsed,
    });
    // Run the gesture observers first, then prevent jsdom's unsupported navigation.
    element.ownerDocument.defaultView?.addEventListener(
      "click",
      (event) => event.preventDefault(),
      { once: true },
    );
    element.dispatchEvent(click);
  });

it("starts with centered title/chapter and quiet honest position, then reveals controls by tap or Escape", async () => {
  await render();
  expect(header().hidden).toBe(true);
  expect(host.querySelector(".reader-running-heading")?.textContent).toBe(
    `${book.title}CHAPTER VIII.`,
  );
  expect(host.querySelector(".reader-page-label")?.textContent).toBe(
    "30% read",
  );
  expect(host.querySelector(".reader-footer-brand")).toBeNull();
  await tap(host.querySelector(".publication-fixture p")!);
  expect(header().hidden).toBe(false);
  await tap(host.querySelector(".publication-fixture p")!);
  expect(header().hidden).toBe(true);
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(header().hidden).toBe(false);
  expect(fixture.close).not.toHaveBeenCalled();
  await act(async () =>
    (
      host.querySelector('[aria-label="Next page"]') as HTMLButtonElement
    ).click(),
  );
  expect(fixture.next).toHaveBeenCalledOnce();
});

it("does not toggle chrome for selection, long press, drag, links, images or publication controls", async () => {
  await render();
  for (const selector of ["a", "img", "button"])
    await tap(host.querySelector(`.publication-fixture ${selector}`)!);
  const paragraph = host.querySelector(".publication-fixture p")!;
  await tap(paragraph, 500);
  await tap(paragraph, 20, 18);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  document.getSelection()!.addRange(range);
  await tap(paragraph);
  expect(header().hidden).toBe(true);
  expect(document.getSelection()?.toString()).toBe("Original selected passage");
  document.getSelection()?.removeAllRanges();
  fixture.selection = {
    quote: "Selection in an EPUB iframe",
    locator: "epubcfi(/6/2)",
  };
  await act(async () => fixture.props?.onReadingTap?.());
  expect(header().hidden).toBe(true);
});

it("uses the same safe tap behavior inside an iframe document and removes its handlers on cleanup", async () => {
  const frame = document.createElement("iframe");
  host.append(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = '<p>Frame text</p><a href="#note">Frame link</a>';
  const toggle = vi.fn();
  const cleanup = bindReadingTap(doc, toggle);
  await tap(doc.querySelector("p")!);
  expect(toggle).toHaveBeenCalledOnce();
  await tap(doc.querySelector("a")!);
  expect(toggle).toHaveBeenCalledOnce();
  cleanup();
  await tap(doc.querySelector("p")!);
  expect(toggle).toHaveBeenCalledOnce();
});

it("auto-hides idle controls but preserves an open panel or keyboard-focused control", async () => {
  vi.useFakeTimers();
  await render();
  await tap(host.querySelector(".publication-fixture p")!);
  await act(async () => {
    vi.advanceTimersByTime(4000);
  });
  expect(header().hidden).toBe(true);
  await tap(host.querySelector(".publication-fixture p")!);
  await act(async () =>
    (
      host.querySelector('[aria-label="Reading settings"]') as HTMLButtonElement
    ).click(),
  );
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(header().hidden).toBe(false);
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(host.querySelector(".reader-panel")).toBeNull();
  expect(fixture.close).not.toHaveBeenCalled();
  await act(async () =>
    (
      host.querySelector('[aria-label="Close reader"]') as HTMLButtonElement
    ).focus(),
  );
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(header().hidden).toBe(false);
});

it("shows source page labels or real fixed-layout totals and clears stale remaining counts", async () => {
  await render();
  await act(async () =>
    fixture.props!.onLocation("epubcfi(/6/4)", 0.4, "CHAPTER IX.", {
      pageLabel: "xvii",
      sectionRemaining: 4,
    }),
  );
  expect(host.querySelector(".reader-page-label")?.textContent).toBe(
    "Page xvii",
  );
  expect(
    host.querySelector(".reader-section-remaining")?.textContent,
  ).toContain("4");
  await act(async () =>
    fixture.props!.onLocation("epubcfi(/6/6)", 0.5, "CHAPTER X.", {
      pageNumber: 5,
      pageCount: 10,
    }),
  );
  expect(host.querySelector(".reader-page-label")?.textContent).toBe(
    "Page 5 of 10",
  );
  expect(host.querySelector(".reader-section-remaining")?.textContent).toBe("");
  await act(async () =>
    fixture.props!.onLocation("epubcfi(/6/8)", 0.6, "CHAPTER XI."),
  );
  expect(host.querySelector(".reader-page-label")?.textContent).toBe(
    "60% read",
  );
});

it("does not treat byte-derived locations, invalid edges or continuous scroll as exact pagination", () => {
  expect(foliatePageInfo({ renderer: { page: 2, pages: 8 } }, {})).toEqual({
    sectionRemaining: 4,
  });
  expect(
    foliatePageInfo({ renderer: { page: 2, pages: 8, scrolled: true } }, {}),
  ).toEqual({});
  expect(foliatePageInfo({ renderer: { page: 0, pages: 8 } }, {})).toEqual({});
  expect(
    foliatePageInfo({ renderer: { page: 2, pages: Infinity } }, {}),
  ).toEqual({});
  expect(
    foliatePageInfo({}, { location: { current: 137, total: 303 } } as never),
  ).toEqual({});
  expect(
    foliatePageInfo(
      { isFixedLayout: true, book: { sections: [{}, {}, {}] } },
      { section: { current: 1 } },
    ),
  ).toEqual({ pageNumber: 2, pageCount: 3 });
  expect(foliatePageInfo({}, { pageItem: { label: " xvii " } })).toEqual({
    pageLabel: "xvii",
  });
});
