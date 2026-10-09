// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadingActivity } from "./useReadingActivity";
import type { RecordPlaybackActivity } from "./usePlaybackActivity";
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.defineProperty(document, "hidden", {
    value: false,
    configurable: true,
  });
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
});
const reader = { book: { id: "book" }, file: { id: "file" } };
function Subject({
  identity = reader,
  scope = "a",
  record,
}: {
  identity?: typeof reader | null;
  scope?: string;
  record: RecordPlaybackActivity;
}) {
  useReadingActivity(identity, record, {
    accountScope: scope,
    flushIntervalMs: 5000,
  });
  return null;
}
describe("visible reading activity", () => {
  it("flushes while open and excludes hidden time without double-counting StrictMode", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <React.StrictMode>
          <Subject record={record} />
        </React.StrictMode>,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(6000);
      Object.defineProperty(document, "hidden", {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      vi.advanceTimersByTime(10000);
      root.render(<Subject record={record} identity={null} />);
    });
    expect(
      record.mock.calls.reduce((sum, call) => sum + call[0].duration, 0),
    ).toBe(6);
    expect(record.mock.calls.every((call) => call[0].kind === "reading")).toBe(
      true,
    );
  });
  it("never attributes a surviving reader to a newly selected account", async () => {
    const recordA = vi.fn().mockResolvedValue(undefined),
      recordB = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<Subject record={recordA} />));
    await act(async () => vi.advanceTimersByTime(2000));
    await act(async () => root.render(<Subject record={recordB} scope="b" />));
    await act(async () => vi.advanceTimersByTime(6000));
    expect(recordA.mock.calls[0][0].duration).toBe(2);
    expect(recordB).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <Subject
          record={recordB}
          scope="b"
          identity={{ book: { id: "new" }, file: { id: "new-file" } }}
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTime(5000));
    expect(recordB.mock.calls[0][0]).toMatchObject({
      bookId: "new",
      duration: 5,
    });
  });
});
