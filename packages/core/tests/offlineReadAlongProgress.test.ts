import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { AvidDatabase, LibraryRepository } from "../src/repository";
import {
  createOfflineReadAlongRepository,
  seedOfflineReadAlongProgress,
} from "../src/offlineReadAlongProgress";
import type { OfflineReadAlongDescriptor } from "../src/offlineReadAlong";
import type { ReadingAnchor } from "../src/types";

const scope = JSON.stringify(["https://books.example", "reader"]);
const timestamp = "2026-10-10T10:00:00.123Z";
const reading: ReadingAnchor = {
  bookId: "12",
  fileId: "31",
  kind: "epub",
  locator: "epubcfi(/6/2!/4/2:3)",
  progress: 0.4,
  updatedAt: timestamp,
};
const audio: ReadingAnchor = {
  bookId: "12",
  fileId: "41",
  kind: "audio",
  progress: 0.5,
  updatedAt: timestamp,
  locator: JSON.stringify({
    version: 1,
    time: 15,
    trackId: "42",
    trackTime: 5,
    manifestRevision: "edition-1",
  }),
};
const databases: AvidDatabase[] = [];
function fixture(): OfflineReadAlongDescriptor {
  return {
    version: 1,
    id: crypto.randomUUID().replaceAll("-", "").repeat(2),
    scope,
    scopeLabel: "Fixture",
    mode: "paired",
    book: {
      id: "12",
      title: "Original edition",
      authors: [],
      description: "",
      format: "EPUB",
      color: "#ffffff",
      progress: 0,
      status: "unread",
      genres: [],
      addedAt: timestamp,
      files: [
        { id: "31", name: "Book.epub", format: "EPUB" },
        { id: "41", name: "Audio.wav", format: "AUDIO" },
      ],
    },
    textFileId: "31",
    textSha256: "b".repeat(64),
    epubSize: 100,
    totalBytes: 300,
    createdAt: timestamp,
    pairings: [],
    timedText: [],
    assets: [],
    integritySha256: "c".repeat(64),
    manifest: {
      schema: "bookorbit.audiobook-manifest",
      schemaVersion: 2,
      revision: "edition-1",
      totalDurationMs: 30000,
      chapters: [],
      assets: [10, 20].map((duration, i) => ({
        assetId: `asset-${i}`,
        fileId: 41 + i,
        sequence: i,
        format: "wav",
        durationMs: duration * 1000,
        sizeBytes: 100,
        etag: "original",
      })),
    },
    alignmentSnapshot: {
      version: "1",
      source: "epub-media-overlay",
      textFileId: "31",
      audioFileId: "41",
      edition: {
        accountScope: scope,
        bookId: "12",
        textFileId: "31",
        audioFileId: "41",
        textSha256: "b".repeat(64),
        manifestRevision: "edition-1",
      },
      tracks: [
        { id: "41", duration: 10 },
        { id: "42", duration: 20 },
      ],
      duration: 30,
      segments: [],
    },
  };
}
function open(pkg: OfflineReadAlongDescriptor) {
  const repository = createOfflineReadAlongRepository(pkg);
  databases.push(repository.db);
  return repository;
}
afterEach(async () => {
  vi.restoreAllMocks();
  const previous = databases.splice(0);
  previous.forEach((database) => database.close());
  for (const database of new Map(previous.map((db) => [db.name, db])).values())
    await database.delete();
});

it("seeds exact checkpoints with original timestamps and survives a cold database reopen without network", async () => {
  const pkg = fixture(),
    repository = open(pkg);
  const fetch = vi.spyOn(globalThis, "fetch");
  await seedOfflineReadAlongProgress(pkg, { reading, audio });
  repository.db.close();
  const restarted = open(pkg);
  expect(restarted.scope).toBe(scope);
  expect(restarted.db.name).toBe(
    `avid-offline-readalong-progress-v1-${pkg.id}`,
  );
  expect(await restarted.getAnchor(reading)).toEqual(reading);
  expect(await restarted.getAnchor(audio)).toEqual(audio);
  expect(await restarted.pendingOperations()).toEqual([]);
  expect(await restarted.getAnnotations()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("isolates changed package editions with reused book/file IDs from each other and the main library", async () => {
  const pkg = fixture(),
    original = open(pkg),
    changed = open({ ...pkg, id: fixture().id });
  const database = new AvidDatabase(`main-fixture-${crypto.randomUUID()}`);
  databases.push(database);
  const main = new LibraryRepository(database, {
    profile: { id: "server", name: "Server", url: "https://books.example" },
    userId: "reader",
  });
  await main.checkpoint({ ...reading, locator: "live-edition" });
  await seedOfflineReadAlongProgress(pkg, { reading });
  expect((await original.getAnchor(reading))?.locator).toBe(reading.locator);
  expect(await changed.getAnchor(reading)).toBeUndefined();
  await changed.checkpoint({ ...reading, locator: "changed-edition" });
  expect((await original.getAnchor(reading))?.locator).toBe(reading.locator);
  expect((await main.getAnchor(reading))?.locator).toBe("live-edition");
  expect(await main.pendingOperations()).toHaveLength(1);
  expect(await original.pendingOperations()).toEqual([]);
});

it("retains original account partitions even when saved package IDs are identical", async () => {
  const pkg = fixture(),
    original = open(pkg);
  const other = open({
    ...pkg,
    scope: JSON.stringify(["https://books.example", "other-reader"]),
  });
  const otherServer = open({
    ...pkg,
    scope: JSON.stringify(["https://other.example", "reader"]),
  });
  await original.checkpoint(reading);
  expect(await other.getAnchors()).toEqual([]);
  expect(await otherServer.getAnchors()).toEqual([]);
  await other.checkpoint({ ...reading, locator: "other-account" });
  await original.clearAccount();
  expect((await other.getAnchor(reading))?.locator).toBe("other-account");
});

it("never overwrites newer or equally timestamped offline positions, including backward seeks", async () => {
  const pkg = fixture(),
    repository = open(pkg);
  const later = {
    ...reading,
    locator: "epubcfi(/6/2!/4/2:1)",
    progress: 0.1,
    updatedAt: "2026-10-10T11:00:00Z",
  };
  await repository.checkpoint(later);
  await seedOfflineReadAlongProgress(pkg, { reading, audio });
  await seedOfflineReadAlongProgress(pkg, {
    reading: { ...reading, updatedAt: later.updatedAt },
  });
  expect(await repository.getAnchor(reading)).toEqual(later);
  expect(await repository.getAnchor(audio)).toEqual(audio);
  await seedOfflineReadAlongProgress(pkg, {
    reading: { ...reading, updatedAt: "2026-10-10T12:00:00Z" },
  });
  expect((await repository.getAnchor(reading))?.locator).toBe(reading.locator);
  expect(await repository.pendingOperations()).toEqual([]);
});

it("keeps future notes, activity, preferences and nested checkpoints local even without readOnly options", async () => {
  const pkg = fixture(),
    repository = open(pkg);
  await repository.putBooks([pkg.book]);
  await repository.checkpoint(reading);
  const note = {
    id: "offline-note",
    bookId: "12",
    fileId: "31",
    kind: "note" as const,
    quote: "Quote",
    text: "Private offline note",
    color: "yellow",
    locator: reading.locator,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await repository.putAnnotation(note, { readOnly: false });
  await repository.recordSession(
    {
      id: "activity",
      bookId: "12",
      kind: "reading",
      startedAt: timestamp,
      duration: 1,
    },
    "31",
    { endedAt: "2026-10-10T10:00:02Z" },
  );
  await repository.saveReaderPreferencePatch(
    "12",
    "31",
    {
      deviceSet: { fontSize: 20 },
      deviceUnset: [],
      set: { fontSize: 20 },
      unset: [],
      localSet: { fontSize: 20 },
    },
    { readOnly: false },
  );
  await repository.atomic(["anchors", "books", "outbox"], (tx) =>
    tx.checkpoint({
      ...reading,
      progress: 0.2,
      updatedAt: "2026-10-10T11:00:00Z",
    }),
  );
  expect(await repository.getAnnotations()).toEqual([note]);
  expect(await repository.getSessions()).toHaveLength(1);
  expect(await repository.getPreferences("reader-file-overrides:31")).toEqual({
    fontSize: 20,
  });
  expect((await repository.getBook("12"))?.progress).toBe(0.2);
  expect(await repository.pendingOperations()).toEqual([]);
  expect(await repository.db.outbox.count()).toBe(0);
});

it.each([
  { bookId: "another-book" },
  { fileId: "another-file" },
  { kind: "pdf" },
  { locator: "" },
  { progress: NaN },
  { progress: 1.1 },
  { updatedAt: "invalid" },
])(
  "rejects an invalid reading checkpoint before importing either seed: %j",
  async (patch) => {
    const pkg = fixture(),
      repository = open(pkg);
    await expect(
      seedOfflineReadAlongProgress(pkg, {
        reading: { ...reading, ...patch } as ReadingAnchor,
        audio,
      }),
    ).rejects.toThrow();
    expect(await repository.getAnchors()).toEqual([]);
  },
);

it.each([
  "15",
  JSON.stringify({ time: 15 }),
  JSON.stringify({ time: 15, manifestRevision: "changed" }),
  JSON.stringify({ time: 40, manifestRevision: "edition-1" }),
  JSON.stringify({
    time: 15,
    trackId: "missing",
    trackTime: 5,
    manifestRevision: "edition-1",
  }),
  JSON.stringify({
    time: 15,
    trackId: "42",
    trackTime: 50,
    manifestRevision: "edition-1",
  }),
  JSON.stringify({
    time: 15,
    trackId: "42",
    trackTime: 6,
    manifestRevision: "edition-1",
  }),
])(
  "rejects missing revision or inconsistent audio timeline atomically: %s",
  async (locator) => {
    const pkg = fixture(),
      repository = open(pkg);
    await expect(
      seedOfflineReadAlongProgress(pkg, {
        reading,
        audio: { ...audio, locator },
      }),
    ).rejects.toThrow();
    expect(await repository.getAnchors()).toEqual([]);
    expect(await repository.pendingOperations()).toEqual([]);
  },
);

it("accepts exact revisioned global-only or track-only audio positions", async () => {
  const pkg = fixture(),
    repository = open(pkg);
  await seedOfflineReadAlongProgress(pkg, {
    audio: {
      ...audio,
      locator: JSON.stringify({ time: 15, manifestRevision: "edition-1" }),
    },
  });
  expect((await repository.getAnchor(audio))?.locator).toBe(
    JSON.stringify({ time: 15, manifestRevision: "edition-1" }),
  );
  const trackOnly = {
    ...audio,
    locator: JSON.stringify({
      trackId: "42",
      trackTime: 3,
      manifestRevision: "edition-1",
    }),
    updatedAt: "2026-10-10T11:00:00Z",
  };
  await seedOfflineReadAlongProgress(pkg, { audio: trackOnly });
  expect(await repository.getAnchor(audio)).toEqual(trackOnly);
});

it("permits embedded EPUB reading seeds but never fabricates a paired audiobook checkpoint", async () => {
  const pkg = {
    ...fixture(),
    mode: "embedded" as const,
    manifest: undefined,
    alignmentSnapshot: undefined,
  };
  const repository = open(pkg);
  await seedOfflineReadAlongProgress(pkg, { reading });
  await expect(seedOfflineReadAlongProgress(pkg, { audio })).rejects.toThrow(
    "paired edition",
  );
  expect(await repository.getAnchors()).toEqual([reading]);
});

it("does not accept another account or text hash in paired edition metadata", async () => {
  const pkg = fixture(),
    repository = open(pkg);
  for (const patch of [
    { accountScope: "other" },
    { textSha256: "a".repeat(64) },
    { audioFileId: "42" },
  ]) {
    const invalid = {
      ...pkg,
      alignmentSnapshot: {
        ...pkg.alignmentSnapshot!,
        edition: { ...pkg.alignmentSnapshot!.edition, ...patch },
      },
    };
    await expect(
      seedOfflineReadAlongProgress(invalid, { reading, audio }),
    ).rejects.toThrow("paired edition");
  }
  expect(await repository.getAnchors()).toEqual([]);
});

it("rolls back the first checkpoint if writing the second fails", async () => {
  const pkg = fixture(),
    repository = open(pkg);
  const original = LibraryRepository.prototype.importAnchor;
  vi.spyOn(LibraryRepository.prototype, "importAnchor")
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error("Storage quota failed"));
  await expect(
    seedOfflineReadAlongProgress(pkg, { reading, audio }),
  ).rejects.toThrow("Storage quota failed");
  expect(await repository.getAnchors()).toEqual([]);
});

it("does not seed annotations or persist accidental extra fields on a live checkpoint", async () => {
  const pkg = fixture(),
    repository = open(pkg);
  await seedOfflineReadAlongProgress(pkg, {
    reading: { ...reading, accessToken: "not-persisted" } as ReadingAnchor,
  });
  expect(await repository.getAnchor(reading)).toEqual(reading);
  expect(await repository.getAnnotations()).toEqual([]);
});

it.each([
  "../avid-library-v1",
  "avid-library-v1",
  "a".repeat(64) + "\n",
  "A".repeat(64),
  "a".repeat(63),
])("rejects an unsafe or non-package database name: %s", (id) => {
  expect(() => createOfflineReadAlongRepository({ ...fixture(), id })).toThrow(
    "SHA-256 identity",
  );
});

it.each([
  JSON.stringify(["https://user:password@books.example", "reader"]),
  JSON.stringify(["https://books.example/?token=secret", "reader"]),
  JSON.stringify(["https://books.example/", "reader"]),
  JSON.stringify(["https://books.example", "reader", "extra"]),
  JSON.stringify(["https://books.example", ""]),
  "unscoped",
])(
  "rejects credentialed, ambiguous or noncanonical account scopes: %s",
  (account) => {
    expect(() =>
      createOfflineReadAlongRepository({ ...fixture(), scope: account }),
    ).toThrow("original account scope");
  },
);
