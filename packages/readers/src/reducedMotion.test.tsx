// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Reader } from "./Reader";
import type { Book, ReaderSettings } from "./contracts";
import { setLocale } from "../../i18n/src";

const engine = vi.hoisted(() => ({
  next: vi.fn(),
  previous: vi.fn(),
  open: vi.fn(),
  makeBook: vi.fn(),
}));
vi.mock("../vendor/foliate/view.js", () => {
  class FixtureView extends HTMLElement {
    book?: unknown;
    renderer?: HTMLElement & { setStyles: () => void };
    async open(book: unknown) {
      engine.open();
      this.book = book;
      this.renderer = Object.assign(document.createElement("div"), {
        setStyles: () => {},
      });
      this.attachShadow({ mode: "open" }).append(this.renderer);
    }
    async init() {}
    close() {}
    next() {
      engine.next();
    }
    prev() {
      engine.previous();
    }
  }
  customElements.define("foliate-view", FixtureView);
  return { makeBook: engine.makeBook };
});
vi.mock("../vendor/foliate/overlayer.js", () => ({ Overlayer: {} }));
vi.mock("./PdfView", () => ({ PdfView: () => null }));
vi.mock("./ComicView", () => ({ ComicView: () => null }));

const book: Book = {
  id: "motion-book",
  title: "Original publication",
  authors: [],
  description: "",
  format: "EPUB",
  color: "",
  progress: 0.3,
  status: "reading",
  genres: [],
  addedAt: "",
  files: [
    {
      id: "motion-file",
      name: "book.epub",
      format: "EPUB",
      url: "https://fixture.invalid/book.epub",
    },
  ],
};
let root: Root, host: HTMLDivElement, osReduced: boolean;
const listeners = new Set<() => void>();
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale("en");
  document.documentElement.dataset.motion = "system";
  osReduced = false;
  listeners.clear();
  vi.clearAllMocks();
  engine.makeBook.mockImplementation(async () => ({ sections: [], toc: [] }));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return osReduced;
      },
      addEventListener: (_: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        listeners.delete(listener),
    })),
  );
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
  expect(listeners.size).toBe(0);
  host.remove();
  delete document.documentElement.dataset.motion;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const render = async (animation: ReaderSettings["animation"]) => {
  localStorage.setItem(
    "avid.reader.settings.v2.motion-account.motion-file",
    JSON.stringify({ animation }),
  );
  await act(async () =>
    root.render(
      <Reader
        book={book}
        accountScope="motion-account"
        annotations={[]}
        onClose={() => {}}
        onAnchor={() => {}}
        onAnnotation={() => {}}
      />,
    ),
  );
  expect(
    host.querySelector(".reader-error"),
    host.textContent ?? "",
  ).toBeNull();
};
const setApp = async (value: "system" | "reduce") =>
  act(async () => {
    document.documentElement.dataset.motion = value;
  });
const setOS = async (value: boolean) =>
  act(async () => {
    osReduced = value;
    listeners.forEach((listener) => listener());
  });
const next = async () =>
  act(async () =>
    (
      host.querySelector('[aria-label="Next page"]') as HTMLButtonElement
    ).click(),
  );
const renderer = () =>
  host.querySelector("foliate-view")!.shadowRoot!.firstElementChild!;

it("applies app and live OS motion preferences inside Foliate's shadow renderer without reopening or erasing the animation choice", async () => {
  await setApp("reduce");
  await render("slide");
  expect(renderer().hasAttribute("animated")).toBe(false);
  await next();
  expect(engine.next).toHaveBeenCalledTimes(1);
  await setApp("system");
  expect(renderer().hasAttribute("animated")).toBe(true);
  await setOS(true);
  expect(renderer().hasAttribute("animated")).toBe(false);
  await setApp("reduce");
  await setOS(false);
  expect(renderer().hasAttribute("animated")).toBe(false);
  await setApp("system");
  expect(renderer().hasAttribute("animated")).toBe(true);
  expect(engine.open).toHaveBeenCalledTimes(1);
  expect(engine.makeBook).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(
      localStorage.getItem(
        "avid.reader.settings.v2.motion-account.motion-file",
      )!,
    ).animation,
  ).toBe("slide");
});

it.each(["fade", "fast-fade"] as const)(
  "suppresses %s and cancels an active flash while keeping page navigation available",
  async (animation) => {
    vi.useFakeTimers();
    await render(animation);
    await next();
    expect(host.querySelector(".reader-stage.turning")).not.toBeNull();
    await setApp("reduce");
    expect(host.querySelector(".reader-stage.turning")).toBeNull();
    expect(host.querySelector("dialog")?.dataset.reducedMotion).toBe("true");
    await next();
    expect(host.querySelector(".reader-stage.turning")).toBeNull();
    await setApp("system");
    await next();
    expect(host.querySelector(".reader-stage.turning")).not.toBeNull();
    await setOS(true);
    expect(host.querySelector(".reader-stage.turning")).toBeNull();
    await next();
    expect(host.querySelector(".reader-stage.turning")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(host.querySelector(".reader-stage.turning")).toBeNull();
    expect(engine.next).toHaveBeenCalledTimes(4);
    expect(engine.open).toHaveBeenCalledTimes(1);
  },
);

it("uses the current preference when an asynchronous publication finishes opening", async () => {
  let resolve!: (value: unknown) => void;
  engine.makeBook.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render("slide");
  await setApp("reduce");
  await act(async () => resolve({ sections: [], toc: [] }));
  expect(renderer().hasAttribute("animated")).toBe(false);
  await setApp("system");
  expect(renderer().hasAttribute("animated")).toBe(true);
  expect(engine.open).toHaveBeenCalledTimes(1);
});
