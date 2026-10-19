// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlaybackPreferenceStore,
  legacyPlaybackPreferenceClaimKey,
  legacyPlaybackPreferenceKey,
  playbackPreferenceStorageKey,
} from "../../../packages/playback/src/preferences";
import {
  PlaybackController,
  type AudioElement,
  type PlaybackBook,
} from "../../../packages/playback/src";
import {
  NativePlaybackTransport,
  type PlaybackTransport,
} from "../../mobile/src/native-transport";
import type {
  NativePlaybackPlugin,
  NativePlaybackSnapshot,
} from "../../mobile/src/native-playback";
import type { Book } from "../../../packages/core/src/types";
import {
  applyListeningPreferences,
  usePlaybackPreferences,
} from "./playbackPreferences";

class TestAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 900;
  playbackRate = 1;
  preservesPitch = true;
  paused = true;
  ended = false;
  error = null;
  preload = "";
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
}
const source: PlaybackBook = {
  bookId: "b",
  fileId: "audio",
  manifestRevision: "v1",
  title: "A book",
  authors: [],
  tracks: [
    { id: "track", url: "https://fixture.invalid/audio", duration: 900 },
  ],
};
const book: Book = {
  id: "b",
  title: "A book",
  authors: [],
  files: [{ id: "audio", name: "Audio", format: "AUDIO" }],
  format: "AUDIO",
  description: "",
  color: "#123456",
  genres: [],
  addedAt: "2026-10-19",
  progress: 0,
  status: "unread",
};
let currentAccount: string;
let host: HTMLDivElement;
let root: Root;
let binding: ReturnType<typeof usePlaybackPreferences>;
const owners: PlaybackTransport[] = [];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  currentAccount = "account";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const owner of owners.splice(0)) owner.destroy();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function browserOwner(rate = 1, bookId = "b") {
  const controller = new PlaybackController({
    audio: new TestAudio() as unknown as AudioElement,
    mediaSession: null,
    accountScope: () => currentAccount,
  });
  controller.load({ ...source, bookId }, 123);
  controller.setRate(rate);
  owners.push(controller);
  return controller;
}
function Harness(props: Parameters<typeof usePlaybackPreferences>[0]) {
  binding = usePlaybackPreferences(props);
  return null;
}
async function render(
  controller: PlaybackTransport,
  extra: Partial<Parameters<typeof usePlaybackPreferences>[0]> = {},
) {
  await act(async () =>
    root.render(
      createElement(Harness, {
        scope: currentAccount,
        controller,
        book,
        active: true,
        allowLegacyMigration: false,
        ...extra,
      }),
    ),
  );
}
async function settled() {
  await act(async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  });
}
async function restoredNative(rate = 2) {
  let ownerState: NativePlaybackSnapshot = {
    accountScope: currentAccount,
    bookId: "b",
    fileId: "audio",
    manifestRevision: "v1",
    position: 321,
    duration: 900,
    rate,
    playing: true,
    trackId: "track",
    trackIds: ["track"],
    updatedAt: new Date().toISOString(),
  };
  const plugin: NativePlaybackPlugin = {
    capabilities: vi.fn(async () => ({
      backgroundAudioAvailable: true,
      systemMediaControlsAvailable: true,
      carIntegrationAvailable: false,
    })),
    load: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    setRate: vi.fn(async (value) => {
      ownerState = {
        ...ownerState,
        rate: value.rate,
        updatedAt: new Date().toISOString(),
      };
    }),
    configureRemote: vi.fn(async () => {}),
    setSleepTimer: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ ...ownerState })),
    clear: vi.fn(async () => {}),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  };
  const controller = new NativePlaybackTransport(plugin, {
    accountScope: () => currentAccount,
  });
  owners.push(controller);
  expect(await controller.adoptNative(source)).toBe(true);
  return { controller, plugin };
}

describe("live listening settings application", () => {
  it("applies directional skips and exact book preferences using source-scoped rate commands without seeking", () => {
    const store = new PlaybackPreferenceStore("account");
    store.set(
      { kind: "account" },
      { rate: 1.25, skipBackwardSeconds: 7, skipForwardSeconds: 42 },
    );
    store.set({ kind: "book", id: "b" }, { rate: 1.75, remoteMode: "chapter" });
    const controller = browserOwner();
    const dispatch = vi.spyOn(controller, "dispatch");
    const load = vi.spyOn(controller, "load");
    const seek = vi.spyOn(controller, "seek");
    const play = vi.spyOn(controller, "play");
    applyListeningPreferences(controller, store, { bookId: "b" });
    expect(dispatch).toHaveBeenCalledWith({
      version: 1,
      expected: controller.getPlaybackSession(),
      action: "rate",
      reason: "rate-change",
      rate: 1.75,
    });
    expect(controller.getRemotePolicy()).toEqual({
      mode: "chapter",
      seconds: 42,
      backwardSeconds: 7,
      forwardSeconds: 42,
    });
    expect(controller.getSnapshot()).toMatchObject({
      rate: 1.75,
      currentTime: 123,
    });
    expect(load).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    const other = browserOwner(1, "other");
    applyListeningPreferences(other, store, { bookId: "other" });
    expect(other.getSnapshot().rate).toBe(1.25);
  });

  it("projects the requested rate and avoids redundant owner commands", () => {
    const store = new PlaybackPreferenceStore("account");
    store.set({ kind: "account" }, { rate: 4 });
    const controller = browserOwner(3);
    const dispatch = vi.spyOn(controller, "dispatch");
    const value = applyListeningPreferences(controller, store);
    expect(value?.rateLimited).toBe(true);
    expect(value?.requested.rate).toBe(4);
    expect(dispatch).not.toHaveBeenCalled();
    const remote = vi.spyOn(controller, "configureRemote");
    applyListeningPreferences(controller, store);
    expect(remote).not.toHaveBeenCalled();
  });

  it("rejects another account, stale book ID, and mismatched file/revision", () => {
    const controller = browserOwner();
    const store = new PlaybackPreferenceStore("account");
    store.set({ kind: "account" }, { rate: 2 });
    const dispatch = vi.spyOn(controller, "dispatch");
    const remote = vi.spyOn(controller, "configureRemote");
    expect(
      applyListeningPreferences(
        controller,
        new PlaybackPreferenceStore("other"),
        { bookId: "b" },
      ),
    ).toBeNull();
    expect(
      applyListeningPreferences(controller, store, { bookId: "other" }),
    ).toBeNull();
    const getBook = vi.spyOn(controller, "getBook");
    getBook.mockReturnValue({ ...source, fileId: "another-file" });
    expect(
      applyListeningPreferences(controller, store, { bookId: "b" }),
    ).toBeNull();
    getBook.mockReturnValue({ ...source, manifestRevision: "v2" });
    expect(
      applyListeningPreferences(controller, store, { bookId: "b" }),
    ).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("listening preferences lifecycle", () => {
  it("checks the live active guard and only applies settings to the matching UI book", async () => {
    const controller = browserOwner();
    const dispatch = vi.spyOn(controller, "dispatch");
    let valid = false;
    await render(controller, { isActive: () => valid });
    await act(async () => {
      binding.store.set({ kind: "account" }, { rate: 2 });
    });
    expect(dispatch).not.toHaveBeenCalled();
    valid = true;
    await render(controller, {
      book: { ...book, id: "different" },
      isActive: () => valid,
    });
    expect(dispatch).not.toHaveBeenCalled();
    await render(controller, { isActive: () => valid });
    expect(controller.getSnapshot().rate).toBe(2);
    valid = false;
    await act(async () => {
      binding.store.set({ kind: "account" }, { rate: 1.5 });
    });
    expect(controller.getSnapshot().rate).toBe(2);
  });

  it("cannot apply new-account or stale-store values to an old owner with the same book ID", async () => {
    const controller = browserOwner();
    await render(controller);
    const oldStore = binding.store;
    await act(async () => {
      oldStore.set({ kind: "account" }, { rate: 1.5 });
    });
    expect(controller.getSnapshot().rate).toBe(1.5);
    const dispatch = vi.spyOn(controller, "dispatch");
    currentAccount = "second";
    await render(controller);
    await act(async () => {
      oldStore.set({ kind: "account" }, { rate: 2.5 });
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(controller.getSnapshot().rate).toBe(1.5);
    await act(async () => controller.load(source, 222));
    expect(controller.getSnapshot().rate).toBe(1);
    expect(controller.getSnapshot().currentTime).toBe(222);
    expect(binding.store.accountId).toBe("second");
  });

  it("reloads only this account's local-storage events, including clear", async () => {
    const controller = browserOwner();
    await render(controller);
    const external = new PlaybackPreferenceStore("account", localStorage);
    external.set(
      { kind: "account" },
      { rate: 1.8, skipBackwardSeconds: 8, skipForwardSeconds: 41 },
    );
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: playbackPreferenceStorageKey("account"),
          storageArea: sessionStorage,
        }),
      ),
    );
    expect(controller.getSnapshot().rate).toBe(1);
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: playbackPreferenceStorageKey("another"),
          storageArea: localStorage,
        }),
      ),
    );
    expect(controller.getSnapshot().rate).toBe(1);
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: playbackPreferenceStorageKey("account"),
          storageArea: localStorage,
        }),
      ),
    );
    expect(controller.getSnapshot().rate).toBe(1.8);
    expect(controller.getRemotePolicy()).toMatchObject({
      backwardSeconds: 8,
      forwardSeconds: 41,
    });
    localStorage.removeItem(playbackPreferenceStorageKey("account"));
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      ),
    );
    expect(controller.getSnapshot().rate).toBe(1);
  });

  it("preserves an adopted native rate as a temporary session choice until explicit reset", async () => {
    const { controller, plugin } = await restoredNative(2);
    await render(controller);
    await settled();
    expect(controller.getSnapshot()).toMatchObject({
      rate: 2,
      currentTime: 321,
      status: "playing",
    });
    expect(plugin.setRate).not.toHaveBeenCalled();
    expect(binding.sessionRate).toBe(2);
    expect(binding.store.getSnapshot().document.account).toEqual({});
    await act(async () => {
      binding.store.set({ kind: "book", id: "b" }, { skipForwardSeconds: 42 });
    });
    await settled();
    expect(plugin.setRate).not.toHaveBeenCalled();
    await act(async () => binding.resetSessionRate());
    await settled();
    expect(controller.getSnapshot().rate).toBe(1);
    expect(binding.sessionRate).toBeUndefined();
    expect(binding.store.getSnapshot().document.books.b).toEqual({
      skipForwardSeconds: 42,
    });
    expect(plugin.load).not.toHaveBeenCalled();
    expect(plugin.seek).not.toHaveBeenCalled();
    expect(plugin.play).not.toHaveBeenCalled();
    await act(async () => {
      binding.store.set({ kind: "account" }, { skipBackwardSeconds: 9 });
    });
    await settled();
    expect(controller.getSnapshot().rate).toBe(1);
  });

  it("applies a saved rate on adoption and an explicit reset returns to the default", async () => {
    const { controller, plugin } = await restoredNative(2);
    const existing = new PlaybackPreferenceStore("account", localStorage);
    existing.set({ kind: "book", id: "b" }, { rate: 1.25 });
    await render(controller);
    await settled();
    expect(controller.getSnapshot().rate).toBe(1.25);
    expect(binding.sessionRate).toBeUndefined();
    expect(plugin.setRate).toHaveBeenCalledWith(
      expect.objectContaining({
        rate: 1.25,
        expected: controller.getPlaybackSession(),
      }),
    );
    await act(async () => {
      binding.store.reset({ kind: "book", id: "b" }, "rate");
    });
    await settled();
    expect(controller.getSnapshot().rate).toBe(1);
    expect(binding.sessionRate).toBeUndefined();
  });

  it("ends temporary recovery speed when the user explicitly chooses a book rate", async () => {
    const { controller } = await restoredNative(2);
    await render(controller);
    await settled();
    expect(binding.sessionRate).toBe(2);
    await act(async () => {
      binding.store.set({ kind: "book", id: "b" }, { rate: 1.75 });
    });
    await settled();
    expect(binding.sessionRate).toBeUndefined();
    expect(controller.getSnapshot().rate).toBe(1.75);
    await act(async () => {
      binding.store.reset({ kind: "book", id: "b" }, "rate");
    });
    await settled();
    expect(controller.getSnapshot().rate).toBe(1);
    expect(binding.sessionRate).toBeUndefined();
  });

  it("never claims legacy settings for a sample session and cancels a queued claim after switching accounts", async () => {
    localStorage.setItem(
      legacyPlaybackPreferenceKey,
      '{"mode":"chapter","seconds":45}',
    );
    const queued: Array<() => Promise<void>> = [];
    const request = vi.fn(
      (_name: string, _options: unknown, work: () => Promise<unknown>) =>
        new Promise((resolve) => {
          queued.push(async () => {
            resolve(await work());
          });
        }),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const controller = browserOwner();
    await render(controller, {
      scope: "sample",
      book: null,
      active: false,
      allowLegacyMigration: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(localStorage.getItem(legacyPlaybackPreferenceClaimKey)).toBeNull();
    await render(controller, {
      scope: "account",
      book: null,
      active: false,
      allowLegacyMigration: true,
    });
    await render(controller, {
      scope: "second",
      book: null,
      active: false,
      allowLegacyMigration: true,
    });
    expect(queued).toHaveLength(2);
    await act(async () => queued[0]!());
    expect(localStorage.getItem(legacyPlaybackPreferenceClaimKey)).toBeNull();
    await act(async () => queued[1]!());
    expect(
      JSON.parse(localStorage.getItem(legacyPlaybackPreferenceClaimKey)!),
    ).toMatchObject({ accountId: "second", state: "complete" });
    expect(binding.store.resolve().values).toMatchObject({
      remoteMode: "chapter",
      skipBackwardSeconds: 45,
      skipForwardSeconds: 45,
    });
    expect(
      localStorage.getItem(playbackPreferenceStorageKey("account")),
    ).toBeNull();
  });

  it("applies the migrated legacy chapter policy with the original symmetric directional skips", async () => {
    localStorage.setItem(
      legacyPlaybackPreferenceKey,
      '{"mode":"chapter","seconds":60}',
    );
    vi.stubGlobal("navigator", {
      locks: {
        request: (
          _name: string,
          _options: unknown,
          work: () => Promise<unknown>,
        ) => work(),
      },
    });
    const controller = browserOwner();
    await render(controller, { allowLegacyMigration: true });
    await settled();
    expect(controller.getRemotePolicy()).toEqual({
      mode: "chapter",
      seconds: 60,
      backwardSeconds: 60,
      forwardSeconds: 60,
    });
    await act(async () => controller.remoteSkip(-1));
    expect(controller.getSnapshot().currentTime).toBe(63);
    await act(async () => controller.remoteSkip(1));
    expect(controller.getSnapshot().currentTime).toBe(123);
  });
});
