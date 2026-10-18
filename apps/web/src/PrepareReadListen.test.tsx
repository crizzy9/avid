// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrepareReadListen,
  type PrepareReadListenProps,
} from "./PrepareReadListen";
import type {
  PreparationInput,
  PreparationResult,
} from "./preparation/prepareReadListen";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  store: vi.fn(() => ({})),
}));
vi.mock("./preparation/prepareReadListen", () => ({
  prepareReadListen: mocks.prepare,
}));
vi.mock("../../../packages/core/src/preparedReadListen", () => ({
  preparedReadListenStore: mocks.store,
}));
const book: Book = {
  id: "12",
  title: "Original ordinary EPUB",
  authors: [],
  description: "",
  format: "EPUB",
  color: "",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "",
  files: [{ id: "31", name: "ordinary.epub", format: "EPUB" }],
};
const result = {
  map: { source: "generated", edition: { bookId: "12", textFileId: "31" } },
  descriptor: {
    alignmentSnapshot: { coverage: { matchedPassages: 8, totalPassages: 10 } },
  },
  reused: false,
} as unknown as PreparationResult;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
let root: Root | null, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
});
async function render(props: PrepareReadListenProps) {
  await act(async () => root!.render(<PrepareReadListen {...props} />));
}
const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (button) => button.textContent === name,
  );
async function click(name: string) {
  expect(button(name)).toBeDefined();
  await act(async () => button(name)!.click());
}
async function fixture() {
  const fetch = vi.fn(),
    client = new BookOrbitClient(
      {
        profile: { id: "test", name: "Fixture", url: "https://example.test" },
        userId: "reader",
        accessToken: "test-only",
      },
      { readOnly: true, fetch },
    );
  const handle = {
    pauseNarration: vi.fn(),
    currentPassage: vi.fn(),
    verifyAudiobook: vi.fn(),
    extractAlignmentText: vi.fn(),
    restorePreparedAlignment: vi.fn(),
  };
  const props: PrepareReadListenProps = {
    client,
    scopeLabel: "Fixture",
    book,
    fileId: "31",
    source: new Blob(["original source"]),
    handle,
    onPrepared: vi.fn(),
    onListen: vi.fn(),
    onOpenPrepared: vi.fn(),
  };
  await render(props);
  return { props, client, handle, fetch };
}
async function start() {
  await click("Prepare Read & Listen");
  await click("Prepare on this device");
  return mocks.prepare.mock.calls.at(-1)![0] as PreparationInput;
}
describe("explicit local preparation controls", () => {
  it("does no network/model/storage work on mount or opening the explanation", async () => {
    const f = await fixture();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await click("Prepare Read & Listen");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(host.textContent).toContain("processed locally");
    expect(host.textContent).toContain("Phase 3");
  });
  it("reports real preparation coverage and invokes handoff only after explicit completion", async () => {
    const f = await fixture();
    mocks.prepare.mockResolvedValueOnce(result);
    const input = await start();
    expect(input.client).toBe(f.client);
    expect(input.epub).toBe(f.props.source);
    expect(input.handle).toBe(f.handle);
    expect(f.props.onPrepared).toHaveBeenCalledWith(result.map);
    expect(host.textContent).toContain("8 of 10 passages matched");
    expect(f.props.onListen).not.toHaveBeenCalled();
    await click("Listen from this passage");
    expect(f.props.onListen).toHaveBeenCalledWith(result.map, f.handle);
    await click("Open prepared books");
    expect(f.props.onOpenPrepared).toHaveBeenCalledOnce();
  });
  it("cancels pending work and ignores late progress, errors and results", async () => {
    const f = await fixture(),
      pending = deferred<PreparationResult>();
    mocks.prepare.mockReturnValueOnce(pending.promise);
    const input = await start();
    await click("Cancel preparation");
    expect(input.signal.aborted).toBe(true);
    expect(input.isActive()).toBe(false);
    await act(async () =>
      input.onProgress({ stage: "comparing", fraction: 0.7 }),
    );
    expect(host.querySelector("progress")).toBeNull();
    await act(async () => pending.resolve(result));
    expect(f.props.onPrepared).not.toHaveBeenCalled();
    expect(button("Listen from this passage")).toBeUndefined();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("ignores same-client account mutation before React can run its cleanup effect", async () => {
    const f = await fixture(),
      pending = deferred<PreparationResult>();
    mocks.prepare.mockReturnValueOnce(pending.promise);
    const input = await start();
    f.client.session = { ...f.client.session, userId: "different-reader" };
    expect(input.isActive()).toBe(false);
    await act(async () => pending.resolve(result));
    expect(f.props.onPrepared).not.toHaveBeenCalled();
    await render(f.props);
    expect(input.signal.aborted).toBe(true);
    expect(button("Listen from this passage")).toBeUndefined();
  });
  it.each(["source", "handle", "file", "book"] as const)(
    "aborts on %s change and discards old source progress/results",
    async (change) => {
      const f = await fixture(),
        pending = deferred<PreparationResult>();
      mocks.prepare.mockReturnValueOnce(pending.promise);
      const input = await start();
      const next = { ...f.props };
      if (change === "source") next.source = new Blob(["new edition"]);
      if (change === "handle") next.handle = { ...f.handle };
      if (change === "file") next.fileId = "99";
      if (change === "book") next.book = { ...book, id: "other-book" };
      await render(next);
      expect(input.signal.aborted).toBe(true);
      await act(async () => {
        input.onProgress({ stage: "saving" });
        pending.resolve(result);
      });
      expect(f.props.onPrepared).not.toHaveBeenCalled();
      expect(host.querySelector("progress")).toBeNull();
      expect(button("Listen from this passage")).toBeUndefined();
    },
  );
  it("aborts on unmount and never publishes the late completion", async () => {
    const f = await fixture(),
      pending = deferred<PreparationResult>();
    mocks.prepare.mockReturnValueOnce(pending.promise);
    const input = await start();
    await act(async () => root!.unmount());
    root = null;
    expect(input.signal.aborted).toBe(true);
    await act(async () => {
      input.onProgress({ stage: "saving" });
      pending.resolve(result);
    });
    expect(f.props.onPrepared).not.toHaveBeenCalled();
  });
  it("requires a fresh check after reopening the same source with a different reader handle", async () => {
    const f = await fixture();
    mocks.prepare.mockResolvedValueOnce(result);
    await start();
    const nextHandle = { ...f.handle };
    await render({ ...f.props, handle: nextHandle });
    expect(button("Listen from this passage")).toBeUndefined();
    mocks.prepare.mockResolvedValueOnce({ ...result, reused: true });
    const input = await start();
    expect(input.handle).toBe(nextHandle);
    await click("Listen from this passage");
    expect(f.props.onListen).toHaveBeenLastCalledWith(result.map, nextHandle);
  });
  it("does not show a stale result when reader changes while onPrepared is pending", async () => {
    const f = await fixture(),
      publish = deferred<void>();
    vi.mocked(f.props.onPrepared).mockReturnValueOnce(publish.promise);
    mocks.prepare.mockResolvedValueOnce(result);
    const input = await start();
    expect(f.props.onPrepared).toHaveBeenCalledOnce();
    expect(button("Listen from this passage")).toBeUndefined();
    await render({ ...f.props, source: new Blob(["other"]) });
    await act(async () => publish.resolve());
    expect(input.signal.aborted).toBe(true);
    expect(button("Listen from this passage")).toBeUndefined();
  });
  it("suppresses a late handoff failure after the source changes", async () => {
    const f = await fixture(),
      handoff = deferred<void>();
    vi.mocked(f.props.onListen).mockReturnValueOnce(handoff.promise);
    mocks.prepare.mockResolvedValueOnce(result);
    await start();
    await click("Listen from this passage");
    expect(button("Listen from this passage")!.disabled).toBe(true);
    await render({ ...f.props, source: new Blob(["changed"]) });
    await act(async () => handoff.reject(new Error("old source failure")));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("requires both extraction and source verification capabilities before starting", async () => {
    const f = await fixture();
    await render({
      ...f.props,
      handle: { ...f.handle, restorePreparedAlignment: undefined },
    });
    await click("Prepare Read & Listen");
    expect(button("Prepare on this device")!.disabled).toBe(true);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
