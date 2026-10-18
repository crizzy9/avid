import { afterEach, describe, it, expect, vi } from "vitest";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { ServerSpeechRequest } from "../../../packages/core/src/serverSpeech";
import {
  createServerSpeechProvider,
  captionRanges,
} from "./serverSpeechProvider";
import {
  registerOnlineSpeechProvider,
  registerSpeechProvider,
  speechProvider,
  type SpeechProvider,
  type OnlineSpeechProvider,
} from "../../../packages/playback/src/speechRuntime";
const voice = {
  id: "Amy",
  name: "Amy",
  shortName: "Amy",
  language: "English",
  locale: "en-US",
  gender: "female",
  providerId: "studio",
  providerName: "Studio",
};
const sample = {
  audio: new Blob(["audio"]),
  words: [
    { word: "Hello", startTime: 0, endTime: 0.5 },
    { word: "world", startTime: 1, endTime: 1.5 },
  ],
};
class AudioFixture extends EventTarget {
  src = "";
  preload = "";
  playbackRate = 1;
  currentTime = 0;
  duration = 2;
  paused = true;
  seeking = false;
  play = vi.fn(async () => {});
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute() {
    this.src = "";
  }
  playing() {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  }
  time(seconds: number) {
    this.currentTime = seconds;
    this.dispatchEvent(new Event("timeupdate"));
  }
  end() {
    this.paused = true;
    this.dispatchEvent(new Event("ended"));
  }
}
function fixture() {
  const client = {
    baseUrl: "https://books.example",
    session: { userId: "1" },
    getServerSpeechCapabilities: vi.fn(async () => ({
      available: true,
      providers: [],
      voices: [voice],
    })),
    synthesizeServerSpeech: vi.fn(
      async (_request: ServerSpeechRequest, _signal?: AbortSignal) => sample,
    ),
  };
  const sounds: AudioFixture[] = [];
  const revoke = vi.fn();
  let url = 0;
  const provider = createServerSpeechProvider(
    client as unknown as BookOrbitClient,
    {
      audioFactory: () => {
        const audio = new AudioFixture();
        sounds.push(audio);
        return audio as unknown as HTMLAudioElement;
      },
      createObjectURL: () => `blob:${++url}`,
      revokeObjectURL: revoke,
    },
  );
  return { client, provider, sounds, revoke };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  registerOnlineSpeechProvider(null);
  registerSpeechProvider(null);
  vi.useRealTimers();
});
describe("online voice playback", () => {
  it("lists provider-named voices without synthesizing or creating an audio owner", async () => {
    const { provider, client, sounds } = fixture();
    const voices = await provider.voices();
    expect(voices).toEqual([
      expect.objectContaining({
        name: "Amy · Studio",
        localService: false,
        default: false,
      }),
    ]);
    expect(client.synthesizeServerSpeech).not.toHaveBeenCalled();
    expect(sounds).toHaveLength(0);
    provider.dispose();
  });
  it("emits start from actual playing and captions from audio time including gaps and UTF16 offsets", async () => {
    const { provider, sounds } = fixture();
    const voice = (await provider.voices())[0];
    const start = vi.fn(),
      boundary = vi.fn(),
      end = vi.fn();
    const player = provider.createPlayer();
    player.speak({
      text: "😀 Hello world",
      start: 3,
      voiceURI: voice.voiceURI,
      onStart: start,
      onBoundary: boundary,
      onEnd: end,
    });
    await settle();
    expect(start).not.toHaveBeenCalled();
    sounds[0].playing();
    expect(start).toHaveBeenCalledTimes(1);
    expect(boundary).toHaveBeenLastCalledWith({
      start: 3,
      end: 8,
      elapsedTime: 0,
      kind: "word",
    });
    sounds[0].time(0.75);
    expect(boundary).toHaveBeenCalledTimes(1);
    sounds[0].time(1.2);
    expect(boundary).toHaveBeenLastCalledWith({
      start: 9,
      end: 14,
      elapsedTime: 1.2,
      kind: "word",
    });
    sounds[0].end();
    await settle();
    expect(end).toHaveBeenCalledOnce();
    provider.dispose();
  });
  it("fetches only one lookahead chunk, uses baked synthesis speed, and revokes each URL", async () => {
    const { provider, client, sounds, revoke } = fixture();
    const uri = (await provider.voices())[0].voiceURI;
    const player = provider.createPlayer();
    player.speak({ text: "word ".repeat(2000), voiceURI: uri, rate: 1.1 });
    await settle();
    expect(client.synthesizeServerSpeech).toHaveBeenCalledTimes(2);
    expect(client.synthesizeServerSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ speed: 1.1 }),
      expect.any(AbortSignal),
    );
    expect(sounds).toHaveLength(1);
    expect(sounds[0].playbackRate).toBe(1);
    sounds[0].end();
    await settle();
    expect(client.synthesizeServerSpeech).toHaveBeenCalledTimes(3);
    expect(sounds).toHaveLength(2);
    expect(revoke).toHaveBeenCalledWith("blob:1");
    player.cancel();
    expect(revoke).toHaveBeenCalledWith("blob:2");
    expect(client.synthesizeServerSpeech.mock.calls[2][1]?.aborted).toBe(true);
    provider.dispose();
  });
  it("cancels pending generation and rejects an old account voice without a fallback", async () => {
    const { provider, client, sounds } = fixture();
    const uri = (await provider.voices())[0].voiceURI;
    let resolve!: (value: typeof sample) => void;
    client.synthesizeServerSpeech.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const player = provider.createPlayer(),
      end = vi.fn();
    player.speak({ text: "Hello world", voiceURI: uri, onEnd: end });
    await settle();
    provider.dispose();
    resolve(sample);
    await settle();
    expect(sounds).toHaveLength(0);
    expect(end).not.toHaveBeenCalled();
    expect(provider.handlesVoice(uri)).toBe(false);
  });
  it("does not fabricate boundaries for empty or altered caption text", () => {
    expect(captionRanges("Hello world", [])).toEqual([]);
    expect(
      captionRanges("Hello world", [
        { word: "Different", startTime: 0, endTime: 1 },
      ]),
    ).toEqual([]);
    expect(
      captionRanges("Hello missing world", [
        { word: "Hello", startTime: 0, endTime: 1 },
        { word: "world", startTime: 2, endTime: 3 },
      ]),
    ).toEqual([]);
  });
  it("stops and aborts lookahead if audio cannot play", async () => {
    const { provider, client, sounds, revoke } = fixture();
    const uri = (await provider.voices())[0].voiceURI,
      error = vi.fn();
    provider
      .createPlayer()
      .speak({ text: "word ".repeat(2000), voiceURI: uri, onError: error });
    await settle();
    sounds[0].dispatchEvent(new Event("error"));
    await settle();
    expect(error).toHaveBeenCalledOnce();
    expect(client.synthesizeServerSpeech.mock.calls[1][1]?.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:1");
    provider.dispose();
  });
  it("combines installed and online voices without changing the default path", async () => {
    const { provider } = fixture();
    const localPlayer = { speak: vi.fn(), cancel: vi.fn(), destroy: vi.fn() },
      base: SpeechProvider = {
        available: true,
        voices: async () => [
          {
            voiceURI: "local",
            name: "Local",
            lang: "en",
            localService: true,
            default: true,
          },
        ],
        subscribeVoices: () => () => {},
        createPlayer: () => localPlayer,
      };
    registerSpeechProvider(base);
    const listener = vi.fn(),
      unsubscribe = speechProvider().subscribeVoices(listener);
    registerOnlineSpeechProvider(provider);
    expect(listener).toHaveBeenCalled();
    expect(await speechProvider().voices()).toHaveLength(2);
    const player = speechProvider().createPlayer();
    player.speak({ text: "Hello" });
    expect(localPlayer.speak).toHaveBeenCalledWith({ text: "Hello" });
    const uri = (await provider.voices())[0].voiceURI;
    registerOnlineSpeechProvider(null);
    const error = vi.fn();
    player.speak({ text: "Hello", voiceURI: uri, onError: error });
    expect(error).toHaveBeenCalledOnce();
    expect(localPlayer.speak).toHaveBeenCalledTimes(1);
    unsubscribe();
    player.destroy();
    provider.dispose();
  });
  it("a precreated player cannot route an old account voice to its replacement, and destroy is terminal", () => {
    const owner = (name: string) => {
      const speak = vi.fn();
      const provider: OnlineSpeechProvider = {
        available: true,
        handlesVoice: (value) => value === `avid-online:${name}`,
        voices: async () => [],
        subscribeVoices: () => () => {},
        createPlayer: () => ({ speak, cancel: vi.fn(), destroy: vi.fn() }),
      };
      return { provider, speak };
    };
    const first = owner("first"),
      second = owner("second");
    registerOnlineSpeechProvider(first.provider);
    const player = speechProvider().createPlayer();
    registerOnlineSpeechProvider(second.provider);
    const error = vi.fn();
    player.speak({
      text: "Old book",
      voiceURI: "avid-online:first",
      onError: error,
    });
    expect(error).toHaveBeenCalledOnce();
    expect(first.speak).not.toHaveBeenCalled();
    expect(second.speak).not.toHaveBeenCalled();
    player.speak({ text: "New book", voiceURI: "avid-online:second" });
    expect(second.speak).toHaveBeenCalledOnce();
    player.destroy();
    player.speak({ text: "Too late", voiceURI: "avid-online:second" });
    expect(second.speak).toHaveBeenCalledOnce();
  });
  it("a delayed old catalogue resolves to the current catalogue instead of erasing it", async () => {
    let resolve!: (
      voices: Awaited<ReturnType<SpeechProvider["voices"]>>,
    ) => void;
    const base: SpeechProvider = {
      available: false,
      voices: async () => [],
      subscribeVoices: () => () => {},
      createPlayer: () => ({
        speak: vi.fn(),
        cancel: vi.fn(),
        destroy: vi.fn(),
      }),
    };
    registerSpeechProvider(base);
    registerOnlineSpeechProvider({
      ...base,
      handlesVoice: () => false,
      voices: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const older = speechProvider().voices();
    const fresh = [
      {
        voiceURI: "avid-online:new",
        name: "New",
        lang: "en",
        localService: false,
        default: false,
      },
    ];
    registerOnlineSpeechProvider({
      ...base,
      handlesVoice: () => false,
      voices: async () => fresh,
    });
    expect(await speechProvider().voices()).toEqual(fresh);
    resolve([{ ...fresh[0], voiceURI: "avid-online:old", name: "Old" }]);
    expect(await older).toEqual(fresh);
  });
  it("reports actual playing separately from loading, stalls, cancellation and stale audio events", async () => {
    const { provider, sounds } = fixture(),
      uri = (await provider.voices())[0].voiceURI,
      activity = vi.fn(),
      player = provider.createPlayer();
    player.speak({
      text: "Hello world",
      voiceURI: uri,
      onPlayingChange: activity,
    });
    expect(activity.mock.calls).toEqual([[false]]);
    await settle();
    sounds[0].playing();
    sounds[0].dispatchEvent(new Event("waiting"));
    sounds[0].playing();
    expect(activity.mock.calls).toEqual([[false], [true], [false], [true]]);
    player.cancel();
    expect(activity).toHaveBeenLastCalledWith(false);
    const next = vi.fn();
    player.speak({ text: "Hello world", voiceURI: uri, onPlayingChange: next });
    await settle();
    sounds[1].playing();
    const calls = next.mock.calls.length;
    sounds[0].dispatchEvent(new Event("playing"));
    sounds[0].end();
    await settle();
    expect(next.mock.calls).toHaveLength(calls);
    expect(next).toHaveBeenLastCalledWith(true);
    provider.dispose();
    expect(next).toHaveBeenLastCalledWith(false);
  });
});
