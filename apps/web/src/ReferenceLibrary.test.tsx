// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";
import { ReferenceLibrary } from "./ReferenceLibrary";
import { upsertCatalogBook } from "./referenceLibraryData";

const book = (id: string, format: Book["format"] = "EPUB"): Book => ({
  id,
  title: `Title ${id}`,
  authors: ["Author"],
  format,
  description: "",
  color: "#333333",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "2026-10-09",
  files: [{ id: `file-${id}`, name: `${id}.${format.toLowerCase()}`, format }],
});
const repo = () => ({ putBooks: vi.fn(async (_books: Book[]) => {}) });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("reference library shelves", () => {
  it("bounds mounted covers, preserves selections and opens the existing catalog only through See all", async () => {
    const onBrowse = vi.fn(),
      onSelect = vi.fn();
    const books = [
      book("audio", "AUDIO"),
      ...Array.from({ length: 100 }, (_, index) => book(String(index))),
      book("comic", "CBZ"),
    ];
    await act(async () =>
      root.render(
        <ReferenceLibrary
          books={books}
          repo={repo()}
          client={null}
          enabled
          onBrowse={onBrowse}
          onSelect={onSelect}
          onError={vi.fn()}
        >
          <div data-catalog="true">Existing filters and virtualized grid</div>
        </ReferenceLibrary>,
      ),
    );
    expect(host.querySelectorAll(".reference-library-shelf")).toHaveLength(3);
    expect(
      host.querySelectorAll(".reference-library-books .book-card"),
    ).toHaveLength(16);
    expect(
      host.querySelector(".reference-library-books .reference-library-see-all")
        ?.textContent,
    ).toContain("100");
    expect(host.querySelectorAll(".reference-library-more")).toHaveLength(3);
    expect(host.querySelector("[data-catalog]")).toBeNull();
    await act(async () =>
      (
        host.querySelector(
          ".reference-library-audio .book-card",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onSelect).toHaveBeenCalledWith(books[0]);
    await act(async () =>
      (
        host.querySelector(
          ".reference-library-books .reference-library-more",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onBrowse).toHaveBeenLastCalledWith("books");
    expect(host.querySelector("[data-catalog]")).not.toBeNull();
    expect(host.querySelector(".reference-library-shelf")).toBeNull();
    await act(async () =>
      (
        host.querySelector(".reference-library-back") as HTMLButtonElement
      ).click(),
    );
    expect(onBrowse).toHaveBeenLastCalledWith("all");
    expect(host.querySelectorAll(".reference-library-shelf")).toHaveLength(3);
  });

  it("keeps search and collection catalog views intact without fetching shelf metadata", async () => {
    const client = { listBooks: vi.fn<BookOrbitClient["listBooks"]>() },
      onBrowse = vi.fn();
    await act(async () =>
      root.render(
        <ReferenceLibrary
          books={[]}
          repo={repo()}
          client={client}
          enabled={false}
          onBrowse={onBrowse}
          onSelect={vi.fn()}
          onError={vi.fn()}
        >
          <input aria-label="Catalog search" />
        </ReferenceLibrary>,
      ),
    );
    expect(
      host.querySelector('input[aria-label="Catalog search"]'),
    ).not.toBeNull();
    expect(client.listBooks).not.toHaveBeenCalled();
    expect(onBrowse).not.toHaveBeenCalled();
  });

  it("returns to the shelf overview when the active Library tab is selected again", async () => {
    const storage = repo(),
      onBrowse = vi.fn();
    const render = (resetKey: number) => (
      <ReferenceLibrary
        books={[book("one")]}
        repo={storage}
        client={null}
        enabled
        resetKey={resetKey}
        onBrowse={onBrowse}
        onSelect={vi.fn()}
        onError={vi.fn()}
      >
        <div data-catalog="true" />
      </ReferenceLibrary>
    );
    await act(async () => root.render(render(0)));
    await act(async () =>
      (
        host.querySelector(
          ".reference-library-books .reference-library-see-all",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(host.querySelector("[data-catalog]")).not.toBeNull();
    await act(async () => root.render(render(1)));
    expect(host.querySelector("[data-catalog]")).toBeNull();
    expect(host.querySelectorAll(".reference-library-shelf")).toHaveLength(3);
    expect(onBrowse).toHaveBeenLastCalledWith("all");
  });

  it("uses actual remote totals, caches only bounded metadata and includes local editions", async () => {
    const storage = repo();
    const client = {
      listBooks: vi.fn<BookOrbitClient["listBooks"]>(async (options) => {
        const format =
          options?.media === "audio"
            ? "AUDIO"
            : options?.media === "comics"
              ? "CBZ"
              : "EPUB";
        return {
          items: [book(`remote-${format}`, format)],
          total: 501,
          page: 1,
          size: 16,
        };
      }),
    };
    await act(async () =>
      root.render(
        <ReferenceLibrary
          books={[book("local-import")]}
          repo={storage}
          client={client}
          enabled
          onBrowse={vi.fn()}
          onSelect={vi.fn()}
          onError={vi.fn()}
        >
          <div />
        </ReferenceLibrary>,
      ),
    );
    expect(client.listBooks).toHaveBeenCalledTimes(3);
    expect(storage.putBooks).toHaveBeenCalledOnce();
    expect(storage.putBooks.mock.calls[0][0]).toHaveLength(3);
    expect(
      host.querySelector(".reference-library-books .reference-library-see-all")
        ?.textContent,
    ).toContain("502");
    expect(
      host.querySelector(".reference-library-audio .reference-library-see-all")
        ?.textContent,
    ).toContain("501");
    expect(
      host.querySelectorAll(".reference-library-books .book-card"),
    ).toHaveLength(2);
  });

  it("discards old-account metadata that arrives after the active client changes", async () => {
    const pending: Array<
      (value: Awaited<ReturnType<BookOrbitClient["listBooks"]>>) => void
    > = [];
    const oldClient = {
      listBooks: vi.fn<BookOrbitClient["listBooks"]>(
        () => new Promise((resolve) => pending.push(resolve)),
      ),
    };
    const oldRepo = repo(),
      nextRepo = repo(),
      onError = vi.fn();
    const props = {
      enabled: true,
      onBrowse: vi.fn(),
      onSelect: vi.fn(),
      onError,
      children: <div />,
    };
    await act(async () =>
      root.render(
        <ReferenceLibrary
          {...props}
          books={[]}
          client={oldClient}
          repo={oldRepo}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <ReferenceLibrary
          {...props}
          books={[book("new-local")]}
          client={null}
          repo={nextRepo}
        />,
      ),
    );
    await act(async () =>
      pending.forEach((resolve) =>
        resolve({ items: [book("old-private")], total: 1, page: 1, size: 16 }),
      ),
    );
    expect(oldRepo.putBooks).not.toHaveBeenCalled();
    expect(nextRepo.putBooks).not.toHaveBeenCalled();
    expect(host.textContent).toContain("new-local");
    expect(host.textContent).not.toContain("old-private");
    expect(onError).not.toHaveBeenCalled();
    expect(
      oldClient.listBooks.mock.calls.every((call) => call[1]?.aborted),
    ).toBe(true);
  });

  it("opens an out-of-page shelf book with its confirmed queue status instead of stale shelf metadata", async () => {
    const storage = repo(),
      onSelect = vi.fn(),
      remote = book("shelf-only");
    const client = {
      listBooks: vi.fn<BookOrbitClient["listBooks"]>(async (query) => ({
        items: query?.media === "books" ? [remote] : [],
        total: query?.media === "books" ? 51 : 0,
        page: 1,
        size: 16,
      })),
    };
    const props = {
      repo: storage,
      client,
      enabled: true,
      onBrowse: vi.fn(),
      onSelect,
      onError: vi.fn(),
      children: <div />,
    };
    const firstPage = [book("first-page")];
    await act(async () =>
      root.render(<ReferenceLibrary {...props} books={firstPage} />),
    );
    await act(async () =>
      (
        host.querySelector(
          ".reference-library-books .book-card",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onSelect).toHaveBeenLastCalledWith(remote);
    const queued = { ...remote, serverStatus: "want_to_read" as const };
    const updated = upsertCatalogBook(firstPage, queued);
    await act(async () =>
      root.render(<ReferenceLibrary {...props} books={updated} />),
    );
    await act(async () =>
      (
        host.querySelector(
          ".reference-library-books .book-card",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onSelect).toHaveBeenLastCalledWith(queued);
    expect(
      host.querySelector(".reference-library-books .reference-library-see-all")
        ?.textContent,
    ).toContain("51");
    const unqueued = { ...remote, serverStatus: "unread" as const };
    await act(async () =>
      root.render(
        <ReferenceLibrary
          {...props}
          books={upsertCatalogBook(updated, unqueued)}
        />,
      ),
    );
    await act(async () =>
      (
        host.querySelector(
          ".reference-library-books .book-card",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onSelect).toHaveBeenLastCalledWith(unqueued);
    expect(client.listBooks).toHaveBeenCalledTimes(3);
  });
});
