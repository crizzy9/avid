import { SpeechController, type SpeechRequest } from "./speech";

export interface InstalledVoice {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}
export interface SpeechPlayer {
  speak(request: SpeechRequest): void;
  cancel(): void;
  destroy(): void;
}
export interface SpeechProvider {
  available: boolean;
  voices(): Promise<InstalledVoice[]>;
  subscribeVoices(listener: () => void): () => void;
  createPlayer(): SpeechPlayer;
}
let installed: SpeechProvider | null = null;
/** Host-owned bridge only. Publication documents cannot register native services. */
export function registerSpeechProvider(provider: SpeechProvider | null) {
  installed = provider;
}
export function installedSpeechProvider() {
  return installed;
}
const browser: SpeechProvider = {
  get available() {
    return (
      typeof speechSynthesis !== "undefined" &&
      typeof SpeechSynthesisUtterance !== "undefined"
    );
  },
  async voices() {
    return typeof speechSynthesis === "undefined"
      ? []
      : speechSynthesis.getVoices();
  },
  subscribeVoices(listener) {
    if (typeof speechSynthesis === "undefined") return () => {};
    speechSynthesis.addEventListener("voiceschanged", listener);
    return () => speechSynthesis.removeEventListener("voiceschanged", listener);
  },
  createPlayer: () => new SpeechController(),
};
export function speechProvider(): SpeechProvider {
  return installed ?? browser;
}

/** Preserve every UTF-16 unit while respecting native utterance limits. */
export function speechChunks(
  text: string,
  maximum = 4000,
): { text: string; offset: number }[] {
  if (!Number.isInteger(maximum) || maximum < 2)
    throw new Error("Invalid speech chunk limit.");
  const chunks: { text: string; offset: number }[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maximum);
    if (end < text.length) {
      const candidate = text.slice(offset, end);
      const breaks = [...candidate.matchAll(/[.!?。！？]\s+|\s+/gu)];
      const last = breaks.at(-1);
      if (last && last.index! + last[0].length >= maximum / 2)
        end = offset + last.index! + last[0].length;
      // A surrogate pair may straddle an unbroken word at the hard limit.
      if (
        /[\uD800-\uDBFF]/u.test(text[end - 1]) &&
        /[\uDC00-\uDFFF]/u.test(text[end])
      )
        end--;
    }
    chunks.push({ text: text.slice(offset, end), offset });
    offset = end;
  }
  return chunks;
}
