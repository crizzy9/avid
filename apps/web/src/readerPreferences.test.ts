import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AvidDatabase,
  LibraryRepository,
} from "../../../packages/core/src/repository";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import { SyncCoordinator } from "../../../packages/core/src/sync";
import { SyncRecovery } from "../../../packages/core/src/syncRecovery";
import {
  createBookOrbitReaderPreferences,
  fromBookOrbitPreferences,
  toBookOrbitPreferencePatch,
} from "./readerPreferences";
const session = {
  profile: { id: "one", name: "Library", url: "https://books.example" },
  userId: "1",
  accessToken: "secret",
};
const file = { id: "5", name: "Book.epub", format: "EPUB" as const };
let db: AvidDatabase, repo: LibraryRepository, client: BookOrbitClient;
beforeEach(() => {
  db = new AvidDatabase(`prefs-${crypto.randomUUID()}`);
  repo = new LibraryRepository(db, session);
  client = new BookOrbitClient(session);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});
function adapter(
  options: Partial<Parameters<typeof createBookOrbitReaderPreferences>[0]> = {},
) {
  return createBookOrbitReaderPreferences({
    repo,
    client,
    bookId: "4",
    file,
    ...options,
  })!;
}
function reads() {
  vi.spyOn(client, "getReaderDefaults").mockResolvedValue({
    epub: { fontSize: 18, lineHeight: 1.5, gap: 0.1, footerDisplayMode: 2 },
  });
  return vi
    .spyOn(client, "getReaderPreferences")
    .mockResolvedValue({ settings: { fontSize: 23 }, isCustomized: true });
}

describe("sparse account and file reader preferences", () => {
  it("merges account defaults and file overrides without echoing them back to the server", async () => {
    reads();
    const write = vi.spyOn(client, "patchPreferences");
    expect(await adapter().load()).toEqual({
      fontSize: 23,
      lineHeight: 1.5,
      margin: 10,
    });
    expect(write).not.toHaveBeenCalled();
    expect(await repo.pendingOperations()).toEqual([]);
  });
  it("writes only fields the reader changed and preserves another client’s unrelated defaults", async () => {
    const remote = { fontSize: 19, lineHeight: 2, footerDisplayMode: 2 };
    const write = vi
      .spyOn(client, "patchPreferences")
      .mockImplementation(async (_file, set) => {
        Object.assign(remote, set);
      });
    await adapter().patch({ fontSize: 25 });
    expect(write).toHaveBeenCalledWith("5", { fontSize: 25 }, []);
    expect(remote).toEqual({
      fontSize: 25,
      lineHeight: 2,
      footerDisplayMode: 2,
    });
    expect(await repo.pendingOperations()).toEqual([]);
  });
  it("keeps read-only changes device-local even after a later writable connection", async () => {
    const transport = vi.fn();
    const readonly = new BookOrbitClient(session, {
      readOnly: true,
      fetch: transport,
    });
    await adapter({ client: readonly }).patch({
      fontSize: 27,
      flow: "scrolled",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(await repo.pendingOperations()).toEqual([]);
    reads();
    expect(await adapter().load()).toMatchObject({
      fontSize: 27,
      flow: "scrolled",
    });
    const write = vi.spyOn(client, "patchPreferences").mockResolvedValue();
    await adapter().patch({ fontSize: 20 });
    expect(write).toHaveBeenCalledWith("5", { fontSize: 20 }, []);
    expect(await repo.getPreferences("reader-file-overrides:5")).toEqual({
      flow: "scrolled",
    });
  });
  it("never sends imported fonts, custom colors, voices, or font sizes outside the server range", async () => {
    const write = vi.spyOn(client, "patchPreferences");
    await adapter().patch({
      font: "Imported on this device",
      theme: "custom",
      background: "#123456",
      voice: "native-voice",
      fontSize: 36,
    });
    expect(write).not.toHaveBeenCalled();
    expect(await repo.pendingOperations()).toEqual([]);
    reads();
    expect(await adapter().load()).toMatchObject({
      font: "Imported on this device",
      theme: "custom",
      background: "#123456",
      voice: "native-voice",
      fontSize: 36,
    });
  });
  it("retains failed patches durably, and applies pending fields over an older server response", async () => {
    reads();
    const write = vi
      .spyOn(client, "patchPreferences")
      .mockRejectedValue(new Error("offline"));
    await adapter().patch({ fontSize: 26 });
    const [operation] = await repo.pendingOperations();
    expect(operation.payload).toMatchObject({
      kind: "preferences",
      fileId: "5",
      set: { fontSize: 26 },
    });
    expect(await adapter().load()).toMatchObject({ fontSize: 26 });
    await repo.updateOperation(operation.id, { nextAttemptAt: undefined });
    write.mockResolvedValue();
    expect((await new SyncCoordinator(repo, client).flush()).sent).toBe(1);
    expect(await repo.pendingOperations()).toEqual([]);
  });
  it("supersedes only changed fields in older failed patches, preventing their later retry from undoing a new choice", async () => {
    const queued = adapter({ onQueued: async () => {} });
    await queued.patch({ fontSize: 20, lineHeight: 1.8 });
    const [first] = await repo.pendingOperations();
    await repo.updateOperation(first.id, { status: "failed" });
    await queued.patch({ fontSize: 25 });
    const operations = await repo.pendingOperations();
    expect(operations).toHaveLength(2);
    expect(
      operations.find((item) => item.id === first.id)?.payload,
    ).toMatchObject({
      set: { lineHeight: 1.8 },
      localSet: { lineHeight: 1.8 },
    });
    expect(
      operations.find((item) => item.id !== first.id)?.payload,
    ).toMatchObject({ set: { fontSize: 25 } });
  });
  it("does not replace an authorized old pending patch with a newer read-only edit", async () => {
    await adapter({ onQueued: async () => {} }).patch({ fontSize: 20 });
    await adapter({
      client: new BookOrbitClient(session, { readOnly: true }),
    }).patch({ fontSize: 28 });
    const write = vi.spyOn(client, "patchPreferences").mockResolvedValue();
    await new SyncCoordinator(repo, client).flush();
    expect(write).toHaveBeenCalledWith("5", { fontSize: 20 }, []);
    reads();
    expect(await adapter().load()).toMatchObject({ fontSize: 28 });
  });
  it("checks the account again when a delayed preference read finishes", async () => {
    let active = true;
    vi.spyOn(client, "getReaderDefaults").mockResolvedValue({});
    vi.spyOn(client, "getReaderPreferences").mockImplementation(async () => {
      active = false;
      return { settings: { fontSize: 25 }, isCustomized: true };
    });
    await expect(adapter({ isActive: () => active }).load()).rejects.toThrow(
      "no longer active",
    );
  });
  it("isolates overrides by both account and file", async () => {
    await adapter({
      client: new BookOrbitClient(session, { readOnly: true }),
    }).patch({ fontSize: 27 });
    reads();
    expect(await adapter({ file: { ...file, id: "6" } }).load()).toMatchObject({
      fontSize: 23,
    });
    const other = { ...session, userId: "2" };
    expect(() => adapter({ repo: new LibraryRepository(db, other) })).toThrow(
      "different account",
    );
  });
  it("supports explicit comic direction removal while preserving automatic manga filing", async () => {
    const cbz = { ...file, format: "CBZ" as const };
    vi.spyOn(client, "getReaderDefaults").mockResolvedValue({
      cbx: { direction: "ltr", viewMode: "two-page" },
    });
    vi.spyOn(client, "getReaderPreferences").mockResolvedValue({
      settings: {},
      isCustomized: false,
    });
    const write = vi.spyOn(client, "patchPreferences").mockResolvedValue();
    const port = adapter({ file: cbz });
    expect(await port.load()).toEqual({ comicMode: "spread" });
    await port.patch({ comicDirection: "auto" });
    expect(write).toHaveBeenCalledWith("5", {}, ["direction"]);
    expect(await port.load()).toEqual({
      comicMode: "spread",
      comicDirection: "auto",
    });
  });
  it("retains a failed preference locally when recovery explicitly stops its synchronization", async () => {
    reads();
    await adapter({ onQueued: async () => {} }).patch({ fontSize: 27 });
    const [operation] = await repo.pendingOperations();
    await repo.updateOperation(operation.id, { status: "failed" });
    const recovery = new SyncRecovery(repo, client);
    await recovery.resolve(await recovery.inspect(operation.id), "keep-device");
    expect(await repo.pendingOperations()).toEqual([]);
    expect(await adapter().load()).toMatchObject({ fontSize: 27 });
  });
  it("serializes claims for different patches on the same file across tabs", async () => {
    const port = adapter({ onQueued: async () => {} });
    await port.patch({ fontSize: 20 });
    const [first] = await repo.pendingOperations();
    await repo.claimOperation(first.id);
    await port.patch({ fontSize: 26 });
    const next = (await repo.pendingOperations()).find(
      (item) => item.id !== first.id,
    )!;
    expect(await repo.claimOperation(next.id)).toBeUndefined();
    await repo.acknowledge(first.id);
    expect(await repo.claimOperation(next.id)).toBeDefined();
  });
  it("maps the verified units and excludes unrelated or malformed fields", () => {
    expect(
      toBookOrbitPreferencePatch("EPUB", { margin: 9, theme: "warm" }).set,
    ).toEqual({ gap: 0.09, themeName: "sepia", isDark: false });
    expect(
      toBookOrbitPreferencePatch("CBZ", { comicMode: "webtoon" }).set,
    ).toEqual({ viewMode: "single", scrollMode: "long-strip" });
    expect(
      fromBookOrbitPreferences("EPUB", {
        fontSize: -12,
        lineHeight: "bad",
        fontFamily: "<script>",
        flow: "unknown",
        gap: Infinity,
      }),
    ).toEqual({});
    expect(
      createBookOrbitReaderPreferences({
        repo,
        client,
        bookId: "local-1",
        file,
      }),
    ).toBeUndefined();
    expect(
      createBookOrbitReaderPreferences({
        repo,
        client,
        bookId: "4",
        file: { ...file, format: "PDF" },
      }),
    ).toBeUndefined();
  });
});
