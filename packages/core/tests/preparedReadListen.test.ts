// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto, createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PreparedReadListenStore,
  preparedPlaybackSource,
  sha256Blob,
  type PreparedReadListenInput,
} from "../src/preparedReadListen";
import {
  alignmentTokens,
  type GeneratedAlignmentSnapshot,
} from "../../playback/src/generated-alignment";
import { OfflineReadAlongStore } from "../src/offlineReadAlong";
const scope = JSON.stringify(["https://fixture.invalid", "reader"]);
const stores: PreparedReadListenStore[] = [];
const makeBlob = (bytes: Uint8Array | string) =>
  new NodeBlob([
    typeof bytes === "string" ? bytes : Uint8Array.from(bytes).buffer,
  ]) as unknown as Blob;
function store(name = `prepared-test-${crypto.randomUUID()}`) {
  const value = new PreparedReadListenStore(name);
  stores.push(value);
  return value;
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", NodeBlob);
});
afterEach(async () => {
  const names = new Set(stores.map((s) => s.database.name));
  stores.forEach((s) => s.close());
  for (const name of names) {
    const db = new PreparedReadListenStore(name);
    await db.database.delete();
  }
  stores.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(): Promise<PreparedReadListenInput> {
  const texts = [
    "The first sentence begins beside the quiet river today.",
    "A second chapter follows with a different sequence of words.",
  ];
  const epub = makeBlob(
    zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      ),
      "book.opf": strToU8(
        '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      ),
      "chapter.xhtml": strToU8(
        `<html xmlns="http://www.w3.org/1999/xhtml"><body>${texts.map((t) => `<p>${t}</p>`).join("")}</body></html>`,
      ),
    }),
  );
  const sources = [
    { assetId: "audio-one", blob: makeBlob("audio one bytes") },
    { assetId: "audio-two", blob: makeBlob("audio two bytes") },
  ];
  const edition = {
    accountScope: scope,
    bookId: "12",
    textFileId: "31",
    textSha256: await sha256Blob(epub),
    audioFileId: "41",
    manifestRevision: "original-v1",
  };
  const tracks = await Promise.all(
    sources.map(async (source, i) => ({
      assetId: source.assetId,
      fileId: String(41 + i),
      sizeBytes: source.blob.size,
      duration: 10,
      sha256: await sha256Blob(source.blob),
    })),
  );
  const passages = texts.map((text, i) => ({
    id: `p${i}`,
    text,
    textLocator: `epubcfi(/6/2!/4/${2 + i * 2})`,
    sectionIndex: 0,
    textHref: "chapter.xhtml",
    elementPath: [i],
  }));
  const alignment: GeneratedAlignmentSnapshot = {
    version: 1,
    source: "generated",
    algorithm: "avid-word-match-v1",
    edition,
    model: { id: "fixture-model", revision: "fixture-v1" },
    tracks,
    passages,
    segments: passages.map((p, i) => ({
      id: p.id,
      textFileId: "31",
      textLocator: p.textLocator,
      audioFileId: "41",
      start: i * 10 + 1,
      end: i * 10 + 5,
      trackId: String(41 + i),
      trackTime: 1,
      sectionIndex: 0,
      textHref: p.textHref,
      textFragment: "",
      textElementPath: p.elementPath,
      confidence: 1,
    })),
    coverage: {
      matchedPassages: 2,
      totalPassages: 2,
      matchedWords: texts.reduce(
        (sum, t) => sum + alignmentTokens(t).length,
        0,
      ),
      totalWords: texts.reduce((sum, t) => sum + alignmentTokens(t).length, 0),
    },
  };
  return {
    scope,
    scopeLabel: "Fixture reader",
    book: {
      id: "12",
      title: "An ordinary EPUB",
      authors: ["Avid"],
      description: "Original text",
      format: "EPUB",
      color: "#66736d",
      progress: 0,
      status: "unread",
      genres: [],
      addedAt: "2026-10-18",
      files: [
        { id: "31", name: "ordinary.epub", format: "EPUB" },
        { id: "41", name: "part1.mp3", format: "AUDIO" },
        { id: "42", name: "part2.mp3", format: "AUDIO" },
      ],
    },
    textFileId: "31",
    epub,
    sources,
    alignment,
    manifest: {
      schema: "bookorbit.audiobook-manifest",
      schemaVersion: 2,
      revision: edition.manifestRevision,
      totalDurationMs: 20000,
      assets: tracks.map((track, i) => ({
        assetId: track.assetId,
        fileId: Number(track.fileId),
        sequence: i,
        format: "mp3",
        durationMs: 10000,
        sizeBytes: track.sizeBytes,
        etag: "fixture",
      })),
      chapters: [
        {
          id: "one",
          title: "One",
          assetId: "audio-one",
          sequence: 0,
          startMs: 0,
          endMs: 10000,
          assetOffsetMs: 0,
        },
        {
          id: "two",
          title: "Two",
          assetId: "audio-two",
          sequence: 1,
          startMs: 10000,
          endMs: 20000,
          assetOffsetMs: 0,
        },
      ],
    },
  };
}
it("persists an ordinary EPUB and ordered compared audio, cold-reopens and reuses it without any network", async () => {
  const input = await fixture(),
    first = store(),
    descriptor = await first.put(input);
  first.close();
  const next = store(first.database.name);
  const fetch = vi.fn(() => {
    throw new Error("No network");
  });
  vi.stubGlobal("fetch", fetch);
  const pkg = await next.get(scope, descriptor.id);
  expect(pkg?.alignmentSnapshot).toEqual(input.alignment);
  expect(await pkg!.epub.arrayBuffer()).toEqual(await input.epub.arrayBuffer());
  expect(pkg?.sources.map((s) => s.assetId)).toEqual([
    "audio-one",
    "audio-two",
  ]);
  const reusable = await next.findReusableSources({
    scope,
    bookId: "12",
    textFileId: "31",
    textSha256: input.alignment.edition.textSha256,
    manifest: input.manifest,
  });
  expect(reusable?.alignmentSnapshot).toEqual(input.alignment);
  expect(fetch).not.toHaveBeenCalled();
  expect(next.database.tables.map((t) => t.name).sort()).toEqual([
    "packages",
    "payloads",
  ]);
});
it("does not reuse another account, EPUB hash or audiobook revision", async () => {
  const input = await fixture(),
    saved = store();
  await saved.put(input);
  const query = {
    scope,
    bookId: "12",
    textFileId: "31",
    textSha256: input.alignment.edition.textSha256,
    manifest: input.manifest,
  };
  for (const changed of [
    { ...query, scope: JSON.stringify(["https://fixture.invalid", "other"]) },
    { ...query, textSha256: "a".repeat(64) },
    { ...query, manifest: { ...input.manifest, revision: "new" } },
  ])
    expect(await saved.findReusable(changed)).toBeUndefined();
});
it("strips transport/session fields and never persists remote or blob URLs", async () => {
  const input = await fixture();
  Object.assign(input.book, {
    coverUrl: "https://private.invalid/cover?token=secret",
    accessToken: "secret",
  });
  input.book.files[0]!.url = "blob:private";
  Object.assign(input.alignment, { refreshToken: "secret" });
  Object.assign(input.alignment.edition, { authorization: "Bearer secret" });
  Object.assign(input.sources[0]!, {
    url: "https://private.invalid/audio?token=secret",
  });
  const saved = store();
  await saved.put(input);
  const rows =
    JSON.stringify(await saved.database.table("packages").toArray()) +
    JSON.stringify(await saved.database.table("payloads").toArray());
  expect(rows).not.toMatch(
    /secret|private\.invalid|blob:private|refreshToken|authorization/,
  );
});
it("captures caller identity and metadata before asynchronous hashing", async () => {
  const input = await fixture(),
    saved = store();
  const pending = saved.put(input);
  input.scope = JSON.stringify(["https://fixture.invalid", "changed"]);
  input.book.title = "Mutated later";
  const descriptor = await pending;
  expect(descriptor.scope).toBe(scope);
  expect(descriptor.book.title).toBe("An ordinary EPUB");
  expect(await saved.list(input.scope)).toEqual([]);
});
it("rejects partial, substituted and wrong-edition sources before publishing", async () => {
  for (const change of [
    (i: PreparedReadListenInput) => {
      i.sources = i.sources.slice(1);
    },
    (i: PreparedReadListenInput) => {
      i.sources = [
        { ...i.sources[0]!, blob: makeBlob("changed bytes!!") },
        i.sources[1]!,
      ];
    },
    (i: PreparedReadListenInput) => {
      i.alignment.edition.manifestRevision = "changed";
    },
    (i: PreparedReadListenInput) => {
      i.manifest.chapters[1]!.startMs = 9000;
    },
  ]) {
    const input = await fixture(),
      saved = store();
    change(input);
    await expect(saved.put(input)).rejects.toThrow();
    expect(await saved.list()).toEqual([]);
  }
});
it("rechecks stored bytes and metadata on every open without deleting damaged data", async () => {
  const input = await fixture(),
    saved = store(),
    descriptor = await saved.put(input);
  const key = JSON.stringify([scope, descriptor.id]);
  const payload = await saved.database.table("payloads").get(key);
  payload.sources[0].blob = makeBlob("changed bytes!!");
  await saved.database.table("payloads").put(payload);
  await expect(saved.get(scope, descriptor.id)).rejects.toMatchObject({
    code: "corrupt",
  });
  expect(await saved.database.table("payloads").count()).toBe(1);
  expect(await saved.list()).toHaveLength(1);
});
it("rolls back both rows when cancellation or storage failure interrupts publication", async () => {
  for (const cancel of [true, false]) {
    const input = await fixture(),
      saved = store(),
      abort = new AbortController();
    saved.database.table("packages").hook("creating", () => {
      if (cancel) abort.abort();
      else throw new Error("Quota exceeded");
    });
    await expect(saved.put(input, { signal: abort.signal })).rejects.toThrow();
    expect(await saved.database.table("packages").count()).toBe(0);
    expect(await saved.database.table("payloads").count()).toBe(0);
  }
});
it("does not touch legacy saved data or progress databases on new preparation/removal", async () => {
  const old = new OfflineReadAlongStore(`legacy-keep-${crypto.randomUUID()}`);
  await old.database
    .table("packages")
    .put({ key: "legacy-marker", scope, id: "legacy" });
  const input = await fixture(),
    saved = store(),
    descriptor = await saved.put(input);
  await saved.remove(scope, descriptor.id);
  expect(await old.database.table("packages").get("legacy-marker")).toEqual({
    key: "legacy-marker",
    scope,
    id: "legacy",
  });
  await old.database.delete();
});
it("keeps a previous prepared edition when a superseding preparation becomes stale", async () => {
  const input = await fixture(),
    saved = store(),
    first = await saved.put(input);
  let active = true;
  const slice = input.epub.slice.bind(input.epub);
  vi.spyOn(input.epub, "slice").mockImplementation((...args) => {
    active = false;
    return slice(...args);
  });
  await expect(saved.put(input, { isActive: () => active })).rejects.toThrow();
  expect((await saved.list()).map((p) => p.id)).toEqual([first.id]);
});
it("hashes at most 1 MiB slices and agrees with whole-file SHA-256", async () => {
  const bytes = new Uint8Array(2 * 1024 ** 2 + 17).fill(37),
    blob = makeBlob(bytes);
  const slice = vi.spyOn(blob, "slice"),
    whole = vi.spyOn(blob, "arrayBuffer");
  expect(await sha256Blob(blob)).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(whole).not.toHaveBeenCalled();
  expect(slice.mock.calls).toHaveLength(3);
  expect(
    slice.mock.calls.every(([start = 0, end = 0]) => end - start <= 1024 ** 2),
  ).toBe(true);
});
it("aborts promptly even if a pending Blob read never settles", async () => {
  const abort = new AbortController();
  const blob = {
    size: 1,
    slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }),
  } as unknown as Blob;
  const work = sha256Blob(blob, { signal: abort.signal });
  abort.abort();
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
});
it("creates only revocable local playback URLs with canonical track/chapter timing", async () => {
  const input = await fixture(),
    saved = store(),
    descriptor = await saved.put(input),
    pkg = (await saved.get(scope, descriptor.id))!;
  const created = vi.fn((_: Blob) => `blob:prepared-${Math.random()}`),
    revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = created;
      static revokeObjectURL = revoke;
    },
  );
  const source = preparedPlaybackSource(pkg);
  expect(source.source.tracks.map((t) => t.id)).toEqual(["41", "42"]);
  expect(source.source.chapters[1]).toMatchObject({ start: 10, duration: 10 });
  source.revoke();
  source.revoke();
  expect(revoke).toHaveBeenCalledTimes(2);
});
