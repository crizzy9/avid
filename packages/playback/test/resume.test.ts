import { describe, expect, it } from "vitest";
import { resolveAudioResume, type PlaybackBook } from "../src";
const book: PlaybackBook = {
  bookId: "1",
  fileId: "11",
  title: "Book",
  authors: [],
  manifestRevision: "revision-2",
  tracks: [
    { id: "11", url: "/one", duration: 100 },
    { id: "12", url: "/two", duration: 50 },
  ],
};
describe("edition-safe audio resume", () => {
  it("uses the identified track offset instead of an outdated aggregate value", () => {
    expect(
      resolveAudioResume(
        book,
        JSON.stringify({ version: 1, trackId: "12", trackTime: 20, time: 20 }),
      ),
    ).toBe(120);
  });
  it("refuses changed editions, missing tracks, and positions beyond a track", () => {
    expect(() =>
      resolveAudioResume(
        book,
        JSON.stringify({
          trackId: "12",
          trackTime: 20,
          manifestRevision: "revision-1",
        }),
      ),
    ).toThrow("edition changed");
    expect(() =>
      resolveAudioResume(
        book,
        JSON.stringify({ trackId: "13", trackTime: 20 }),
      ),
    ).toThrow("no longer available");
    expect(() =>
      resolveAudioResume(
        book,
        JSON.stringify({ trackId: "12", trackTime: 90 }),
      ),
    ).toThrow("beyond");
  });
  it("retains valid legacy source seconds and rejects malformed positions", () => {
    expect(resolveAudioResume(book, "12.5")).toBe(12.5);
    expect(resolveAudioResume(book, '{"time":25}')).toBe(25);
    for (const value of ["null", "-1", "{}", '{"time":"25"}'])
      expect(() => resolveAudioResume(book, value)).toThrow();
  });
});
