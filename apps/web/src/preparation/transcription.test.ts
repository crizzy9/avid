import { afterEach, expect, it, vi } from "vitest";
import { LocalTranscriber } from "./transcription";
class WorkerStub {
  static latest: WorkerStub;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerStub.latest = this;
  }
}
afterEach(() => vi.unstubAllGlobals());
const fixture = (model = vi.fn()) => {
  vi.stubGlobal("Worker", WorkerStub);
  const abort = new AbortController(),
    engine = new LocalTranscriber(abort.signal, model);
  return { abort, engine, worker: WorkerStub.latest };
};
it("terminates model work on cancellation and cannot consume a late reply", async () => {
  const { abort, engine, worker } = fixture(),
    load = engine.load();
  abort.abort();
  await expect(load).rejects.toMatchObject({ name: "AbortError" });
  worker.onmessage?.({ data: { type: "result", id: 1, chunks: [] } });
  engine.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("fails subsequent requests after a worker crash instead of hanging forever", async () => {
  const { engine, worker } = fixture(),
    load = engine.load();
  worker.onmessage?.({ data: { type: "result", id: 1 } });
  await load;
  worker.onerror?.();
  await expect(engine.load()).rejects.toThrow("could not start");
  expect(worker.postMessage).toHaveBeenCalledOnce();
  engine.dispose();
});
it("rejects pending work when a source-scope guard fails during model progress", async () => {
  const { engine, worker } = fixture(
      vi.fn(() => {
        throw new Error("Source changed");
      }),
    ),
    load = engine.load();
  worker.onmessage?.({ data: { type: "model", progress: 50 } });
  await expect(load).rejects.toThrow("Source changed");
  expect(worker.terminate).toHaveBeenCalledOnce();
  engine.dispose();
});
