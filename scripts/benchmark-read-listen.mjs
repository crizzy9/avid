// Opt-in public human audiobook benchmark. Downloads/models are never part of the unit suite.
// node --experimental-strip-types scripts/benchmark-read-listen.mjs --corpus /path/LibriSpeech/dev-clean-2 --output /tmp/avid-benchmark.json
// Optional: --baseline /tmp/avid-generated-alignment-baseline.ts --model Xenova/whisper-base.en --revision <full SHA>
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { generateAlignment } from "../packages/playback/src/generated-alignment.ts";
import { SPEECH_MODEL } from "../apps/web/src/preparation/model.ts";
import {
  loadSpeechSmokeRuntime,
  speechRuntimeIdentity,
} from "./speech-smoke-runtime.mjs";
import {
  sha256 as sha,
  cachedBenchmarkTranscript,
  recognizedBenchmarkWords,
} from "./benchmark-evidence.mjs";
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const corpus = option("--corpus"),
  output = option("--output");
if (!corpus || !output)
  throw new Error(
    "Supply --corpus and --output. See docs/read-listen-benchmark.md.",
  );
const model = {
  id: option("--model") ?? SPEECH_MODEL.id,
  revision: option("--revision") ?? SPEECH_MODEL.revision,
};
if (option("--model") && !option("--revision"))
  throw new Error("Pin --revision when choosing another model.");
if (!/^[a-f0-9]{40}$/.test(model.revision))
  throw new Error("Model revision must be a full immutable commit SHA.");
const wasm = process.argv.includes("--wasm"),
  allowLegacy = process.argv.includes("--reuse-legacy-transcripts");
if (wasm && allowLegacy)
  throw new Error("Legacy CPU transcripts cannot qualify the WASM backend.");
const baselinePath = option("--baseline");
const baseline = baselinePath
  ? (await import(pathToFileURL(resolve(baselinePath)).href)).generateAlignment
  : undefined;
const matcherPath = new URL(
  "../packages/playback/src/generated-alignment.ts",
  import.meta.url,
);
const matcherSha256 = sha(readFileSync(matcherPath)),
  baselineSha256 = baselinePath ? sha(readFileSync(baselinePath)) : undefined;
const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (ffmpeg.status !== 0)
  throw new Error("ffmpeg is required to decode the public benchmark.");
const recognition = {
  runtime: speechRuntimeIdentity(wasm),
  sampleRate: 16000,
  channels: 1,
  returnTimestamps: "word",
  filterVersion: 1,
  decoder: ffmpeg.stdout.split("\n")[0],
};
const identity = { model, recognition };
const speakers = readdirSync(corpus)
  .filter((name) => /^\d+$/.test(name))
  .sort((a, b) => Number(a) - Number(b))
  .slice(0, 4);
// Fixed selection: first four numeric speaker IDs, first numeric chapter, first three utterances.
// Do not select examples based on recognizer success.
const examples = [];
for (const speaker of speakers) {
  const chapter = readdirSync(join(corpus, speaker))
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b))[0];
  const dir = join(corpus, speaker, chapter);
  const references = Object.fromEntries(
    readFileSync(join(dir, `${speaker}-${chapter}.trans.txt`), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const pos = line.indexOf(" ");
        return [line.slice(0, pos), line.slice(pos + 1)];
      }),
  );
  for (const id of Object.keys(references).sort().slice(0, 3))
    examples.push({
      id,
      path: join(dir, `${id}.flac`),
      reference: references[id],
    });
}
if (examples.length !== 12)
  throw new Error("Expected 12 fixed benchmark excerpts.");
const cacheFile = output + ".transcripts.json";
const cached = existsSync(cacheFile)
  ? JSON.parse(readFileSync(cacheFile, "utf8"))
  : null;
let recognize, pipeline;
const results = [];
try {
  for (const example of examples) {
    const audio = readFileSync(example.path),
      audioHash = sha(audio);
    let result = cachedBenchmarkTranscript(
      cached,
      { ...example, sha256: audioHash, sizeBytes: audio.length },
      identity,
      allowLegacy,
    );
    if (!result) {
      pipeline ??= (await loadSpeechSmokeRuntime(wasm)).pipeline;
      recognize ??= await pipeline("automatic-speech-recognition", model.id, {
        revision: model.revision,
        device: wasm ? "wasm" : "cpu",
        dtype: "q8",
      });
      const decoded = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          example.path,
          "-f",
          "f32le",
          "-ac",
          "1",
          "-ar",
          "16000",
          "pipe:1",
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      if (decoded.status !== 0)
        throw new Error("ffmpeg failed to decode benchmark audio.");
      const pcm = new Float32Array(
        decoded.stdout.buffer.slice(
          decoded.stdout.byteOffset,
          decoded.stdout.byteOffset + decoded.stdout.byteLength,
        ),
      );
      const duration = pcm.length / 16000,
        started = performance.now();
      const transcript = await recognize(pcm, { return_timestamps: "word" });
      const words = recognizedBenchmarkWords(transcript.chunks ?? [], duration);
      result = {
        id: example.id,
        sha256: audioHash,
        sizeBytes: audio.length,
        pcmSha256: sha(decoded.stdout),
        duration,
        reference: example.reference,
        referenceSha256: sha(example.reference),
        text: transcript.text,
        words,
        recognitionMs: Math.round(performance.now() - started),
      };
      console.log(
        example.id,
        JSON.stringify({
          duration,
          recognitionMs: result.recognitionMs,
          words: words.length,
        }),
      );
    }
    results.push(result);
    writeFileSync(
      cacheFile,
      JSON.stringify({ version: 2, ...identity, results }, null, 2) + "\n",
    );
  }
} finally {
  await recognize?.dispose();
}
const makeInput = (row, texts) => ({
  edition: {
    accountScope: "public-benchmark",
    bookId: row.id,
    textFileId: "epub",
    audioFileId: "audio",
    manifestRevision: row.sha256,
    textSha256: sha(texts.join("\n")),
  },
  publication: {
    version: 1,
    textSha256: sha(texts.join("\n")),
    passages: texts.map((text, i) => ({
      id: String(i),
      text,
      textLocator: `epubcfi(/6/2!/4/${2 * (i + 1)},/1:0,/1:${text.length})`,
      sectionIndex: 0,
      textHref: "chapter.xhtml",
      elementPath: [i],
    })),
  },
  tracks: [
    {
      assetId: row.id,
      fileId: "audio",
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      duration: row.duration,
      words: row.words,
    },
  ],
  model,
  language: "en",
});
const measure = (matcher, row, texts) => {
  try {
    const map = matcher(makeInput(row, texts));
    return {
      algorithm: map.algorithm,
      matched: map.coverage.matchedPassages,
      total: map.coverage.totalPassages,
      segments: map.segments.map(({ id, start, end, confidence }) => ({
        id,
        start,
        end,
        confidence,
      })),
    };
  } catch (error) {
    if (!String(error).includes("No sufficiently clear")) throw error;
    return { matched: 0, total: texts.length, segments: [] };
  }
};
const cases = results.map((row, i) => {
  const words = row.reference.split(" ");
  // A controlled paragraph-reflow stress test, not original EPUB paragraph boundaries.
  const reflow =
    words.length >= 24
      ? [
          words.slice(0, 10).join(" "),
          ...Array.from(
            { length: Math.ceil((words.length - 20) / 4) },
            (_, n) =>
              words
                .slice(10 + n * 4, Math.min(words.length - 10, 14 + n * 4))
                .join(" "),
          ),
          words.slice(-10).join(" "),
        ]
      : [row.reference];
  const layouts = {
    source: [row.reference],
    reflow,
    wrongBook: [results[(i + 3) % results.length].reference],
  };
  return {
    id: row.id,
    sha256: row.sha256,
    referenceSha256: row.referenceSha256,
    pcmSha256: row.pcmSha256,
    duration: row.duration,
    recognitionRuntime: row.runtimeUnrecorded
      ? "unrecorded legacy CPU transcript"
      : recognition.runtime,
    cases: Object.fromEntries(
      Object.entries(layouts).map(([name, texts]) => [
        name,
        {
          current: measure(generateAlignment, row, texts),
          ...(baseline ? { baseline: measure(baseline, row, texts) } : {}),
        },
      ]),
    ),
  };
});
if (
  sha(readFileSync(matcherPath)) !== matcherSha256 ||
  (baselinePath && sha(readFileSync(baselinePath)) !== baselineSha256)
)
  throw new Error(
    "Matcher source changed during the benchmark. Rerun using the saved transcripts.",
  );
const report = {
  version: 2,
  dataset: "OpenSLR 31 Mini LibriSpeech dev-clean-2",
  source: "https://openslr.org/31/",
  license: "CC BY 4.0",
  selection:
    "First four numeric speakers, first numeric chapter per speaker, first three sorted utterance IDs per chapter; selected before recognition.",
  model,
  matcherSha256,
  baselineSha256,
  recognition,
  legacyRuntimeUnrecorded: results.some((row) => row.runtimeUnrecorded),
  device: wasm
    ? "Web ONNX WASM q8 hosted in Node; not browser/device qualification"
    : "Node CPU q8; not iOS/browser qualification",
  limitations:
    "Twelve clean English audiobook excerpts; reference transcripts, not complete commercial EPUB editions. Reflow is a controlled layout perturbation. No human word-boundary labels; this measures passage coverage and wrong-book rejection, not timestamp accuracy.",
  cases,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
for (const name of ["source", "reflow", "wrongBook"])
  for (const variant of baseline ? ["baseline", "current"] : ["current"])
    console.log(
      name,
      variant,
      JSON.stringify(
        cases.reduce(
          (sum, row) => ({
            matched: sum.matched + row.cases[name][variant].matched,
            total: sum.total + row.cases[name][variant].total,
          }),
          { matched: 0, total: 0 },
        ),
      ),
    );
