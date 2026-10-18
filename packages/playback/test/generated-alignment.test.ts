import { describe, expect, it } from "vitest";
import {
  alignmentTokens,
  generateAlignment,
  validateGeneratedAlignment,
  type ExtractedPublicationText,
  type GeneratedAudioTrack,
} from "../src/generated-alignment";
import {
  createGeneratedAlignment,
  assertStandaloneAlignment,
  alignedTextTarget,
  alignedAudioAnchor,
} from "../src/standalone-alignment";

const first =
  "The small river curved through the valley beneath the old stone bridge.";
const second =
  "Beyond the silent orchard a narrow path led home before the evening rain.";
const hash = "a".repeat(64);
const edition = {
  accountScope: '["https://example.test","reader"]',
  bookId: "1",
  textFileId: "2",
  textSha256: hash,
  audioFileId: "3",
  manifestRevision: "original-recording",
};
function passage(text: string, index: number) {
  return {
    id: `0:${index}`,
    text,
    textLocator: `epubcfi(/6/2!/4/${2 * (index + 1)},/1:0,/1:${text.length})`,
    sectionIndex: 0,
    textHref: "chapter.xhtml",
    elementPath: [index],
  };
}
function words(text: string, start = 2) {
  return alignmentTokens(text).map((text, i) => ({
    text,
    start: start + i * 0.4,
    end: start + i * 0.4 + 0.3,
  }));
}
function fixture(texts = [first, second]) {
  const publication: ExtractedPublicationText = {
    version: 1,
    textSha256: hash,
    passages: texts.map(passage),
  };
  const tracks: GeneratedAudioTrack[] = [
    {
      assetId: "recording",
      fileId: "3",
      sha256: "b".repeat(64),
      sizeBytes: 100,
      duration: 30,
      words: [
        ...words("An original recording begins now", 0),
        ...words(first, 4),
        ...words(second, 17),
      ],
    },
  ];
  return {
    edition,
    publication,
    tracks,
    model: { id: "test-recognizer", revision: "test-v1" },
  };
}
describe("generated source alignment", () => {
  it("uses observed word times, leaves introductions/silence/end gaps and hands off both ways", () => {
    const input = fixture(),
      snapshot = generateAlignment(input);
    expect(snapshot.segments.map((s) => [s.start, s.end])).toEqual([
      [4, 8.700000000000001],
      [17, 22.1],
    ]);
    expect(snapshot.coverage).toEqual({
      matchedPassages: 2,
      totalPassages: 2,
      matchedWords: 25,
      totalWords: 25,
    });
    const map = createGeneratedAlignment(
      snapshot,
      input.publication,
      snapshot.tracks,
    );
    expect(map.source).toBe("generated");
    expect(alignedTextTarget(map, edition, 0)).toBeNull();
    expect(alignedTextTarget(map, edition, 12)).toBeNull();
    expect(alignedTextTarget(map, edition, 30)).toBeNull();
    expect(alignedTextTarget(map, edition, 18)?.locator).toBe(
      input.publication.passages[1]!.textLocator,
    );
    expect(
      JSON.parse(
        alignedAudioAnchor(
          map,
          edition,
          input.publication.passages[1]!.textLocator,
        )!.locator,
      ).time,
    ).toBe(17);
    expect(() =>
      assertStandaloneAlignment(JSON.parse(JSON.stringify(map)), edition),
    ).toThrow("Fresh verified");
    expect(Object.isFrozen(map.segments[0]!.textElementPath)).toBe(true);
  });
  it("accepts a small real transcription error using token agreement, without stretching timings", () => {
    const input = fixture();
    input.tracks[0]!.words.find((w) => w.text === "curved")!.text = "turned";
    const snapshot = generateAlignment(input);
    expect(snapshot.segments[0]!.confidence).toBeCloseTo(11 / 12);
    expect(snapshot.segments[0]!.start).toBe(4);
    expect(snapshot.segments[0]!.end).toBeCloseTo(8.7);
  });
  it("rejects repeated audio occurrences instead of choosing one from progress or order", () => {
    const input = fixture();
    input.tracks[0]!.duration = 60;
    input.tracks[0]!.words.push(...words(first, 40));
    const snapshot = generateAlignment(input);
    expect(snapshot.segments.map((s) => s.id)).toEqual(["0:1"]);
    expect(snapshot.coverage.matchedWords).toBe(13);
  });
  it("does not match duplicate ebook text, very short phrases or unrelated recordings", () => {
    expect(() => generateAlignment(fixture([first, first]))).toThrow(
      "No sufficiently clear",
    );
    expect(() => generateAlignment(fixture(["The old bridge"]))).toThrow(
      "No sufficiently clear",
    );
    expect(() =>
      generateAlignment(
        fixture([
          "Completely unrelated planets orbit distant suns far beyond human history and knowledge.",
        ]),
      ),
    ).toThrow("No sufficiently clear");
  });
  it("keeps canonical multi-track offsets, not transcript endpoints", () => {
    const input = fixture();
    input.tracks[0]!.words = words(first, 4);
    input.tracks.push({
      ...input.tracks[0]!,
      assetId: "part-two",
      fileId: "4",
      sha256: "c".repeat(64),
      words: words(second, 3),
    });
    const snapshot = generateAlignment(input);
    expect(snapshot.segments[1]!.start).toBe(33);
    expect(snapshot.segments[1]!.trackTime).toBe(3);
    expect(snapshot.segments[1]!.trackId).toBe("4");
  });
  it("does not invent separate timestamps inside a recognizer chunk", () => {
    const input = fixture([first]);
    input.tracks[0]!.words = [{ text: first, start: 6, end: 11 }];
    const snapshot = generateAlignment(input);
    expect(snapshot.segments[0]!.start).toBe(6);
    expect(snapshot.segments[0]!.end).toBe(11);
  });
  it.each([
    "hash",
    "source-text",
    "source-cfi",
    "source-path",
    "audio-hash",
    "audio-order",
  ] as const)("refuses restoring changed %s", (defect) => {
    const input = fixture(),
      snapshot = generateAlignment(input),
      publication = structuredClone(input.publication),
      audio = structuredClone(snapshot.tracks);
    if (defect === "hash") publication.textSha256 = "e".repeat(64);
    if (defect === "source-text") publication.passages[0]!.text += " changed";
    if (defect === "source-cfi")
      publication.passages[0]!.textLocator += "changed";
    if (defect === "source-path") publication.passages[0]!.elementPath = [99];
    if (defect === "audio-hash") audio[0]!.sha256 = "f".repeat(64);
    if (defect === "audio-order") audio[0]!.fileId = "99";
    expect(() =>
      createGeneratedAlignment(snapshot, publication, audio),
    ).toThrow("does not match");
  });
  it.each([
    "timing",
    "overlap",
    "confidence",
    "path",
    "coverage",
    "track",
    "cfi",
  ] as const)("rejects malformed persisted %s", (defect) => {
    const snapshot = generateAlignment(fixture());
    if (defect === "timing") snapshot.segments[0]!.start = NaN;
    if (defect === "overlap") snapshot.segments[1]!.start = 8;
    if (defect === "confidence") snapshot.segments[0]!.confidence = 0.4;
    if (defect === "path") snapshot.segments[0]!.textElementPath = [99];
    if (defect === "coverage") snapshot.coverage.matchedPassages = 99;
    if (defect === "track") snapshot.tracks[0]!.duration = 0;
    if (defect === "cfi") snapshot.passages[0]!.textLocator = "30%";
    expect(() => validateGeneratedAlignment(snapshot)).toThrow();
  });
  it("rejects invalid and out-of-order recognizer boundaries", () => {
    const input = fixture();
    input.tracks[0]!.words[2]!.start = -1;
    expect(() => generateAlignment(input)).toThrow();
  });
});
