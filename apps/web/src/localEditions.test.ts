import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AvidDatabase,
  LibraryRepository,
} from "../../../packages/core/src/repository";
import { importAo3Edition, type ImportedAo3Edition } from "./localEditions";

const databases: AvidDatabase[] = [];
function fixture() {
  const db = new AvidDatabase(`editions-${crypto.randomUUID()}`);
  databases.push(db);
  const repo = new LibraryRepository(db, {
    profile: { id: "s", name: "Books", url: "https://books.test" },
    userId: "one",
  });
  return { db, repo };
}
function edition(
  revision = "a".repeat(64),
  accountId = "AO3-reader",
): ImportedAo3Edition {
  return {
    accountId,
    workId: "12345",
    title: "Original test work",
    author: "Avid fixture",
    revision,
    file: new File(["original fixture bytes"], "fixture.epub", {
      type: "application/epub+zip",
    }),
    chapterIds: ["1", "2"],
  };
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.delete()));
});
describe("followed-work library editions", () => {
  it("deduplicates one work and revision while retaining source bytes and account-scoped metadata", async () => {
    const { repo } = fixture();
    const first = await importAo3Edition(repo, edition());
    const second = await importAo3Edition(repo, edition());
    expect(second.id).toBe(first.id);
    expect(await repo.getImportedBooks()).toHaveLength(1);
    expect(second.files).toHaveLength(1);
    expect(await (await repo.getLocalFile(first.files[0].id))?.text()).toBe(
      "original fixture bytes",
    );
    expect(await repo.pendingOperations()).toEqual([]);
  });
  it("adds chapters as a new edition without erasing the current anchor or notes", async () => {
    const { repo } = fixture();
    const first = await importAo3Edition(repo, edition());
    const fileId = first.files[0].id;
    const anchor = {
      bookId: first.id,
      fileId,
      kind: "epub" as const,
      locator: "epubcfi(/6/4!/4/2:0)",
      progress: 0.4,
      updatedAt: new Date().toISOString(),
    };
    await repo.checkpoint(anchor, { readOnly: true });
    await repo.putAnnotation(
      {
        id: "note",
        bookId: first.id,
        fileId,
        kind: "note",
        locator: anchor.locator,
        text: "Keep this passage",
        quote: "",
        color: "yellow",
        createdAt: anchor.updatedAt,
        updatedAt: anchor.updatedAt,
      },
      { readOnly: true },
    );
    const next = await importAo3Edition(repo, {
      ...edition("b".repeat(64)),
      chapterIds: ["1", "2", "3"],
    });
    expect(next.id).toBe(first.id);
    expect(next.files).toHaveLength(2);
    expect(next.files[0].id).toBe(fileId);
    expect(next.progress).toBe(0.4);
    expect(await repo.getAnchor(anchor)).toEqual(anchor);
    expect(await repo.getAnnotations(first.id)).toHaveLength(1);
    expect(
      await repo.getAnchor({
        bookId: first.id,
        fileId: next.files[1].id,
        kind: "epub",
      }),
    ).toBeUndefined();
  });
  it("keeps concurrent new editions and isolates both BookOrbit and AO3 account identities", async () => {
    const { repo, db } = fixture();
    await importAo3Edition(repo, edition());
    await Promise.all([
      importAo3Edition(repo, edition("b".repeat(64))),
      importAo3Edition(repo, edition("c".repeat(64))),
    ]);
    expect((await repo.getImportedBooks())[0].files).toHaveLength(3);
    const otherAo3 = await importAo3Edition(
      repo,
      edition("a".repeat(64), "another-user"),
    );
    expect(await repo.getImportedBooks()).toHaveLength(2);
    const otherRepo = new LibraryRepository(db, {
      profile: { id: "s", name: "Books", url: "https://books.test" },
      userId: "two",
    });
    expect(await otherRepo.getImportedBooks()).toHaveLength(0);
    expect(await otherRepo.getLocalFile(otherAo3.files[0].id)).toBeUndefined();
    await repo.clearAccount();
    expect(await repo.getImportedBooks()).toHaveLength(0);
    expect(await repo.hasLocalFile(otherAo3.files[0].id)).toBe(false);
  });
});
