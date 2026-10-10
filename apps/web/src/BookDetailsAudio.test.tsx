// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookDetails } from "./BookDetails";
import {
  BookOrbitClient,
  type PlaybackSource,
} from "../../../packages/core/src/bookorbit";
import type { Book, ReadingAnchor } from "../../../packages/core/src/types";
import { setLocale } from "../../../packages/i18n/src";

const book: Book = {
  id: "12",
  title: "Independent audio progress",
  authors: ["Avid"],
  description: "An original fixture",
  color: "#345b70",
  format: "EPUB",
  progress: 0.99,
  status: "reading",
  genres: [],
  addedAt: "2026-10-10",
  files: [
    { id: "31", name: "Text.epub", format: "EPUB" },
    { id: "41", name: "Audio.m4b", format: "AUDIO" },
  ],
};
const source: PlaybackSource = {
  bookId: "12",
  fileId: "41",
  title: book.title,
  authors: book.authors,
  manifestRevision: "revision-1",
  chapters: [],
  tracks: [
    { id: "a", url: "/audio/a", duration: 600 },
    { id: "b", url: "/audio/b", duration: 1200 },
  ],
};
const checkpoint: ReadingAnchor = {
  bookId: "12",
  fileId: "41",
  kind: "audio",
  locator: JSON.stringify({
    version: 1,
    trackId: "b",
    trackTime: 300,
    time: 5,
    manifestRevision: "revision-1",
  }),
  progress: 0.5,
  updatedAt: "2026-10-10T00:00:00Z",
};
let host: HTMLDivElement,
  root: Root,
  client: BookOrbitClient,
  props: ComponentProps<typeof BookDetails>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLocale("en");
  client = new BookOrbitClient({
    profile: { id: "fixture", name: "Fixture", url: "https://fixture.invalid" },
    userId: "reader",
    accessToken: "fixture",
  });
  vi.spyOn(client, "getBook").mockResolvedValue(book);
  vi.spyOn(client, "getPlaybackSource").mockResolvedValue(source);
  vi.spyOn(client, "getProgress").mockResolvedValue(checkpoint);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    book,
    client,
    collections: [],
    annotations: [],
    readOnly: true,
    onRead: vi.fn(),
    onListen: vi.fn(),
    onQueue: vi.fn(),
    onStatus: vi.fn(),
    onShowNotes: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function render(
  changes: Partial<ComponentProps<typeof BookDetails>> = {},
) {
  props = { ...props, ...changes };
  await act(async () => root.render(<BookDetails {...props} />));
}

describe("book sheet audiobook time", () => {
  it("uses the active player's supplied speed-adjusted time without fetching a second source", async () => {
    await render({ audioRemaining: "10:00 remaining at 1.5×" });
    expect(
      host.querySelector(".book-detail-audio-remaining")?.textContent,
    ).toBe("10:00 remaining at 1.5×");
    expect(client.getPlaybackSource).not.toHaveBeenCalled();
    expect(client.getProgress).not.toHaveBeenCalled();
  });
  it("resolves audio track time independently of ebook percentage and stale aggregate time", async () => {
    await render();
    expect(client.getProgress).toHaveBeenCalledWith({
      bookId: "12",
      fileId: "41",
      kind: "audio",
    });
    expect(
      host.querySelector(".book-detail-audio-remaining")?.textContent,
    ).toBe("15:00 remaining at 1×");
    expect(host.textContent).not.toContain("0:18 remaining");
  });
  it("does not invent remaining time when the manifest revision no longer matches", async () => {
    vi.mocked(client.getProgress).mockResolvedValue({
      ...checkpoint,
      locator: JSON.stringify({
        version: 1,
        trackId: "b",
        trackTime: 300,
        time: 900,
        manifestRevision: "old-revision",
      }),
    });
    await render();
    expect(host.querySelector(".book-detail-audio-remaining")).toBeNull();
  });
  it("discards a delayed previous account's audio response", async () => {
    let resolve!: (value: PlaybackSource) => void;
    vi.mocked(client.getPlaybackSource).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    const next = new BookOrbitClient({
      profile: { id: "next", name: "Next", url: "https://next.invalid" },
      userId: "reader",
      accessToken: "fixture",
    });
    vi.spyOn(next, "getBook").mockResolvedValue(book);
    vi.spyOn(next, "getPlaybackSource").mockResolvedValue({
      ...source,
      tracks: [{ id: "c", url: "/audio/c", duration: 120 }],
    });
    vi.spyOn(next, "getProgress").mockResolvedValue(null);
    await render({ client: next });
    expect(
      host.querySelector(".book-detail-audio-remaining")?.textContent,
    ).toBe("2:00 remaining at 1×");
    await act(async () => resolve(source));
    expect(
      host.querySelector(".book-detail-audio-remaining")?.textContent,
    ).toBe("2:00 remaining at 1×");
  });
});
