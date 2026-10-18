import { describe, expect, it } from "vitest";
import {
  latestConfirmedPosition,
  handoffPolicyKey,
  validReaderPosition,
  matchingAlignedPlayback,
} from "./readAlongState";
import { readAlongMessages } from "./readAlongMessages";
import type { ReadingAnchor } from "../../../packages/core/src/types";
import type { VerifiedAudioAlignment } from "../../../packages/playback/src/standalone-alignment";
import type { PlaybackBook } from "../../../packages/playback/src/types";

describe("deliberate read/listen position control", () => {
  it("uses a later backward move rather than the furthest percentage", () => {
    const earlier = {
      source: "reading" as const,
      seconds: 900,
      updatedAt: "2026-10-10T10:00:00Z",
    };
    const backward = {
      source: "listening" as const,
      seconds: 120,
      updatedAt: "2026-10-10T10:01:00Z",
    };
    expect(latestConfirmedPosition([earlier, backward])).toBe(backward);
    expect(latestConfirmedPosition([backward, earlier])).toBe(backward);
  });
  it("rejects unusable source positions and scopes policies by account and book", () => {
    expect(
      latestConfirmedPosition([
        {
          source: "reading",
          seconds: NaN,
          updatedAt: new Date().toISOString(),
        },
        { source: "listening", seconds: 10, updatedAt: "bad" },
      ]),
    ).toBeUndefined();
    expect(handoffPolicyKey("a", "12")).not.toBe(handoffPolicyKey("b", "12"));
    expect(handoffPolicyKey("a", "12")).not.toBe(handoffPolicyKey("a", "13"));
  });
  it("provides the new controls and offline instructions in all seven locales", () => {
    for (const values of Object.values(readAlongMessages)) {
      expect(values).toHaveLength(7);
      values.forEach((value) => expect(value.trim()).not.toBe(""));
    }
  });
  it("never commits a preview from another account, title, file or reader format", () => {
    const owner = {
      ownerScope: "a",
      book: { id: "12" },
      file: { id: "31", format: "EPUB" },
    };
    const anchor: ReadingAnchor = {
      bookId: "12",
      fileId: "31",
      kind: "epub",
      locator: "epubcfi(/6/2)",
      progress: 0.2,
      updatedAt: "2026-10-10T10:01:00Z",
    };
    expect(validReaderPosition(owner, "a", anchor)).toBe(true);
    expect(validReaderPosition(owner, "b", anchor)).toBe(false);
    expect(validReaderPosition(null, "a", anchor)).toBe(false);
    expect(validReaderPosition(owner, "a", { ...anchor, bookId: "13" })).toBe(
      false,
    );
    expect(validReaderPosition(owner, "a", { ...anchor, fileId: "32" })).toBe(
      false,
    );
    expect(validReaderPosition(owner, "a", { ...anchor, kind: "audio" })).toBe(
      false,
    );
    expect(
      validReaderPosition(
        { ...owner, file: { id: "31", format: "PDF" } },
        "a",
        anchor,
      ),
    ).toBe(false);
  });
  it("requires the exact canonical audio edition for Latest, follow and Undo", () => {
    const map = {
      edition: {
        accountScope: "a",
        bookId: "12",
        textFileId: "31",
        audioFileId: "32",
        textSha256: "a".repeat(64),
        manifestRevision: "revision-1",
      },
      tracks: [
        { id: "asset-1", duration: 4.167165533 },
        { id: "asset-2", duration: 3.64 },
      ],
    } as unknown as VerifiedAudioAlignment;
    const source: PlaybackBook = {
      bookId: "12",
      fileId: "32",
      title: "Original fixture",
      authors: [],
      manifestRevision: "revision-1",
      tracks: map.tracks.map((track) => ({ ...track, url: "blob:fixture" })),
    };
    expect(matchingAlignedPlayback(map, source, "a")).toBe(true);
    expect(matchingAlignedPlayback(map, null, "a")).toBe(false);
    expect(matchingAlignedPlayback(map, source, "b")).toBe(false);
    expect(matchingAlignedPlayback(map, { ...source, fileId: "33" }, "a")).toBe(
      false,
    );
    expect(
      matchingAlignedPlayback(
        map,
        { ...source, manifestRevision: "revision-2" },
        "a",
      ),
    ).toBe(false);
    expect(
      matchingAlignedPlayback(
        map,
        { ...source, tracks: [...source.tracks].reverse() },
        "a",
      ),
    ).toBe(false);
    expect(
      matchingAlignedPlayback(
        map,
        {
          ...source,
          tracks: [{ ...source.tracks[0]!, duration: 4.2 }, source.tracks[1]!],
        },
        "a",
      ),
    ).toBe(false);
    expect(
      matchingAlignedPlayback(
        map,
        {
          ...source,
          tracks: [
            { ...source.tracks[0]!, decodedDuration: 4.167 },
            source.tracks[1]!,
          ],
        },
        "a",
      ),
    ).toBe(true);
    expect(
      matchingAlignedPlayback(
        map,
        {
          ...source,
          tracks: [
            { ...source.tracks[0]!, decodedDuration: 4.18 },
            source.tracks[1]!,
          ],
        },
        "a",
      ),
    ).toBe(false);
    expect(
      matchingAlignedPlayback(
        map,
        {
          ...source,
          tracks: [
            { ...source.tracks[0]!, decodedDuration: NaN },
            source.tracks[1]!,
          ],
        },
        "a",
      ),
    ).toBe(false);
  });
  it("permits whole-second BookOrbit rounding for generated links only", () => {
    const map = {
      source: "generated",
      edition: {
        accountScope: "a",
        bookId: "12",
        audioFileId: "32",
        manifestRevision: "revision",
      },
      tracks: [{ id: "asset", duration: 16 }],
    } as unknown as VerifiedAudioAlignment;
    const source: PlaybackBook = {
      bookId: "12",
      fileId: "32",
      title: "Title",
      authors: [],
      manifestRevision: "revision",
      tracks: [
        {
          id: "asset",
          duration: 16,
          decodedDuration: 15.86,
          url: "blob:source",
        },
      ],
    };
    expect(matchingAlignedPlayback(map, source, "a")).toBe(true);
    expect(
      matchingAlignedPlayback(
        { ...map, source: "smil" } as unknown as VerifiedAudioAlignment,
        source,
        "a",
      ),
    ).toBe(false);
    expect(
      matchingAlignedPlayback(
        map,
        {
          ...source,
          tracks: [{ ...source.tracks[0]!, decodedDuration: 16.6 }],
        },
        "a",
      ),
    ).toBe(false);
    expect(
      matchingAlignedPlayback(
        map,
        { ...source, tracks: [{ ...source.tracks[0]!, duration: 15.86 }] },
        "a",
      ),
    ).toBe(false);
  });
});
