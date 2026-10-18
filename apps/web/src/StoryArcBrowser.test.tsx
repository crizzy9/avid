// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Book } from "../../../packages/core/src/types";
import { setLocale } from "../../../packages/i18n/src";
import { StoryArcBrowser } from "./StoryArcBrowser";
import { demoBooks } from "./fixtures";
import type { StoryArcClient } from "./storyArcs";
vi.mock("./ui", () => ({
  BookCard: ({
    book,
    onSelect,
  }: {
    book: Book;
    onSelect: (book: Book) => void;
  }) => (
    <button data-book={book.id} onClick={() => onSelect(book)}>
      {book.title}
    </button>
  ),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  setLocale("en");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const comic = {
  ...demoBooks[0]!,
  id: "7",
  title: "Original comic",
  format: "CBZ" as const,
  files: [{ id: "8", format: "CBZ" as const, name: "comic.cbz" }],
  comicMetadata: { storyArcs: ["Original arc"], issueNumber: "2" },
};
function fixture(): StoryArcClient {
  return {
    listBooks: vi.fn(async () => ({
      items: [comic],
      total: 1,
      page: 1,
      size: 24,
    })),
    getBook: vi.fn(async () => comic),
  };
}
const render = (
  client: StoryArcClient | null,
  scope = "one",
  onBook = vi.fn(),
) =>
  act(async () =>
    root.render(
      <StoryArcBrowser
        client={client}
        repo={{ scope }}
        books={[]}
        onBook={onBook}
      />,
    ),
  );
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
it("loads only after explicit action and opens a real grouped comic", async () => {
  const client = fixture(),
    onBook = vi.fn();
  await render(client, "one", onBook);
  expect(client.listBooks).not.toHaveBeenCalled();
  await click("Read story-arc metadata");
  expect(client.getBook).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("1 of 1");
  await click("Original arc");
  expect(host.textContent).toContain("does not supply an arc reading sequence");
  await click("Original comic");
  expect(onBook).toHaveBeenCalledWith(comic);
});
it("keeps successfully indexed arcs when a later page fails and retries the same page", async () => {
  const client = fixture();
  vi.mocked(client.listBooks)
    .mockResolvedValueOnce({ items: [comic], total: 25, page: 1, size: 24 })
    .mockRejectedValueOnce(new Error("private error"))
    .mockResolvedValueOnce({ items: [], total: 25, page: 2, size: 24 });
  await render(client);
  await click("Read story-arc metadata");
  await click("Read next");
  expect(host.textContent).toContain("Original arc");
  expect(host.textContent).not.toContain("private error");
  await click("Retry this page");
  expect(
    vi.mocked(client.listBooks).mock.calls.map((call) => call[0]?.page),
  ).toEqual([1, 2, 2]);
});
it("discards late detail metadata after an account switch", async () => {
  const client = fixture();
  let finish!: (book: Book) => void;
  vi.mocked(client.getBook).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render(client);
  await click("Read story-arc metadata");
  await render(null, "two");
  await act(async () => finish(comic));
  expect(host.textContent).not.toContain("Original arc");
  expect(host.textContent).not.toContain("Original comic");
});
it("bounds mounted arc cards when local metadata has a large number of arcs", async () => {
  const books = Array.from({ length: 1000 }, (_, i) => ({
    ...comic,
    id: String(i),
    comicMetadata: { storyArcs: [`Arc ${i}`] },
  }));
  await act(async () =>
    root.render(
      <StoryArcBrowser
        client={null}
        repo={{ scope: "local" }}
        books={books}
        onBook={() => {}}
      />,
    ),
  );
  expect(host.querySelectorAll(".story-arc-groups>button")).toHaveLength(24);
  await click("Next");
  expect(host.querySelectorAll(".story-arc-groups>button")).toHaveLength(24);
});
