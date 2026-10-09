import { describe, expect, it } from "vitest";
import { newestAnchor } from "./resume";
import type { ReadingAnchor } from "../../../packages/core/src/types";
const local: ReadingAnchor = {
  bookId: "1",
  fileId: "2",
  kind: "epub",
  locator: "local",
  progress: 0.8,
  updatedAt: "2026-10-09T10:00:00Z",
};
describe("cross-device resume ordering", () => {
  it("accepts a later intentional backwards read", () => {
    const remote = {
      ...local,
      locator: "remote",
      progress: 0.2,
      updatedAt: "2026-10-09T11:00:00Z",
    };
    expect(newestAnchor(local, remote)).toBe(remote);
  });
  it("keeps unsynced local work when server is older, tied, or undated", () => {
    for (const updatedAt of ["2026-10-09T09:00:00Z", local.updatedAt, ""])
      expect(
        newestAnchor(local, { ...local, locator: "remote", updatedAt }),
      ).toBe(local);
  });
  it("refuses different editions and uses the server on a new device", () => {
    expect(
      newestAnchor(local, {
        ...local,
        fileId: "3",
        updatedAt: "2026-10-09T12:00:00Z",
      }),
    ).toBe(local);
    expect(newestAnchor(undefined, local)).toBe(local);
  });
});
