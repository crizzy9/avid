import type { RecognizedWord } from "../../../../packages/playback/src/generated-alignment";
import type { SpeechWindow } from "./audioWindows";

export { SPEECH_MODEL } from "./model";
export interface SpeechChunk {
  text: string;
  timestamp: [number | null, number | null];
}
/** Only retain actual recognizer intervals; an absent boundary remains an unaligned gap. */
export function recognizedWords(
  chunks: SpeechChunk[],
  window: Omit<SpeechWindow, "pcm">,
): RecognizedWord[] {
  return chunks
    .flatMap(({ text, timestamp }) => {
      const [begin, finish] = timestamp;
      if (
        !text.trim() ||
        begin === null ||
        finish === null ||
        !Number.isFinite(begin) ||
        !Number.isFinite(finish) ||
        begin < 0 ||
        finish <= begin ||
        finish > window.end - window.start + 0.001
      )
        return [];
      const start = window.start + begin,
        end = window.start + finish,
        midpoint = (start + end) / 2;
      return midpoint >= window.acceptStart && midpoint < window.acceptEnd
        ? [{ text, start, end }]
        : [];
    })
    .sort((a, b) => a.start - b.start);
}

export class LocalTranscriber {
  private worker: Worker;
  private next = 0;
  private failure?: Error;
  private pending = new Map<
    number,
    { resolve: (chunks: SpeechChunk[]) => void; reject: (error: Error) => void }
  >();
  constructor(
    private signal: AbortSignal,
    onModel: (file?: string, progress?: number) => void,
  ) {
    signal.throwIfAborted();
    this.worker = new Worker(
      new URL("./transcription.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = ({ data }) => {
      if (signal.aborted) return;
      if (data.type === "model") {
        try {
          onModel(data.file, data.progress);
        } catch (error) {
          this.stop(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.type === "error") pending.reject(new Error(data.message));
      else pending.resolve(data.chunks ?? []);
    };
    this.worker.onerror = () =>
      this.stop(
        new Error(
          "The local speech engine could not start. Retry preparation in a current browser.",
        ),
      );
    this.worker.onmessageerror = () =>
      this.stop(
        new Error(
          "The local speech engine returned an unreadable result. Retry preparation.",
        ),
      );
    signal.addEventListener("abort", this.abort, { once: true });
  }
  private abort = () =>
    this.stop(new DOMException("Preparation cancelled.", "AbortError"));
  private stop(error: Error) {
    if (!this.failure) this.worker.terminate();
    this.failure = error;
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }
  private request(
    type: "load" | "transcribe",
    pcm?: Float32Array,
  ): Promise<SpeechChunk[]> {
    this.signal.throwIfAborted();
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, pcm }, pcm ? [pcm.buffer] : []);
    });
  }
  async load() {
    await this.request("load");
  }
  async transcribe(window: SpeechWindow) {
    return recognizedWords(
      await this.request("transcribe", window.pcm),
      window,
    );
  }
  dispose() {
    this.signal.removeEventListener("abort", this.abort);
    this.stop(new DOMException("Preparation ended.", "AbortError"));
  }
}
