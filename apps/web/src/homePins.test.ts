import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AvidDatabase,
  LibraryRepository,
} from "../../../packages/core/src/repository";
import { demoBooks } from "./fixtures";
import {
  changeHomePins,
  HOME_PIN_LIMIT,
  HOME_PIN_PREFERENCE,
  homePinOptions,
  loadHomePins,
  loadPinnedBooks,
  parseHomePins,
  type HomePinClient,
  type HomePinRepository,
} from "./homePins";
import { homePinMessages } from "./homePinMessages";

const databases: AvidDatabase[] = [];
function repository(userId = "one", db?: AvidDatabase) {
  const database =
    db ?? new AvidDatabase(`home-pins-test-${crypto.randomUUID()}`);
  if (!db) databases.push(database);
  return {
    repo: new LibraryRepository(database, {
      profile: { id: "server", name: "Fixture", url: "https://books.example" },
      userId,
    }),
    database,
  };
}
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete();
});

describe("account-bound Home pins", () => {
  it("persists ordering and distinguishes equal collection/scope IDs without creating outbox writes", async () => {
    const { repo, database } = repository();
    const collection = { kind: "collection" as const, id: "3" };
    const scope = { kind: "scope" as const, id: "3" };
    await Promise.all([
      changeHomePins(repo, { type: "pin", pin: collection }),
      changeHomePins(repo, { type: "pin", pin: scope }),
    ]);
    await changeHomePins(repo, { type: "pin", pin: collection });
    expect(await loadHomePins(repo)).toEqual([collection, scope]);
    await changeHomePins(repo, { type: "move", pin: scope, direction: -1 });
    const reopened = repository("one", database).repo;
    expect(await loadHomePins(reopened)).toEqual([scope, collection]);
    expect(await loadHomePins(repository("two", database).repo)).toEqual([]);
    expect(await database.outbox.count()).toBe(0);
    await changeHomePins(repo, { type: "unpin", pin: collection });
    expect(await loadHomePins(repo)).toEqual([scope]);
  });

  it("does not replace saved order on a storage failure and allows a subsequent retry", async () => {
    let value = { pins: [{ kind: "scope", id: "1" }] };
    const repo: HomePinRepository = {
      scope: "fixture",
      getPreferences: vi.fn(async () => structuredClone(value)),
      patchPreferences: vi.fn(async (next) => {
        value = next as typeof value;
      }),
    };
    vi.mocked(repo.patchPreferences).mockRejectedValueOnce(new Error("quota"));
    const operation = {
      type: "pin" as const,
      pin: { kind: "collection" as const, id: "2" },
    };
    await expect(changeHomePins(repo, operation)).rejects.toThrow("quota");
    expect(await loadHomePins(repo)).toEqual([{ kind: "scope", id: "1" }]);
    expect(await changeHomePins(repo, operation)).toHaveLength(2);
  });

  it("rejects corrupt preferences and a thirteenth shelf without replacing stored data", async () => {
    const { repo } = repository();
    await repo.patchPreferences(
      {
        pins: [
          { kind: "scope", id: "1" },
          { kind: "scope", id: "1" },
        ],
      },
      HOME_PIN_PREFERENCE,
    );
    await expect(
      changeHomePins(repo, { type: "pin", pin: { kind: "scope", id: "2" } }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect((await repo.getPreferences(HOME_PIN_PREFERENCE)).pins).toHaveLength(
      2,
    );
    const pins = Array.from({ length: HOME_PIN_LIMIT }, (_, index) => ({
      kind: "scope",
      id: String(index),
    }));
    await repo.patchPreferences({ pins }, HOME_PIN_PREFERENCE);
    await expect(
      changeHomePins(repo, {
        type: "pin",
        pin: { kind: "collection", id: "extra" },
      }),
    ).rejects.toMatchObject({ code: "limit" });
    expect(await loadHomePins(repo)).toEqual(pins);
    expect(() =>
      parseHomePins([{ kind: "scope", id: "bad\u0000id" }]),
    ).toThrow();
  });

  it("discards extra persisted fields and does not expose the built-in queue as a server collection", () => {
    expect(
      parseHomePins([{ kind: "scope", id: "1", url: "secret", name: "old" }]),
    ).toEqual([{ kind: "scope", id: "1" }]);
    expect(
      homePinOptions(
        [
          { id: "queue", name: "Queue", bookIds: [] },
          { id: "1", name: "Collection", bookIds: [] },
        ],
        [{ id: "1", name: "Scope" }],
      ),
    ).toEqual([
      { kind: "collection", id: "1", name: "Collection" },
      { kind: "scope", id: "1", name: "Scope" },
    ]);
  });
});

describe("bounded pinned shelves", () => {
  const client = (): HomePinClient => ({
    listSmartScopes: vi.fn(async () => []),
    getSmartScopeBooks: vi.fn(async (_id, page, size) => ({
      items: demoBooks,
      total: 10000,
      page: page!,
      size: size!,
    })),
    getCollectionBooks: vi.fn(async (_id, page, size) => ({
      items: demoBooks,
      total: 10000,
      page: page!,
      size: size!,
    })),
  });
  it("uses verified independent scope/collection pages with a strict page bound", async () => {
    const remote = client(),
      signal = new AbortController().signal;
    await loadPinnedBooks(
      { kind: "scope", id: "9" },
      remote,
      [],
      [],
      1,
      12,
      signal,
    );
    expect(remote.getSmartScopeBooks).toHaveBeenCalledWith("9", 1, 12);
    await loadPinnedBooks(
      { kind: "collection", id: "9" },
      remote,
      [],
      [],
      2,
      40,
      signal,
    );
    expect(remote.getCollectionBooks).toHaveBeenCalledWith(
      "9",
      2,
      40,
      undefined,
      signal,
    );
    await expect(
      loadPinnedBooks(
        { kind: "scope", id: "9" },
        remote,
        [],
        [],
        1,
        10000,
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("drops a late scope response after cancellation and pages local memberships", async () => {
    const remote = client(),
      abort = new AbortController();
    vi.mocked(remote.getSmartScopeBooks).mockImplementationOnce(async () => {
      abort.abort();
      return { items: demoBooks, total: 4, page: 1, size: 12 };
    });
    await expect(
      loadPinnedBooks(
        { kind: "scope", id: "9" },
        remote,
        [],
        [],
        1,
        12,
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    const collection = {
      id: "local",
      name: "Local",
      bookIds: demoBooks.slice(0, 3).map((book) => book.id),
    };
    const page = await loadPinnedBooks(
      { kind: "collection", id: "local" },
      null,
      [collection],
      demoBooks,
      2,
      2,
      new AbortController().signal,
    );
    expect(page.items).toEqual([demoBooks[2]]);
    expect(page.total).toBe(3);
  });
});

it("provides every Home pin control and placeholder in all seven languages", () => {
  const parameters = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [key, values] of Object.entries(homePinMessages)) {
    expect(values, key).toHaveLength(7);
    for (const value of values) {
      expect(value.trim().length, key).toBeGreaterThan(0);
      expect(parameters(value), key).toEqual(parameters(values[0]));
    }
  }
});
