// Opt-in network/model smoke test, not part of the offline unit suite.
// node --experimental-strip-types scripts/verify-read-listen.mjs
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateAlignment } from "../packages/playback/src/generated-alignment.ts";
import { SPEECH_MODEL } from "../apps/web/src/preparation/model.ts";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url),
  wasm = process.argv.includes("--wasm");
let runtime;
if (wasm) {
  // Select the web backend while importing, then restore Node for the CLI harness.
  const nodeProcess = process;
  try {
    globalThis.process = undefined;
    runtime = await import(
      pathToFileURL(
        join(
          dirname(require.resolve("@huggingface/transformers")),
          "transformers.web.js",
        ),
      ).href
    );
  } finally {
    globalThis.process = nodeProcess;
  }
} else runtime = await import("@huggingface/transformers");
const { pipeline, env } = runtime;
if (wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmBinary = readFileSync(
    require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"),
  );
  env.backends.onnx.wasm.wasmPaths = {
    mjs: pathToFileURL(
      require.resolve("onnxruntime-web/ort-wasm-simd-threaded.mjs"),
    ).href,
    wasm: pathToFileURL(
      require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"),
    ).href,
  };
}

env.cacheDir = process.env.AVID_MODEL_CACHE ?? "/tmp/avid-speech-models";
env.allowLocalModels = false;
const archive = unzipSync(
  readFileSync("packages/readers/fixtures/sample-aligned.epub"),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const publication = {
  version: 1,
  textSha256: sha(
    readFileSync("packages/readers/fixtures/sample-aligned.epub"),
  ),
  passages: [
    ...strFromU8(archive["chapter.xhtml"]).matchAll(
      /<p id="p(\d+)">([^<]+)<\/p>/g,
    ),
  ].map((match, i) => ({
    id: String(i),
    text: match[2],
    textLocator: `epubcfi(/6/2!/4/${4 + i * 2},/1:0,/1:${match[2].length})`,
    textHref: "chapter.xhtml",
    sectionIndex: 0,
    elementPath: [i + 1],
  })),
};
console.log(
  "Loading pinned English speech model; original synthetic fixture stays local.",
);
const recognize = await pipeline(
  "automatic-speech-recognition",
  SPEECH_MODEL.id,
  {
    revision: SPEECH_MODEL.revision,
    device: wasm ? "wasm" : "cpu",
    dtype: "q8",
  },
);
const tracks = [];
try {
  for (const [index, name] of ["audio1.wav", "audio2.wav"].entries()) {
    const bytes = Buffer.from(archive[name]);
    const rate = bytes.readUInt32LE(24),
      channels = bytes.readUInt16LE(22),
      bits = bytes.readUInt16LE(34);
    if (channels !== 1 || bits !== 16)
      throw new Error("Expected mono 16-bit fixture.");
    let samples;
    for (let offset = 12; offset + 8 < bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4);
      if (bytes.toString("ascii", offset, offset + 4) === "data") {
        samples = bytes.subarray(offset + 8, offset + 8 + size);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!samples) throw new Error("Fixture audio data missing.");
    const duration = samples.length / 2 / rate,
      pcm = new Float32Array(Math.floor(duration * 16000));
    for (let i = 0; i < pcm.length; i++) {
      const pos = (i * rate) / 16000,
        left = Math.floor(pos),
        right = Math.min(samples.length / 2 - 1, left + 1),
        mix = pos - left;
      pcm[i] =
        (samples.readInt16LE(left * 2) * (1 - mix) +
          samples.readInt16LE(right * 2) * mix) /
        32768;
    }
    const output = await recognize(pcm, { return_timestamps: "word" });
    const words = (output.chunks ?? [])
      .filter(
        (c) =>
          c.timestamp[0] !== null &&
          c.timestamp[1] !== null &&
          c.timestamp[1] > c.timestamp[0] &&
          c.timestamp[1] <= duration,
      )
      .map((c) => ({
        text: c.text,
        start: c.timestamp[0],
        end: c.timestamp[1],
      }));
    tracks.push({
      assetId: name,
      fileId: String(41 + index),
      sha256: sha(bytes),
      sizeBytes: bytes.length,
      duration,
      words,
    });
    console.log(
      name,
      JSON.stringify({ text: output.text, words: words.length, duration }),
    );
  }
  const alignment = generateAlignment({
    edition: {
      accountScope: '["https://fixture.invalid","test"]',
      bookId: "12",
      textFileId: "31",
      audioFileId: "41",
      manifestRevision: "original",
      textSha256: publication.textSha256,
    },
    publication,
    tracks,
    model: SPEECH_MODEL,
    language: "en",
  });
  console.log(
    JSON.stringify(
      {
        coverage: alignment.coverage,
        segments: alignment.segments.map(({ id, start, end, confidence }) => ({
          id,
          start,
          end,
          confidence,
        })),
      },
      null,
      2,
    ),
  );
  // The synthetic voice is intentionally not treated as ground-truth transcription.
  // Misheard text must remain a gap. This smoke proves at least one actual model match.
  if (!alignment.coverage.matchedPassages)
    throw new Error(
      "The real speech model did not match any original fixture passage.",
    );
} finally {
  await recognize.dispose();
}
