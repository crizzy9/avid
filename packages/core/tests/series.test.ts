import { describe, expect, it, vi } from "vitest";
import { BookOrbitClient } from "../src/bookorbit";
import type { Session } from "../src/types";
const session: Session = {
  profile: { id: "test", name: "Fixture", url: "https://books.example" },
  userId: "1",
  accessToken: "fixture-token",
};
const card = {
  id: 20,
  title: "Second edition",
  authors: ["Author"],
  files: [{ id: 9, format: "epub", role: "primary" }],
  addedAt: "2026-10-09T00:00:00Z",
  seriesName: "Same title",
  seriesId: 7,
  seriesIndex: "2.5",
};
describe("server series identity and pagination", () => {
  it("uses numeric series identity and preserves contextual volume order", async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({
        items: [card, { ...card, id: 21, seriesIndex: "3" }],
        total: 2,
        page: 0,
        size: 24,
      }),
    );
    const client = new BookOrbitClient(session, {
      fetch: transport,
      readOnly: true,
    });
    const page = await client.getSeriesBooks("7", 1, 24);
    expect(transport.mock.calls[0][0]).toBe(
      "https://books.example/api/v1/series/7/books?page=0&size=24&sort=seriesIndex&order=asc",
    );
    expect(
      page.items.map((book) => [book.id, book.seriesId, book.seriesIndex]),
    ).toEqual([
      ["20", "7", 2.5],
      ["21", "7", 3],
    ]);
    expect(page.page).toBe(1);
  });
  it("encodes query text and translates subsequent pages without merging same-name series", async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({
        items: [
          { id: 7, name: "Same", bookCount: 4, readCount: 2, authors: [] },
          { id: 8, name: "Same", bookCount: 2, readCount: 0, authors: [] },
        ],
        total: 26,
        page: 1,
        size: 24,
      }),
    );
    const page = await new BookOrbitClient(session, {
      fetch: transport,
      readOnly: true,
    }).listSeries({ page: 2, size: 24, query: "A & B" });
    expect(String(transport.mock.calls[0][0])).toContain(
      "page=1&size=24&sort=name&order=asc&q=A+%26+B",
    );
    expect(page.items.map((item) => item.id)).toEqual(["7", "8"]);
    expect(page.page).toBe(2);
  });
  it("rejects a malformed series identity before requesting a path", async () => {
    const transport = vi.fn();
    const client = new BookOrbitClient(session, { fetch: transport });
    await expect(client.getSeriesBooks("../books")).rejects.toThrow(
      "positive numeric",
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
