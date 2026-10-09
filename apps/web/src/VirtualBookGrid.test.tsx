// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../../../packages/core/src/types";
import { BookCoverCache } from "./coverCache";
import { CoverContext } from "./CoverContext";
import { VirtualBookGrid, virtualRange } from "./VirtualBookGrid";

const books: Book[] = Array.from({ length: 10000 }, (_, index) => ({
  id: String(index + 1),
  title: `Book ${index + 1}`,
  authors: ["Author"],
  description: "",
  format: "EPUB",
  color: "#ccc",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "2026-10-09",
  files: [],
  coverUrl: `https://books.example/api/v1/books/${index + 1}/cover`,
}));
let host: HTMLDivElement, root: Root;
const observers = new Map<Element, IntersectionObserverCallback>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  URL.createObjectURL = vi.fn(() => `blob:${crypto.randomUUID()}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(node: Element) {
        observers.set(node, this.callback);
      }
      disconnect() {
        for (const [node, callback] of observers)
          if (callback === this.callback) observers.delete(node);
      }
      unobserve(node: Element) {
        observers.delete(node);
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    gridTemplateColumns: "184px 184px 184px 184px 184px",
    columnGap: "20px",
    rowGap: "20px",
  } as CSSStyleDeclaration);
  Object.defineProperty(window, "scrollY", {
    value: 0,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: 600,
    writable: true,
    configurable: true,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const offset = this.classList.contains("book-card")
        ? Number.parseFloat(this.parentElement?.style.top || "0")
        : 0;
      return {
        width: 1000,
        height: this.classList.contains("book-card") ? 300 : 1000,
        top: 100 + offset - window.scrollY,
        bottom: 400 + offset - window.scrollY,
        left: 0,
        right: 1000,
        x: 0,
        y: 0,
        toJSON() {},
      };
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("10,000-book library rendering and covers", () => {
  it("retains measured scroll height when the entire catalog is outside the viewport", async () => {
    await act(async () =>
      root.render(<VirtualBookGrid books={books} onSelect={() => {}} />),
    );
    const list = host.querySelector<HTMLElement>('[role="list"]')!,
      height = list.style.height;
    await act(async () => {
      window.scrollY = 1_000_000;
      window.dispatchEvent(new Event("scroll"));
      await new Promise((done) => setTimeout(done, 30));
    });
    expect(host.querySelectorAll(".book-card")).toHaveLength(0);
    expect(list.style.height).toBe(height);
  });
  it("mounts only the viewport and overscan while pinning the focused card across scrolling", async () => {
    await act(async () =>
      root.render(<VirtualBookGrid books={books} onSelect={() => {}} />),
    );
    expect(host.querySelectorAll(".book-card").length).toBeLessThan(70);
    expect(host.querySelector('[aria-setsize="10000"]')).not.toBeNull();
    const focused = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => focused.focus());
    await act(async () => {
      window.scrollY = 100000;
      window.dispatchEvent(new Event("scroll"));
      await new Promise((done) => setTimeout(done, 30));
    });
    expect(document.activeElement).toBe(focused);
    expect(host.contains(focused)).toBe(true);
    expect(host.querySelectorAll(".book-card").length).toBeLessThan(70);
    await act(async () =>
      focused.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(
      document.activeElement
        ?.closest("[data-book-index]")
        ?.getAttribute("data-book-index"),
    ).toBe("9999");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });
  it("registers 10,000 cover identities without fetching, then fetches only intersecting covers", async () => {
    const fetchCover = vi.fn(async () => new Blob(["cover"]));
    const cache = new BookCoverCache(fetchCover, 12, 4);
    cache.register(books);
    await act(async () =>
      root.render(
        <CoverContext.Provider value={cache}>
          <VirtualBookGrid books={books} onSelect={() => {}} />
        </CoverContext.Provider>,
      ),
    );
    expect(fetchCover).not.toHaveBeenCalled();
    expect(cache.getStats().sources).toBe(10000);
    await act(async () => {
      for (const [target, callback] of [...observers].slice(0, 8))
        callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
    });
    expect(fetchCover).toHaveBeenCalledTimes(8);
    expect(cache.getStats().cached).toBe(8);
    await act(async () => cache.dispose());
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(8);
  });
  it("evicts released covers without retaining stale URLs and never evicts a visible cover", async () => {
    const cache = new BookCoverCache(async () => new Blob(["cover"]), 2, 1);
    cache.register(books.slice(0, 4));
    const keep = cache.acquire("1");
    await vi.waitFor(() => expect(cache.get("1")).toMatch(/^blob:/));
    const kept = cache.get("1");
    let evicted: string | undefined;
    for (const id of ["2", "3", "4"]) {
      const release = cache.acquire(id);
      await vi.waitFor(() => expect(cache.get(id)).toMatch(/^blob:/));
      if (id === "2") evicted = cache.get(id);
      release();
    }
    expect(cache.get("1")).toBe(kept);
    expect(cache.get("2")).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(evicted);
    expect(cache.getStats().cached).toBeLessThanOrEqual(2);
    keep();
    cache.dispose();
  });
  it("keeps pure range computation bounded at the end of large grid and list catalogs", () => {
    expect(virtualRange(10000, 5, 320, 639000, 600).length).toBeLessThan(50);
    expect(virtualRange(10000, 1, 114, 900000, 600).length).toBeLessThan(12);
    expect(virtualRange(10000, 5, 320, 100000, 600, 0)).toContain(0);
  });
});
