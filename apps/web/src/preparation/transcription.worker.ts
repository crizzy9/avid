import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import mjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import { SPEECH_MODEL } from "./model";

// Runtime code ships with Avid. Only public model data is downloaded; book/audio bytes stay here.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.wasmPaths = { wasm, mjs };
let transcriber: Promise<AutomaticSpeechRecognitionPipeline> | undefined;
function load() {
  return (transcriber ??= pipeline(
    "automatic-speech-recognition",
    SPEECH_MODEL.id,
    {
      revision: SPEECH_MODEL.revision,
      device: "wasm",
      dtype: "q8",
      progress_callback: (event) => {
        if (event.status === "progress")
          self.postMessage({
            type: "model",
            file: event.file,
            progress: event.progress,
          });
      },
    },
  ));
}
self.onmessage = async ({
  data,
}: MessageEvent<{
  type: "load" | "transcribe";
  id: number;
  pcm?: Float32Array;
}>) => {
  try {
    const recognize = await load();
    const result =
      data.type === "transcribe" && data.pcm
        ? await recognize(data.pcm, { return_timestamps: "word" })
        : undefined;
    self.postMessage({
      type: "result",
      id: data.id,
      chunks: result?.chunks ?? [],
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
