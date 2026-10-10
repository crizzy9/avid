// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePlaybackActivity,
  type RecordPlaybackActivity,
} from "../../../apps/web/src/usePlaybackActivity";
import type {
  PlaybackBook,
  PlaybackController,
  PlaybackSnapshot,
} from "../src";

class Transport {
  listeners = new Set<() => void>();
  book: PlaybackBook = {
    bookId: "book",
    fileId: "file",
    title: "Book",
    authors: [],
    tracks: [{ id: "file", url: "/audio" }],
  };
  state: PlaybackSnapshot = {
    bookId: "book",
    fileId: "file",
    title: "Book",
    status: "paused",
    currentTime: 0,
    duration: 100,
    trackIndex: 0,
    chapterIndex: 0,
    rate: 1,
    sleepUntil: null,
    sleepAtChapterEnd: null,
    error: null,
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  getBook = () => this.book;
  checkpoint = vi.fn();
  destroy = vi.fn();
  pause = vi.fn(() => this.update({ status: "paused" }));
  update(patch: Partial<PlaybackSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

const roots: Root[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  vi.useRealTimers();
  document.body.innerHTML = "";
});
function mount(
  transport: Transport,
  record: RecordPlaybackActivity,
  scope = "account-a",
) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  roots.push(root);
  function Subject({
    save,
    account,
    readOnly,
  }: {
    save: RecordPlaybackActivity;
    account: string;
    readOnly: boolean;
  }) {
    usePlaybackActivity(transport as unknown as PlaybackController, save, {
      accountScope: account,
      readOnly,
    });
    return null;
  }
  const render = async (save = record, account = scope, readOnly = true) => {
    await act(async () => {
      root.render(
        <React.StrictMode>
          <Subject save={save} account={account} readOnly={readOnly} />
        </React.StrictMode>,
      );
    });
  };
  return { root, render };
}

describe("playback activity lifecycle", () => {
  it("survives StrictMode effect replay and records one active interval once", async () => {
    const transport = new Transport();
    const record = vi.fn().mockResolvedValue(undefined);
    const view = mount(transport, record);
    await view.render();
    await act(async () => {
      transport.update({ status: "playing" });
      vi.advanceTimersByTime(4_000);
      transport.update({ currentTime: 4 });
      transport.pause();
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      kind: "listening",
      duration: 4,
    });
    expect(transport.destroy).not.toHaveBeenCalled();
    expect(transport.listeners.size).toBe(1);
  });
  it("flushes the old account and blocks its surviving book until a fresh load", async () => {
    const transport = new Transport();
    const recordA = vi.fn().mockResolvedValue(undefined);
    const recordB = vi.fn().mockResolvedValue(undefined);
    const view = mount(transport, recordA);
    await view.render();
    await act(async () => {
      transport.update({ status: "playing" });
      vi.advanceTimersByTime(2_000);
      transport.update({ currentTime: 2 });
    });
    await view.render(recordB, "account-b");
    expect(recordA).toHaveBeenCalledTimes(1);
    expect(recordB).not.toHaveBeenCalled();
    expect(transport.state.status).toBe("paused");
    await act(async () => {
      transport.update({ status: "playing" });
      vi.advanceTimersByTime(3_000);
      transport.update({ currentTime: 5 });
      transport.pause();
    });
    expect(recordB).not.toHaveBeenCalled();
    await act(async () => {
      transport.book = { ...transport.book };
      transport.update({ status: "playing", currentTime: 0 });
      vi.advanceTimersByTime(2_000);
      transport.update({ currentTime: 2 });
      transport.pause();
    });
    expect(recordB).toHaveBeenCalledTimes(1);
    expect(recordB.mock.calls[0]?.[0]).toMatchObject({ duration: 2 });
  });
  it("splits activity at a permission change and retains the previous chunk permission", async () => {
    const transport = new Transport();
    const record = vi.fn().mockResolvedValue(undefined);
    const view = mount(transport, record);
    await view.render(record, "account-a", true);
    await act(async () => {
      transport.update({ status: "playing" });
      vi.advanceTimersByTime(2_000);
      transport.update({ currentTime: 2 });
    });
    await view.render(record, "account-a", false);
    const previous = record.mock.calls.filter((call) => call[2].readOnly);
    expect(previous.length).toBeGreaterThan(0);
    expect(new Set(previous.map((call) => call[0].id)).size).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      transport.update({ currentTime: 5 });
      transport.pause();
    });
    const writable = record.mock.calls.filter((call) => !call[2].readOnly);
    expect(writable).toHaveLength(1);
    expect(writable[0][0].duration).toBe(3);
    expect(previous[0][0].duration).toBe(2);
    expect(writable[0][0].id).not.toBe(previous[0][0].id);
  });
});
