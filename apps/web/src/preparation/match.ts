import type {
  generateAlignment,
  GeneratedAlignmentSnapshot,
} from "../../../../packages/playback/src/generated-alignment";

export type AlignmentMatchInput = Parameters<typeof generateAlignment>[0];

/** One cancellable worker per comparison; no models, media decoding or network calls here. */
export async function generateAlignmentInWorker(
  input: AlignmentMatchInput,
  signal: AbortSignal,
): Promise<GeneratedAlignmentSnapshot> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./match.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const fail = (reason: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(reason);
    };
    const abort = () =>
      fail(
        signal.reason ??
          new DOMException("Preparation cancelled.", "AbortError"),
      );
    worker.onmessage = ({ data }) => {
      if (finished) return;
      if (signal.aborted) {
        abort();
        return;
      }
      if (data?.type === "error") {
        fail(
          new Error(
            typeof data.message === "string"
              ? data.message
              : "Text comparison failed.",
          ),
        );
        return;
      }
      // The bundled worker validates the full map. Source-byte and exact DOM checks run
      // again during reader restoration before this snapshot can enable linked playback.
      if (
        data?.type !== "result" ||
        data.snapshot?.version !== 1 ||
        data.snapshot?.source !== "generated"
      ) {
        fail(new Error("The text comparison returned an invalid result."));
        return;
      }
      finished = true;
      cleanup();
      resolve(data.snapshot as GeneratedAlignmentSnapshot);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(
        new Error(
          "The local text comparison could not finish. Retry preparation.",
        ),
      );
    };
    worker.onmessageerror = () =>
      fail(new Error("The local text comparison result could not be read."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage(input);
    } catch (error) {
      fail(error);
    }
  });
}
