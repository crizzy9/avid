import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import type { SpeechRequest } from "../../../packages/playback/src/speech";
import {
  speechChunks,
  type InstalledVoice,
  type SpeechPlayer,
  type SpeechProvider,
} from "../../../packages/playback/src/speechRuntime";

export interface NativeSpeechEvent {
  id: string;
  type: "start" | "boundary" | "end" | "error" | "cancel";
  start?: number;
  end?: number;
  elapsedTime?: number;
  message?: string;
}
export interface NativeSpeechPlugin {
  voices(): Promise<{ voices: InstalledVoice[] }>;
  speak(options: {
    id: string;
    text: string;
    voiceURI?: string;
    lang?: string;
    rate: number;
  }): Promise<void>;
  cancel(options: { id?: string }): Promise<void>;
  addListener(
    event: "speech",
    callback: (event: NativeSpeechEvent) => void,
  ): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<NativeSpeechPlugin>("AvidSpeech");
export function getNativeSpeech(): NativeSpeechPlugin | null {
  return Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable("AvidSpeech")
    ? plugin
    : null;
}
/** One serial native owner; request IDs reject late callbacks without synthetic timing. */
export class NativeSpeechPlayer implements SpeechPlayer {
  private generation = 0;
  private id: string | null = null;
  private request: SpeechRequest | null = null;
  private chunks: ReturnType<typeof speechChunks> = [];
  private index = 0;
  private base = 0;
  private started = false;
  private disposed = false;
  private commands: Promise<void> = Promise.resolve();
  private listener: Promise<PluginListenerHandle>;
  constructor(private readonly native: NativeSpeechPlugin) {
    this.listener = native.addListener("speech", (event) =>
      this.onEvent(event),
    );
    // Handled again by a speak attempt; constructing a player never leaks a rejection.
    void this.listener.catch(() => {});
  }
  speak(request: SpeechRequest) {
    if (this.disposed) return;
    this.cancel();
    this.request = request;
    this.base = Math.floor(
      Math.max(0, Math.min(request.text.length, request.start ?? 0)),
    );
    this.chunks = speechChunks(request.text.slice(this.base));
    this.index = 0;
    this.started = false;
    if (!this.chunks.some((chunk) => chunk.text.trim())) {
      this.request = null;
      request.onEnd?.();
      return;
    }
    this.playChunk(this.generation);
  }
  private playChunk(generation: number) {
    const chunk = this.chunks[this.index],
      request = this.request;
    if (!chunk || !request || this.disposed || generation !== this.generation)
      return;
    const id = crypto.randomUUID();
    this.id = id;
    this.enqueue(async () => {
      await this.listener;
      if (this.disposed || generation !== this.generation || id !== this.id)
        return;
      await this.native.speak({
        id,
        text: chunk.text,
        voiceURI: request.voiceURI,
        lang: request.lang,
        rate: Math.max(0.5, Math.min(2, request.rate ?? 1)),
      });
    }, generation);
  }
  private enqueue(action: () => Promise<void>, generation: number) {
    this.commands = this.commands.then(action).catch((error) => {
      if (!this.disposed && generation === this.generation)
        this.fail(error instanceof Error ? error.message : String(error));
    });
  }
  private onEvent(event: NativeSpeechEvent) {
    const request = this.request,
      chunk = this.chunks[this.index];
    if (this.disposed || !request || !chunk || event.id !== this.id) return;
    if (event.type === "start") {
      if (!this.started) {
        this.started = true;
        request.onStart?.();
      }
    } else if (event.type === "boundary") {
      const { start, end } = event;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start! < 0 ||
        end! <= start! ||
        end! > chunk.text.length
      )
        return;
      request.onBoundary?.({
        start: this.base + chunk.offset + start!,
        end: this.base + chunk.offset + end!,
        elapsedTime: Math.max(0, event.elapsedTime ?? 0),
        kind: "word",
      });
    } else if (event.type === "end") {
      this.id = null;
      this.index++;
      if (this.index < this.chunks.length) this.playChunk(this.generation);
      else {
        this.request = null;
        request.onEnd?.();
      }
    } else if (event.type === "error")
      this.fail(
        event.message || "The installed speech engine could not speak.",
      );
    else if (event.type === "cancel") this.fail("interrupted");
  }
  private fail(message: string) {
    const request = this.request;
    this.cancel();
    request?.onError?.(message);
  }
  cancel() {
    this.generation++;
    const id = this.id;
    this.id = null;
    this.request = null;
    if (id) this.enqueue(() => this.native.cancel({ id }), this.generation);
  }
  destroy() {
    this.cancel();
    this.disposed = true;
    void this.listener.then((handle) => handle.remove()).catch(() => {});
  }
}
export function nativeSpeechProvider(
  native: NativeSpeechPlugin,
): SpeechProvider {
  return {
    available: true,
    async voices() {
      const result = await native.voices();
      if (!Array.isArray(result.voices)) return [];
      return result.voices.filter(
        (voice) =>
          typeof voice.voiceURI === "string" &&
          typeof voice.name === "string" &&
          typeof voice.lang === "string" &&
          voice.localService === true,
      );
    },
    subscribeVoices(listener) {
      if (typeof window === "undefined") return () => {};
      window.addEventListener("focus", listener);
      return () => window.removeEventListener("focus", listener);
    },
    createPlayer: () => new NativeSpeechPlayer(native),
  };
}
