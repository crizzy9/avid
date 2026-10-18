import { expect, it } from "vitest";
import {
  alignmentTokens,
  generateAlignment,
  type ExtractedPublicationText,
  type GeneratedAudioTrack,
} from "../src/generated-alignment";

function match(text: string | string[], recording: string) {
  const texts = typeof text === "string" ? [text] : text;
  const publication: ExtractedPublicationText = {
    version: 1,
    textSha256: "a".repeat(64),
    passages: texts.map((text, i) => ({
      id: `passage-${i}`,
      text,
      textLocator: `epubcfi(/6/2!/4/${i + 2},/1:0,/1:10)`,
      sectionIndex: 0,
      textHref: "chapter.xhtml",
      elementPath: [i],
    })),
  };
  const tokens = alignmentTokens(recording);
  const tracks: GeneratedAudioTrack[] = [
    {
      assetId: "audio",
      fileId: "3",
      sha256: "b".repeat(64),
      sizeBytes: 100,
      duration: tokens.length + 1,
      words: tokens.map((text, index) => ({
        text,
        start: index,
        end: index + 0.8,
      })),
    },
  ];
  return generateAlignment({
    publication,
    tracks,
    model: { id: "test", revision: "test" },
    edition: {
      accountScope: '["https://example.test","reader"]',
      bookId: "1",
      textFileId: "2",
      textSha256: publication.textSha256,
      audioFileId: "3",
      manifestRevision: "revision",
    },
  });
}

it("leaves overlapping repeated audio occurrences ambiguous", () => {
  expect(() =>
    match(
      "He was gone. He was gone.",
      "He was gone. He was gone. He was gone.",
    ),
  ).toThrow("No sufficiently clear");
});

it("does not discard an exact short match when a neighboring repeated seed gives a wrong start", () => {
  const snapshot = match(
    "Very very very bright lamps shone.",
    "Very very very very bright lamps shone.",
  );
  expect(snapshot.segments[0]!.start).toBe(1);
  expect(snapshot.segments[0]!.end).toBe(6.8);
});

it("keeps independent unique matches when audio includes an unmatched repeated refrain", () => {
  const snapshot = match(
    "Beyond the orchard the old stone gate remained closed.",
    "He was gone. He was gone. Beyond the orchard the old stone gate remained closed.",
  );
  expect(snapshot.segments[0]!.start).toBe(6);
});

it("keeps ordinary constructor text as a string instead of inheriting properties from the title alias object", () => {
  expect(
    alignmentTokens("The constructor builds a useful new object."),
  ).toEqual(["the", "constructor", "builds", "a", "useful", "new", "object"]);
});

it("does not restore a repeated audio paragraph through context after rejecting its ambiguous standalone match", () => {
  const left = Array.from({ length: 35 }, (_, i) => `before${i}`).join(" ");
  const right = Array.from({ length: 35 }, (_, i) => `after${i}`).join(" ");
  const middle = "A silver bird flew above the trees.";
  const snapshot = match(
    [left, middle, right],
    [left, middle, middle, right].join(" "),
  );
  expect(snapshot.segments.map((segment) => segment.id)).toEqual([
    "passage-0",
    "passage-2",
  ]);
});
