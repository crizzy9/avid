// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  OfflineReadAlongStore,
  downloadOfflineReadAlong,
  offlinePlaybackSource,
  type OfflineReadAlongInput,
  type OfflineDownloadClient,
} from "../src/offlineReadAlong";
import {
  alignmentSha256,
  assertStandaloneAlignment,
  createStandaloneAlignment,
  verifyAudioResource,
} from "../../playback/src/standalone-alignment";
import type { AudioManifest } from "../src/bookorbit";
import type { MediaOverlayPlaylist } from "../src/media-overlay";

const scope = JSON.stringify(["https://fixture.invalid", "reader"]);
const secondScope = JSON.stringify([
  "https://fixture.invalid",
  "another-reader",
]);
const original = new Uint8Array(
  readFileSync("packages/readers/fixtures/sample-aligned.epub"),
);
const archive = unzipSync(original);
const stores: OfflineReadAlongStore[] = [];
const blob = (bytes: Uint8Array) =>
  new NodeBlob([Uint8Array.from(bytes).buffer]) as unknown as Blob;
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", NodeBlob);
});
afterEach(async () => {
  const closed = stores.splice(0);
  closed.forEach((store) => store.close());
  for (const store of new Map(
    closed.map((store) => [store.database.name, store]),
  ).values())
    await store.database.delete();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function store(name = `offline-fixture-${crypto.randomUUID()}`) {
  const result = new OfflineReadAlongStore(name);
  stores.push(result);
  return result;
}
function duration(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  let offset = 12;
  while (offset + 8 < data.length) {
    const size = data.readUInt32LE(offset + 4);
    if (data.toString("ascii", offset, offset + 4) === "data")
      return size / data.readUInt32LE(28);
    offset += 8 + size + (size % 2);
  }
  throw new Error("Original WAV fixture has no data.");
}
async function fixture(account = scope): Promise<OfflineReadAlongInput> {
  const names = ["audio1.wav", "audio2.wav"],
    durations = names.map((name) => duration(archive[name]!));
  const edition = {
    accountScope: account,
    bookId: "12",
    textFileId: "31",
    audioFileId: "41",
    textSha256: await alignmentSha256(Uint8Array.from(original).buffer),
    manifestRevision: "original-v1",
  };
  const manifest: AudioManifest = {
    schema: "bookorbit.audiobook-manifest",
    schemaVersion: 2,
    revision: edition.manifestRevision,
    chapters: [],
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0) * 1000,
    assets: names.map((name, index) => ({
      assetId: name,
      fileId: 41 + index,
      sequence: index,
      format: "wav",
      durationMs: durations[index]! * 1000,
      sizeBytes: archive[name]!.length,
      etag: "original",
    })),
  };
  const playlist: MediaOverlayPlaylist = {
    bookId: 12,
    fileId: 31,
    durationSeconds: manifest.totalDurationMs / 1000,
    sections: [],
    resources: names.map((name) => ({
      href: name,
      size: archive[name]!.length,
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
  const proofs = await Promise.all(
    names.map((name, index) =>
      verifyAudioResource(
        edition,
        { audioHref: name, assetId: name, audioFileId: String(41 + index) },
        Uint8Array.from(archive[name]!).buffer,
        Uint8Array.from(archive[name]!).buffer,
      ),
    ),
  );
  const alignment = createStandaloneAlignment(
    edition,
    playlist,
    manifest,
    proofs,
  );
  const chapter = new DOMParser().parseFromString(
    new TextDecoder().decode(archive["chapter.xhtml"]),
    "application/xhtml+xml",
  );
  return {
    scope: account,
    scopeLabel: "Fixture reader",
    book: {
      id: "12",
      title: "Original aligned fixture",
      authors: ["Avid"],
      description: "",
      format: "EPUB",
      color: "#ddd",
      progress: 0,
      status: "unread",
      genres: [],
      addedAt: "",
      files: [
        { id: "31", name: "Original.epub", format: "EPUB" },
        ...names.map((name, index) => ({
          id: String(41 + index),
          name,
          format: "AUDIO" as const,
        })),
      ],
    },
    textFileId: "31",
    epub: blob(original),
    alignment,
    manifest,
    playlist,
    pairings: names.map((name, index) => ({
      audioHref: name,
      assetId: name,
      fileId: String(41 + index),
    })),
    audioAssets: names.map((name) => ({
      assetId: name,
      blob: blob(archive[name]!),
    })),
    timedText: alignment.segments.map((segment) => ({
      segmentId: segment.id,
      text: chapter.getElementById(segment.textFragment)!.textContent!,
      textLocator: segment.textLocator,
      start: segment.start,
      end: segment.end,
      trackId: segment.trackId,
      trackTime: segment.trackTime,
    })),
  };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

it("atomically stores original EPUB/WAV hashes and exact timed text, survives restart, and keeps the restored map unbranded", async () => {
  const db = store(),
    f = await fixture();
  const saved = await db.put(f);
  expect(saved.mode).toBe("paired");
  expect(saved.textSha256).toBe(f.alignment!.edition.textSha256);
  const name = db.database.name;
  db.close();
  const restarted = store(name);
  const network = vi.fn(() => {
    throw new Error("Network unavailable");
  });
  vi.stubGlobal("fetch", network);
  const restored = (await restarted.get(scope, saved.id))!;
  expect(await restored.epub.arrayBuffer()).toEqual(await f.epub.arrayBuffer());
  expect(restored.assets).toHaveLength(2);
  expect(restored.audioAssets).toHaveLength(2);
  expect(restored.timedText).toEqual(f.timedText);
  expect(restored.totalBytes).toBe(
    f.epub.size +
      f.audioAssets!.reduce((sum, asset) => sum + asset.blob.size, 0),
  );
  for (const asset of restored.assets)
    expect(asset.sha256).toBe(
      await alignmentSha256(
        await restored.audioAssets
          .find((item) => item.assetId === asset.assetId)!
          .blob.arrayBuffer(),
      ),
    );
  expect(() =>
    assertStandaloneAlignment(
      restored.alignmentSnapshot!,
      f.alignment!.edition,
    ),
  ).toThrow("Fresh verified");
  expect(await restarted.listScopes()).toEqual([
    {
      scope,
      label: "Fixture reader",
      count: 1,
      totalBytes: restored.totalBytes,
    },
  ]);
  expect((await restarted.list(scope))[0]?.id).toBe(saved.id);
  expect(network).not.toHaveBeenCalled();
  const repeated = await restarted.put({
    ...f,
    pairings: [...f.pairings!].reverse(),
  });
  expect(repeated.id).toBe(saved.id);
  expect(await restarted.list(scope)).toHaveLength(1);
});

it("supports a self-contained EPUB/SMIL package without external audio and segregates list/get/remove by original account", async () => {
  const db = store(),
    f = await fixture();
  const embedded = {
    scope: secondScope,
    scopeLabel: "Second reader",
    book: f.book,
    textFileId: f.textFileId,
    epub: f.epub,
  };
  const saved = await db.put(embedded);
  expect(saved.mode).toBe("embedded");
  expect(saved.assets).toEqual([]);
  expect(await db.list(scope)).toEqual([]);
  expect(await db.get(scope, saved.id)).toBeUndefined();
  await db.remove(scope, saved.id);
  expect(await db.get(secondScope, saved.id)).toBeDefined();
  await db.remove(secondScope, saved.id);
  expect(await db.listScopes()).toEqual([]);
});

it("removes authentication fields, remote/signed URLs and markup from stored book metadata", async () => {
  const db = store(),
    f = await fixture();
  f.book.coverUrl = "https://secret.invalid/cover?access_token=do-not-store";
  f.book.color = "url(https://secret.invalid/style?signature=do-not-store)";
  f.book.files[0]!.url = "https://secret.invalid/file?signature=do-not-store";
  f.book.description =
    '<img src="https://secret.invalid/pixel?token=do-not-store">Original <b>description</b> https://secret.invalid/link?token=do-not-store';
  Object.assign(f.book, {
    accessToken: "never-persist-this",
    refreshToken: "never-persist-that",
  });
  const saved = await db.put(f),
    serialized = JSON.stringify(await db.list(scope));
  expect(serialized).not.toContain("secret.invalid");
  expect(serialized).not.toContain("never-persist");
  expect(saved.book.description).toBe("Original description ");
  expect(saved.book.coverUrl).toBeUndefined();
  expect(saved.book.color).toBe("#66736d");
  expect(saved.book.files[0]!.url).toBeUndefined();
});

it.each([
  "missing-asset",
  "partial-audio",
  "wrong-audio-bytes",
  "different-account",
  "different-epub",
  "wrong-revision",
  "wrong-version",
  "declared-epub-size",
  "wrong-timing",
  "wrong-timed-text",
] as const)("rejects %s before publishing anything", async (defect) => {
  const db = store(),
    f = await fixture();
  if (defect === "missing-asset") f.audioAssets = f.audioAssets!.slice(0, 1);
  if (defect === "partial-audio")
    f.audioAssets = [
      { ...f.audioAssets![0]!, blob: f.audioAssets![0]!.blob.slice(0, 10) },
      f.audioAssets![1]!,
    ];
  if (defect === "wrong-audio-bytes") {
    const bytes = new Uint8Array(await f.audioAssets![0]!.blob.arrayBuffer());
    bytes[50] ^= 1;
    f.audioAssets = [
      { ...f.audioAssets![0]!, blob: blob(bytes) },
      f.audioAssets![1]!,
    ];
  }
  if (defect === "different-account") f.scope = secondScope;
  if (defect === "different-epub") {
    const entries = {
      ...archive,
      "chapter.xhtml": new TextEncoder().encode(
        new TextDecoder()
          .decode(archive["chapter.xhtml"])
          .replace("quiet", "loud"),
      ),
    };
    f.epub = blob(zipSync(entries));
  }
  if (defect === "wrong-revision") f.manifest!.revision = "another-edition";
  if (defect === "wrong-version")
    f.alignment = { ...f.alignment!, version: "old-proof-version" };
  if (defect === "declared-epub-size") f.book.files[0]!.size = f.epub.size + 1;
  if (defect === "wrong-timing") f.playlist!.items[0]!.clipEndSeconds = 0.2;
  if (defect === "wrong-timed-text")
    f.timedText = f.timedText!.map((line, index) =>
      index ? line : { ...line, text: "Invented passage" },
    );
  await expect(db.put(f)).rejects.toThrow();
  expect(await db.list(scope)).toEqual([]);
  expect(await db.database.table("payloads").count()).toBe(0);
});

it("rejects a missing/external SMIL resource and bounds expanded archive/package sizes", async () => {
  const db = store(),
    f = await fixture();
  const embedded = {
    scope,
    scopeLabel: "Fixture",
    book: f.book,
    textFileId: f.textFileId,
    epub: f.epub,
  };
  const bad = {
    ...archive,
    "timing.smil": new TextEncoder().encode(
      new TextDecoder()
        .decode(archive["timing.smil"])
        .replace("audio1.wav", "https://outside.invalid/audio.wav"),
    ),
  };
  await expect(
    db.put({ ...embedded, epub: blob(zipSync(bad)) }),
  ).rejects.toThrow("external resources");
  await expect(
    db.put(embedded, { limits: { expandedEpubBytes: 100 } }),
  ).rejects.toMatchObject({ code: "limit" });
  await expect(
    db.put(f, { limits: { totalBytes: f.epub.size } }),
  ).rejects.toMatchObject({ code: "limit" });
  expect(await db.listScopes()).toEqual([]);
});

it.each(["overlapping", "out-of-order", "duplicate-sequence"] as const)(
  "rejects %s audio chapters before a package can be advertised as ready",
  async (defect) => {
    const db = store(),
      f = await fixture();
    f.manifest!.chapters = [
      {
        id: "one",
        title: "One",
        assetId: "audio1.wav",
        sequence: 0,
        startMs: 0,
        endMs: 1000,
        assetOffsetMs: 0,
      },
      {
        id: "two",
        title: "Two",
        assetId: "audio1.wav",
        sequence: 1,
        startMs: 1000,
        endMs: 2000,
        assetOffsetMs: 1000,
      },
    ];
    if (defect === "overlapping") f.manifest!.chapters[1]!.startMs = 500;
    if (defect === "out-of-order") {
      f.manifest!.chapters[0]!.startMs = 2000;
      f.manifest!.chapters[0]!.endMs = 3000;
    }
    if (defect === "duplicate-sequence") f.manifest!.chapters[1]!.sequence = 0;
    await expect(db.put(f)).rejects.toThrow("chapter timeline");
    expect(await db.list(scope)).toEqual([]);
  },
);

it("captures original account arguments before hashing and never publishes under a later caller mutation", async () => {
  const db = store(),
    f = await fixture();
  let release!: () => void;
  const bytes = await f.epub.arrayBuffer(),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  vi.spyOn(f.epub, "arrayBuffer").mockImplementation(async () => {
    await gate;
    return bytes;
  });
  const pending = db.put(f);
  f.scope = secondScope;
  release();
  const saved = await pending;
  expect(saved.scope).toBe(scope);
  expect(await db.list(secondScope)).toEqual([]);
  expect((await db.list(scope))[0]?.id).toBe(saved.id);
});

it("rolls back both tables on quota failure, preserving an existing ready edition and its old metadata", async () => {
  const db = store(),
    f = await fixture(),
    saved = await db.put(f);
  const failure = () => {
    throw new DOMException("Fixture quota exceeded", "QuotaExceededError");
  };
  db.database.table("packages").hook("updating", failure);
  await expect(
    db.put({ ...f, book: { ...f.book, title: "Uncommitted replacement" } }),
  ).rejects.toMatchObject({ code: "storage" });
  db.database.table("packages").hook("updating").unsubscribe(failure);
  expect((await db.get(scope, saved.id))?.book.title).toBe(f.book.title);
  expect(await db.database.table("payloads").count()).toBe(1);
  db.database.table("packages").hook("creating", failure);
  await expect(
    db.put({
      scope: secondScope,
      scopeLabel: "Second",
      book: f.book,
      textFileId: f.textFileId,
      epub: f.epub,
    }),
  ).rejects.toMatchObject({ code: "storage" });
  db.database.table("packages").hook("creating").unsubscribe(failure);
  expect(await db.list(secondScope)).toEqual([]);
  expect(await db.database.table("payloads").count()).toBe(1);
});

it("cancels aborted/stale transactions before publication and does not erase an existing ready package", async () => {
  const db = store(),
    f = await fixture(),
    saved = await db.put(f);
  const controller = new AbortController();
  controller.abort();
  await expect(db.put(f, { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  let active = true;
  const switchAccount = () => {
    active = false;
  };
  db.database.table("payloads").hook("updating", switchAccount);
  await expect(
    db.put(
      { ...f, book: { ...f.book, title: "Late account" } },
      { isActive: () => active },
    ),
  ).rejects.toMatchObject({ code: "stale" });
  db.database.table("payloads").hook("updating").unsubscribe(switchAccount);
  expect((await db.get(scope, saved.id))?.book.title).toBe(f.book.title);
});

it("detects persisted metadata and same-size binary corruption on restart instead of publishing usable playback", async () => {
  const db = store(),
    f = await fixture(),
    saved = await db.put(f),
    identity = JSON.stringify([scope, saved.id]);
  const payload = await db.database.table("payloads").get(identity);
  const bytes = new Uint8Array(await payload.audioAssets[0].blob.arrayBuffer());
  bytes[100] ^= 1;
  payload.audioAssets[0].blob = blob(bytes);
  await db.database.table("payloads").put(payload);
  await expect(db.get(scope, saved.id)).rejects.toMatchObject({
    code: "corrupt",
  });
  await db.put(f);
  await db.database
    .table("packages")
    .update(identity, { textFileId: "other-edition" });
  expect(await db.list(scope)).toEqual([]);
  expect(await db.listIssues()).toEqual([
    {
      recoveryId: expect.stringMatching(/^[a-f0-9]{64}$/),
      code: "corrupt-metadata",
    },
  ]);
  await expect(db.get(scope, saved.id)).rejects.toMatchObject({
    code: "corrupt",
  });
});

it("lists healthy accounts/downloads when another descriptor is corrupt and removes only its metadata and bytes", async () => {
  const db = store(),
    f = await fixture(),
    healthy = await db.put(f);
  const damaged = await db.put({
    scope,
    scopeLabel: "Fixture",
    book: f.book,
    textFileId: f.textFileId,
    epub: f.epub,
  });
  const another = await db.put(await fixture(secondScope));
  await db.database
    .table("packages")
    .update(JSON.stringify([scope, damaged.id]), {
      scopeLabel: "https://user:password@private.invalid/?token=never-show",
      textFileId: "damaged",
    });
  expect((await db.list(scope)).map((item) => item.id)).toEqual([healthy.id]);
  expect(await db.listScopes()).toEqual(
    expect.arrayContaining([
      {
        scope,
        label: "Fixture reader",
        count: 1,
        totalBytes: healthy.totalBytes,
      },
      {
        scope: secondScope,
        label: "Fixture reader",
        count: 1,
        totalBytes: another.totalBytes,
      },
    ]),
  );
  const issues = await db.listIssues();
  expect(issues).toEqual([
    {
      recoveryId: expect.stringMatching(/^[a-f0-9]{64}$/),
      code: "corrupt-metadata",
    },
  ]);
  expect(JSON.stringify(issues)).not.toMatch(
    /private|password|token|reader|https/,
  );
  expect(await db.removeIssue(issues[0]!.recoveryId)).toBe(true);
  expect(await db.removeIssue(issues[0]!.recoveryId)).toBe(false);
  expect(await db.listIssues()).toEqual([]);
  expect(await db.get(scope, damaged.id)).toBeUndefined();
  expect((await db.get(scope, healthy.id))?.id).toBe(healthy.id);
  expect((await db.get(secondScope, another.id))?.id).toBe(another.id);
  expect(await db.database.table("payloads").count()).toBe(2);
});

it("does not let a stale recovery handle delete an edition repaired by a repeated download", async () => {
  const db = store(),
    f = await fixture(),
    saved = await db.put(f);
  await db.database
    .table("packages")
    .update(JSON.stringify([scope, saved.id]), { textSha256: "corrupt" });
  const [issue] = await db.listIssues();
  await db.put(f);
  expect(await db.removeIssue(issue!.recoveryId)).toBe(false);
  expect((await db.get(scope, saved.id))?.id).toBe(saved.id);
  expect(await db.listIssues()).toEqual([]);
});

it("handles malformed account fields and cyclic metadata without exposing corrupt values or blocking healthy packages", async () => {
  const db = store(),
    f = await fixture(),
    saved = await db.put(f);
  const row = await db.database
    .table("packages")
    .get(JSON.stringify([scope, saved.id]));
  const badScope = JSON.stringify([
    "https://reader:private-password@private.invalid/?token=private-token",
    "private-user",
  ]);
  await db.database.table("packages").put({
    ...row,
    key: JSON.stringify([badScope, saved.id]),
    scope: badScope,
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await db.database.table("packages").put({
    ...row,
    key: JSON.stringify([scope, "a".repeat(64)]),
    id: "a".repeat(64),
    corrupt: cyclic,
  });
  expect((await db.list(scope)).map((item) => item.id)).toEqual([saved.id]);
  expect(await db.listScopes()).toEqual([
    { scope, label: "Fixture reader", count: 1, totalBytes: saved.totalBytes },
  ]);
  const issues = await db.listIssues();
  expect(issues).toHaveLength(2);
  expect(JSON.stringify(issues)).not.toMatch(
    /private|password|token|reader|https/,
  );
  for (const issue of issues)
    expect(await db.removeIssue(issue.recoveryId)).toBe(true);
  expect((await db.get(scope, saved.id))?.id).toBe(saved.id);
});

it("rolls back explicit damaged-package removal if its blob deletion fails", async () => {
  const db = store(),
    f = await fixture(),
    saved = await db.put(f),
    identity = JSON.stringify([scope, saved.id]);
  await db.database
    .table("packages")
    .update(identity, { textFileId: "corrupt" });
  const [issue] = await db.listIssues();
  const failure = () => {
    throw new Error("Storage delete failed");
  };
  db.database.table("payloads").hook("deleting", failure);
  await expect(db.removeIssue(issue!.recoveryId)).rejects.toThrow(
    "Storage delete failed",
  );
  db.database.table("payloads").hook("deleting").unsubscribe(failure);
  expect(await db.database.table("packages").get(identity)).toBeDefined();
  expect(await db.database.table("payloads").get(identity)).toBeDefined();
  expect(await db.removeIssue(issue!.recoveryId)).toBe(true);
});

it("does not hide a cryptography failure as an empty healthy library", async () => {
  const db = store();
  await db.put(await fixture());
  vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(
    new Error("Crypto unavailable"),
  );
  await expect(db.listScopes()).rejects.toThrow("Crypto unavailable");
});

function client(f: OfflineReadAlongInput): OfflineDownloadClient {
  return {
    baseUrl: "https://fixture.invalid",
    session: {
      profile: {
        id: "fixture",
        name: "Fixture",
        url: "https://fixture.invalid",
      },
      userId: "reader",
      accessToken: "never-persist-access",
      refreshToken: "never-persist-refresh",
    },
    getFileBlob: vi.fn(async () => f.epub),
    getAudioManifest: vi.fn(async () => clone(f.manifest!)),
    getAudioAssetBlob: vi.fn(
      async (_book, asset) =>
        f.audioAssets!.find((item) => item.assetId === asset)!.blob,
    ),
  };
}
it("downloads every manifest asset via read-only APIs, rechecks the revision, and generates revocable local-only playback URLs", async () => {
  const db = store(),
    f = await fixture(),
    api = client(f);
  const saved = await downloadOfflineReadAlong(api, db, {
    ...f,
    epub: undefined,
  });
  expect(api.getFileBlob).toHaveBeenCalledOnce();
  expect(api.getAudioManifest).toHaveBeenCalledTimes(2);
  expect(api.getAudioAssetBlob).toHaveBeenCalledTimes(2);
  const restored = (await db.get(scope, saved.id))!;
  const create = vi.fn(() => `blob:offline/${Math.random()}`),
    revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: create,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revoke,
  });
  const playback = offlinePlaybackSource(restored);
  expect(
    playback.source.tracks.every((track) => track.url.startsWith("blob:")),
  ).toBe(true);
  expect(playback.source.tracks.map((track) => track.id)).toEqual(["41", "42"]);
  expect(playback.source.manifestRevision).toBe(f.manifest!.revision);
  playback.revoke();
  playback.revoke();
  expect(revoke).toHaveBeenCalledTimes(2);
});

it.each(["changed-manifest", "aborted", "stale-account"] as const)(
  "does not publish a download after %s",
  async (failure) => {
    const db = store(),
      f = await fixture(),
      api = client(f),
      controller = new AbortController();
    if (failure === "changed-manifest")
      vi.mocked(api.getAudioManifest)
        .mockResolvedValueOnce(clone(f.manifest!))
        .mockResolvedValueOnce({ ...clone(f.manifest!), revision: "changed" });
    else
      vi.mocked(api.getAudioAssetBlob).mockImplementationOnce(async () => {
        if (failure === "aborted") controller.abort();
        else api.session.userId = "other-account";
        return f.audioAssets![0]!.blob;
      });
    await expect(
      downloadOfflineReadAlong(api, db, f, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(await db.list(scope)).toEqual([]);
    expect(await db.database.table("payloads").count()).toBe(0);
  },
);

it("rejects immediately on cancellation during a manifest read and ignores its later completion", async () => {
  const db = store(),
    f = await fixture(),
    api = client(f),
    controller = new AbortController();
  let complete!: (value: AudioManifest) => void;
  vi.mocked(api.getAudioManifest).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = downloadOfflineReadAlong(api, db, f, {
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejected;
  complete(f.manifest!);
  await Promise.resolve();
  expect(api.getAudioAssetBlob).not.toHaveBeenCalled();
  expect(await db.list(scope)).toEqual([]);
});
