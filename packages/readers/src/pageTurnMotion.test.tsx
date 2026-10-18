// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComicView } from "./ComicView";
import { PdfView } from "./PdfView";
import {
  defaultSettings,
  type Book,
  type EngineHandle,
  type EngineProps,
} from "./contracts";
import { pageLocator } from "./anchors";
import { setLocale } from "../../i18n/src";

const fixture = vi.hoisted(() => ({
  renderGate: undefined as Promise<void> | undefined,
  rendered: vi.fn(),
}));
vi.mock("./comicArchive", () => ({
  openComicArchive: async () => ({
    pages: Array.from({ length: 8 }, (_, index) => ({
      name: `${index + 1}.png`,
      load: async () => new Blob(["original fixture image"]),
    })),
    close: () => {},
  }),
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 4,
      destroy: async () => {},
      getPage: async (page: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({
          userUnit: 1,
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => {
          fixture.rendered(page);
          return {
            promise: fixture.renderGate ?? Promise.resolve(),
            cancel: () => {},
          };
        },
        getTextContent: async () => ({
          items: [{ str: `Original PDF page ${page}` }],
        }),
        cleanup: () => {},
      }),
    }),
    destroy: async () => {},
  }),
  TextLayer: class {
    container: HTMLElement;
    constructor({ container }: { container: HTMLElement }) {
      this.container = container;
    }
    async render() {
      this.container.textContent = "Selectable original PDF text";
    }
    cancel() {}
  },
}));

let root: Root, host: HTMLDivElement, handle: EngineHandle, props: EngineProps;
let osReduced = false;
const listeners = new Set<() => void>();
const active: {
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}[] = [];
const animate = vi.fn(function (
  this: HTMLElement,
  _frames: Keyframe[],
  _options: KeyframeAnimationOptions,
) {
  const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
  active.push(animation);
  return animation as unknown as Animation;
});
let originalAnimate: PropertyDescriptor | undefined,
  originalCreate: PropertyDescriptor | undefined,
  originalRevoke: PropertyDescriptor | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLocale("en");
  osReduced = false;
  listeners.clear();
  active.length = 0;
  animate.mockClear();
  fixture.renderGate = undefined;
  fixture.rendered.mockClear();
  document.documentElement.dataset.motion = "system";
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return osReduced;
    },
    addEventListener: (_event: string, callback: () => void) =>
      listeners.add(callback),
    removeEventListener: (_event: string, callback: () => void) =>
      listeners.delete(callback),
  }));
  originalAnimate = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:fixture/${crypto.randomUUID()}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  const book: Book = {
    id: "comic",
    title: "Original fixture",
    authors: [],
    description: "",
    format: "CBZ",
    color: "",
    progress: 0,
    status: "unread",
    genres: [],
    addedAt: "",
    files: [{ id: "comic-file", name: "fixture.cbz", format: "CBZ" }],
  };
  props = {
    book,
    file: book.files[0]!,
    source: new Blob(["archive"]),
    annotations: [],
    settings: { ...defaultSettings, animation: "slide" },
    onReady: (value) => {
      handle = value;
    },
    onLocation: vi.fn(),
    onAnchor: vi.fn(),
    onClose: vi.fn(),
    onAnnotation: vi.fn(),
    onSelection: vi.fn(),
    onSpeaking: vi.fn(),
    onMediaState: vi.fn(),
    onReadingTap: vi.fn(),
    onError: vi.fn(),
    onNotice: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(listeners.size).toBe(0);
  for (const [target, key, descriptor] of [
    [HTMLElement.prototype, "animate", originalAnimate],
    [URL, "createObjectURL", originalCreate],
    [URL, "revokeObjectURL", originalRevoke],
  ] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  delete document.documentElement.dataset.motion;
  vi.unstubAllGlobals();
});
const renderComic = async () =>
  act(async () => root.render(<ComicView {...props} />));
const displayed = async (images = [...host.querySelectorAll("img")]) =>
  act(async () =>
    images.forEach((image) => image.dispatchEvent(new Event("load"))),
  );
const navigate = async (direction: "next" | "prev") =>
  act(async () => handle[direction]());
const frame = () => animate.mock.calls.at(-1)?.[0][0]?.transform;

it("slides decoded comic pages forward/backward without animating first open, loading placeholders, or boundaries", async () => {
  await renderComic();
  await displayed();
  expect(animate).not.toHaveBeenCalled();
  await navigate("next");
  expect(animate).not.toHaveBeenCalled();
  await displayed();
  expect(frame()).toBe("translateX(100%)");
  expect(animate.mock.instances.at(-1)).toBe(
    host.querySelector(".avid-comic-sheet"),
  );
  await navigate("prev");
  await displayed();
  expect(frame()).toBe("translateX(-100%)");
  expect(active[0]!.cancel).toHaveBeenCalledOnce();
  const count = animate.mock.calls.length;
  await navigate("prev");
  await displayed();
  expect(animate).toHaveBeenCalledTimes(count);
  expect(host.querySelectorAll("img")).toHaveLength(1);
});

it("waits for both spread images and reverses slide direction for RTL without duplicating page DOM", async () => {
  props.settings = { ...props.settings, comicMode: "spread", direction: "rtl" };
  await renderComic();
  await displayed();
  await navigate("next");
  expect(host.querySelector(".avid-comic-pages")?.getAttribute("dir")).toBe(
    "rtl",
  );
  expect(host.querySelectorAll("img")).toHaveLength(2);
  await displayed([host.querySelectorAll("img")[0]!]);
  expect(animate).not.toHaveBeenCalled();
  await displayed([host.querySelectorAll("img")[1]!]);
  expect(frame()).toBe("translateX(-100%)");
  await navigate("prev");
  await displayed();
  expect(frame()).toBe("translateX(100%)");
  expect(host.querySelectorAll("img")).toHaveLength(1);
});

it("cancels active slides for app/OS reduction and animation changes while navigation stays available", async () => {
  await renderComic();
  await displayed();
  await navigate("next");
  await displayed();
  await act(async () => {
    document.documentElement.dataset.motion = "reduce";
  });
  expect(active[0]!.cancel).toHaveBeenCalledOnce();
  await navigate("next");
  await displayed();
  expect(animate).toHaveBeenCalledOnce();
  await act(async () => {
    document.documentElement.dataset.motion = "system";
  });
  await navigate("next");
  await displayed();
  expect(animate).toHaveBeenCalledTimes(2);
  await act(async () => {
    osReduced = true;
    listeners.forEach((listener) => listener());
  });
  expect(active[1]!.cancel).toHaveBeenCalledOnce();
  await navigate("next");
  await displayed();
  expect(animate).toHaveBeenCalledTimes(2);
  await act(async () => {
    osReduced = false;
    listeners.forEach((listener) => listener());
  });
  props.settings = { ...props.settings, animation: "none" };
  await renderComic();
  await navigate("next");
  await displayed();
  expect(animate).toHaveBeenCalledTimes(2);
  expect(props.onLocation).toHaveBeenLastCalledWith(
    pageLocator(6),
    5 / 7,
    "Page 6 of 8",
  );
});

it("moves webtoon Next/Previous to the requested image, preserving scroll checkpoints and continuous calm", async () => {
  props.settings = { ...props.settings, comicMode: "webtoon" };
  await renderComic();
  await displayed();
  const scroll = host.querySelector(".avid-webtoon") as HTMLElement;
  await navigate("next");
  expect(scroll.scrollTop).toBe(500);
  await act(async () => scroll.dispatchEvent(new Event("scroll")));
  expect(props.onLocation).toHaveBeenLastCalledWith(
    pageLocator(2),
    1 / 8,
    "Page 2 of 8",
  );
  await navigate("next");
  expect(scroll.scrollTop).toBe(1000);
  await navigate("prev");
  expect(scroll.scrollTop).toBe(500);
  await act(async () => handle.goTo(pageLocator(4, 0.25)));
  expect(scroll.scrollTop).toBe(1625);
  await act(async () => scroll.dispatchEvent(new Event("scroll")));
  expect(props.onLocation).toHaveBeenLastCalledWith(
    pageLocator(4, 0.25),
    3.25 / 8,
    "Page 4 of 8",
  );
  await navigate("next");
  expect(scroll.scrollTop).toBe(2000);
  await displayed();
  expect(animate).not.toHaveBeenCalled();
});

it("slides only after PDF canvas/text rendering, preserves selection DOM, and cancels stale render completions", async () => {
  props.file = {
    id: "pdf",
    name: "fixture.pdf",
    format: "PDF",
    url: "https://fixture.invalid/original.pdf",
  };
  props.source = undefined;
  const render = async () =>
    act(async () => root.render(<PdfView {...props} />));
  await render();
  expect(animate).not.toHaveBeenCalled();
  let finish!: () => void;
  fixture.renderGate = new Promise((resolve) => {
    finish = resolve;
  });
  await navigate("next");
  expect(animate).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(frame()).toBe("translateX(100%)");
  const surface = host.querySelector(".avid-pdf-page")!;
  const text = host.querySelector(".textLayer")!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.getClientRects = () => [] as unknown as DOMRectList;
  range.selectNodeContents(text);
  selection.addRange(range);
  props.settings = { ...props.settings, animation: "none" };
  await render();
  expect(selection.toString()).toBe("Selectable original PDF text");
  expect(host.querySelector(".avid-pdf-page")).toBe(surface);
  expect(active[0]!.cancel).toHaveBeenCalledOnce();
  selection.removeAllRanges();
  props.settings = { ...props.settings, animation: "slide" };
  await render();
  fixture.renderGate = undefined;
  await navigate("prev");
  expect(frame()).toBe("translateX(-100%)");
  const count = animate.mock.calls.length;
  fixture.renderGate = new Promise((resolve) => {
    finish = resolve;
  });
  await navigate("next");
  fixture.renderGate = undefined;
  await navigate("prev");
  await act(async () => finish());
  expect(animate).toHaveBeenCalledTimes(count);
  expect(props.onLocation).toHaveBeenLastCalledWith(
    pageLocator(1),
    0,
    "Page 1 of 4",
    {pageNumber:1,pageCount:4},
  );
});
