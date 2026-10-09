// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const plugin = vi.hoisted(() => ({
  activateAccount: vi.fn(),
  clearAccount: vi.fn(),
  indexBooks: vi.fn(),
  publishRecent: vi.fn(),
  consumeNavigation: vi.fn(),
  addListener: vi.fn(),
}));
vi.mock("../../mobile/src/native-surfaces", () => ({
  getNativeSystemSurfaces: () => plugin,
}));
import { useNativeSurfaces } from "./useNativeSurfaces";
import type { Book } from "../../../packages/core/src/types";
let root: Root;
const onNavigate = vi.fn();
const onError = vi.fn();
const book: Book = {
  id: "1",
  title: "Book",
  authors: [],
  description: "",
  color: "#444444",
  format: "EPUB",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "2026-10-09",
  files: [
    { id: "11", name: "Text", format: "EPUB" },
    { id: "12", name: "Audio one", format: "AUDIO" },
    { id: "13", name: "Audio two", format: "AUDIO" },
  ],
};
function Subject({
  scope = "demo",
  connected = false,
  books = [],
}: {
  scope?: string;
  connected?: boolean;
  books?: Book[];
}) {
  useNativeSurfaces(scope, connected, books, onNavigate, onError);
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  plugin.activateAccount.mockResolvedValue(undefined);
  plugin.clearAccount.mockResolvedValue(undefined);
  plugin.indexBooks.mockResolvedValue({ ids: [] });
  plugin.consumeNavigation.mockResolvedValue({});
  plugin.addListener.mockResolvedValue({
    remove: vi.fn().mockResolvedValue(undefined),
  });
  vi.stubGlobal("crypto", webcrypto);
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
describe("native library account lifecycle", () => {
  it("preserves a cold native session at startup but clears an explicit disconnect", async () => {
    await act(async () => root.render(<Subject />));
    expect(plugin.clearAccount).not.toHaveBeenCalled();
    await act(async () => root.render(<Subject scope="account" connected />));
    expect(plugin.activateAccount).toHaveBeenCalledWith({
      accountScope: "account",
    });
    await act(async () => root.render(<Subject />));
    expect(plugin.clearAccount).toHaveBeenCalledTimes(1);
  });
  it("indexes one canonical audio source and batches to the native 500-entry limit", async () => {
    const books = Array.from({ length: 300 }, (_, index) => ({
      ...book,
      id: String(index + 1),
    }));
    await act(async () =>
      root.render(<Subject scope="account" connected books={books} />),
    );
    const batches = plugin.indexBooks.mock.calls.map((call) => call[0].books);
    expect(batches.map((batch) => batch.length)).toEqual([500, 100]);
    expect(batches.flat().filter((item) => item.kind === "audio")).toHaveLength(
      300,
    );
    expect(batches.flat().some((item) => item.fileId === "13")).toBe(false);
  });
  it("rejects a native shortcut bound to another account", async () => {
    plugin.consumeNavigation.mockResolvedValue({
      book: {
        scopeHash: "wrong-account",
        bookId: "1",
        fileId: "11",
        kind: "epub",
      },
    });
    await act(async () => root.render(<Subject scope="account" connected />));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
