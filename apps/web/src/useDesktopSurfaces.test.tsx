// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDesktopAction, useDesktopSurfaces } from "./useDesktopSurfaces";
import type { PlaybackTransport } from "../../mobile/src/native-transport";
import type { DesktopAction, DesktopBridge } from "../../desktop/src/bridge";
import type { LibraryRepository } from "../../../packages/core/src/repository";
let root: Root;
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});
function fixture() {
  let action: (value: DesktopAction) => void = () => {};
  const remove = vi.fn(),
    open = vi.fn(),
    error = vi.fn();
  const bridge: DesktopBridge = {
    capabilities: vi.fn(),
    publish: vi.fn(async () => {}),
    onAction: vi.fn(async (callback) => {
      action = callback;
      return remove;
    }),
  };
  const controller = {
    getBook: () => ({
      bookId: "1",
      fileId: "2",
      title: "Private book",
      authors: ["Author"],
      tracks: [],
      chapters: [
        { id: "a", start: 0, title: "First", duration: 100 },
        { id: "b", start: 100, title: "Second", duration: 100 },
      ],
    }),
    getSnapshot: () => ({
      bookId: "1",
      fileId: "2",
      chapterIndex: 1,
      currentTime: 150,
      duration: 200,
      status: "playing",
    }),
    subscribe: () => () => {},
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    skip: vi.fn(),
    remoteSkip: vi.fn(),
    toggle: vi.fn(),
  } as unknown as PlaybackTransport;
  const repo = (scope: string) =>
    ({
      scope,
      getAnchors: async () => [],
      getBook: vi.fn(),
    }) as unknown as LibraryRepository;
  return {
    bridge,
    controller,
    repo,
    open,
    error,
    remove,
    action: (value: DesktopAction) => action(value),
  };
}
describe("desktop media and recents account binding", () => {
  it("ignores transport events for another account or another exact source", () => {
    const f = fixture();
    const event: DesktopAction = {
      accountScope: "A",
      bookId: "1",
      fileId: "2",
      action: "play",
    };
    applyDesktopAction(event, "B", f.controller, f.open);
    applyDesktopAction({ ...event, fileId: "3" }, "A", f.controller, f.open);
    expect(f.controller.play).not.toHaveBeenCalled();
    applyDesktopAction(event, "A", f.controller, f.open);
    expect(f.controller.play).toHaveBeenCalledOnce();
  });
  it("routes previous/next through the selected skip policy and rejects a malformed seek", () => {
    const f = fixture(),
      event: DesktopAction = {
        accountScope: "A",
        bookId: "1",
        fileId: "2",
        action: "previous",
      };
    applyDesktopAction(event, "A", f.controller, f.open);
    expect(f.controller.remoteSkip).toHaveBeenCalledWith(-1);
    applyDesktopAction({ ...event, action: "next" }, "A", f.controller, f.open);
    expect(f.controller.remoteSkip).toHaveBeenCalledWith(1);
    applyDesktopAction(
      { ...event, action: "seek", position: NaN },
      "A",
      f.controller,
      f.open,
    );
    expect(f.controller.seek).not.toHaveBeenCalled();
  });
  it("clears metadata on logout and never republishes the old player under a new account", async () => {
    const f = fixture();
    function Subject({
      repo,
      connected = true,
      mediaScope = "A",
    }: {
      repo: LibraryRepository;
      connected?: boolean;
      mediaScope?: string | null;
    }) {
      useDesktopSurfaces(
        {
          repo,
          connected,
          mediaScope,
          controller: f.controller,
          onOpen: f.open,
          onError: f.error,
        },
        f.bridge,
      );
      return null;
    }
    const a = f.repo("A"),
      b = f.repo("B");
    await act(async () => root.render(<Subject repo={a} />));
    expect(f.bridge.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountScope: "A",
        media: expect.objectContaining({ title: "Private book" }),
      }),
    );
    await act(async () => root.render(<Subject repo={b} mediaScope="A" />));
    expect(f.bridge.publish).toHaveBeenLastCalledWith({
      accountScope: "B",
      recents: [],
      media: null,
    });
    f.action({ accountScope: "B", bookId: "1", fileId: "2", action: "play" });
    expect(f.controller.play).not.toHaveBeenCalled();
    f.action({
      accountScope: "A",
      bookId: "1",
      fileId: "2",
      kind: "epub",
      action: "open",
    });
    expect(f.open).not.toHaveBeenCalled();
    await act(async () => root.render(<Subject repo={b} connected={false} />));
    expect(f.bridge.publish).toHaveBeenLastCalledWith({
      accountScope: null,
      recents: [],
      media: null,
    });
  });
  it("does not publish a delayed old-account recent-book lookup", async () => {
    const f = fixture();
    let resolve!: (value: unknown[]) => void;
    const old = {
      ...f.repo("A"),
      getAnchors: () =>
        new Promise<unknown[]>((r) => {
          resolve = r;
        }),
    } as LibraryRepository;
    function Subject({ repo }: { repo: LibraryRepository }) {
      useDesktopSurfaces(
        {
          repo,
          connected: true,
          mediaScope: null,
          controller: f.controller,
          onOpen: f.open,
          onError: f.error,
        },
        f.bridge,
      );
      return null;
    }
    await act(async () => root.render(<Subject repo={old} />));
    await act(async () => root.render(<Subject repo={f.repo("B")} />));
    await act(async () =>
      resolve([
        { bookId: "1", fileId: "2", kind: "epub", updatedAt: "2026-10-01" },
      ]),
    );
    expect(f.bridge.publish).toHaveBeenLastCalledWith({
      accountScope: "B",
      recents: [],
      media: null,
    });
  });
});
