import { describe, expect, it, vi } from "vitest";
import {
  PlaybackController,
  normalizeRemotePolicy,
  readRemotePolicy,
  remoteSkipPosition,
  type AudioElement,
  type PlaybackBook,
  type PlaybackSnapshot,
} from "../src";

const book: PlaybackBook = {
  bookId: "book",
  fileId: "audio",
  title: "Book",
  authors: [],
  tracks: [{ id: "track", url: "/audio", duration: 200 }],
  chapters: [
    { id: "1", title: "One", start: 10, duration: 40 },
    { id: "2", title: "Two", start: 60, duration: 60 },
    { id: "3", title: "Three", start: 150, duration: 50 },
  ],
};
const state = (time: number): PlaybackSnapshot => ({
  status: "paused",
  bookId: "book",
  fileId: "audio",
  title: "Book",
  currentTime: time,
  duration: 200,
  trackIndex: 0,
  chapterIndex: -1,
  rate: 1,
  sleepUntil: null,
  sleepAtChapterEnd: null,
  error: null,
});
const chapter = { mode: "chapter" as const, seconds: 15 };
describe("remote skip source policy", () => {
  it("uses source starts through chapter gaps and the exact end, without wrapping", () => {
    expect(remoteSkipPosition(book, state(0), 1, chapter)).toBe(10);
    expect(remoteSkipPosition(book, state(55), -1, chapter)).toBe(10);
    expect(remoteSkipPosition(book, state(55), 1, chapter)).toBe(60);
    expect(remoteSkipPosition(book, state(61), -1, chapter)).toBe(10);
    expect(remoteSkipPosition(book, state(65), -1, chapter)).toBe(60);
    expect(remoteSkipPosition(book, state(200), -1, chapter)).toBe(150);
    expect(remoteSkipPosition(book, state(200), 1, chapter)).toBe(200);
  });
  it("uses a bounded time fallback when chapters are unavailable", () => {
    expect(
      remoteSkipPosition({ ...book, chapters: [] }, state(80), -1, chapter),
    ).toBe(65);
    expect(
      remoteSkipPosition(
        { ...book, chapters: undefined },
        state(195),
        1,
        chapter,
      ),
    ).toBe(200);
    expect(
      remoteSkipPosition(book, state(4), -1, { mode: "time", seconds: 30 }),
    ).toBe(0);
  });
  it("restores only valid bounded settings and survives unavailable storage", () => {
    expect(normalizeRemotePolicy({ mode: "chapter", seconds: 999 })).toEqual({
      mode: "chapter",
      seconds: 300,
    });
    expect(normalizeRemotePolicy({ seconds: NaN })).toEqual({
      mode: "time",
      seconds: 30,
    });
    expect(readRemotePolicy({ getItem: () => "{bad" })).toEqual({
      mode: "time",
      seconds: 30,
    });
    expect(
      readRemotePolicy({
        getItem: () => {
          throw new Error("storage unavailable");
        },
      }),
    ).toEqual({ mode: "time", seconds: 30 });
  });
  it("applies independent source-time skips to system handlers while preserving legacy symmetric policies", () => {
    const policy = normalizeRemotePolicy({ mode: "time", seconds: 30, backwardSeconds: 15, forwardSeconds: 45 });
    expect(remoteSkipPosition(book, state(80), -1, policy)).toBe(65);
    expect(remoteSkipPosition(book, state(80), 1, policy)).toBe(125);
    expect(normalizeRemotePolicy({ seconds: 45 })).toEqual({ mode: "time", seconds: 45 });
    expect(normalizeRemotePolicy({ seconds: 30, backwardSeconds: -2, forwardSeconds: 999 })).toEqual({ mode: "time", seconds: 30, backwardSeconds: 1, forwardSeconds: 300 });
  });
  it("applies a changed policy to existing system media handlers", () => {
    const handlers = new Map<
      MediaSessionAction,
      MediaSessionActionHandler | null
    >();
    const audio = Object.assign(new EventTarget(), {
      src: "",
      currentTime: 0,
      duration: 200,
      playbackRate: 1,
      preservesPitch: true,
      paused: true,
      ended: false,
      error: null,
      preload: "",
      load: vi.fn(),
      removeAttribute: vi.fn(),
      play: vi.fn(async () => {}),
      pause: vi.fn(),
    }) as AudioElement;
    const media = {
      setActionHandler: (
        name: MediaSessionAction,
        handler: MediaSessionActionHandler | null,
      ) => handlers.set(name, handler),
      setPositionState: vi.fn(),
    } as unknown as MediaSession;
    const controller = new PlaybackController({
      audio,
      mediaSession: media,
      remotePolicy: { mode: "time", seconds: 15 },
    });
    try {
      controller.load(book, 60);
      (audio as unknown as EventTarget).dispatchEvent(
        new Event("loadedmetadata"),
      );
      handlers.get("nexttrack")!({ action: "nexttrack" });
      expect(controller.getSnapshot().currentTime).toBe(75);
      controller.configureRemote({mode: "time", seconds: 30, backwardSeconds: 10, forwardSeconds: 25});
      handlers.get("seekbackward")!({action:"seekbackward"});
      expect(controller.getSnapshot().currentTime).toBe(65);
      handlers.get("seekforward")!({action:"seekforward"});
      expect(controller.getSnapshot().currentTime).toBe(90);
      controller.configureRemote(chapter);
      handlers.get("previoustrack")!({ action: "previoustrack" });
      expect(controller.getSnapshot().currentTime).toBe(60);
      handlers.get("seekforward")!({ action: "seekforward" });
      expect(controller.getSnapshot().currentTime).toBe(150);
    } finally {
      controller.destroy();
    }
  });
});
