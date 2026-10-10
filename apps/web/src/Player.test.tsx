// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Player } from "./Player";
import {
  PlaybackController,
  type AudioElement,
  type PlaybackBook,
} from "../../../packages/playback/src";
import type { Book } from "../../../packages/core/src/types";
import { setLocale } from "../../../packages/i18n/src";

class TestAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 1000;
  playbackRate = 1;
  preservesPitch = true;
  paused = true;
  ended = false;
  error = null;
  preload = "";
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  load = vi.fn();
  removeAttribute = vi.fn();
}
const source: PlaybackBook = {
  bookId: "book",
  fileId: "audio",
  title: "The island",
  authors: ["A Reader"],
  tracks: [
    { id: "track-one", url: "/one.mp3", duration: 1000 },
    { id: "track-two", url: "/two.mp3", duration: 2600 },
  ],
  chapters: [
    { id: "a", title: "At the harbor", start: 0, duration: 600 },
    { id: "b", title: "Across the bay", start: 600, duration: 1200 },
    { id: "c", title: "Home again", start: 1800, duration: 1800 },
  ],
};
const book: Book = {
  id: "book",
  title: "The island",
  authors: ["A Reader"],
  description: "An adventure",
  format: "AUDIO",
  files: [{ id: "audio", name: "The island.mp3", format: "AUDIO" }],
  genres: [],
  color: "#345b70",
  progress: 0.25,
  status: "reading",
  addedAt: "2026-10-10",
};
let host: HTMLDivElement,
  root: Root,
  audio: TestAudio,
  controller: PlaybackController;
let onRead: ReturnType<typeof vi.fn>, onNote: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLocale("en");
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  audio = new TestAudio();
  controller = new PlaybackController({
    audio: audio as unknown as AudioElement,
    mediaSession: null,
  });
  controller.load(source, 900);
  controller.setRate(1.5);
  onRead = vi.fn();
  onNote = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  controller.destroy();
  host.remove();
  vi.restoreAllMocks();
  setLocale("en");
});
async function render(extra: Partial<ComponentProps<typeof Player>> = {}) {
  await act(async () =>
    root.render(
      <Player
        controller={controller}
        book={book}
        onRead={onRead}
        onNote={onNote}
        {...extra}
      />,
    ),
  );
}
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function change(
  node: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

describe("chapter-focused player", () => {
  it("shows chapter-relative source times and whole-book remaining at the selected speed", async () => {
    await render();
    const range = host.querySelector<HTMLInputElement>(
      'input[aria-label="Chapter position"]',
    )!;
    expect(range.max).toBe("1200");
    expect(range.value).toBe("300");
    expect(range.getAttribute("aria-valuetext")).toBe("5:00 of 20:00");
    expect(host.querySelector("h3")?.textContent).toBe("Across the bay");
    expect(host.querySelector(".timeline-labels")?.textContent).toBe(
      "5:00−15:00",
    );
    expect(host.textContent).toContain("Chapter 2 of 3");
    expect(host.textContent).toContain("30:00 remaining at 1.5×");
    await change(range, "1000");
    expect(controller.getSnapshot()).toMatchObject({
      currentTime: 1600,
      trackIndex: 1,
    });
    expect(audio.src).toBe("/two.mp3");
    audio.duration = 2600;
    await act(async () => audio.dispatchEvent(new Event("loadedmetadata")));
    expect(audio.currentTime).toBe(600);
  });
  it("keeps dedicated chapter navigation separate from time skips even when system commands skip chapters", async () => {
    controller.configureRemote({ mode: "chapter", seconds: 30 });
    await render();
    await click("Back 30 seconds");
    expect(controller.getSnapshot().currentTime).toBe(870);
    await click("Forward 30 seconds");
    expect(controller.getSnapshot().currentTime).toBe(900);
    await click("Next chapter");
    expect(controller.getSnapshot().currentTime).toBe(1800);
    expect(button("Next chapter").disabled).toBe(true);
    await click("Previous chapter");
    expect(controller.getSnapshot().currentTime).toBe(600);
    await click("Previous chapter");
    expect(controller.getSnapshot().currentTime).toBe(0);
    expect(button("Previous chapter").disabled).toBe(true);
  });
  it("keeps one pointer drag on its captured chapter when reaching the chapter boundary", async () => {
    await render();
    const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    await act(async () =>
      range.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    await change(range, "1200");
    expect(controller.getSnapshot().currentTime).toBe(1800);
    expect(range.max).toBe("1200");
    expect(host.querySelector("h3")?.textContent).toBe("Across the bay");
    await change(range, "1100");
    expect(controller.getSnapshot().currentTime).toBe(1700);
    await change(range, "1200");
    await act(async () =>
      range.dispatchEvent(new Event("pointerup", { bubbles: true })),
    );
    expect(range.max).toBe("1800");
    expect(range.value).toBe("0");
    expect(host.querySelector("h3")?.textContent).toBe("Home again");
  });
  it("lists durations instead of starts, marks the active chapter and seeks on selection", async () => {
    await render();
    await click("Chapters");
    const rows = [
      ...host.querySelectorAll<HTMLButtonElement>(".chapter-list button"),
    ];
    expect(rows.map((row) => row.querySelector("small")?.textContent)).toEqual([
      "10:00",
      "20:00",
      "30:00",
    ]);
    expect(rows[1]?.getAttribute("aria-current")).toBe("true");
    await act(async () => rows[2]!.click());
    expect(controller.getSnapshot().currentTime).toBe(1800);
    expect(rows[2]?.getAttribute("aria-current")).toBe("true");
  });
  it("retains play/pause, 1.1× speed, sleep, note, read and supplied application controls", async () => {
    await render({
      readAlong: <p>Mapped passage</p>,
      offlineControl: <button>Keep on device</button>,
    });
    await click("Play");
    expect(controller.getSnapshot().status).toBe("playing");
    await click("Pause");
    expect(controller.getSnapshot().status).toBe("paused");
    const speed = [...host.querySelectorAll("select")].find((node) =>
      [...node.options].some((option) => option.value === "1.1"),
    )!;
    await change(speed, "1.1");
    expect(controller.getSnapshot().rate).toBe(1.1);
    expect(audio.playbackRate).toBe(1.1);
    await change(
      host.querySelector<HTMLSelectElement>(
        'select[aria-label="Sleep timer"]',
      )!,
      "chapter",
    );
    expect(controller.getSnapshot().sleepAtChapterEnd).toBe(1800);
    await click("Read from here");
    await click("Add note");
    expect(onRead).toHaveBeenCalledOnce();
    expect(onNote).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Mapped passage");
    expect(button("Keep on device")).toBeDefined();
  });
  it("falls back to the book timeline without chapters and disables seeks when duration is unknown", async () => {
    controller.load({ ...source, chapters: [] }, 900);
    await render();
    const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(range.max).toBe("3600");
    expect(range.value).toBe("900");
    expect(range.disabled).toBe(false);
    expect(button("Next chapter").disabled).toBe(true);
    expect(button("Previous chapter").disabled).toBe(true);
    await act(async () =>
      controller.load({
        ...source,
        chapters: [],
        tracks: [{ id: "unknown", url: "/unknown" }],
      }),
    );
    expect(range.disabled).toBe(true);
    expect(host.textContent).toContain("Duration not available");
    expect(host.querySelector("progress")).toBeNull();
  });
  it("updates chapter and remaining time after an external controller seek or speed change", async () => {
    await render();
    await act(async () => {
      controller.seek(2000);
      controller.setRate(2);
    });
    expect(host.querySelector("h3")?.textContent).toBe("Home again");
    expect(
      host.querySelector<HTMLInputElement>('input[type="range"]')!.value,
    ).toBe("200");
    expect(host.textContent).toContain("13:20 remaining at 2×");
  });
});
