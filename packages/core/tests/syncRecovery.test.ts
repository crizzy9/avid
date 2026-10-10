import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvidDatabase, LibraryRepository } from "../src/repository";
import { BookOrbitClient } from "../src/bookorbit";
import { SyncCoordinator } from "../src/sync";
import { RecoveryChangedError, SyncRecovery } from "../src/syncRecovery";
import type { Annotation, ReadingAnchor, Session } from "../src/types";

const session: Session = {
  profile: { id: "one", name: "Books", url: "https://books.example" },
  userId: "1",
  accessToken: "secret",
};
const anchor: ReadingAnchor = {
  bookId: "4",
  fileId: "5",
  kind: "epub",
  locator: "epubcfi(/6/2)",
  progress: 0.3,
  updatedAt: "2026-10-09T10:00:00Z",
};
const remote: ReadingAnchor = {
  ...anchor,
  locator: "epubcfi(/6/8)",
  progress: 0.1,
  updatedAt: "2026-10-09T11:00:00Z",
};
const note: Annotation = {
  id: "22",
  bookId: "4",
  fileId: "5",
  kind: "note",
  quote: "Source",
  text: "Local note",
  color: "sand",
  locator: anchor.locator,
  createdAt: anchor.updatedAt,
  updatedAt: anchor.updatedAt,
};
let db: AvidDatabase, repo: LibraryRepository, client: BookOrbitClient;
beforeEach(() => {
  db = new AvidDatabase(`recovery-${crypto.randomUUID()}`);
  repo = new LibraryRepository(db, session);
  client = new BookOrbitClient(session);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});
async function pendingProgress() {
  await repo.checkpoint(anchor);
  const [op] = await repo.pendingOperations();
  await repo.updateOperation(op.id, { status: "conflict" });
  return op.id;
}
async function pendingNote(value = note) {
  await repo.putAnnotation(value);
  const [op] = await repo.pendingOperations();
  await repo.updateOperation(op.id, { status: "conflict", attempts: 1 });
  return op.id;
}

describe("explicit synchronization recovery", () => {
  it("archives both exact positions before accepting a backwards server position without a server write", async () => {
    const id = await pendingProgress();
    vi.spyOn(client, "getProgress").mockResolvedValue(remote);
    const save = vi.spyOn(client, "saveProgress");
    const recovery = new SyncRecovery(repo, client);
    const review = await recovery.inspect(id);
    await recovery.resolve(review, "use-server");
    expect(await repo.getAnchor(anchor)).toEqual(remote);
    expect(await repo.pendingOperations()).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect((await recovery.receipts())[0]).toMatchObject({
      action: "use-server",
      review: { local: { anchor }, remote: { value: remote } },
    });
  });
  it("turns an explicitly chosen local position into a new intent, retaining the original source time in its receipt", async () => {
    const id = await pendingProgress();
    vi.spyOn(client, "getProgress").mockResolvedValue(remote);
    const recovery = new SyncRecovery(repo, client);
    const receipt = await recovery.resolve(
      await recovery.inspect(id),
      "use-local",
    );
    const [operation] = await repo.pendingOperations();
    expect(operation.id).not.toBe(id);
    expect(operation.occurredAt).toBe(receipt.resolvedAt);
    expect(operation.payload).toEqual({
      kind: "progress",
      anchor: { ...anchor, updatedAt: receipt.resolvedAt },
    });
    expect(receipt.review.local).toEqual({ kind: "progress", anchor });
    const save = vi.spyOn(client, "saveProgress").mockResolvedValue();
    expect((await new SyncCoordinator(repo, client).flush()).sent).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("rejects a local checkpoint arriving after the comparison without erasing either pending event", async () => {
    const id = await pendingProgress();
    vi.spyOn(client, "getProgress").mockResolvedValue(remote);
    const recovery = new SyncRecovery(repo, client);
    const review = await recovery.inspect(id);
    const newer = {
      ...anchor,
      locator: "epubcfi(/6/10)",
      updatedAt: "2026-10-09T12:00:00Z",
    };
    await repo.checkpoint(newer);
    await expect(recovery.resolve(review, "use-server")).rejects.toBeInstanceOf(
      RecoveryChangedError,
    );
    expect(await repo.getAnchor(anchor)).toEqual(newer);
    expect(await repo.pendingOperations()).toHaveLength(2);
    expect(await recovery.receipts()).toEqual([]);
  });
  it("also detects device-only local edits without a new outbox record", async () => {
    const id = await pendingProgress();
    vi.spyOn(client, "getProgress").mockResolvedValue(remote);
    const recovery = new SyncRecovery(repo, client);
    const review = await recovery.inspect(id);
    await repo.checkpoint(
      { ...anchor, updatedAt: "2026-10-09T12:00:00Z" },
      { readOnly: true },
    );
    await expect(
      recovery.resolve(review, "keep-device"),
    ).rejects.toBeInstanceOf(RecoveryChangedError);
  });
  it("rereads and rejects a changed remote position before applying the reviewed decision", async () => {
    const id = await pendingProgress();
    vi.spyOn(client, "getProgress")
      .mockResolvedValueOnce(remote)
      .mockResolvedValue({ ...remote, progress: 0.7 });
    const recovery = new SyncRecovery(repo, client);
    await expect(
      recovery.resolve(await recovery.inspect(id), "use-local"),
    ).rejects.toBeInstanceOf(RecoveryChangedError);
    expect(await repo.getAnchor(anchor)).toEqual(anchor);
    expect(await recovery.receipts()).toEqual([]);
  });
  it("makes no network calls in read-only mode and cannot turn existing work into a write", async () => {
    const id = await pendingProgress();
    const transport = vi.fn();
    client = new BookOrbitClient(session, { readOnly: true, fetch: transport });
    const recovery = new SyncRecovery(repo, client);
    const review = await recovery.inspect(id);
    expect(recovery.actions(review)).toEqual(["keep-device"]);
    await expect(recovery.resolve(review, "retry")).rejects.toThrow(
      "read-only",
    );
    await recovery.resolve(review, "keep-device");
    expect(transport).not.toHaveBeenCalled();
    expect(await repo.getAnchor(anchor)).toEqual(anchor);
    expect(await repo.pendingOperations()).toEqual([]);
  });
  it("cannot resolve an old account after its server comparison returns", async () => {
    const id = await pendingProgress();
    let active = true;
    vi.spyOn(client, "getProgress").mockImplementation(async () => {
      active = false;
      return remote;
    });
    const recovery = new SyncRecovery(repo, client, { isActive: () => active });
    await expect(recovery.inspect(id)).rejects.toBeInstanceOf(
      RecoveryChangedError,
    );
    expect(await repo.pendingOperations()).toHaveLength(1);
  });
  it("rejects a different account before reading any queued data", () => {
    expect(
      () =>
        new SyncRecovery(
          repo,
          new BookOrbitClient({ ...session, userId: "2" }),
        ),
    ).toThrow("scopes");
  });
  it("does not convert an uncertain annotation create into a duplicate POST on explicit retry", async () => {
    const id = await pendingNote({ ...note, id: crypto.randomUUID() });
    vi.spyOn(client, "getAnnotations").mockResolvedValue([]);
    const save = vi.spyOn(client, "saveAnnotation");
    const recovery = new SyncRecovery(repo, client);
    const review = await recovery.inspect(id);
    expect(recovery.actions(review)).toEqual(["keep-device", "retry"]);
    await recovery.resolve(review, "retry");
    expect((await repo.pendingOperations())[0].status).toBe("uncertain");
    expect((await new SyncCoordinator(repo, client).flush()).conflicts).toBe(1);
    expect(save).not.toHaveBeenCalled();
  });
  it("accepts server deletion only explicitly and retains the deleted local note in the receipt", async () => {
    const id = await pendingNote();
    vi.spyOn(client, "getAnnotations").mockResolvedValue([]);
    const recovery = new SyncRecovery(repo, client);
    const review = await recovery.inspect(id);
    expect(recovery.actions(review)).not.toContain("use-local");
    await recovery.resolve(review, "use-server");
    expect(await repo.getAnnotations()).toEqual([]);
    expect((await repo.getAnnotations(undefined, true))[0].deleted).toBe(true);
    expect((await recovery.receipts())[0].review.local).toEqual({
      kind: "annotation",
      annotation: note,
    });
  });
  it("safely retries an immutable activity record with the same session identity and timing", async () => {
    const activity = {
      id: crypto.randomUUID(),
      bookId: "4",
      kind: "reading" as const,
      startedAt: anchor.updatedAt,
      duration: 42,
    };
    await repo.recordSession(activity, "5", {
      endedAt: "2026-10-09T10:00:42Z",
    });
    const [operation] = await repo.pendingOperations();
    await repo.updateOperation(operation.id, { status: "failed", attempts: 1 });
    const recovery = new SyncRecovery(repo, client);
    await recovery.resolve(await recovery.inspect(operation.id), "retry");
    const saved = vi.spyOn(client, "saveReadingSession").mockResolvedValue();
    expect((await new SyncCoordinator(repo, client).flush()).sent).toBe(1);
    expect(saved).toHaveBeenCalledWith(activity, "5", {
      endedAt: "2026-10-09T10:00:42Z",
    });
  });
  it("refuses to resolve an entity while another tab is writing it", async () => {
    const id = await pendingProgress();
    await repo.checkpoint({ ...anchor, updatedAt: "2026-10-09T12:00:00Z" });
    const second = (await repo.pendingOperations()).find(
      (operation) => operation.id !== id,
    )!;
    await repo.claimOperation(second.id);
    await expect(
      new SyncRecovery(repo, client).inspect(id),
    ).rejects.toBeInstanceOf(RecoveryChangedError);
  });
  it("retains local versions even when the comparison is unavailable and user stops their synchronization", async () => {
    const id = await pendingNote();
    vi.spyOn(client, "getAnnotations").mockRejectedValue(new Error("offline"));
    const recovery = new SyncRecovery(repo, client);
    const review = await recovery.inspect(id);
    expect(review.remote).toEqual({ kind: "unavailable", reason: "offline" });
    await recovery.resolve(review, "keep-device");
    expect(await repo.getAnnotations()).toEqual([note]);
    expect(await repo.pendingOperations()).toEqual([]);
    expect(await recovery.receipts()).toHaveLength(1);
  });
});
