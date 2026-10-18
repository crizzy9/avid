import { expect, it, vi } from "vitest";
import { demoBooks } from "./fixtures";
import {
  groupStoryArcs,
  loadStoryArcPage,
  STORY_ARC_PAGE_SIZE,
  STORY_ARC_CONCURRENCY,
} from "./storyArcs";
import { storyArcMessages } from "./storyArcMessages";
import { notificationMessages } from "./notificationMessages";
const comic = (id: string, issueNumber: string, storyArcs: string[]) => ({
  ...demoBooks[0]!,
  id,
  title: `Issue ${issueNumber}`,
  format: "CBZ" as const,
  files: [{ id: `f${id}`, name: "comic.cbz", format: "CBZ" as const }],
  series: "Series",
  comicMetadata: { issueNumber, storyArcs },
});
it("supports multiple arcs, keeps unknown metadata separate and uses actual issue order", () => {
  const issue10 = comic("10", "10", ["Arc", "Other"]),
    issue2 = comic("2", "2", ["Arc", " Arc "]),
    unknown = comic("3", "3", []);
  const result = groupStoryArcs([
    issue10,
    issue2,
    unknown,
    issue10,
    demoBooks[0]!,
  ]);
  expect(
    result.groups.map((group) => [
      group.name,
      group.books.map((book) => book.id),
    ]),
  ).toEqual([
    ["Arc", ["2", "10"]],
    ["Other", ["10"]],
  ]);
  expect(result.ungrouped.map((book) => book.id)).toEqual(["3"]);
});
it("indexes only a bounded comic page with at most four concurrent detail reads", async () => {
  let running = 0,
    peak = 0;
  const cards = Array.from({ length: 24 }, (_, i) =>
    comic(String(i + 1), String(i + 1), ["Arc"]),
  );
  const client = {
    listBooks: vi.fn(async () => ({
      items: cards,
      total: 10000,
      page: 2,
      size: 24,
    })),
    getBook: vi.fn(async (id: string) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      await Promise.resolve();
      running--;
      return cards.find((book) => book.id === id)!;
    }),
  };
  const signal = new AbortController().signal;
  const result = await loadStoryArcPage(client, 2, signal);
  expect(client.listBooks).toHaveBeenCalledWith(
    {
      media: "comics",
      page: 2,
      size: STORY_ARC_PAGE_SIZE,
      sort: "title",
      direction: "asc",
    },
    signal,
  );
  expect(client.getBook).toHaveBeenCalledTimes(24);
  expect(peak).toBe(STORY_ARC_CONCURRENCY);
  expect(result.books).toHaveLength(24);
  expect(result.total).toBe(10000);
  expect(result.failedIds).toEqual([]);
});
it("retains successful details on partial errors and rejects a changed book identity", async () => {
  const cards = [
    comic("1", "1", ["Arc"]),
    comic("2", "2", []),
    comic("3", "3", []),
  ];
  const client = {
    listBooks: vi.fn(async () => ({
      items: cards,
      total: 3,
      page: 1,
      size: 24,
    })),
    getBook: vi.fn(async (id: string) => {
      if (id === "2") throw new Error("offline");
      return id === "3" ? comic("wrong", "3", []) : cards[0]!;
    }),
  };
  const result = await loadStoryArcPage(
    client,
    1,
    new AbortController().signal,
  );
  expect(result.books).toEqual([cards[0]]);
  expect(result.failedIds.sort()).toEqual(["2", "3"]);
});
it("does not continue indexing after account cancellation", async () => {
  const abort = new AbortController(),
    cards = Array.from({ length: 24 }, (_, i) =>
      comic(String(i + 1), String(i + 1), []),
    );
  const client = {
    listBooks: vi.fn(async () => ({
      items: cards,
      total: 100,
      page: 1,
      size: 24,
    })),
    getBook: vi.fn(async (id: string) => {
      await Promise.resolve();
      abort.abort();
      return cards.find((book) => book.id === id)!;
    }),
  };
  await expect(loadStoryArcPage(client, 1, abort.signal)).rejects.toMatchObject(
    { name: "AbortError" },
  );
  expect(client.getBook.mock.calls.length).toBeLessThanOrEqual(4);
});
it("translates story-arc and notification flows with matching placeholders in seven locales", () => {
  const params = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [key, values] of Object.entries({
    ...storyArcMessages,
    ...notificationMessages,
  })) {
    expect(values, key).toHaveLength(7);
    for (const value of values) {
      expect(value.trim(), key).not.toBe("");
      expect(params(value), key).toEqual(params(values[0]));
    }
  }
});
