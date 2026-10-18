import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
function packageVersion(name) {
  const resolver =
    name === "@huggingface/transformers"
      ? require
      : createRequire(require.resolve("@huggingface/transformers"));
  let directory = dirname(resolver.resolve(name));
  for (let i = 0; i < 8; i++, directory = dirname(directory)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (manifest.name === name) return manifest.version;
    } catch {
      /* Walk from the resolved entry to its own package root. */
    }
  }
  throw new Error(`Could not identify installed runtime ${name}.`);
}

export function speechRuntimeIdentity(wasm = false) {
  return {
    backend: wasm ? "web-wasm" : "node-cpu",
    node: process.version,
    transformers: packageVersion("@huggingface/transformers"),
    onnx: packageVersion(wasm ? "onnxruntime-web" : "onnxruntime-node"),
    platform: process.platform,
    architecture: process.arch,
    dtype: "q8",
    ...(wasm ? { numThreads: 1 } : {}),
  };
}

/** Same web ONNX backend as Avid, hosted in Node for an opt-in command-line check. */
export async function loadSpeechSmokeRuntime(wasm = false) {
  let runtime;
  if (wasm) {
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
  if (wasm) {
    runtime.env.backends.onnx.wasm.numThreads = 1;
    runtime.env.backends.onnx.wasm.wasmBinary = readFileSync(
      require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"),
    );
    runtime.env.backends.onnx.wasm.wasmPaths = {
      mjs: pathToFileURL(
        require.resolve("onnxruntime-web/ort-wasm-simd-threaded.mjs"),
      ).href,
      wasm: pathToFileURL(
        require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"),
      ).href,
    };
  }
  runtime.env.cacheDir =
    process.env.AVID_MODEL_CACHE ?? "/tmp/avid-speech-models";
  runtime.env.allowLocalModels = false;
  return runtime;
}
