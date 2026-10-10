import { describe, expect, it } from "vitest";
import type { PlaybackBook } from "../../../packages/playback/src";
import {
  formatPlayerTime,
  playerSeekTime,
  playerTimeline,
} from "./playerTimeline";
import {
  playerMessages,
  playerRemainingLabel,
  playerTranslate,
} from "./playerMessages";
import { LOCALES } from "../../../packages/i18n/src";

const book: PlaybackBook = {
  bookId: "book",
  fileId: "audio",
  title: "Book",
  authors: [],
  tracks: [
    { id: "one", url: "/one", duration: 1000 },
    { id: "two", url: "/two", duration: 2600 },
  ],
  chapters: [
    { id: "a", title: "At the harbor", start: 0, duration: 600 },
    { id: "b", title: "Across the bay", start: 600, duration: 1200 },
    { id: "c", title: "Home again", start: 1800, duration: 1800 },
  ],
};
const state = { currentTime: 900, duration: 3600, rate: 1.5 };

describe("chapter player source clock", () => {
  it("keeps chapter elapsed and remaining in source time while adjusting the complete book estimate", () => {
    const timeline = playerTimeline(book, state);
    expect(timeline).toMatchObject({
      chapter: { id: "b" },
      chapterIndex: 1,
      start: 600,
      duration: 1200,
      elapsed: 300,
      remaining: 900,
      listeningRemaining: 1800,
      previous: { id: "a" },
      next: { id: "c" },
    });
    expect(playerSeekTime(timeline, 1000)).toBe(1600);
    expect(playerRemainingLabel(timeline)).toBe("30:00 remaining at 1.5×");
  });
  it("selects the new chapter exactly at its start and preserves the final chapter at book end", () => {
    expect(playerTimeline(book, { ...state, currentTime: 1800 })).toMatchObject(
      { chapter: { id: "c" }, elapsed: 0, next: null },
    );
    expect(playerTimeline(book, { ...state, currentTime: 3600 })).toMatchObject(
      {
        chapter: { id: "c" },
        elapsed: 1800,
        remaining: 0,
        listeningRemaining: 0,
      },
    );
    expect(playerTimeline(book, { ...state, currentTime: 0 })).toMatchObject({
      previous: null,
      next: { id: "b" },
    });
  });
  it("uses the whole book in a chapter gap and offers actual adjacent chapters", () => {
    const gapped = {
      ...book,
      chapters: [{ ...book.chapters![0]!, duration: 200 }, book.chapters![1]!],
    };
    const timeline = playerTimeline(gapped, { ...state, currentTime: 400 });
    expect(timeline).toMatchObject({
      chapter: null,
      start: 0,
      elapsed: 400,
      duration: 3600,
      previous: { id: "a" },
      next: { id: "b" },
    });
    expect(playerSeekTime(timeline, 450)).toBe(450);
  });
  it("does not claim a book duration from a last known chapter or partial track list", () => {
    const timeline = playerTimeline(book, { ...state, duration: 0 });
    expect(timeline).toMatchObject({
      duration: 1200,
      elapsed: 300,
      remaining: 900,
      bookDuration: null,
      listeningRemaining: null,
    });
    expect(playerRemainingLabel(timeline)).toBe("Duration not available");
    const unknown = playerTimeline(null, { ...state, duration: 0 });
    expect(unknown).toMatchObject({
      duration: null,
      elapsed: 900,
      remaining: null,
      previous: null,
      next: null,
    });
    expect(playerSeekTime(unknown, 10)).toBeNull();
  });
  it("clamps malformed, overlapping and out-of-book chapter intervals without misleading durations", () => {
    const timeline = playerTimeline(
      {
        ...book,
        chapters: [
          { id: "bad", title: "Invalid", start: NaN, duration: 10 },
          { id: "negative", title: "Invalid", start: 0, duration: -5 },
          { id: "b", title: "Second", start: 50, duration: 100 },
          { id: "a", title: "First", start: 0, duration: 80 },
          { id: "c", title: "Beyond", start: 120, duration: 30 },
        ],
      },
      { ...state, currentTime: 55, duration: 100 },
    );
    expect(
      timeline.chapters.map((item) => [item.id, item.start, item.duration]),
    ).toEqual([
      ["a", 0, 50],
      ["b", 50, 50],
    ]);
    expect(timeline).toMatchObject({
      chapter: { id: "b" },
      elapsed: 5,
      remaining: 45,
    });
  });
  it("clamps seeks and invalid times, never renders NaN or negative remaining time", () => {
    const timeline = playerTimeline(book, {
      currentTime: 9999,
      duration: 3600,
      rate: NaN,
    });
    expect(timeline).toMatchObject({
      rate: 1,
      bookElapsed: 3600,
      listeningRemaining: 0,
    });
    expect(playerSeekTime(timeline, -5)).toBe(1800);
    expect(playerSeekTime(timeline, 9999)).toBe(3600);
    expect(playerSeekTime(timeline, NaN)).toBeNull();
    expect(
      playerTimeline(null, { currentTime: NaN, duration: Infinity, rate: 0 }),
    ).toMatchObject({ elapsed: 0, rate: 1, listeningRemaining: null });
    expect(formatPlayerTime(-1)).toBe("0:00");
    expect(formatPlayerTime(3661.8)).toBe("1:01:01");
  });
  it("rounds a positive listening remainder up so an unfinished book is not shown as complete", () => {
    const timeline = playerTimeline(book, {
      currentTime: 3599.8,
      duration: 3600,
      rate: 3,
    });
    expect(playerRemainingLabel(timeline)).toBe("0:01 remaining at 3×");
  });
});

describe("player labels", () => {
  it("provides every new label in all seven locales with matching parameters", () => {
    for (const [key, values] of Object.entries(playerMessages)) {
      expect(values).toHaveLength(LOCALES.length);
      const parameters = values[0].match(/\{\w+\}/g)?.sort() ?? [];
      for (const value of values) {
        expect(value.trim(), key).not.toBe("");
        expect(value.match(/\{\w+\}/g)?.sort() ?? [], key).toEqual(parameters);
      }
    }
  });
  it("formats the rate using the chosen locale and keeps the actual source duration", () => {
    expect(playerRemainingLabel(playerTimeline(book, state), "fr")).toBe(
      "30:00 restantes à 1,5×",
    );
    expect(
      playerTranslate("chapterCount", { current: 2, total: 3 }, "es"),
    ).toBe("Capítulo 2 de 3");
  });
});
