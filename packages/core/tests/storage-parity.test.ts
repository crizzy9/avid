import "fake-indexeddb/auto";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvidDatabase, LibraryRepository } from "../src/repository";
import { NativeLibraryStorage } from "../src/nativeStorage";
import { DexieLibraryStorage, type LibraryStorage } from "../src/storage";
import type { Annotation, Book, ReadingAnchor, Session } from "../src/types";
import { FixtureStorageBridge } from "./helpers/nativeStorageBridge";
import { commitNativeEvents } from "../../../apps/web/src/nativeJournalReplay";
const session: Session = {
  profile: { id: "one", name: "One", url: "https://fixture.invalid" },
  accessToken: "never-store",
  userId: "1",
};
const anchor: ReadingAnchor = {
  bookId: "4",
  fileId: "5",
  kind: "epub",
  locator: "exact",
  progress: 0.6,
  updatedAt: "2026-10-09T00:00:00Z",
};
const book: Book = {
  id: "4",
  title: "Fixture",
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
const note: Annotation = {
  id: "one",
  bookId: "4",
  fileId: "5",
  kind: "note",
  quote: "Quote",
  text: "Text",
  color: "yellow",
  locator: "exact",
  createdAt: anchor.updatedAt,
  updatedAt: anchor.updatedAt,
};
const databases: AvidDatabase[] = [];
afterEach(async () => {
  for (const db of databases) await db.delete();
  databases.length = 0;
});
for (const backend of ["IndexedDB", "native CAS"] as const)
  describe(`${backend} storage parity`, () => {
    const setup = () => {
      let storage: LibraryStorage;
      if (backend === "IndexedDB") {
        const db = new AvidDatabase(crypto.randomUUID());
        databases.push(db);
        storage = new DexieLibraryStorage(db);
      } else storage = new NativeLibraryStorage(new FixtureStorageBridge());
      return new LibraryRepository(storage, session);
    };
    it("rolls back a whole local operation and isolates immutable account transactions", async () => {
      const repo = setup(),
        other = new LibraryRepository(repo.storage, {
          ...session,
          userId: "2",
        });
      await repo.putBooks([book]);
      await other.putBooks([{ ...book, title: "Other" }]);
      await expect(
        repo.atomic(["books", "anchors", "outbox"], async (tx) => {
          await tx.checkpoint(anchor);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await repo.getAnchors()).toEqual([]);
      expect(await repo.pendingOperations()).toEqual([]);
      expect((await repo.getBook("4"))?.progress).toBe(0);
      await repo.checkpoint(anchor);
      await other.checkpoint({ ...anchor, locator: "other" });
      await repo.clearAccount();
      expect(await repo.getBooks()).toEqual([]);
      expect((await other.getAnchor(anchor))?.locator).toBe("other");
    });
    it("preserves backward checkpoints, read-only provenance, note tombstones and canonical edits", async () => {
      const repo = setup();
      await repo.putBooks([book]);
      await repo.checkpoint(anchor);
      await repo.checkpoint({
        ...anchor,
        progress: 0.2,
        updatedAt: "2026-10-09T01:00:00Z",
      });
      await repo.importAnchor(anchor);
      expect((await repo.getBook("4"))?.progress).toBe(0.2);
      expect(await repo.pendingOperations()).toHaveLength(1);
      await repo.putAnnotation(
        { ...note, id: "7", deleted: true },
        { readOnly: true },
      );
      await repo.importAnnotations([{ ...note, id: "7" }]);
      expect(await repo.getAnnotations()).toEqual([]);
      await repo.putAnnotation(note);
      await repo.acknowledgeAnnotation("one", { ...note, id: "8" });
      expect((await repo.getAnnotations())[0].id).toBe("8");
      expect(
        (await repo.pendingOperations()).find(
          (op) => op.entityKey === "annotation:8",
        ),
      ).toBeDefined();
    });
    it("retains its original scope when a caller later mutates the supplied session object", async () => {
      const initial = setup();
      const mutable = { ...session, profile: { ...session.profile } };
      const repo = new LibraryRepository(initial.storage, mutable);
      mutable.userId = "different-user";
      mutable.profile.url = "https://different.invalid";
      await repo.checkpoint(anchor);
      expect((await initial.getAnchor(anchor))?.locator).toBe("exact");
      expect(
        await new LibraryRepository(initial.storage, mutable).getAnchors(),
      ).toEqual([]);
    });
    it("serializes concurrent session creation and claims and keeps native replay receipts atomic", async () => {
      const repo = setup(),
        second = new LibraryRepository(repo.storage, session);
      const activity = {
        id: "activity",
        bookId: "4",
        kind: "listening" as const,
        startedAt: anchor.updatedAt,
        duration: 30,
      };
      const endedAt = "2026-10-09T00:00:30Z";
      await Promise.all([
        repo.recordSession(activity, "5", { endedAt }),
        second.recordSession(activity, "5", { endedAt }),
      ]);
      const [operation] = await repo.pendingOperations();
      expect(await repo.getSessions()).toHaveLength(1);
      expect(await repo.pendingOperations()).toHaveLength(1);
      const claims = await Promise.all([
        repo.claimOperation(operation.id),
        second.claimOperation(operation.id),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const event = {
        id: "event",
        accountScope: repo.scope,
        bookId: "4",
        fileId: "5",
        createdAt: anchor.updatedAt,
        readOnly: true,
        type: "progress",
        payload: anchor,
      };
      await commitNativeEvents(repo, [event], false);
      await commitNativeEvents(second, [event], false);
      expect(await repo.readRecords("nativeReceipts")).toHaveLength(1);
      expect(await repo.pendingOperations()).toHaveLength(1);
      await expect(
        commitNativeEvents(
          repo,
          [{ ...event, payload: { ...anchor, locator: "changed" } }],
          false,
        ),
      ).rejects.toThrow("reused");
      expect((await repo.getAnchor(anchor))?.locator).toBe("exact");
    });
  });
describe("native storage bridge boundaries", () => {
  it("reuploads the same Blob after a failed commit or account clearing instead of reusing an expired native receipt", async () => {
    const bridge = new FixtureStorageBridge(),
      repo = new LibraryRepository(new NativeLibraryStorage(bridge), session);
    const file = new File(["bytes"], "original.epub", {
      type: "application/epub+zip",
    });
    const local: Book = {
      ...book,
      id: "local-book",
      files: [{ id: "local-file", name: file.name, format: "EPUB" }],
    };
    const begin = vi.spyOn(bridge, "beginBlob"),
      commit = bridge.commit.bind(bridge);
    let fail = true;
    vi.spyOn(bridge, "commit").mockImplementation(async (request) => {
      for (const mutation of request.mutations)
        if (mutation.type === "put" && mutation.table === "localFiles") {
          const value = mutation.row.value as { blob: { blobId: string } };
          if (!bridge.blobs.has(value.blob.blobId))
            throw new Error("expired receipt");
          if (fail) {
            fail = false;
            throw new Error("disk unavailable");
          }
        }
      return commit(request);
    });
    await expect(
      repo.putLocalEdition(local, "local-file", file),
    ).rejects.toThrow("disk unavailable");
    bridge.blobs.clear();
    await repo.putLocalEdition(local, "local-file", file);
    expect(begin).toHaveBeenCalledTimes(2);
    expect((await repo.getLocalFile("local-file"))?.size).toBe(5);
    await repo.clearAccount();
    bridge.blobs.clear();
    await repo.putLocalEdition(local, "local-file", file);
    expect(begin).toHaveBeenCalledTimes(3);
  });
  it("retries a CAS conflict without dropping a checkpoint or duplicating its intent", async () => {
    const bridge = new FixtureStorageBridge(),
      repo = new LibraryRepository(new NativeLibraryStorage(bridge), session);
    await repo.putBooks([book]);
    bridge.rejectNextCommit = true;
    await repo.checkpoint(anchor);
    expect((await repo.getAnchor(anchor))?.locator).toBe("exact");
    expect(await repo.pendingOperations()).toHaveLength(1);
    expect(bridge.commits).toBe(3);
    expect(
      bridge.reads
        .filter((read) => read.table === "books")
        .every(
          (read) =>
            read.query?.ids?.length === 1 || read.query?.ids?.length === 0,
        ),
    ).toBe(true);
  });
  it("imports and restores exact bytes in bounded chunks, while imported-book listing reads metadata only", async () => {
    const bridge = new FixtureStorageBridge(),
      repo = new LibraryRepository(new NativeLibraryStorage(bridge), session);
    const bytes = Uint8Array.from({ length: 600_123 }, (_, i) => i % 251);
    const file = new File([bytes], "original.epub", {
      type: "application/epub+zip",
    });
    const localBook: Book = {
      ...book,
      id: "local-work",
      files: [{ id: "local-edition", name: file.name, format: "EPUB" }],
    };
    await repo.putLocalEdition(localBook, "local-edition", file);
    expect(bridge.chunks).toEqual([262144, 262144, 75835]);
    expect(await repo.getImportedBooks()).toHaveLength(1);
    expect(bridge.blobReads).toBe(0);
    const restored = await repo.getLocalFile("local-edition");
    expect(restored?.name).toBe(file.name);
    expect(
      Buffer.compare(
        Buffer.from(await restored!.arrayBuffer()),
        Buffer.from(bytes),
      ),
    ).toBe(0);
    expect(bridge.blobReads).toBe(3);
    const other = new LibraryRepository(repo.storage, {
      ...session,
      userId: "2",
    });
    expect(await other.getLocalFile("local-edition")).toBeUndefined();
  });
  it("rejects a wrong-account read before returning content and rejects truncated binary data", async () => {
    const bridge = new FixtureStorageBridge(),
      repo = new LibraryRepository(new NativeLibraryStorage(bridge), session);
    vi.spyOn(bridge, "read").mockResolvedValueOnce({
      revision: "1",
      rows: [{ key: "wrong", scope: "another", id: "4", value: book }],
    });
    await expect(repo.getBooks()).rejects.toThrow("account");
    const file = new File(["content"], "original.epub", {
      type: "application/epub+zip",
    });
    await repo.putLocalEdition(
      {
        ...book,
        id: "local-book",
        files: [{ id: "local-file", name: file.name, format: "EPUB" }],
      },
      "local-file",
      file,
    );
    vi.spyOn(bridge, "readBlob").mockResolvedValueOnce({
      dataBase64: "",
      done: true,
    });
    await expect(repo.getLocalFile("local-file")).rejects.toThrow("truncated");
  });
});
