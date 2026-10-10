import "fake-indexeddb/auto";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvidDatabase, LibraryRepository } from "../src/repository";
import { DexieLibraryStorage, storageKey } from "../src/storage";
import { NativeLibraryStorage } from "../src/nativeStorage";
import {
  migrateLibraryAccount,
  MigratingLibraryStorage,
  migrationReceiptId,
} from "../src/storageMigration";
import { FixtureStorageBridge } from "./helpers/nativeStorageBridge";
import type { Book, ReadingAnchor, Session } from "../src/types";
const session: Session = {
  profile: { id: "fixture", name: "Fixture", url: "https://migration.invalid" },
  userId: "1",
  accessToken: "not-migrated",
};
const anchor: ReadingAnchor = {
  bookId: "4",
  fileId: "5",
  kind: "epub",
  locator: "exact-cfi",
  progress: 0.2,
  updatedAt: "2026-10-09T01:00:00Z",
};
const book: Book = {
  id: "4",
  title: "Original",
  authors: [],
  description: "",
  format: "EPUB",
  color: "sand",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: anchor.updatedAt,
  files: [],
};
const databases: AvidDatabase[] = [];
afterEach(async () => {
  for (const db of databases) await db.delete();
  databases.length = 0;
  vi.restoreAllMocks();
});

describe("migration readiness boundary", () => {
  it("shares one account migration and holds reads and writes until verification completes", async () => {
    const f = setup();
    await populate(f.legacy);
    const wrapper = new MigratingLibraryStorage(f.source, f.target);
    const repo = new LibraryRepository(wrapper, session);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const copyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const commit = f.bridge.commit.bind(f.bridge);
    let first = true;
    vi.spyOn(f.bridge, "commit").mockImplementation(async (request) => {
      if (
        first &&
        request.mutations.some(
          (mutation) => mutation.type === "put" && mutation.table === "books",
        )
      ) {
        first = false;
        started();
        await gate;
      }
      return commit(request);
    });
    const sourceTransactions = vi.spyOn(f.source, "atomic");
    const books = repo.getBooks();
    const saved = repo.checkpoint(
      {
        ...anchor,
        locator: "after-migration",
        updatedAt: "2026-10-09T03:00:00Z",
      },
      { readOnly: true },
    );
    await copyStarted;
    expect(await f.native.getAnchors()).toEqual([]);
    release();
    await Promise.all([books, saved]);
    expect(sourceTransactions).toHaveBeenCalledTimes(2);
    expect((await repo.getAnchor(anchor))?.locator).toBe("after-migration");
    expect((await repo.getAnnotations())[0].text).toBe("Remember");
    expect(sourceTransactions).toHaveBeenCalledTimes(2);
  });
  it("surfaces a failed attempt to all waiting callers and permits a later operation to retry", async () => {
    const f = setup();
    await populate(f.legacy);
    const wrapper = new MigratingLibraryStorage(f.source, f.target),
      repo = new LibraryRepository(wrapper, session);
    vi.spyOn(f.bridge, "read").mockRejectedValueOnce(
      new Error("native disk unavailable"),
    );
    const results = await Promise.allSettled([
      repo.getBooks(),
      repo.getAnnotations(),
    ]);
    expect(
      results.every(
        (result) =>
          result.status === "rejected" &&
          result.reason.message === "native disk unavailable",
      ),
    ).toBe(true);
    expect(await repo.getBooks()).toHaveLength(1);
    expect(
      (await repo.getPreferences(migrationReceiptId(f.source.name))).version,
    ).toBe(1);
  });
  it("keeps simultaneous account readiness separate and rejects malformed scopes before I/O", async () => {
    const f = setup();
    await populate(f.legacy);
    const otherSession = { ...session, userId: "2" };
    await new LibraryRepository(f.source, otherSession).putBooks([
      { ...book, title: "Other private title" },
    ]);
    const wrapper = new MigratingLibraryStorage(f.source, f.target);
    const first = new LibraryRepository(wrapper, session),
      second = new LibraryRepository(wrapper, otherSession);
    const [one, two] = await Promise.all([first.getBooks(), second.getBooks()]);
    expect(one[0].title).toBe("Original");
    expect(two[0].title).toBe("Other private title");
    const reads = vi.spyOn(f.bridge, "read");
    reads.mockClear();
    await expect(
      wrapper.ready('["https://migration.invalid/", "1"]'),
    ).rejects.toThrow("canonical");
    expect(reads).not.toHaveBeenCalled();
  });
});
function setup() {
  const db = new AvidDatabase(`legacy-${crypto.randomUUID()}`);
  databases.push(db);
  const source = new DexieLibraryStorage(db),
    bridge = new FixtureStorageBridge(),
    target = new NativeLibraryStorage(bridge);
  const legacy = new LibraryRepository(source, session),
    native = new LibraryRepository(target, session);
  return {
    source,
    target,
    bridge,
    legacy,
    native,
    options: { source, target, session },
  };
}
async function populate(repo: LibraryRepository) {
  await repo.putBooks([book]);
  await repo.checkpoint(anchor);
  await repo.putAnnotation({
    id: "note",
    bookId: "4",
    fileId: "5",
    kind: "note",
    quote: "Words",
    text: "Remember",
    color: "yellow",
    locator: "exact-cfi",
    createdAt: anchor.updatedAt,
    updatedAt: anchor.updatedAt,
  });
  await repo.putCollections([
    { id: "collection", name: "Mine", bookIds: ["4"] },
  ]);
  await repo.patchPreferences({ theme: "warm" });
  await repo.recordSession(
    {
      id: "session",
      bookId: "4",
      kind: "reading",
      startedAt: anchor.updatedAt,
      duration: 30,
    },
    "5",
    { endedAt: "2026-10-09T01:00:30Z", readOnly: true },
  );
  await repo.putRecord("nativeReceipts", {
    key: storageKey(repo.scope, "receipt"),
    scope: repo.scope,
    id: "receipt",
    value: { fingerprint: "existing-native-replay" },
  });
}
describe("copy-before-activation account migration", () => {
  it("copies every table and exact file bytes, verifies the native copy, and preserves the complete source", async () => {
    const f = setup();
    await populate(f.legacy);
    const bytes = Uint8Array.from({ length: 270_013 }, (_, i) => i % 251);
    const file = new File([bytes], "original.epub", {
      type: "application/epub+zip",
    });
    await f.legacy.putLocalEdition(
      {
        ...book,
        id: "local-work",
        files: [{ id: "local-file", name: file.name, format: "EPUB" }],
      },
      "local-file",
      file,
    );
    const sourceBefore = await f.legacy.getBooks();
    const outbox = await f.legacy.pendingOperations();
    const result = await migrateLibraryAccount(f.options);
    expect(result.status).toBe("copied");
    expect(result.receipt.counts).toEqual({
      books: 2,
      anchors: 1,
      annotations: 1,
      collections: 1,
      sessions: 1,
      preferences: 1,
      outbox: 2,
      localFiles: 1,
      nativeReceipts: 1,
    });
    expect(result.receipt.fileBytes).toBe(bytes.length);
    expect(await f.native.getBooks()).toEqual(sourceBefore);
    expect(await f.native.pendingOperations()).toEqual(outbox);
    expect(await f.native.getSessions()).toEqual(await f.legacy.getSessions());
    expect(
      Buffer.compare(
        Buffer.from(
          await (await f.native.getLocalFile("local-file"))!.arrayBuffer(),
        ),
        Buffer.from(bytes),
      ),
    ).toBe(0);
    expect(await f.legacy.getBooks()).toEqual(sourceBefore);
    expect(await f.legacy.pendingOperations()).toEqual(outbox);
    expect(
      await f.legacy.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect(
      (await f.native.getPreferences(migrationReceiptId(f.source.name)))
        .sourceFingerprint,
    ).toBe(result.receipt.sourceFingerprint);
    expect(
      JSON.stringify(await f.native.readRecords("preferences")),
    ).not.toContain("not-migrated");
    expect(f.bridge.chunks.every((size) => size <= 256 * 1024)).toBe(true);
    expect(
      f.bridge.reads.every((read) => (read.query?.ids?.length ?? 0) <= 200),
    ).toBe(true);
  });
  it("is idempotent after success without re-reading legacy files or overwriting subsequent native edits", async () => {
    const f = setup();
    await populate(f.legacy);
    const first = await migrateLibraryAccount(f.options);
    await f.native.patchPreferences({ theme: "dark" });
    await f.native.checkpoint(
      { ...anchor, locator: "native-new", updatedAt: "2026-10-09T02:00:00Z" },
      { readOnly: true },
    );
    const sourceRead = vi.spyOn(f.source, "atomic");
    const again = await migrateLibraryAccount(f.options);
    expect(again).toEqual({
      status: "already-complete",
      receipt: first.receipt,
    });
    expect(sourceRead).not.toHaveBeenCalled();
    expect((await f.native.getAnchor(anchor))?.locator).toBe("native-new");
    expect(await f.native.getPreferences()).toEqual({ theme: "dark" });
  });
  it("rejects conflicting destination content without publishing any copied rows or a receipt", async () => {
    const f = setup();
    await populate(f.legacy);
    await f.native.putBooks([{ ...book, title: "Native version" }]);
    await expect(migrateLibraryAccount(f.options)).rejects.toMatchObject({
      name: "StorageMigrationConflictError",
      table: "books",
      recordId: "4",
    });
    expect((await f.native.getBook("4"))?.title).toBe("Native version");
    expect(await f.native.getAnchors()).toEqual([]);
    expect(await f.native.getAnnotations()).toEqual([]);
    expect(
      await f.native.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect((await f.legacy.getBook("4"))?.title).toBe("Original");
  });
  it("resumes after a failure between copy and receipt, without duplicating rows or queue operations", async () => {
    const f = setup();
    await populate(f.legacy);
    const original = f.bridge.commit.bind(f.bridge);
    let fail = true;
    vi.spyOn(f.bridge, "commit").mockImplementation(async (request) => {
      if (
        fail &&
        request.mutations.some(
          (mutation) =>
            mutation.type === "put" &&
            mutation.row.id === migrationReceiptId(f.source.name),
        )
      ) {
        fail = false;
        throw new Error("disk failure");
      }
      return original(request);
    });
    await expect(migrateLibraryAccount(f.options)).rejects.toThrow(
      "disk failure",
    );
    expect(await f.native.getBooks()).toHaveLength(1);
    expect(
      await f.native.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect((await migrateLibraryAccount(f.options)).status).toBe("copied");
    expect(await f.native.pendingOperations()).toHaveLength(2);
    expect(await f.native.getAnnotations()).toHaveLength(1);
  });
  it("records no completion if read-back bytes or committed rows differ", async () => {
    const f = setup();
    await populate(f.legacy);
    const original = f.bridge.commit.bind(f.bridge);
    let corrupt = true;
    vi.spyOn(f.bridge, "commit").mockImplementation(async (request) => {
      const result = await original(request);
      if (
        corrupt &&
        result.committed &&
        request.mutations.some(
          (mutation) => mutation.type === "put" && mutation.table === "books",
        )
      ) {
        corrupt = false;
        f.bridge.rows.get(f.bridge.key(f.native.scope, "books"))!.delete("4");
      }
      return result;
    });
    await expect(migrateLibraryAccount(f.options)).rejects.toMatchObject({
      name: "StorageMigrationVerificationError",
    });
    expect(
      await f.native.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect((await f.legacy.getBook("4"))?.title).toBe("Original");
    expect((await migrateLibraryAccount(f.options)).status).toBe("copied");
  });
  it("isolates accounts and refuses a changed source before marking completion", async () => {
    const f = setup();
    await populate(f.legacy);
    const other = new LibraryRepository(f.source, { ...session, userId: "2" });
    await other.putBooks([{ ...book, title: "Private other account" }]);
    const original = f.bridge.commit.bind(f.bridge);
    let change = true;
    vi.spyOn(f.bridge, "commit").mockImplementation(async (request) => {
      const result = await original(request);
      if (change && result.committed && request.mutations.length) {
        change = false;
        await f.legacy.patchPreferences({ theme: "changed-during-copy" });
      }
      return result;
    });
    await expect(migrateLibraryAccount(f.options)).rejects.toThrow(
      "changed during migration",
    );
    expect(
      await f.native.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect((await other.getBook("4"))?.title).toBe("Private other account");
    expect(
      await new LibraryRepository(f.target, {
        ...session,
        userId: "2",
      }).getBooks(),
    ).toEqual([]);
    expect(await f.legacy.getPreferences()).toEqual({
      theme: "changed-during-copy",
    });
  });
  it("detects same-size file corruption before writing the completion receipt", async () => {
    const f = setup();
    const file = new File([new Uint8Array([1, 2, 3])], "original.epub", {
      type: "application/epub+zip",
    });
    await f.legacy.putLocalEdition(
      {
        ...book,
        id: "local-book",
        files: [{ id: "local-file", name: file.name, format: "EPUB" }],
      },
      "local-file",
      file,
    );
    const commit = f.bridge.commit.bind(f.bridge);
    vi.spyOn(f.bridge, "commit").mockImplementation(async (request) => {
      const result = await commit(request);
      if (
        request.mutations.some(
          (mutation) =>
            mutation.type === "put" && mutation.table === "localFiles",
        )
      )
        for (const blob of f.bridge.blobs.values()) blob.bytes[0] = 99;
      return result;
    });
    await expect(migrateLibraryAccount(f.options)).rejects.toMatchObject({
      name: "StorageMigrationConflictError",
      table: "localFiles",
    });
    expect(
      await f.native.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect([
      ...new Uint8Array(
        await (await f.legacy.getLocalFile("local-file"))!.arrayBuffer(),
      ),
    ]).toEqual([1, 2, 3]);
  });
  it("does not certify a destination modified between verification and the receipt commit", async () => {
    const f = setup();
    await populate(f.legacy);
    const commit = f.bridge.commit.bind(f.bridge);
    let intervene = true;
    vi.spyOn(f.bridge, "commit").mockImplementation(async (request) => {
      if (
        intervene &&
        request.mutations.some(
          (mutation) =>
            mutation.type === "put" &&
            mutation.row.id === migrationReceiptId(f.source.name),
        )
      ) {
        intervene = false;
        const key = f.bridge.key(f.native.scope, "books"),
          rows = f.bridge.rows.get(key)!;
        const row = rows.get("4")!;
        rows.set("4", {
          ...row,
          value: { ...(row.value as object), title: "Concurrent native edit" },
        });
        f.bridge.revisions.set(key, (f.bridge.revisions.get(key) ?? 0) + 1);
      }
      return commit(request);
    });
    await expect(migrateLibraryAccount(f.options)).rejects.toMatchObject({
      name: "StorageMigrationConflictError",
      table: "books",
    });
    expect(
      await f.native.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect((await f.native.getBook("4"))?.title).toBe("Concurrent native edit");
  });
  it("cancels before receipt publication and surfaces backend failures", async () => {
    const f = setup();
    await populate(f.legacy);
    let live = true;
    const original = f.bridge.commit.bind(f.bridge);
    vi.spyOn(f.bridge, "commit").mockImplementation(async (request) => {
      const result = await original(request);
      if (request.mutations.length) live = false;
      return result;
    });
    await expect(
      migrateLibraryAccount({ ...f.options, isActive: () => live }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      await f.native.getPreferences(migrationReceiptId(f.source.name)),
    ).toEqual({});
    expect(await f.legacy.getBooks()).toHaveLength(1);
    vi.spyOn(f.bridge, "read").mockRejectedValueOnce(
      new Error("native disk unavailable"),
    );
    await expect(migrateLibraryAccount(f.options)).rejects.toThrow(
      "native disk unavailable",
    );
  });
  it("rejects a malformed receipt and supports local verification in an IndexedDB destination", async () => {
    const f = setup();
    await f.native.patchPreferences(
      { version: 1 },
      migrationReceiptId(f.source.name),
    );
    await expect(migrateLibraryAccount(f.options)).rejects.toThrow(
      "receipt is invalid",
    );
    const db = new AvidDatabase(`destination-${crypto.randomUUID()}`);
    databases.push(db);
    await populate(f.legacy);
    const target = new DexieLibraryStorage(db);
    expect((await migrateLibraryAccount({ ...f.options, target })).status).toBe(
      "copied",
    );
    expect(
      await new LibraryRepository(target, session).getBooks(),
    ).toHaveLength(1);
  });
});
