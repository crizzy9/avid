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
export interface OnlineSpeechProvider extends SpeechProvider {
  handlesVoice(voiceURI: string): boolean;
}
let installed: SpeechProvider | null = null;
let online: OnlineSpeechProvider | null = null;
const subscriptions = new Set<{ listener: () => void; cleanup: () => void }>();
function rebindVoices() {
  for (const entry of subscriptions) {
    entry.cleanup();
    entry.cleanup = bindVoices(entry.listener);
    entry.listener();
  }
}
function bindVoices(listener: () => void) {
  const local = (installed ?? browser).subscribeVoices(listener),
    remote = online?.subscribeVoices(listener);
  return () => {
    local();
    remote?.();
  };
}
/** Host-owned bridge only. Publication documents cannot register native services. */
export function registerSpeechProvider(provider: SpeechProvider | null) {
  installed = provider;
  rebindVoices();
}
/** Account-owned, explicit-choice online voices; never replaces the default installed voice. */
export function registerOnlineSpeechProvider(
  provider: OnlineSpeechProvider | null,
) {
  online = provider;
  rebindVoices();
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
const combined: SpeechProvider = {
  get available() {
    return (installed ?? browser).available || Boolean(online?.available);
  },
  async voices() {
    const current = online;
    const base = installed ?? browser;
    const [local, remote] = await Promise.allSettled([
      base.voices(),
      current?.voices() ?? Promise.resolve([]),
    ]);
    // A slow catalogue from the old account must not erase the replacement's voices.
    if (current !== online || base !== (installed ?? browser))
      return combined.voices();
    return [
      ...(local.status === "fulfilled" ? local.value : []),
      ...(remote.status === "fulfilled" && current === online
        ? remote.value
        : []),
    ];
  },
  subscribeVoices(listener) {
    const entry = { listener, cleanup: bindVoices(listener) };
    subscriptions.add(entry);
    return () => {
      entry.cleanup();
      subscriptions.delete(entry);
    };
  },
  createPlayer() {
    let player: SpeechPlayer | undefined;
    let destroyed = false;
    return {
      speak(request) {
        if (destroyed) return;
        player?.destroy();
        player = undefined;
        if (request.voiceURI?.startsWith("avid-online:")) {
          if (!online?.handlesVoice(request.voiceURI)) {
            request.onError?.(
              "This online voice is no longer available for the current account.",
            );
            return;
          }
          player = online.createPlayer();
        } else player = (installed ?? browser).createPlayer();
        player.speak(request);
      },
      cancel() {
        player?.cancel();
      },
      destroy() {
        destroyed = true;
        player?.destroy();
        player = undefined;
      },
    };
  },
};
export function speechProvider(): SpeechProvider {
  return combined;
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
