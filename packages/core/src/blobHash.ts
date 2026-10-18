import { sha256 } from "@noble/hashes/sha2.js";

export interface BlobHashGuard {
  signal?: AbortSignal;
  isActive?: () => boolean;
}
function readSlice(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const read = blob.arrayBuffer();
  if (!signal) return read;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        signal.reason ??
          new DOMException("Preparation canceled.", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
/** SHA-256 with a fixed 1 MiB working slice; does not materialize the complete audiobook. */
export async function sha256Blob(
  blob: Blob,
  guard: BlobHashGuard = {},
): Promise<string> {
  const active = () => {
    guard.signal?.throwIfAborted();
    if (guard.isActive && !guard.isActive())
      throw new DOMException("The selected source changed.", "AbortError");
  };
  const digest = sha256.create();
  try {
    active();
    for (let offset = 0; offset < blob.size; offset += 1024 ** 2) {
      active();
      digest.update(
        new Uint8Array(
          await readSlice(blob.slice(offset, offset + 1024 ** 2), guard.signal),
        ),
      );
    }
    active();
    return Array.from(digest.digest(), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } finally {
    digest.destroy();
  }
}
