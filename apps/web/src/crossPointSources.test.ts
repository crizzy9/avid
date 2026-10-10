import { describe, expect, it, vi } from "vitest";
import type { Book, BookFile } from "../../../packages/core/src/types";
import {
  createCrossPointLibrarySources,
  CROSSPOINT_LIBRARY_FILE_LIMIT,
  CROSSPOINT_LIBRARY_SOURCE_LIMIT,
} from "./crossPointSources";

const book = (id: string, files: BookFile[]): Book => ({
  id, title: `Title ${id}`, authors: [], description: "", format: "EPUB", color: "#000",
  progress: 0, status: "unread", genres: [], addedAt: "2026-10-09", files,
});
const epub = (id: string, size?: number): BookFile => ({ id, name: `${id}.epub`, format: "EPUB", size });
function fixture(books: Book[]) {
  let active = true;
  const repo = { scope: '["https://books.example","one"]', getLocalFile: vi.fn<(id: string) => Promise<File | undefined>>() };
  const client = { getFileBlob: vi.fn<(id: string, signal?: AbortSignal, maximumBytes?: number) => Promise<Blob>>() };
  const sources = createCrossPointLibrarySources({ books, repo, client, isActive: () => active });
  return { sources, repo, client, deactivate: () => { active = false; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => { resolve = ready; });
  return { promise, resolve };
}

describe("lazy library EPUB transfer sources", () => {
  it("uses only bounded eligible metadata without loading bytes or sample URLs", () => {
    const first = book("1", [epub("11", 1), epub("12", CROSSPOINT_LIBRARY_FILE_LIMIT + 1), epub("13", 0),
      { ...epub("14"), format: "PDF" }, { ...epub("15"), name: "unsupported.mobi" }]);
    const many = Array.from({ length: 250 }, (_, i) => book(String(i + 20), [epub(String(i + 100))]));
    const f = fixture([first, first, book("demo-sample", [epub("demo-file")]), book("local-import", [epub("local-file")]), ...many]);
    expect(f.sources).toHaveLength(CROSSPOINT_LIBRARY_SOURCE_LIMIT);
    expect(f.sources.slice(0, 2).map((source) => source.name)).toEqual(["11.epub", "local-file.epub"]);
    expect(f.sources[0].label).toBe("Title 1 · 11.epub");
    expect(f.sources[0].id).toBe(JSON.stringify([f.repo.scope, "1", "11"]));
    expect(f.client.getFileBlob).not.toHaveBeenCalled();
    expect(f.repo.getLocalFile).not.toHaveBeenCalled();
  });

  it("loads the exact server file only on request and forwards its abort signal", async () => {
    const f = fixture([book("1", [epub("11")])]);
    const bytes = new Blob(["exact server EPUB bytes"], { type: "application/epub+zip" });
    f.client.getFileBlob.mockResolvedValue(bytes);
    const abort = new AbortController();
    expect(await f.sources[0].load(abort.signal)).toBe(bytes);
    expect(f.client.getFileBlob).toHaveBeenCalledExactlyOnceWith("11", abort.signal, CROSSPOINT_LIBRARY_FILE_LIMIT);
    expect(f.repo.getLocalFile).not.toHaveBeenCalled();
  });

  it("reads imported editions from their account repository without a server or URL fallback", async () => {
    const f = fixture([book("local-import", [{ ...epub("local-file"), url: "https://other.example/private.epub" }])]);
    const file = new File(["local EPUB bytes"], "original-name.epub", { type: "application/epub+zip" });
    f.repo.getLocalFile.mockResolvedValueOnce(file).mockResolvedValueOnce(undefined);
    expect(await f.sources[0].load()).toBe(file);
    expect(f.repo.getLocalFile).toHaveBeenCalledWith("local-file");
    await expect(f.sources[0].load()).rejects.toMatchObject({ code: "unsupported-file" });
    expect(f.client.getFileBlob).not.toHaveBeenCalled();
    expect(createCrossPointLibrarySources({ books: [book("1", [epub("11")])], repo: f.repo, client: null, isActive: () => true })).toEqual([]);
  });

  it("rejects a stale connection before I/O and after a pending local read", async () => {
    const before = fixture([book("1", [epub("11")])]);
    before.deactivate();
    await expect(before.sources[0].load()).rejects.toMatchObject({ name: "AbortError" });
    expect(before.client.getFileBlob).not.toHaveBeenCalled();

    const after = fixture([book("local-import", [epub("local-file")])]);
    const read = deferred<File>();
    after.repo.getLocalFile.mockReturnValue(read.promise);
    const pending = after.sources[0].load();
    after.deactivate(); // Even reconnecting to the same scope invalidates the captured owner.
    read.resolve(new File(["old account bytes"], "old.epub"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("settles cancellation before an unabortable read finishes and never returns late bytes", async () => {
    const f = fixture([book("1", [epub("11")])]);
    const read = deferred<Blob>();
    f.client.getFileBlob.mockReturnValue(read.promise);
    const abort = new AbortController();
    const pending = f.sources[0].load(abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    read.resolve(new Blob(["late bytes"]));
    const alreadyCanceled = new AbortController();
    alreadyCanceled.abort();
    await expect(f.sources[0].load(alreadyCanceled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.client.getFileBlob).toHaveBeenCalledTimes(1);
  });

  it("rejects empty or oversized actual results even when metadata omitted their size", async () => {
    const f = fixture([book("1", [epub("11")])]);
    f.client.getFileBlob.mockResolvedValueOnce(new Blob([]));
    await expect(f.sources[0].load()).rejects.toMatchObject({ code: "unsupported-file" });
    const oversized = new Blob(["fixture"]);
    Object.defineProperty(oversized, "size", { value: CROSSPOINT_LIBRARY_FILE_LIMIT + 1 });
    f.client.getFileBlob.mockResolvedValueOnce(oversized);
    await expect(f.sources[0].load()).rejects.toMatchObject({ code: "unsupported-file" });
  });
});
