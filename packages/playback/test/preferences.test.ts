import { describe, expect, it, vi } from "vitest";
import {
  PlaybackPreferenceStore,
  defaultPlaybackPreferences,
  legacyPlaybackPreferenceClaimKey,
  legacyPlaybackPreferenceKey,
  playbackPreferenceStorageKey,
  playbackPreferencesFormat,
  projectPlaybackPreferences,
  validatePlaybackPreferencePatch,
  type PlaybackPreferenceStorage,
  type PlaybackPreferenceStoreOptions,
} from "../src/preferences";

class MemoryStorage implements PlaybackPreferenceStorage {
  readonly values = new Map<string, string>();
  getItem = vi.fn((key: string) => this.values.get(key) ?? null);
  setItem = vi.fn((key: string, value: string) => {
    this.values.set(key, value);
  });
  removeItem = vi.fn((key: string) => {
    this.values.delete(key);
  });
}

function exclusiveLock(): PlaybackPreferenceStoreOptions {
  let previous: Promise<unknown> = Promise.resolve();
  return {
    withMigrationLock: (work) => {
      const result = previous.then(work, work);
      previous = result;
      return result;
    },
  };
}

describe("account-scoped listening preferences", () => {
  it("starts at the listening defaults without writing during construction or resolution", () => {
    const storage = new MemoryStorage();
    const store = new PlaybackPreferenceStore("account-a", storage);
    expect(store.resolve().values).toEqual(defaultPlaybackPreferences);
    expect(store.resolve().sources.rate).toEqual({ kind: "default" });
    expect(store.getSnapshot().status).toBe("ready");
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("resolves each field independently through every scope and reports its source", () => {
    const store = new PlaybackPreferenceStore("a", new MemoryStorage());
    store.set(
      { kind: "account" },
      { rate: 1.1, skipBackwardSeconds: 10, remoteMode: "chapter" },
    );
    store.set(
      { kind: "library", id: "library" },
      { rate: 1.2, skipForwardSeconds: 40 },
    );
    store.set({ kind: "series", id: "series" }, { rate: 1.3 });
    store.set({ kind: "book", id: "book" }, { rate: 1.4 });
    const context = {
      libraryId: "library",
      seriesId: "series",
      bookId: "book",
    };
    const result = store.resolve(context, { rate: 1.5 });
    expect(result.values).toEqual({
      rate: 1.5,
      skipBackwardSeconds: 10,
      skipForwardSeconds: 40,
      remoteMode: "chapter",
    });
    expect(result.sources).toEqual({
      rate: { kind: "session" },
      skipBackwardSeconds: { kind: "account" },
      skipForwardSeconds: { kind: "library", id: "library" },
      remoteMode: { kind: "account" },
    });
    expect(store.resolve(context).sources.rate).toEqual({
      kind: "book",
      id: "book",
    });
    expect(
      store.resolve({ libraryId: "library", seriesId: "series" }).values.rate,
    ).toBe(1.3);
    expect(store.resolve({ libraryId: "library" }).values.rate).toBe(1.2);
    expect(store.resolve().values.rate).toBe(1.1);
  });

  it("resets only the requested override and restores inheritance through to defaults", () => {
    const store = new PlaybackPreferenceStore("a", new MemoryStorage());
    store.set({ kind: "account" }, { rate: 1.2, skipForwardSeconds: 45 });
    store.set({ kind: "series", id: "s" }, { rate: 1.4 });
    store.set(
      { kind: "book", id: "b" },
      { rate: 1.6, skipBackwardSeconds: 20 },
    );
    expect(store.reset({ kind: "book", id: "b" }, "rate")).toBe(true);
    expect(store.resolve({ seriesId: "s", bookId: "b" }).values.rate).toBe(1.4);
    expect(store.getSnapshot().document.books.b).toEqual({
      skipBackwardSeconds: 20,
    });
    expect(store.reset({ kind: "book", id: "b" })).toBe(true);
    expect(store.getSnapshot().document.books.b).toBeUndefined();
    store.reset({ kind: "series", id: "s" });
    expect(store.resolve({ seriesId: "s", bookId: "b" }).values.rate).toBe(1.2);
    store.reset({ kind: "account" }, "rate");
    expect(store.resolve().values).toEqual({
      ...defaultPlaybackPreferences,
      skipForwardSeconds: 45,
    });
    store.resetAll();
    expect(store.resolve().values).toEqual(defaultPlaybackPreferences);
  });

  it("persists only its account; identical book IDs and session overrides cannot leak", () => {
    const storage = new MemoryStorage();
    const first = new PlaybackPreferenceStore("server-a/user", storage);
    first.set({ kind: "book", id: "book" }, { rate: 1.8 });
    first.resolve({ bookId: "book" }, { rate: 2 });
    const restored = new PlaybackPreferenceStore("server-a/user", storage);
    const second = new PlaybackPreferenceStore("server-b/user", storage);
    expect(restored.resolve({ bookId: "book" }).values.rate).toBe(1.8);
    expect(second.resolve({ bookId: "book" }).values.rate).toBe(1);
    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()][0]).not.toContain('"rate":2');
  });

  it("projects an engine-limited speed without modifying the user's requested value or its provenance", () => {
    const store = new PlaybackPreferenceStore("a", new MemoryStorage());
    store.set({ kind: "book", id: "b" }, { rate: 4.25 });
    const applied = projectPlaybackPreferences(store.resolve({ bookId: "b" }), {
      minRate: 0.5,
      maxRate: 3,
    });
    expect(applied.values.rate).toBe(3);
    expect(applied.requested.rate).toBe(4.25);
    expect(applied.rateLimited).toBe(true);
    expect(applied.sources.rate).toEqual({ kind: "book", id: "b" });
    expect(store.resolve({ bookId: "b" }).values.rate).toBe(4.25);
    expect(
      projectPlaybackPreferences(store.resolve({ bookId: "b" }), {
        minRate: 0.5,
        maxRate: 5,
      }).rateLimited,
    ).toBe(false);
    expect(
      projectPlaybackPreferences(store.resolve({ bookId: "b" }), {
        minRate: NaN,
        maxRate: Infinity,
      }).values.rate,
    ).toBe(3);
  });

  it.each([
    { rate: 0.49 },
    { rate: 5.01 },
    { rate: Infinity },
    { rate: NaN },
    { rate: "1.5" },
    { skipBackwardSeconds: 0 },
    { skipForwardSeconds: 301 },
    { skipForwardSeconds: 1.5 },
    { remoteMode: "next-book" },
    { pitchPreserved: false },
    { token: "sensitive" },
  ])("rejects invalid settings atomically: %j", (invalid) => {
    const store = new PlaybackPreferenceStore("a", new MemoryStorage());
    store.set({ kind: "account" }, { rate: 1.25 });
    const previous = store.getSnapshot().document;
    expect(store.set({ kind: "account" }, invalid as never)).toBe(false);
    expect(store.getSnapshot().document).toBe(previous);
    expect(store.resolve().values.rate).toBe(1.25);
    expect(store.getSnapshot().error).not.toContain("sensitive");
  });

  it("accepts the supported boundaries and ignores an invalid temporary override", () => {
    expect(
      validatePlaybackPreferencePatch({
        rate: 0.5,
        skipBackwardSeconds: 1,
        skipForwardSeconds: 300,
        remoteMode: "chapter",
      }),
    ).not.toBeNull();
    expect(validatePlaybackPreferencePatch({ rate: 5 })).not.toBeNull();
    const store = new PlaybackPreferenceStore("a", new MemoryStorage());
    expect(store.resolve({}, { rate: NaN }).values.rate).toBe(1);
  });

  it("does not interpret prototype property names as settings or inherited scopes", () => {
    const storage = new MemoryStorage();
    const store = new PlaybackPreferenceStore("a", storage);
    expect(store.resolve({ bookId: "constructor" }).values.rate).toBe(1);
    expect(store.set({ kind: "book", id: "__proto__" }, { rate: 1.5 })).toBe(
      true,
    );
    expect(store.resolve({ bookId: "__proto__" }).values.rate).toBe(1.5);
    expect(
      new PlaybackPreferenceStore("a", storage).resolve({ bookId: "__proto__" })
        .values.rate,
    ).toBe(1.5);
    expect(
      store.set({ kind: "account" }, JSON.parse('{"__proto__":{"rate":5}}')),
    ).toBe(false);
    expect(store.resolve().values.rate).toBe(1);
  });

  it("provides stable immutable snapshots and emits changes for subscribers", () => {
    const store = new PlaybackPreferenceStore("a", new MemoryStorage());
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set({ kind: "account" }, { rate: 1.25 });
    expect(store.getSnapshot()).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(store.getSnapshot().document.account)).toBe(true);
    expect(() => {
      store.getSnapshot().document.account.rate = 4;
    }).toThrow();
    unsubscribe();
    store.resetAll();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("retains a failed save in memory, reports it honestly, and can retry later", () => {
    const storage = new MemoryStorage();
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("quota with secret details");
    });
    const store = new PlaybackPreferenceStore("a", storage);
    expect(store.set({ kind: "account" }, { rate: 1.7 })).toBe(false);
    expect(store.resolve().values.rate).toBe(1.7);
    expect(store.getSnapshot().status).toBe("memory");
    expect(store.getSnapshot().error).not.toContain("secret");
    expect(
      new PlaybackPreferenceStore("a", storage).resolve().values.rate,
    ).toBe(1);
    expect(store.set({ kind: "account" }, { rate: 1.7 })).toBe(true);
    expect(
      new PlaybackPreferenceStore("a", storage).resolve().values.rate,
    ).toBe(1.7);
    expect(store.getSnapshot().error).toBeNull();
  });

  it("can operate without storage and rejects an absent account identity without a render exception", () => {
    const temporary = new PlaybackPreferenceStore("a");
    expect(temporary.set({ kind: "account" }, { rate: 1.5 })).toBe(false);
    expect(temporary.resolve().values.rate).toBe(1.5);
    expect(temporary.getSnapshot().status).toBe("memory");
    const invalid = new PlaybackPreferenceStore("", new MemoryStorage());
    expect(invalid.set({ kind: "account" }, { rate: 1.5 })).toBe(false);
    expect(invalid.getSnapshot().error).toContain("account identity");
  });

  it("leaves corrupt or account-mismatched storage untouched until an explicit valid save", () => {
    for (const raw of [
      "{bad",
      JSON.stringify({
        ...new PlaybackPreferenceStore("b").getSnapshot().document,
        account: { rate: 2 },
      }),
    ]) {
      const storage = new MemoryStorage();
      storage.values.set(playbackPreferenceStorageKey("a"), raw);
      const store = new PlaybackPreferenceStore("a", storage);
      expect(store.getSnapshot().status).toBe("corrupt");
      expect(store.resolve().values.rate).toBe(1);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(store.set({ kind: "account" }, { rate: 1.2 })).toBe(true);
      expect(store.getSnapshot().status).toBe("ready");
      expect(
        new PlaybackPreferenceStore("a", storage).resolve().values.rate,
      ).toBe(1.2);
    }
  });

  it("never overwrites newer-version settings, including on reset/import/migration", async () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify({
      format: playbackPreferencesFormat,
      version: 2,
      accountId: "a",
      future: "preserve",
    });
    storage.values.set(playbackPreferenceStorageKey("a"), raw);
    storage.values.set(
      legacyPlaybackPreferenceKey,
      '{"mode":"chapter","seconds":60}',
    );
    const store = new PlaybackPreferenceStore("a", storage, exclusiveLock());
    expect(store.getSnapshot().status).toBe("unsupported-version");
    expect(store.set({ kind: "account" }, { rate: 2 })).toBe(false);
    expect(store.resetAll()).toBe(false);
    expect(
      store.importSettings(new PlaybackPreferenceStore("b").exportSettings()),
    ).toBe(false);
    expect((await store.migrateLegacyRemotePolicy()).migration).toBe(
      "unavailable",
    );
    expect(storage.values.get(playbackPreferenceStorageKey("a"))).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("exports only typed preferences and imports atomically into the chosen account", () => {
    const storage = new MemoryStorage();
    const source = new PlaybackPreferenceStore(
      "private-account-identity",
      storage,
    );
    source.set({ kind: "account" }, { rate: 1.35 });
    source.set({ kind: "book", id: "b" }, { skipForwardSeconds: 45 });
    const exported = source.exportSettings();
    expect(exported).not.toContain("private-account-identity");
    expect(JSON.parse(exported)).toEqual({
      format: "avid.playback-preferences-export",
      version: 1,
      preferences: {
        account: { rate: 1.35 },
        libraries: {},
        series: {},
        books: { b: { skipForwardSeconds: 45 } },
      },
    });
    const target = new PlaybackPreferenceStore("target", storage);
    expect(target.importSettings(exported)).toBe(true);
    expect(target.resolve({ bookId: "b" }).values).toEqual({
      ...defaultPlaybackPreferences,
      rate: 1.35,
      skipForwardSeconds: 45,
    });
    const previous = target.getSnapshot().document;
    const untrusted = JSON.parse(exported);
    untrusted.preferences.account.token = "credential";
    expect(target.importSettings(JSON.stringify(untrusted))).toBe(false);
    expect(target.getSnapshot().document).toBe(previous);
    expect(target.exportSettings()).not.toContain("credential");
    expect(target.importSettings("{bad")).toBe(false);
  });

  it("bounds imported data before parsing and scopes before persistence", () => {
    const store = new PlaybackPreferenceStore("a", new MemoryStorage());
    expect(store.importSettings(" ".repeat(256 * 1024 + 1))).toBe(false);
    const value = JSON.parse(store.exportSettings());
    value.preferences.books = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [`b${index}`, { rate: 1 }]),
    );
    expect(store.importSettings(JSON.stringify(value))).toBe(false);
    expect(store.set({ kind: "book", id: "" }, { rate: 1.5 })).toBe(false);
    expect(store.set({ kind: "book", id: "b\n" }, { rate: 1.5 })).toBe(false);
    expect(store.getSnapshot().document.books).toEqual({});
  });
});

describe("legacy remote-policy migration", () => {
  it("claims the unscoped value for exactly one account under concurrent migrations", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      legacyPlaybackPreferenceKey,
      '{"mode":"chapter","seconds":45}',
    );
    const lock = exclusiveLock();
    const first = new PlaybackPreferenceStore("a", storage, lock);
    const second = new PlaybackPreferenceStore("b", storage, lock);
    await Promise.all([
      first.migrateLegacyRemotePolicy(),
      second.migrateLegacyRemotePolicy(),
    ]);
    expect(first.resolve().values).toEqual({
      rate: 1,
      skipBackwardSeconds: 45,
      skipForwardSeconds: 45,
      remoteMode: "chapter",
    });
    expect(first.getSnapshot().migration).toBe("migrated");
    expect(second.resolve().values).toEqual(defaultPlaybackPreferences);
    expect(second.getSnapshot().migration).toBe("claimed-elsewhere");
    expect(storage.values.has(legacyPlaybackPreferenceKey)).toBe(false);
    expect(
      JSON.parse(storage.values.get(legacyPlaybackPreferenceClaimKey)!),
    ).toMatchObject({ accountId: "a", state: "complete" });
  });

  it("preserves current choices during migration and never reimports after reset", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      legacyPlaybackPreferenceKey,
      '{"mode":"chapter","seconds":500}',
    );
    const lock = exclusiveLock();
    const store = new PlaybackPreferenceStore("a", storage, lock);
    store.set({ kind: "account" }, { rate: 1.5, skipBackwardSeconds: 10 });
    await store.migrateLegacyRemotePolicy();
    expect(store.resolve().values).toEqual({
      rate: 1.5,
      skipBackwardSeconds: 10,
      skipForwardSeconds: 120,
      remoteMode: "chapter",
    });
    store.resetAll();
    const restored = new PlaybackPreferenceStore("a", storage, lock);
    await restored.migrateLegacyRemotePolicy();
    expect(restored.resolve().values).toEqual(defaultPlaybackPreferences);
  });

  it("recovers an interrupted migration from its durable receipt without allowing another account to claim", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      legacyPlaybackPreferenceKey,
      '{"mode":"time","seconds":20}',
    );
    const originalSet = storage.setItem.getMockImplementation()!;
    storage.setItem.mockImplementation((key, value) => {
      if (key === playbackPreferenceStorageKey("a"))
        throw new Error("disk full");
      originalSet(key, value);
    });
    const lock = exclusiveLock();
    const first = new PlaybackPreferenceStore("a", storage, lock);
    await first.migrateLegacyRemotePolicy();
    expect(first.getSnapshot().migration).toBe("unavailable");
    expect(
      JSON.parse(storage.values.get(legacyPlaybackPreferenceClaimKey)!),
    ).toMatchObject({ accountId: "a", state: "pending" });
    const second = new PlaybackPreferenceStore("b", storage, lock);
    await second.migrateLegacyRemotePolicy();
    expect(second.getSnapshot().migration).toBe("claimed-elsewhere");
    expect(second.resolve().values).toEqual(defaultPlaybackPreferences);
    storage.setItem.mockImplementation(originalSet);
    const recovered = new PlaybackPreferenceStore("a", storage, lock);
    await recovered.migrateLegacyRemotePolicy();
    expect(recovered.getSnapshot().migration).toBe("migrated");
    expect(recovered.resolve().values.skipBackwardSeconds).toBe(20);
  });

  it("does not copy anything when the durable claim cannot be written", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      legacyPlaybackPreferenceKey,
      '{"mode":"time","seconds":20}',
    );
    storage.setItem.mockImplementation(() => {
      throw new Error("blocked");
    });
    const store = new PlaybackPreferenceStore("a", storage, exclusiveLock());
    await store.migrateLegacyRemotePolicy();
    expect(store.resolve().values).toEqual(defaultPlaybackPreferences);
    expect(store.getSnapshot().migration).toBe("unavailable");
    expect(storage.values.size).toBe(1);
  });

  it("does not overwrite an invalid existing claim or corrupt account record", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      legacyPlaybackPreferenceKey,
      '{"mode":"time","seconds":20}',
    );
    storage.values.set(
      legacyPlaybackPreferenceClaimKey,
      '{"version":5,"accountId":"another"}',
    );
    const first = new PlaybackPreferenceStore("a", storage, exclusiveLock());
    expect((await first.migrateLegacyRemotePolicy()).migration).toBe("invalid");
    expect(storage.setItem).not.toHaveBeenCalled();
    storage.values.delete(legacyPlaybackPreferenceClaimKey);
    storage.values.set(playbackPreferenceStorageKey("a"), "{corrupt");
    const second = new PlaybackPreferenceStore("a", storage, exclusiveLock());
    expect((await second.migrateLegacyRemotePolicy()).migration).toBe(
      "unavailable",
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.values.get(playbackPreferenceStorageKey("a"))).toBe(
      "{corrupt",
    );
  });

  it("skips missing values quietly and never migrates without an exclusive lock", async () => {
    vi.stubGlobal("navigator", {});
    try {
      const storage = new MemoryStorage();
      const store = new PlaybackPreferenceStore("a", storage);
      expect((await store.migrateLegacyRemotePolicy()).migration).toBe(
        "absent",
      );
      expect(store.getSnapshot().error).toBeNull();
      storage.values.set(
        legacyPlaybackPreferenceKey,
        '{"mode":"time","seconds":20}',
      );
      expect((await store.migrateLegacyRemotePolicy()).migration).toBe(
        "unavailable",
      );
      expect(store.resolve().values).toEqual(defaultPlaybackPreferences);
      expect(storage.setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
