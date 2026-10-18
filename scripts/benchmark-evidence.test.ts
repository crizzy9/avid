import { expect, it } from "vitest";
import {
  cachedBenchmarkTranscript,
  recognizedBenchmarkWords,
  sha256,
} from "./benchmark-evidence.mjs";

const model = { id: "recognizer", revision: "a".repeat(40) };
const recognition = {
  runtime: { backend: "node-cpu", node: "24", transformers: "4.3.1" },
  filterVersion: 1,
};
const identity = { model, recognition };
const example = {
  id: "sample",
  sha256: "b".repeat(64),
  sizeBytes: 100,
  reference: "Current correct reference",
};
const row = {
  ...example,
  reference: "Previously cached reference",
  text: "Actual transcript",
  duration: 2,
  words: [{ text: "Actual", start: 0, end: 1 }],
  recognitionMs: 50,
};
const cache = { version: 2, ...identity, results: [row] };

it("binds cached inference to model, backend, runtime version, decoding policy, and exact audio bytes", () => {
  expect(cachedBenchmarkTranscript(cache, example, identity)?.text).toBe(
    "Actual transcript",
  );
  expect(
    cachedBenchmarkTranscript(cache, example, {
      ...identity,
      model: { ...model, revision: "c".repeat(40) },
    }),
  ).toBeNull();
  expect(
    cachedBenchmarkTranscript(cache, example, {
      ...identity,
      recognition: {
        ...recognition,
        runtime: { ...recognition.runtime, backend: "web-wasm" },
      },
    }),
  ).toBeNull();
  expect(
    cachedBenchmarkTranscript(cache, example, {
      ...identity,
      recognition: {
        ...recognition,
        runtime: { ...recognition.runtime, transformers: "new" },
      },
    }),
  ).toBeNull();
  expect(
    cachedBenchmarkTranscript(cache, example, {
      ...identity,
      recognition: { ...recognition, filterVersion: 2 },
    }),
  ).toBeNull();
  expect(
    cachedBenchmarkTranscript(
      cache,
      { ...example, sha256: "c".repeat(64) },
      identity,
    ),
  ).toBeNull();
  expect(
    cachedBenchmarkTranscript(cache, { ...example, sizeBytes: 101 }, identity),
  ).toBeNull();
});

it("always measures current reference text, even when reusing independent audio inference", () => {
  const restored = cachedBenchmarkTranscript(cache, example, identity);
  expect(restored?.reference).toBe(example.reference);
  expect(restored?.referenceSha256).toBe(sha256(example.reference));
});

it("rejects legacy caches by default and never counts their CPU transcripts as a WASM run", () => {
  const legacy = { model, results: [row] };
  expect(cachedBenchmarkTranscript(legacy, example, identity)).toBeNull();
  expect(
    cachedBenchmarkTranscript(legacy, example, identity, true)
      ?.runtimeUnrecorded,
  ).toBe(true);
  expect(
    cachedBenchmarkTranscript(
      legacy,
      example,
      {
        ...identity,
        recognition: { ...recognition, runtime: { backend: "web-wasm" } },
      },
      true,
    ),
  ).toBeNull();
  const marked = { ...cache, results: [{ ...row, runtimeUnrecorded: true }] };
  expect(cachedBenchmarkTranscript(marked, example, identity)).toBeNull();
  expect(
    cachedBenchmarkTranscript(marked, example, identity, true)
      ?.runtimeUnrecorded,
  ).toBe(true);
});

it.each([NaN, -1, 3])("rejects corrupt cached timing %s", (end) => {
  expect(
    cachedBenchmarkTranscript(
      {
        ...cache,
        results: [{ ...row, words: [{ text: "Actual", start: 0, end }] }],
      },
      example,
      identity,
    ),
  ).toBeNull();
});

it("retains only finite real timestamp intervals in opt-in benchmark recognition", () => {
  expect(
    recognizedBenchmarkWords(
      [
        { text: "valid", timestamp: [0, 1] },
        { text: "no-end", timestamp: [1, null] },
        { text: "negative", timestamp: [-1, 0] },
        { text: "long", timestamp: [0, 20] },
        { text: "NaN", timestamp: [NaN, 1] },
        { text: "missing" },
      ],
      2,
    ),
  ).toEqual([{ text: "valid", start: 0, end: 1 }]);
});
