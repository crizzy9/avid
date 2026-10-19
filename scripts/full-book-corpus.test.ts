import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, expect, it } from "vitest";
import {
  epubMetadata,
  originalAudio,
  safeRelativePath,
  splitFor,
  verifyManifest,
} from "./full-book-corpus.mjs";

const rss = `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <item><title>First</title><itunes:episode>01</itunes:episode><enclosure url="https://www.archive.org/download/sample/first_64kb.mp3"/><itunes:duration>00:01:00</itunes:duration></item>
  <item><title>Second</title><itunes:episode>02</itunes:episode><enclosure url="https://www.archive.org/download/sample/second_64kb.mp3"/></item>
</channel></rss>`;
const archive = {
  metadata: { identifier: "sample" },
  files: [
    { name: "second_128kb.mp3", source: "original", size: "200" },
    { name: "first_128kb.mp3", source: "original", size: "100" },
    {
      name: "first_64kb.mp3",
      source: "derivative",
      original: "first_128kb.mp3",
    },
    {
      name: "second_64kb.mp3",
      source: "derivative",
      original: "second_128kb.mp3",
    },
  ],
};

it("preserves catalog order while selecting explicit original MP3 ancestors", () => {
  const result = originalAudio(rss, archive, 2);
  expect(result.map((track) => track.originalName)).toEqual([
    "first_128kb.mp3",
    "second_128kb.mp3",
  ]);
  expect(result[0]).toMatchObject({
    index: 0,
    section: "01",
    title: "First",
    catalogAudioUrl: "https://www.archive.org/download/sample/first_64kb.mp3",
    sourceUrl: "https://archive.org/download/sample/first_128kb.mp3",
    archive: { bytes: 100 },
  });
  expect(result[0].archive.originalLineage).toHaveLength(2);
});

it("refuses missing originals, cyclic ancestry, duplicates and incomplete books", () => {
  expect(() => originalAudio(rss, { ...archive, files: [] }, 2)).toThrow(
    "No original MP3",
  );
  expect(() => originalAudio(rss, archive, 3)).toThrow("Expected 3");
  const cyclic = structuredClone(archive);
  cyclic.files[2].original = "first_64kb.mp3";
  expect(() => originalAudio(rss, cyclic, 2)).toThrow("Cyclic");
  expect(() =>
    originalAudio(
      rss.replaceAll("second_64kb.mp3", "first_64kb.mp3"),
      archive,
      2,
    ),
  ).toThrow("unique tracks");
});

it("rejects paths outside the corpus and unexpected catalog download hosts", () => {
  for (const bad of [
    "../book.mp3",
    "/tmp/book.mp3",
    "one/../two",
    "a\\b",
    "a//b",
    ".",
    "",
  ]) {
    expect(() => safeRelativePath(bad)).toThrow();
  }
  expect(safeRelativePath("alice/audio/chapter.mp3")).toBe(
    "alice/audio/chapter.mp3",
  );
  expect(() =>
    originalAudio(rss.replaceAll("www.archive.org", "example.org"), archive, 2),
  ).toThrow("origin");
});

it("pins actual EPUB spine bytes and retains non-linear/front matter in metadata", () => {
  const bytes = zipSync({
    "META-INF/container.xml": strToU8(
      '<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>',
    ),
    "EPUB/package.opf": strToU8(
      '<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Example</dc:title><dc:language>en</dc:language><dc:rights>Fixture only</dc:rights></metadata><manifest><item id="front" href="front.xhtml" media-type="application/xhtml+xml"/><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="front" linear="no"/><itemref idref="body"/></spine></package>',
    ),
    "EPUB/front.xhtml": strToU8("<html><body>License</body></html>"),
    "EPUB/body.xhtml": strToU8("<html><body>Book body</body></html>"),
  });
  const metadata = epubMetadata(bytes);
  expect(metadata.version).toBe("3.0");
  expect(metadata.title).toEqual(["Example"]);
  expect(metadata.spine.map((entry) => [entry.path, entry.linear])).toEqual([
    ["EPUB/front.xhtml", false],
    ["EPUB/body.xhtml", true],
  ]);
  expect(metadata.spine[1].sha256).toBe(
    createHash("sha256")
      .update("<html><body>Book body</body></html>")
      .digest("hex"),
  );
});

it("freezes chapter splits independently of inference and keeps Jane entirely held out", () => {
  const audio = Array.from({ length: 12 }, (_, index) => ({
    index,
    section: String(index + 1),
  }));
  const development = splitFor(
    { id: "alice-yearsley-v3", role: "development" },
    audio,
  );
  expect(development).toEqual(
    splitFor({ id: "alice-yearsley-v3", role: "development" }, audio),
  );
  expect(
    development.chapters
      .filter((chapter) => chapter.role === "quality-holdout")
      .map((chapter) => chapter.section),
  ).toEqual(["2", "10"]);
  expect(
    splitFor(
      { id: "jane-eyre-volunteers", role: "sealed-quality-holdout" },
      audio,
    ).chapters.every((chapter) => chapter.role === "quality-holdout"),
  ).toBe(true);
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
it("detects media corruption before a frozen corpus can be reused", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "avid-corpus-test-"));
  temporary.push(directory);
  const text = "data";
  const sha256 = createHash("sha256").update(text).digest("hex");
  for (const name of ["ebook", "audio", "notices"])
    await writeFile(path.join(directory, name), text);
  const manifest = {
    schemaVersion: 1,
    books: [
      {
        id: "test",
        expectedTracks: 1,
        epub: { path: "ebook", bytes: 4, sha256 },
        audio: [{ path: "audio", bytes: 4, sha256 }],
        sourceSnapshots: [],
        rights: { noticesPath: "notices", noticesSha256: sha256 },
        totalAudioBytes: 4,
      },
    ],
  };
  expect(await verifyManifest(manifest, directory)).toEqual({
    books: 1,
    tracks: 1,
    bytes: 8,
  });
  await writeFile(path.join(directory, "audio"), "edit");
  await expect(verifyManifest(manifest, directory)).rejects.toThrow(
    "hash/size mismatch",
  );
});
