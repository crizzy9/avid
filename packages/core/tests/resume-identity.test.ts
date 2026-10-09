import { describe, expect, it, vi } from "vitest";
import { BookOrbitClient, ProgressConflictError } from "../src/bookorbit";
import type { Session } from "../src/types";
const session: Session = {
  profile: { id: "server", name: "Fixture", url: "https://books.example" },
  userId: "1",
  accessToken: "fixture-token",
};
describe("progress source identity", () => {
  it("rejects a server locator for a different file", async () => {
    const transport = vi.fn(async () =>
      Response.json({
        percentage: 30,
        cfi: "epubcfi(/6/4)",
        currentFileId: 99,
        updatedAt: "2026-10-09T12:00:00Z",
      }),
    );
    const client = new BookOrbitClient(session, {
      fetch: transport,
      readOnly: true,
    });
    await expect(
      client.getProgress({ bookId: "1", fileId: "2", kind: "epub" }),
    ).rejects.toBeInstanceOf(ProgressConflictError);
  });
  it("refuses to write a checkpoint made against an older audio edition", async () => {
    const manifest = {
      schema: "bookorbit.audiobook-manifest",
      schemaVersion: 2,
      revision: "new-edition",
      assets: [
        {
          assetId: "asset1",
          fileId: 2,
          sequence: 0,
          format: "mp3",
          durationMs: 100000,
          sizeBytes: 1000,
          etag: "hash",
        },
      ],
      chapters: [],
      totalDurationMs: 100000,
    };
    const transport = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(String(input).endsWith("/manifest") ? manifest : null),
    );
    const client = new BookOrbitClient(session, { fetch: transport });
    await expect(
      client.saveProgress({
        bookId: "1",
        fileId: "2",
        kind: "audio",
        locator: JSON.stringify({
          version: 1,
          trackId: "2",
          trackTime: 20,
          time: 20,
          manifestRevision: "old-edition",
        }),
        progress: 0.2,
        updatedAt: "2026-10-09T12:00:00Z",
      }),
    ).rejects.toBeInstanceOf(ProgressConflictError);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      transport.mock.calls.every(
        (call) =>
          String(call[0]).endsWith("/manifest") ||
          String(call[0]).endsWith("/playback-state"),
      ),
    ).toBe(true);
  });
});
