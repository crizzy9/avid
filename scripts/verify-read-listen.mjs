// Opt-in network/model smoke test, not part of the offline unit suite.
// Default: human narration + balanced model; add --wasm for the web ONNX backend.
// node --experimental-strip-types scripts/verify-read-listen.mjs --wasm
// Optional: --synthetic selects the original synthesized recording + compact model.
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { generateAlignment } from "../packages/playback/src/generated-alignment.ts";
import { SPEECH_MODELS } from "../apps/web/src/preparation/model.ts";
import { createHash } from "node:crypto";

import { loadSpeechSmokeRuntime } from "./speech-smoke-runtime.mjs";
import { recognizedBenchmarkWords } from "./benchmark-evidence.mjs";
const wasm = process.argv.includes("--wasm");
const synthetic = process.argv.includes("--synthetic");
const model = synthetic ? SPEECH_MODELS.compact : SPEECH_MODELS.balanced;
const fixture = synthetic
  ? "original synthetic compact-model fixture"
  : "human LibriSpeech 174-168635-0002 balanced-model fixture";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const epubBytes = readFileSync(
  synthetic
    ? "packages/readers/fixtures/sample-aligned.epub"
    : "packages/readers/fixtures/preparation-text.epub",
);
const archive = unzipSync(epubBytes);
const manifest = synthetic
  ? undefined
  : JSON.parse(
      readFileSync(
        "packages/readers/fixtures/preparation-manifest.json",
        "utf8",
      ),
    );
if (
  manifest &&
  (manifest.schema !== "bookorbit.audiobook-manifest" ||
    manifest.schemaVersion !== 2 ||
    manifest.assets.length !== 1)
)
  throw new Error("The human fixture manifest changed unexpectedly.");
const sources = synthetic
  ? ["audio1.wav", "audio2.wav"].map((name, index) => ({
      name,
      bytes: Buffer.from(archive[name]),
      assetId: name,
      fileId: String(41 + index),
    }))
  : [
      {
        name: "preparation-speech.wav",
        bytes: readFileSync("packages/readers/fixtures/preparation-speech.wav"),
        assetId: manifest.assets[0].assetId,
        fileId: String(manifest.assets[0].fileId),
      },
    ];
if (
  manifest &&
  (sources[0].bytes.length !== manifest.assets[0].sizeBytes ||
    sha(sources[0].bytes) !== manifest.assets[0].etag)
)
  throw new Error(
    "The human fixture audio does not match its checked-in manifest.",
  );
// These controlled fixtures contain plain paragraph text. Their known structural
// CFIs are matcher inputs; the browser harness separately verifies real reader extraction.
const firstParagraphIndex = synthetic ? 1 : 0;
const paragraphPattern = synthetic
  ? /<p id="p\d+">([^<]+)<\/p>/g
  : /<p>([^<]+)<\/p>/g;
const publication = {
  version: 1,
  textSha256: sha(epubBytes),
  passages: [
    ...strFromU8(archive["chapter.xhtml"]).matchAll(paragraphPattern),
  ].map((match, i) => ({
    id: String(i),
    text: match[1],
    textLocator: `epubcfi(/6/2!/4/${2 * (firstParagraphIndex + i + 1)},/1:0,/1:${match[1].length})`,
    textHref: "chapter.xhtml",
    sectionIndex: 0,
    elementPath: [firstParagraphIndex + i],
  })),
};
if (publication.passages.length !== 2)
  throw new Error(
    "The smoke fixture must contain exactly two source paragraphs.",
  );
console.log(`Loading pinned ${model.id}; ${fixture}. Audio stays local.`);
const { pipeline } = await loadSpeechSmokeRuntime(wasm);
const recognize = await pipeline("automatic-speech-recognition", model.id, {
  revision: model.revision,
  device: wasm ? "wasm" : "cpu",
  dtype: "q8",
});

const tracks = [];
try {
  for (const { name, bytes, assetId, fileId } of sources) {
    if (
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE"
    )
      throw new Error("Expected a RIFF WAV fixture.");
    let samples, rate, channels, bits, format;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + size > bytes.length)
        throw new Error("Truncated WAV fixture.");
      const kind = bytes.toString("ascii", offset, offset + 4);
      if (kind === "fmt ") {
        if (size < 16) throw new Error("Invalid WAV fixture format.");
        format = bytes.readUInt16LE(offset + 8);
        channels = bytes.readUInt16LE(offset + 10);
        rate = bytes.readUInt32LE(offset + 12);
        bits = bytes.readUInt16LE(offset + 22);
      }
      if (kind === "data") {
        samples = bytes.subarray(offset + 8, offset + 8 + size);
      }
      offset += 8 + size + (size % 2);
    }
    if (
      !samples?.length ||
      samples.length % 2 ||
      format !== 1 ||
      channels !== 1 ||
      bits !== 16 ||
      !rate
    )
      throw new Error("Expected mono PCM 16-bit fixture audio.");
    const duration = samples.length / 2 / rate,
      pcm = new Float32Array(Math.floor(duration * 16000));
    if (
      manifest &&
      (Math.abs(duration * 1000 - manifest.assets[0].durationMs) > 0.001 ||
        manifest.totalDurationMs !== manifest.assets[0].durationMs)
    )
      throw new Error("Human fixture duration differs from its manifest.");
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
    const words = recognizedBenchmarkWords(output.chunks ?? [], duration);
    tracks.push({
      assetId,
      fileId,
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
      bookId: synthetic ? "12" : "174168635",
      textFileId: synthetic ? "31" : "31835",
      audioFileId: sources[0].fileId,
      manifestRevision: manifest?.revision ?? "original",
      textSha256: publication.textSha256,
    },
    publication,
    tracks,
    model,
    language: "en",
  });
  console.log(
    JSON.stringify(
      {
        fixture,
        model,
        backend: wasm
          ? "web ONNX WASM hosted in Node; not browser/device qualification"
          : "Node CPU",
        epubSha256: publication.textSha256,
        audio: tracks.map(({ assetId, sha256, duration }) => ({
          assetId,
          sha256,
          duration,
        })),
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
  // This tests actual inference and source matching, not human word-boundary accuracy.
  // Both human and synthetic inputs retain gaps when recognition is uncertain.
  if (!alignment.coverage.matchedPassages)
    throw new Error(
      "The real speech model did not match any source fixture passage.",
    );
} finally {
  await recognize.dispose();
}
