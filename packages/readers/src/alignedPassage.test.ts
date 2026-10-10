// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EPUB } from "../vendor/foliate/epub.js";
import * as CFI from "../vendor/foliate/epubcfi.js";
import {
  alignedPassageAtRange,
  passageAtLocator,
  passageText,
  readPublicationTimedText,
  verifyPublicationAudiobook,
  verifyPublicationPlaylist,
} from "./alignedPassage";
import { AUDIO_HIGHLIGHT_CLASS, ReadAlongHighlighter } from "./readAlong";
import {
  alignedAudioAnchor,
  alignedTextTarget,
} from "../../playback/src/standalone-alignment";
import type { MediaOverlayPlaylist } from "../../core/src/media-overlay";
import type { AudioManifest } from "../../core/src/bookorbit";
const epubBytes = new Uint8Array(
  readFileSync("packages/readers/fixtures/sample-aligned.epub"),
);
const entries = unzipSync(epubBytes);
const source = new NodeBlob([epubBytes]) as unknown as Blob;
const originalText = (name: string) => new TextDecoder().decode(entries[name]);
function duration(bytes: Uint8Array): number {
  const data = Buffer.from(bytes);
  let offset = 12;
  while (offset + 8 < data.length) {
    const size = data.readUInt32LE(offset + 4);
    if (data.toString("ascii", offset, offset + 4) === "data")
      return size / data.readUInt32LE(28);
    offset += 8 + size + (size % 2);
  }
  throw new Error("Missing WAV data");
}
async function fixture() {
  const names = ["audio1.wav", "audio2.wav"];
  const durations = names.map((name) => duration(entries[name]!));
  const publication = await new EPUB({
    loadText: async (name: string) => originalText(name),
    loadBlob: async (name: string) =>
      new NodeBlob([new Uint8Array(entries[name]!)]),
    getSize: (name: string) => entries[name]?.length ?? 0,
  }).init();
  const playlist: MediaOverlayPlaylist = {
    bookId: 12,
    fileId: 31,
    durationSeconds: durations[0]! + durations[1]!,
    sections: [],
    resources: names.map((name) => ({
      href: name,
      size: entries[name]!.length,
      mediaType: "audio/wav",
    })),
    items: names.map((name, index) => ({
      index,
      sectionIndex: 0,
      smilHref: "timing.smil",
      textHref: "chapter.xhtml",
      textFragment: `p${index + 1}`,
      audioHref: name,
      audioMimeType: "audio/wav",
      clipBeginSeconds: 0,
      clipEndSeconds: durations[index]!,
      durationSeconds: durations[index]!,
      label: null,
    })),
  };
  const manifest: AudioManifest = {
    schema: "bookorbit.audiobook-manifest",
    schemaVersion: 2,
    revision: "fixture-v1",
    chapters: [],
    totalDurationMs: playlist.durationSeconds! * 1000,
    assets: names.map((name, index) => ({
      assetId: name,
      fileId: 41 + index,
      sequence: index,
      format: "wav",
      durationMs: durations[index]! * 1000,
      sizeBytes: entries[name]!.length,
      etag: "fixture",
    })),
  };
  const candidates = names.map((name, index) => ({
    audioHref: name,
    assetId: name,
    fileId: String(41 + index),
    bytes: new Uint8Array(entries[name]!).buffer,
  }));
  return { publication, playlist, manifest, candidates };
}
const binding = {
  accountScope: "server/user",
  bookId: "12",
  textFileId: "31",
  audioFileId: "41",
};
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe("open EPUB edition verification and DOM handoff", () => {
  it("verifies the original EPUB/WAV fixture and resolves both directions at the second real passage", async () => {
    const f = await fixture();
    const map = await verifyPublicationAudiobook(
      source,
      f.publication,
      binding,
      f.playlist,
      f.manifest,
      f.candidates,
    );
    const doc = new DOMParser().parseFromString(
      originalText("chapter.xhtml"),
      "application/xhtml+xml",
    );
    const range = doc.createRange();
    range.setStart(doc.getElementById("p2")!.firstChild!, 8);
    range.collapse(true);
    const passage = alignedPassageAtRange(map, map.edition, doc, 0, range)!;
    expect(passage.textFragment).toBe("p2");
    const anchor = alignedAudioAnchor(map, map.edition, passage.textLocator)!;
    const locator = JSON.parse(anchor.locator) as {
      trackId: string;
      time: number;
      trackTime: number;
    };
    expect(locator.trackId).toBe("42");
    expect(locator.trackTime).toBe(0);
    expect(locator.time).toBeCloseTo(duration(entries["audio1.wav"]!));
    expect(
      alignedTextTarget(map, map.edition, locator.time + 0.1)?.locator,
    ).toBe("chapter.xhtml#p2");
    range.selectNodeContents(doc.querySelector("body")!);
    expect(
      alignedPassageAtRange(map, map.edition, doc, 0, range)?.textFragment,
    ).toBe("p1");
    f.publication.destroy();
  });
  it.each([
    "changed-clock",
    "wrong-section",
    "wrong-fragment",
    "missing-passage",
    "changed-smil",
    "duplicate-fragment",
  ] as const)(
    "rejects %s before binding a standalone source",
    async (defect) => {
      const f = await fixture();
      if (defect === "changed-clock") f.playlist.items[0]!.clipEndSeconds = 1;
      if (defect === "wrong-section") f.playlist.items[0]!.sectionIndex = 1;
      if (defect === "wrong-fragment")
        f.playlist.items[0]!.textFragment = "absent";
      if (defect === "missing-passage") f.playlist.items.pop();
      if (defect === "changed-smil")
        f.publication.loadText = async (name: string) =>
          originalText(name).replace('id="p2"', 'id="changed"');
      if (defect === "duplicate-fragment")
        f.publication.loadText = async (name: string) =>
          originalText(name).replace("<h1>", '<h1 id="p1">');
      await expect(
        verifyPublicationPlaylist(f.publication, f.playlist),
      ).rejects.toThrow();
      f.publication.destroy();
    },
  );
  it("does not infer a mapped passage from chapter, percentage or a different DOM document", async () => {
    const f = await fixture();
    const map = await verifyPublicationAudiobook(
      source,
      f.publication,
      binding,
      f.playlist,
      f.manifest,
      f.candidates,
    );
    const doc = new DOMParser().parseFromString(
      originalText("chapter.xhtml"),
      "application/xhtml+xml",
    );
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("h1")!);
    range.collapse(true);
    expect(alignedPassageAtRange(map, map.edition, doc, 0, range)).toBeNull();
    range.selectNodeContents(doc.getElementById("p1")!);
    range.collapse(true);
    expect(alignedPassageAtRange(map, map.edition, doc, 1, range)).toBeNull();
    expect(
      alignedPassageAtRange(map, map.edition, document, 0, range),
    ).toBeNull();
    f.publication.destroy();
  });
});

async function readAlongFixture() {
  const f = await fixture();
  const map = await verifyPublicationAudiobook(
    source,
    f.publication,
    binding,
    f.playlist,
    f.manifest,
    f.candidates,
  );
  const doc = new DOMParser().parseFromString(
    originalText("chapter.xhtml"),
    "application/xhtml+xml",
  );
  const lines = await readPublicationTimedText(f.publication, map, map.edition);
  let contents: { doc: Document | null; index: number }[] = [{ doc, index: 0 }];
  const navigate = vi.fn(async (_locator: string) => {});
  const validate = vi.fn(async () => {});
  const highlighter = new ReadAlongHighlighter({
    validate,
    timedText: async () => lines,
    contents: () => contents,
    navigate,
  });
  const marked = () =>
    [...doc.querySelectorAll(`.${AUDIO_HIGHLIGHT_CLASS}`)].map(
      (element) => element.id,
    );
  return {
    ...f,
    map,
    doc,
    lines,
    navigate,
    validate,
    highlighter,
    marked,
    setContents: (next: typeof contents) => {
      contents = next;
    },
  };
}
describe("verified lyrics text and external audio following", () => {
  it("resolves a captured CFI or fragment independently of a later viewport/selection", async () => {
    const f = await readAlongFixture();
    const range = f.doc.createRange();
    range.setStart(f.doc.getElementById("p1")!.firstChild!, 10);
    range.collapse(true);
    const locator = CFI.fromRange(range);
    const resolver = {
      resolve: (value: string) => ({
        index: 0,
        anchor: (doc: Document) =>
          value.startsWith("epubcfi(")
            ? CFI.toRange(doc, CFI.parse(value))
            : doc.getElementById(value.split("#")[1]!),
      }),
      document: async () =>
        new DOMParser().parseFromString(
          originalText("chapter.xhtml"),
          "application/xhtml+xml",
        ),
    };
    range.selectNodeContents(f.doc.getElementById("p2")!);
    f.doc.getSelection()?.addRange(range);
    expect(
      (await passageAtLocator(f.map, f.map.edition, locator, resolver))
        ?.textFragment,
    ).toBe("p1");
    expect(
      (
        await passageAtLocator(
          f.map,
          f.map.edition,
          "chapter.xhtml#p2",
          resolver,
        )
      )?.textFragment,
    ).toBe("p2");
    expect(
      await passageAtLocator(f.map, f.map.edition, "chapter.xhtml", resolver),
    ).toBeNull();
    expect(
      await passageAtLocator(
        f.map,
        f.map.edition,
        "chapter.xhtml#missing",
        resolver,
      ),
    ).toBeNull();
    f.publication.destroy();
  });
  it("extracts immutable exact original passages and source timing, without manufacturing lyrics for other text", async () => {
    const f = await readAlongFixture();
    expect(f.lines.map((line) => line.text)).toEqual([
      "The reading room was quiet. A book lay open on the table.",
      "She turned the page and listened to the rain outside.",
    ]);
    expect(f.lines.map((line) => line.textLocator)).toEqual([
      "chapter.xhtml#p1",
      "chapter.xhtml#p2",
    ]);
    expect(f.lines[1]).toMatchObject({
      segmentId: "1",
      start: f.map.segments[1]!.start,
      end: f.map.duration,
      trackId: "42",
      trackTime: 0,
    });
    expect(Object.isFrozen(f.lines)).toBe(true);
    expect(Object.isFrozen(f.lines[0])).toBe(true);
    f.publication.destroy();
  });
  it("reads safe plain text with block boundaries, excluding hidden and executable content", () => {
    const doc = new DOMParser().parseFromString(
      '<div>One<br/>two<p>Three &amp; four</p><script>bad()</script><style>bad</style><span hidden="">secret</span><span aria-hidden="true">hidden</span><i>&lt;img src=x&gt;</i></div>',
      "application/xml",
    );
    expect(passageText(doc.documentElement)).toBe(
      "One two Three & four <img src=x>",
    );
  });
  it("rejects missing or duplicate fragment identities instead of choosing nearby text", async () => {
    const f = await readAlongFixture();
    f.publication.loadText = async () =>
      originalText("chapter.xhtml").replace('id="p2"', 'id="p1"');
    await expect(
      readPublicationTimedText(f.publication, f.map, f.map.edition),
    ).rejects.toThrow("ambiguous");
    await expect(
      readPublicationTimedText(f.publication, f.map, {
        ...f.map.edition,
        accountScope: "another",
      }),
    ).rejects.toThrow("different");
    f.publication.destroy();
  });
  it("highlights exact source intervals while paused or going backward, without navigation in hold mode", async () => {
    const f = await readAlongFixture();
    const second = f.map.segments[1]!.start;
    expect(
      (
        await f.highlighter.update(f.map, f.map.edition, second, {
          follow: false,
        })
      )?.segmentId,
    ).toBe("1");
    expect(f.marked()).toEqual(["p2"]);
    await f.highlighter.update(f.map, f.map.edition, 0.1, { follow: false });
    expect(f.marked()).toEqual(["p1"]);
    expect(f.navigate).not.toHaveBeenCalled();
    await f.highlighter.update(f.map, f.map.edition, f.map.duration, {
      follow: false,
    });
    expect(f.marked()).toEqual([]);
    await f.highlighter.update(f.map, f.map.edition, NaN, { follow: false });
    expect(f.marked()).toEqual([]);
    f.highlighter.destroy();
    f.publication.destroy();
  });
  it("clears a genuine silent source gap and retains the source clock without percentage interpolation", async () => {
    const f = await fixture();
    const end = f.playlist.items[0]!.clipEndSeconds! / 2;
    const changedSmil = originalText("timing.smil").replace(
      `clipEnd="${f.playlist.items[0]!.clipEndSeconds}s"`,
      `clipEnd="${end}s"`,
    );
    const changedEntries: Record<string, Uint8Array> = {
      ...entries,
      "timing.smil": new TextEncoder().encode(changedSmil),
    };
    const changedSource = new NodeBlob([
      new Uint8Array(zipSync(changedEntries)),
    ]) as unknown as Blob;
    f.publication.loadText = async (name: string) =>
      new TextDecoder().decode(changedEntries[name]!);
    f.playlist.items[0]!.clipEndSeconds = end;
    f.playlist.items[0]!.durationSeconds = end;
    const map = await verifyPublicationAudiobook(
      changedSource,
      f.publication,
      binding,
      f.playlist,
      f.manifest,
      f.candidates,
    );
    const doc = new DOMParser().parseFromString(
      originalText("chapter.xhtml"),
      "application/xhtml+xml",
    );
    const navigate = vi.fn(async () => {});
    const highlighter = new ReadAlongHighlighter({
      validate: async () => {},
      timedText: () =>
        readPublicationTimedText(f.publication, map, map.edition),
      contents: () => [{ doc, index: 0 }],
      navigate,
    });
    await highlighter.update(map, map.edition, 0.1, { follow: true });
    expect(doc.querySelector(`.${AUDIO_HIGHLIGHT_CLASS}`)?.id).toBe("p1");
    expect(
      await highlighter.update(map, map.edition, end, { follow: true }),
    ).toBeNull();
    expect(doc.querySelector(`.${AUDIO_HIGHLIGHT_CLASS}`)).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
    highlighter.destroy();
    f.publication.destroy();
  });
  it("navigates once per passage and explicitly refollows after hold, while unloaded held pages stay put", async () => {
    const f = await readAlongFixture();
    await f.highlighter.update(f.map, f.map.edition, 0.1, { follow: true });
    await f.highlighter.update(f.map, f.map.edition, 0.2, { follow: true });
    expect(f.navigate).toHaveBeenCalledTimes(1);
    f.setContents([]);
    await f.highlighter.update(f.map, f.map.edition, f.map.segments[1]!.start, {
      follow: false,
    });
    expect(f.marked()).toEqual([]);
    expect(f.navigate).toHaveBeenCalledTimes(1);
    f.setContents([{ doc: f.doc, index: 0 }]);
    f.highlighter.refresh();
    expect(f.marked()).toEqual(["p2"]);
    await f.highlighter.update(f.map, f.map.edition, f.map.segments[1]!.start, {
      follow: true,
    });
    expect(f.navigate).toHaveBeenLastCalledWith("chapter.xhtml#p2");
    f.highlighter.clear();
    expect(f.marked()).toEqual([]);
    f.publication.destroy();
  });
  it("clears owned marks copied into a replacement document during renderer reflow", async () => {
    const f = await readAlongFixture();
    await f.highlighter.update(f.map, f.map.edition, f.map.segments[1]!.start, {
      follow: false,
    });
    const replacement = f.doc.cloneNode(true) as Document;
    f.setContents([{ doc: replacement, index: 0 }]);
    expect(replacement.querySelector(`.${AUDIO_HIGHLIGHT_CLASS}`)?.id).toBe(
      "p2",
    );
    await f.highlighter.update(f.map, f.map.edition, f.map.duration, {
      follow: false,
    });
    expect(replacement.querySelector(`.${AUDIO_HIGHLIGHT_CLASS}`)).toBeNull();
    expect(f.marked()).toEqual([]);
    f.publication.destroy();
  });
  it("cleans up safely after the reader iframe has detached its document", async () => {
    const f = await readAlongFixture();
    await f.highlighter.update(f.map, f.map.edition, 0.1, { follow: false });
    f.setContents([{ doc: null, index: 0 }]);
    expect(() => f.highlighter.refresh()).not.toThrow();
    expect(() => f.highlighter.destroy()).not.toThrow();
    expect(f.marked()).toEqual([]);
    f.publication.destroy();
  });
  it("discards old asynchronous navigation and verification, leaving the newest paused backward passage highlighted", async () => {
    const f = await readAlongFixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.navigate.mockImplementationOnce(() => gate);
    const old = f.highlighter.update(
      f.map,
      f.map.edition,
      f.map.segments[1]!.start,
      { follow: true },
    );
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledOnce());
    const latest = f.highlighter.update(f.map, f.map.edition, 0.1, {
      follow: true,
    });
    finish();
    await Promise.all([old, latest]);
    expect(f.navigate).toHaveBeenLastCalledWith("chapter.xhtml#p1");
    expect(f.marked()).toEqual(["p1"]);
    let validate!: () => void;
    f.validate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          validate = resolve;
        }),
    );
    const stale = f.highlighter.update(
      f.map,
      f.map.edition,
      f.map.segments[1]!.start,
      { follow: true },
    );
    f.highlighter.clear();
    validate();
    await stale;
    expect(f.marked()).toEqual([]);
    f.highlighter.destroy();
    await expect(
      f.highlighter.update(f.map, f.map.edition, 0.1, { follow: true }),
    ).rejects.toThrow("no longer");
    f.publication.destroy();
  });
});
