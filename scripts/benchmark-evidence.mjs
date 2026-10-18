import { createHash } from "node:crypto";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Legacy cache reuse is explicit and never masquerades as a measured WASM run. */
export function cachedBenchmarkTranscript(
  cache,
  example,
  identity,
  allowLegacy = false,
) {
  if (
    !cache ||
    !equal(cache.model, identity.model) ||
    !Array.isArray(cache.results)
  )
    return null;
  const exact =
    cache.version === 2 && equal(cache.recognition, identity.recognition);
  const legacy =
    allowLegacy &&
    cache.version === undefined &&
    identity.recognition.runtime.backend === "node-cpu";
  if (!exact && !legacy) return null;
  const row = cache.results.find(
    (item) =>
      item?.id === example.id &&
      item.sha256 === example.sha256 &&
      item.sizeBytes === example.sizeBytes,
  );
  if (
    !row ||
    typeof row.text !== "string" ||
    !Number.isFinite(row.duration) ||
    row.duration <= 0 ||
    !Number.isFinite(row.recognitionMs) ||
    row.recognitionMs < 0 ||
    !Array.isArray(row.words) ||
    row.words.some(
      (word) =>
        typeof word.text !== "string" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end <= word.start ||
        word.end > row.duration,
    )
  )
    return null;
  if (
    exact &&
    row.runtimeUnrecorded &&
    (!allowLegacy || identity.recognition.runtime.backend !== "node-cpu")
  )
    return null;
  return {
    ...row,
    reference: example.reference,
    referenceSha256: sha256(example.reference),
    ...(legacy || row.runtimeUnrecorded ? { runtimeUnrecorded: true } : {}),
  };
}

export function recognizedBenchmarkWords(chunks, duration) {
  return chunks
    .filter(
      (chunk) =>
        typeof chunk?.text === "string" &&
        Array.isArray(chunk.timestamp) &&
        Number.isFinite(chunk.timestamp[0]) &&
        Number.isFinite(chunk.timestamp[1]) &&
        chunk.timestamp[0] >= 0 &&
        chunk.timestamp[1] > chunk.timestamp[0] &&
        chunk.timestamp[1] <= duration,
    )
    .map((chunk) => ({
      text: chunk.text,
      start: chunk.timestamp[0],
      end: chunk.timestamp[1],
    }));
}
