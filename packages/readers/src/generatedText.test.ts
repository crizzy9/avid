// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import * as CFI from "../vendor/foliate/epubcfi.js";
import { extractPublicationText, passageElement } from "./generatedText";
import {
  generateAlignment,
  alignmentTokens,
} from "../../playback/src/generated-alignment";
import { createGeneratedAlignment } from "../../playback/src/standalone-alignment";
import {
  alignedPassageAtRange,
  readPublicationTimedText,
  passageAtLocator,
  verifyPreparedPublication,
} from "./alignedPassage";
import { ReadAlongHighlighter, AUDIO_HIGHLIGHT_CLASS } from "./readAlong";
import { sha256Blob } from "../../core/src/blobHash";
import type { AudioManifest } from "../../core/src/bookorbit";

const html =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Original</title></head><body><h1>A quiet morning</h1><section><p>The river ran beside the little house beneath the ancient bridge.</p><p>After breakfast we followed the winding road into the distant green hills.</p><p hidden="hidden">This secret text is not a reading passage.</p></section></body></html>';
const documentOf = () =>
  new DOMParser().parseFromString(html, "application/xhtml+xml");
const source = {
  sections: [{ id: "chapter.xhtml", createDocument: async () => documentOf() }],
  loadText: async () => html,
  loadBlob: async () => new Blob(),
};
const hash = "a".repeat(64);
const edition = {
  accountScope: "local",
  bookId: "1",
  textFileId: "2",
  audioFileId: "3",
  textSha256: hash,
  manifestRevision: "original",
};
const extract = () =>
  extractPublicationText(source, hash, (_index, range) => CFI.fromRange(range));
async function fixture() {
  const publication = await extract();
  const tracks = [
    {
      assetId: "narration",
      fileId: "3",
      sha256: "b".repeat(64),
      sizeBytes: 100,
      duration: 40,
      words: publication.passages
        .slice(1)
        .flatMap((p, index) =>
          alignmentTokens(p.text).map((text, i) => ({
            text,
            start: 5 + index * 20 + i * 0.5,
            end: 5 + index * 20 + i * 0.5 + 0.4,
          })),
        ),
    },
  ];
  const snapshot = generateAlignment({
    edition,
    publication,
    tracks,
    model: { id: "test", revision: "v1" },
  });
  return {
    publication,
    map: createGeneratedAlignment(snapshot, publication, snapshot.tracks),
  };
}
describe("ordinary EPUB prepared text", () => {
  it("extracts stable source ranges without publisher IDs, excludes hidden text and duplicate parent text", async () => {
    const first = await extract(),
      again = await extract();
    expect(first).toEqual(again);
    expect(first.passages).toHaveLength(3);
    expect(first.passages[1]!.elementPath).toEqual([1, 0]);
    const doc = documentOf(),
      range = CFI.toRange(doc, CFI.parse(first.passages[1]!.textLocator));
    expect(range.toString()).toBe(first.passages[1]!.text);
    expect(first.passages.some((p) => p.text.includes("secret"))).toBe(false);
  });
  it("re-extracts timed text and resolves captured/current exact CFIs on an ordinary EPUB", async () => {
    const { publication, map } = await fixture();
    const doc = documentOf();
    const lines = await readPublicationTimedText(source, map, edition);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe(publication.passages[1]!.text);
    const locator = publication.passages[2]!.textLocator;
    const range = CFI.toRange(doc, CFI.parse(locator));
    expect(alignedPassageAtRange(map, edition, doc, 0, range)?.id).toBe(
      publication.passages[2]!.id,
    );
    expect(
      (
        await passageAtLocator(map, edition, locator, {
          resolve: (value) => ({
            index: 0,
            anchor: (doc) => CFI.toRange(doc, CFI.parse(value)),
          }),
          document: async () => doc,
        })
      )?.id,
    ).toBe(publication.passages[2]!.id);
  });
  it("highlights generated no-ID paragraphs, honors paused backward/gap and held-page navigation", async () => {
    const { map } = await fixture(),
      doc = documentOf();
    const navigated: string[] = [];
    const highlighter = new ReadAlongHighlighter({
      validate: async () => {},
      timedText: () => readPublicationTimedText(source, map, edition),
      contents: () => [{ doc, index: 0 }],
      navigate: async (locator) => {
        navigated.push(locator);
      },
    });
    await highlighter.update(map, edition, 26, { follow: true });
    expect(
      passageElement(doc, map.segments[1]!)!.classList.contains(
        AUDIO_HIGHLIGHT_CLASS,
      ),
    ).toBe(true);
    await highlighter.update(map, edition, 6, { follow: false });
    expect(
      passageElement(doc, map.segments[0]!)!.classList.contains(
        AUDIO_HIGHLIGHT_CLASS,
      ),
    ).toBe(true);
    expect(
      passageElement(doc, map.segments[1]!)!.classList.contains(
        AUDIO_HIGHLIGHT_CLASS,
      ),
    ).toBe(false);
    expect(navigated).toHaveLength(1);
    await highlighter.update(map, edition, 20, { follow: true });
    expect(doc.querySelectorAll("." + AUDIO_HIGHLIGHT_CLASS)).toHaveLength(0);
    highlighter.destroy();
  });
  it("cancels extraction when the reader identity changes", async () => {
    await expect(
      extractPublicationText(
        source,
        hash,
        (_index, range) => CFI.fromRange(range),
        () => false,
      ),
    ).rejects.toThrow("reader changed");
  });
});
async function byteFixture() {
  const bytes = readFileSync("packages/readers/fixtures/audio1.wav");
  let duration = 0;
  for (let offset = 12; offset + 8 < bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "data") {
      duration = size / bytes.readUInt32LE(28);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const blob = new NodeBlob([bytes]) as unknown as Blob,
    publication = await extract();
  const track = {
    assetId: "narration",
    fileId: "3",
    sha256: await sha256Blob(blob),
    sizeBytes: blob.size,
    duration,
    words: alignmentTokens(publication.passages[1]!.text).map((text, i) => ({
      text,
      start: 0.2 + i * 0.1,
      end: 0.28 + i * 0.1,
    })),
  };
  const snapshot = generateAlignment({
    edition,
    publication,
    tracks: [track],
    model: { id: "unit-transcript", revision: "v1" },
  });
  const manifest: AudioManifest = {
    schema: "bookorbit.audiobook-manifest",
    schemaVersion: 2,
    revision: edition.manifestRevision,
    totalDurationMs: duration * 1000,
    chapters: [],
    assets: [
      {
        assetId: track.assetId,
        fileId: 3,
        sequence: 0,
        format: "wav",
        durationMs: duration * 1000,
        sizeBytes: blob.size,
        etag: "fixture",
      },
    ],
  };
  return {
    snapshot,
    manifest,
    publication,
    assets: [{ assetId: track.assetId, fileId: "3", blob }],
    bytes,
  };
}
describe("prepared reader restoration", () => {
  it("rehashes original audio bytes and restores a freshly branded map without a model", async () => {
    const f = await byteFixture();
    const map = await verifyPreparedPublication(
      f.snapshot,
      f.manifest,
      f.assets,
      f.publication,
      edition,
    );
    expect(map.source).toBe("generated");
    expect(map.segments[0]!.textLocator).toBe(
      f.publication.passages[1]!.textLocator,
    );
  });
  it("rejects equal-size changed audio bytes, a different manifest and account", async () => {
    const f = await byteFixture();
    const changed = Buffer.from(f.bytes);
    changed[changed.length - 1] ^= 1;
    await expect(
      verifyPreparedPublication(
        f.snapshot,
        f.manifest,
        [{ ...f.assets[0]!, blob: new NodeBlob([changed]) as unknown as Blob }],
        f.publication,
        edition,
      ),
    ).rejects.toThrow("does not match");
    await expect(
      verifyPreparedPublication(
        f.snapshot,
        { ...f.manifest, revision: "different" },
        f.assets,
        f.publication,
        edition,
      ),
    ).rejects.toThrow("different account or edition");
    await expect(
      verifyPreparedPublication(
        f.snapshot,
        f.manifest,
        f.assets,
        f.publication,
        { ...edition, accountScope: "other" },
      ),
    ).rejects.toThrow("different account or edition");
  });
  it("captures the snapshot before awaiting source reads and rejects a closed reader", async () => {
    const f = await byteFixture();
    const pending = verifyPreparedPublication(
      f.snapshot,
      f.manifest,
      f.assets,
      f.publication,
      edition,
    );
    f.snapshot.edition.bookId = "changed-after-start";
    expect((await pending).edition.bookId).toBe("1");
    await expect(
      verifyPreparedPublication(
        f.snapshot,
        f.manifest,
        f.assets,
        f.publication,
        edition,
        () => false,
      ),
    ).rejects.toThrow();
  });
});
