import { describe, expect, it } from "vitest";
import { demoBooks } from "./fixtures";
import { inReadingQueue, serverShelfFilter } from "./queueFilter";
describe("reading queue filters", () => {
  it("queries reading status rather than inventing a server collection ID", () => {
    expect(serverShelfFilter("queue")).toEqual({
      readStatuses: ["want_to_read"],
    });
    expect(serverShelfFilter("17")).toEqual({ collectionId: "17" });
  });
  it("uses server status and confines the sample collection to sample mode", () => {
    const book = demoBooks[0]!;
    const collections = [{ id: "queue", name: "Queue", bookIds: [book.id] }];
    expect(
      inReadingQueue({ ...book, serverStatus: "want_to_read" }, [], true),
    ).toBe(true);
    expect(
      inReadingQueue({ ...book, serverStatus: "unread" }, collections, true),
    ).toBe(false);
    expect(
      inReadingQueue({ ...book, serverStatus: "unread" }, collections, false),
    ).toBe(true);
  });
});
