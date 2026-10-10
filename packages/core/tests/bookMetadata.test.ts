import { describe, expect, it, vi } from "vitest";
import { BookOrbitClient } from "../src/bookorbit";

// Shapes verified against BookOrbit e767358: packages/types/src/book.ts and metadata-fetch.ts,
// modules/book/dto/update-book-metadata.dto.ts; these are server metadata, not UI placeholders.
const session = {
  profile: { id: "server", name: "Books", url: "https://books.example" },
  userId: "7",
  accessToken: "fixture",
};
const card = {
  id: 31,
  title: "Treasure Island",
  authors: ["Robert Louis Stevenson"],
  files: [{ id: 41, role: "primary", format: "epub" }],
  genres: [],
  addedAt: "2026-10-09T00:00:00Z",
};
function client(value: unknown) {
  return new BookOrbitClient(session, {
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(value)),
  });
}
describe("verified optional book detail metadata", () => {
  it("preserves personal rating and publication fields from a catalog card", async () => {
    const source = {
      ...card,
      publisher: "  Project Gutenberg  ",
      publishedYear: 1883,
      rating: 4,
    };
    const result = await client({
      items: [source],
      total: 1,
      page: 0,
      size: 16,
    }).listBooks();
    expect(result.items[0]).toMatchObject({
      publisher: "Project Gutenberg",
      publishedYear: 1883,
      rating: 4,
    });
    expect(result.items[0].communityRatings).toBeUndefined();
  });
  it("normalizes actual provider ratings and preserves zero counts without inventing missing ones", async () => {
    const result = await client({
      ...card,
      communityRatings: [
        {
          provider: "goodreads",
          rating: 3.8,
          ratingCount: 100,
          updatedAt: "2026-10-01",
        },
        { provider: "hardcover", rating: 4, ratingCount: null },
        { provider: "openLibrary", rating: 0, ratingCount: 0 },
      ],
    }).getBook("31");
    expect(result.communityRatings).toEqual([
      { provider: "goodreads", rating: 3.8, ratingCount: 100 },
      { provider: "hardcover", rating: 4, ratingCount: undefined },
      { provider: "openLibrary", rating: 0, ratingCount: 0 },
    ]);
  });
  it.each([
    {},
    {
      publisher: null,
      publishedYear: null,
      rating: null,
      communityRatings: null,
    },
  ])("keeps unavailable metadata absent: %j", async (fields) => {
    const result = await client({ ...card, ...fields }).getBook("31");
    expect(result.publisher).toBeUndefined();
    expect(result.publishedYear).toBeUndefined();
    expect(result.rating).toBeUndefined();
    expect(result.communityRatings).toBeUndefined();
  });
  it("rejects a malformed rating instead of displaying an invented normalized score", async () => {
    await expect(
      client({
        ...card,
        communityRatings: [{ provider: "goodreads", rating: 8 }],
      }).getBook("31"),
    ).rejects.toThrow("Unexpected BookOrbit");
  });
});
