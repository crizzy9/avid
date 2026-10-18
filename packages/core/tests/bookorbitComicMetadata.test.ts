import { expect, it, vi } from "vitest";
import { BookOrbitClient, ContractError } from "../src/bookorbit";
import type { Session } from "../src/types";
const session: Session = {
  profile: { id: "server", name: "Fixture", url: "https://books.example" },
  userId: "1",
  accessToken: "test",
};
const book = {
  id: 12,
  title: "Issue",
  authors: [],
  files: [{ id: 31, format: "cbz", role: "primary" }],
  genres: [],
  addedAt: "2026-10-18T00:00:00Z",
};
it("reads the actual comicMetadata detail fields without inventing an arc endpoint", async () => {
  const transport = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ...book,
          comicMetadata: {
            storyArcs: ["Arc one", "Arc two"],
            issueNumber: "12.5",
            volumeName: "Volume",
            characters: ["not needed"],
          },
        }),
      ),
  );
  const signal = new AbortController().signal;
  const detail = await new BookOrbitClient(session, {
    readOnly: true,
    fetch: transport,
  }).getBook("12", signal);
  expect(detail.comicMetadata).toEqual({
    storyArcs: ["Arc one", "Arc two"],
    issueNumber: "12.5",
    volumeName: "Volume",
  });
  expect(transport.mock.calls[0][0]).toBe(
    "https://books.example/api/v1/books/12",
  );
  expect(transport.mock.calls[0][1]).toMatchObject({ signal });
  expect(transport.mock.calls[0][1]?.method).toBeUndefined();
});
it("accepts card omissions/null detail metadata and rejects malformed arc names", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(book)))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ...book, comicMetadata: null })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...book, comicMetadata: { storyArcs: null } }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...book, comicMetadata: { storyArcs: [7] } }),
      ),
    );
  const client = new BookOrbitClient(session, {
    readOnly: true,
    fetch: transport,
  });
  expect((await client.getBook("12")).comicMetadata).toBeUndefined();
  expect((await client.getBook("12")).comicMetadata).toBeUndefined();
  expect((await client.getBook("12")).comicMetadata?.storyArcs).toEqual([]);
  await expect(client.getBook("12")).rejects.toBeInstanceOf(ContractError);
});
