// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Reader } from "./Reader";
import { defaultSettings } from "./contracts";
import type {
  Book,
  ReaderPreferencePort,
  ReaderPreferenceValues,
  ReaderSettings,
} from "./contracts";
vi.mock("./EbookView", () => ({
  EbookView: ({ settings }: { settings: ReaderSettings }) => (
    <div
      data-font-size={settings.fontSize}
      data-line-height={settings.lineHeight}
    />
  ),
}));
vi.mock("./PdfView", () => ({ PdfView: () => null }));
vi.mock("./ComicView", () => ({ ComicView: () => null }));
const book: Book = {
  id: "4",
  title: "Original title",
  authors: [],
  description: "",
  format: "EPUB",
  color: "",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "",
  files: [{ id: "5", name: "Book.epub", format: "EPUB" }],
};
let root: Root, host: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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
  vi.restoreAllMocks();
  host.remove();
});
const render = async (preferences?: ReaderPreferencePort, fileId = "5") =>
  act(async () =>
    root.render(
      <Reader
        accountScope="account"
        book={book}
        file={{ ...book.files[0], id: fileId }}
        preferences={preferences}
        annotations={[]}
        onClose={() => {}}
        onAnchor={() => {}}
        onAnnotation={() => {}}
      />,
    ),
  );
const click = async (label: string) =>
  act(async () => {
    (
      host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
    ).click();
  });
it("does not overwrite a user change when a slow server preference load finishes", async () => {
  const load = deferred<ReaderPreferenceValues>(),
    patch = vi.fn().mockResolvedValue(undefined);
  await render({
    id: "account-file-5",
    readOnly: false,
    load: () => load.promise,
    patch,
  });
  await click("Reading settings");
  await click("Increase font size");
  expect(patch).toHaveBeenCalledWith({
    fontSize: defaultSettings.fontSize + 1,
  });
  await act(async () => load.resolve({ fontSize: 14, lineHeight: 2 }));
  expect(
    host.querySelector("[data-font-size]")?.getAttribute("data-font-size"),
  ).toBe(String(defaultSettings.fontSize + 1));
  expect(
    host.querySelector("[data-line-height]")?.getAttribute("data-line-height"),
  ).toBe("2");
  expect(patch).toHaveBeenCalledTimes(1);
});
it("does not apply a prior file’s late settings or persist them over the new edition", async () => {
  const old = deferred<ReaderPreferenceValues>();
  await render({
    id: "file-5",
    readOnly: false,
    load: () => old.promise,
    patch: vi.fn(),
  });
  await render(
    {
      id: "file-6",
      readOnly: false,
      load: async () => ({ fontSize: 15 }),
      patch: vi.fn(),
    },
    "6",
  );
  await act(async () => old.resolve({ fontSize: 31 }));
  expect(
    host.querySelector("[data-font-size]")?.getAttribute("data-font-size"),
  ).toBe("15");
  expect(
    JSON.parse(localStorage.getItem("avid.reader.settings.v2.account.6")!)
      .fontSize,
  ).toBe(15);
});
it("keeps file settings separate when using local files without a server adapter", async () => {
  await render();
  await click("Reading settings");
  await click("Increase font size");
  await render(undefined, "6");
  expect(
    host.querySelector("[data-font-size]")?.getAttribute("data-font-size"),
  ).toBe(String(defaultSettings.fontSize));
  await render();
  expect(
    host.querySelector("[data-font-size]")?.getAttribute("data-font-size"),
  ).toBe(String(defaultSettings.fontSize + 1));
});
it("keeps the reader available with a notice when local preference storage fails", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await render();
  expect(host.querySelector("[data-font-size]")).not.toBeNull();
  expect(host.textContent).toContain("Could not save this preference.");
});
