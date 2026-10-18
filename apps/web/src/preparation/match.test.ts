import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAlignmentInWorker, type AlignmentMatchInput } from "./match";
import { generateAlignment } from "../../../../packages/playback/src/generated-alignment";

class FakeWorker {
  static instances: FakeWorker[] = [];
  static onCreate: (() => void) | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
    FakeWorker.onCreate?.();
  }
}
function fixture(): AlignmentMatchInput {
  const text = "The original story follows a quiet river through the valley.";
  return {
    edition: {
      accountScope: "fixture",
      bookId: "1",
      textFileId: "2",
      textSha256: "a".repeat(64),
      audioFileId: "3",
      manifestRevision: "one",
    },
    publication: {
      version: 1,
      textSha256: "a".repeat(64),
      passages: [
        {
          id: "0:0",
          text,
          textLocator: "epubcfi(/6/2!/4/2,/1:0,/1:60)",
          sectionIndex: 0,
          textHref: "chapter.xhtml",
          elementPath: [0],
        },
      ],
    },
    tracks: [
      {
        assetId: "audio",
        fileId: "3",
        sha256: "b".repeat(64),
        sizeBytes: 100,
        duration: 20,
        words: text
          .split(" ")
          .map((text, i) => ({ text, start: i + 1, end: i + 1.8 })),
      },
    ],
    model: { id: "unit", revision: "one" },
  };
}
beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.onCreate = undefined;
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());
describe("cancellable comparison worker", () => {
  it("posts actual source text/timing, returns the validated worker snapshot and releases handlers", async () => {
    const input = fixture(),
      abort = new AbortController(),
      pending = generateAlignmentInWorker(input, abort.signal),
      worker = FakeWorker.instances[0]!;
    expect(worker.url.pathname).toMatch(/match\.worker\.ts$/);
    expect(worker.options.type).toBe("module");
    expect(worker.postMessage).toHaveBeenCalledWith(input);
    const snapshot = generateAlignment(input);
    worker.onmessage!({ data: { type: "result", snapshot } } as MessageEvent);
    expect(await pending).toBe(snapshot);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
    abort.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("does not create a worker for already cancelled work", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      generateAlignmentInWorker(fixture(), abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it("terminates immediately on cancellation and ignores a queued late completion", async () => {
    const abort = new AbortController(),
      pending = generateAlignmentInWorker(fixture(), abort.signal),
      worker = FakeWorker.instances[0]!,
      late = worker.onmessage!;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    late({
      data: { type: "result", snapshot: generateAlignment(fixture()) },
    } as MessageEvent);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("handles cancellation during worker construction before any data is posted", async () => {
    const abort = new AbortController();
    FakeWorker.onCreate = () => abort.abort();
    await expect(
      generateAlignmentInWorker(fixture(), abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances[0]!.postMessage).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("propagates real alignment rejection and cleans up", async () => {
    const pending = generateAlignmentInWorker(
        fixture(),
        new AbortController().signal,
      ),
      worker = FakeWorker.instances[0]!;
    worker.onmessage!({
      data: {
        type: "error",
        message: "No sufficiently clear passages matched.",
      },
    } as MessageEvent);
    await expect(pending).rejects.toThrow("No sufficiently clear");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("rejects worker runtime, message decoding and invalid result failures", async () => {
    for (const kind of ["runtime", "decode", "invalid"]) {
      const pending = generateAlignmentInWorker(
          fixture(),
          new AbortController().signal,
        ),
        worker = FakeWorker.instances.at(-1)!;
      if (kind === "runtime")
        worker.onerror!({ preventDefault: vi.fn() } as unknown as ErrorEvent);
      if (kind === "decode") worker.onmessageerror!({} as MessageEvent);
      if (kind === "invalid")
        worker.onmessage!({
          data: { type: "result", snapshot: { version: 99 } },
        } as MessageEvent);
      await expect(pending).rejects.toThrow();
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  });
  it("cleans up when the source payload cannot be cloned", async () => {
    class UncloneableWorker extends FakeWorker {
      override postMessage = vi.fn(() => {
        throw new DOMException("Cannot clone", "DataCloneError");
      });
    }
    vi.stubGlobal("Worker", UncloneableWorker);
    await expect(
      generateAlignmentInWorker(fixture(), new AbortController().signal),
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
