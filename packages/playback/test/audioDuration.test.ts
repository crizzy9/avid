import { expect, it, vi } from "vitest";
import { generatedDurationCompatible } from "../src/audioDuration";
import { generateAlignment } from "../src/generated-alignment";
import {
  createGeneratedAlignment,
  alignedPlaybackSeconds,
  handoffToAudio,
  handoffToText,
} from "../src/standalone-alignment";
import type { PlaybackBook, PlaybackSnapshot } from "../src/types";

it("accepts only documented integer-second metadata rounding, keeping precise metadata strict", () => {
  expect(generatedDurationCompatible(16, 15.86)).toBe(true);
  expect(generatedDurationCompatible(16, 16.4)).toBe(true);
  expect(generatedDurationCompatible(16, 16.502)).toBe(true);
  expect(generatedDurationCompatible(16, 16.503)).toBe(false);
  expect(generatedDurationCompatible(15.86, 15.861)).toBe(true);
  expect(generatedDurationCompatible(15.86, 15.948)).toBe(false);
  for (const value of [NaN, Infinity, -1, 0])
    expect(generatedDurationCompatible(16, value)).toBe(false);
});

function fixture() {
  const edition = {
    accountScope: "scope",
    bookId: "12",
    textFileId: "31",
    textSha256: "a".repeat(64),
    audioFileId: "41",
    manifestRevision: "revision",
  };
  const texts = [
    "The silver river ran below the old bridge.",
    "Beyond the orchard a winding road led toward home.",
  ];
  const publication = {
    version: 1 as const,
    textSha256: edition.textSha256,
    passages: texts.map((text, i) => ({
      id: String(i),
      text,
      textLocator: `epubcfi(/6/2!/4/${2 + i * 2},/1:0,/1:10)`,
      sectionIndex: 0,
      textHref: "chapter.xhtml",
      elementPath: [i],
    })),
  };
  const tracks = texts.map((text, i) => ({
    assetId: String(i),
    fileId: String(41 + i),
    sha256: "b".repeat(64),
    sizeBytes: 10,
    duration: 16,
    words: text
      .replace(/[.]/g, "")
      .split(" ")
      .map((text, index) => ({
        text,
        start: 0.1 + index * 0.4,
        end: 0.3 + index * 0.4,
      })),
  }));
  const snapshot = generateAlignment({
    edition,
    publication,
    tracks,
    model: { id: "test", revision: "test" },
  });
  const map = createGeneratedAlignment(snapshot, publication, snapshot.tracks);
  const source: PlaybackBook = {
    bookId: "12",
    fileId: "41",
    title: "Title",
    authors: [],
    manifestRevision: "revision",
    tracks: tracks.map((track) => ({
      id: track.fileId,
      duration: 16,
      decodedDuration: 15.86,
      url: "blob:source",
    })),
  };
  return { edition, publication, map, source };
}

it("allows generated handoff after server rounding without shifting later-track source offsets", () => {
  const { edition, publication, map, source } = fixture();
  const transport = {
    getBook: () => source,
    getSnapshot: () =>
      ({
        bookId: "12",
        fileId: "41",
        trackIndex: 1,
        currentTime: 17,
      }) as PlaybackSnapshot,
    pause: vi.fn(),
    load: vi.fn(),
  };
  handoffToAudio(
    map,
    edition,
    publication.passages[1]!.textLocator,
    transport,
    source,
  );
  expect(transport.load).toHaveBeenCalledWith(source, 16.1);
  expect(handoffToText(map, edition, transport)?.segmentId).toBe("1");
  source.tracks[0]!.decodedDuration = 16.8;
  expect(() => handoffToText(map, edition, transport)).toThrow(
    "decoded audio duration",
  );
});

it("does not interpret the first track's longer decoded tail as the next track's paragraph or pause it", () => {
  const { edition, map, source } = fixture();
  source.tracks[0]!.decodedDuration = 16.4;
  const state = {
    bookId: "12",
    fileId: "41",
    trackIndex: 0,
    currentTime: 16.2,
  };
  const transport = {
    getBook: () => source,
    getSnapshot: () => state as PlaybackSnapshot,
    pause: vi.fn(),
    load: vi.fn(),
  };
  expect(alignedPlaybackSeconds(map, state)).toBeNull();
  expect(handoffToText(map, edition, transport)).toBeNull();
  expect(transport.pause).not.toHaveBeenCalled();
  state.trackIndex = 1;
  expect(alignedPlaybackSeconds(map, state)).toBe(16.2);
  expect(handoffToText(map, edition, transport)?.segmentId).toBe("1");
});

it("rejects invalid source ownership, track identities, and half-open terminal positions", () => {
  const { map } = fixture();
  const state = { bookId: "12", fileId: "41", trackIndex: 0, currentTime: 1 };
  expect(alignedPlaybackSeconds(map, state)).toBe(1);
  for (const change of [
    { bookId: "other" },
    { fileId: "other" },
    { trackIndex: -1 },
    { trackIndex: 0.5 },
    { trackIndex: 2 },
    { currentTime: NaN },
    { currentTime: -1 },
    { currentTime: 16 },
  ])
    expect(alignedPlaybackSeconds(map, { ...state, ...change })).toBeNull();
});

it("rechecks the active track after pause before returning a text target", () => {
  const { edition, map, source } = fixture();
  const state = { bookId: "12", fileId: "41", trackIndex: 1, currentTime: 17 };
  const transport = {
    getBook: () => source,
    getSnapshot: () => state as PlaybackSnapshot,
    pause: vi.fn(() => {
      state.trackIndex = 0;
    }),
    load: vi.fn(),
  };
  expect(handoffToText(map, edition, transport)).toBeNull();
});
