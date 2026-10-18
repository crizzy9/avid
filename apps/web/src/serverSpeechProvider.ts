import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type {
  ServerSpeechAudio,
  ServerSpeechVoice,
} from "../../../packages/core/src/serverSpeech";
import {
  speechChunks,
  type OnlineSpeechProvider,
  type SpeechPlayer,
} from "../../../packages/playback/src/speechRuntime";

export interface ServerSpeechOptions {
  isActive?: () => boolean;
  audioFactory?: () => HTMLAudioElement;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}
/** Captions must literally align in order; never estimate ranges from audio duration. */
export function captionRanges(
  text: string,
  words: ServerSpeechAudio["words"],
): { start: number; end: number; startTime: number; endTime: number }[] {
  let cursor = 0;
  const ranges = [];
  for (const word of words) {
    const token = word.word.trim();
    if (!token) continue;
    const start = text.indexOf(token, cursor);
    if (start < 0 || /[\p{L}\p{N}]/u.test(text.slice(cursor, start))) return [];
    const end = start + token.length;
    ranges.push({
      start,
      end,
      startTime: word.startTime,
      endTime: word.endTime,
    });
    cursor = end;
  }
  return ranges;
}
/** One playing chunk + one lookahead. Audio URLs and caption data live only in this utterance. */
export function createServerSpeechProvider(
  client: BookOrbitClient,
  options: ServerSpeechOptions = {},
): OnlineSpeechProvider & { dispose(): void } {
  const scope = JSON.stringify([client.baseUrl, client.session.userId]),
    prefix = `avid-online:${encodeURIComponent(scope)}:`,
    life = new AbortController(),
    players = new Set<SpeechPlayer>();
  let catalogue: Promise<ServerSpeechVoice[]> | undefined;
  const active = () =>
    !life.signal.aborted &&
    JSON.stringify([client.baseUrl, client.session.userId]) === scope &&
    (options.isActive?.() ?? true);
  const uri = (voice: ServerSpeechVoice) =>
    prefix + encodeURIComponent(JSON.stringify([voice.providerId, voice.id]));
  const voices = () => {
    if (!active()) return Promise.resolve([]);
    return (catalogue ??= client
      .getServerSpeechCapabilities(life.signal)
      .then((result) => (active() ? result.voices : []))
      .catch((error) => {
        catalogue = undefined;
        throw error;
      }));
  };
  const createURL =
      options.createObjectURL ?? ((blob) => URL.createObjectURL(blob)),
    revokeURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
  const provider: OnlineSpeechProvider & { dispose(): void } = {
    get available() {
      return active();
    },
    handlesVoice(value) {
      return active() && value.startsWith(prefix);
    },
    async voices() {
      return (await voices()).map((voice) => ({
        voiceURI: uri(voice),
        name: `${voice.name} · ${voice.providerName}`,
        lang: voice.locale || voice.language,
        localService: false,
        default: false,
      }));
    },
    subscribeVoices() {
      return () => {};
    },
    createPlayer() {
      let generation = 0,
        abort: AbortController | undefined,
        audio: HTMLAudioElement | undefined,
        cancelActivity: (() => void) | undefined,
        urls = new Set<string>(),
        destroyed = false;
      const cancel = () => {
        cancelActivity?.();
        cancelActivity = undefined;
        generation++;
        abort?.abort();
        abort = undefined;
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
          audio = undefined;
        }
        for (const url of urls) revokeURL(url);
        urls.clear();
      };
      const player: SpeechPlayer = {
        speak(request) {
          cancel();
          if (destroyed) return;
          const run = generation;
          abort = new AbortController();
          const signal = abort.signal;
          const current = () =>
            run === generation && active() && !signal.aborted;
          let playing = false;
          const activity = (value: boolean, force = false) => {
            if (value && !current()) return;
            if (value === playing && !force) return;
            playing = value;
            request.onPlayingChange?.(value);
          };
          const endActivity = () => activity(false, true);
          cancelActivity = endActivity;
          activity(false, true);
          void (async () => {
            if (!current())
              throw new Error(
                "This online voice is no longer available for the current account.",
              );
            const selected = (await voices()).find(
              (voice) => uri(voice) === request.voiceURI,
            );
            if (!current()) return;
            if (!selected)
              throw new Error("The selected online voice is unavailable.");
            const start = Math.max(
                0,
                Math.min(
                  request.text.length,
                  Math.floor(
                    Number.isFinite(request.start) ? request.start! : 0,
                  ),
                ),
              ),
              chunks = speechChunks(request.text.slice(start), 4000).filter(
                (chunk) => chunk.text.trim(),
              );
            if (!chunks.length || !request.text.slice(start).trim()) {
              request.onEnd?.();
              return;
            }
            const pending = new Map<
              number,
              Promise<{ value: ServerSpeechAudio } | { error: unknown }>
            >();
            const fetchChunk = (index: number) => {
              if (!pending.has(index))
                pending.set(
                  index,
                  client
                    .synthesizeServerSpeech(
                      {
                        text: chunks[index].text,
                        providerId: selected.providerId,
                        voiceId: selected.id,
                        speed: Math.max(0.25, Math.min(4, request.rate ?? 1)),
                        format: "mp3",
                      },
                      signal,
                    )
                    .then(
                      (value) => ({ value }),
                      (error) => ({ error }),
                    ),
                );
              return pending.get(index)!;
            };
            let started = false,
              elapsed = 0;
            for (let index = 0; index < chunks.length; index++) {
              const result = await fetchChunk(index);
              pending.delete(index);
              if (!current()) return;
              if ("error" in result) throw result.error;
              if (index + 1 < chunks.length) void fetchChunk(index + 1);
              const chunk = chunks[index],
                ranges = captionRanges(chunk.text, result.value.words),
                element = (options.audioFactory ?? (() => new Audio()))();
              audio = element;
              const url = createURL(result.value.audio);
              urls.add(url);
              element.src = url;
              element.preload = "auto";
              element.playbackRate = 1;
              try {
                await new Promise<void>((resolve, reject) => {
                  let last = -1;
                  const onAbort = () =>
                    finish(new DOMException("Cancelled", "AbortError"));
                  const onError = () =>
                    finish(
                      new Error("The online voice audio could not be played."),
                    );
                  const onPlaying = () => {
                    if (!current()) return;
                    if (!started) {
                      started = true;
                      request.onStart?.();
                    }
                    activity(true);
                    tick();
                  };
                  const onWaiting = () => activity(false);
                  const tick = () => {
                    if (!current()) {
                      finish(new DOMException("Cancelled", "AbortError"));
                      return;
                    }
                    if (element.paused || element.seeking) {
                      activity(false);
                      return;
                    }
                    const time = element.currentTime;
                    const at = ranges.findIndex(
                      (range) =>
                        time >= range.startTime && time < range.endTime,
                    );
                    if (at < 0 || at === last) return;
                    last = at;
                    const range = ranges[at];
                    request.onBoundary?.({
                      start: start + chunk.offset + range.start,
                      end: start + chunk.offset + range.end,
                      elapsedTime: elapsed + time,
                      kind: "word",
                    });
                  };
                  const onEnded = () => finish();
                  const timer = setInterval(tick, 40);
                  let done = false;
                  function finish(error?: Error) {
                    if (done) return;
                    done = true;
                    activity(false);
                    clearInterval(timer);
                    signal.removeEventListener("abort", onAbort);
                    element.removeEventListener("playing", onPlaying);
                    element.removeEventListener("timeupdate", tick);
                    element.removeEventListener("ended", onEnded);
                    element.removeEventListener("error", onError);
                    for (const event of [
                      "waiting",
                      "stalled",
                      "pause",
                      "seeking",
                    ])
                      element.removeEventListener(event, onWaiting);
                    error ? reject(error) : resolve();
                  }
                  signal.addEventListener("abort", onAbort, { once: true });
                  element.addEventListener("playing", onPlaying);
                  element.addEventListener("timeupdate", tick);
                  element.addEventListener("ended", onEnded);
                  element.addEventListener("error", onError);
                  for (const event of [
                    "waiting",
                    "stalled",
                    "pause",
                    "seeking",
                  ])
                    element.addEventListener(event, onWaiting);
                  if (signal.aborted) onAbort();
                  else
                    void element
                      .play()
                      .catch((error) =>
                        finish(
                          error instanceof Error
                            ? error
                            : new Error(String(error)),
                        ),
                      );
                });
                elapsed += Number.isFinite(element.duration)
                  ? element.duration
                  : element.currentTime;
              } finally {
                element.pause();
                element.removeAttribute("src");
                element.load();
                if (audio === element) audio = undefined;
                if (urls.delete(url)) revokeURL(url);
              }
              if (!current()) return;
            }
            if (cancelActivity === endActivity) cancelActivity = undefined;
            request.onEnd?.();
          })().catch((error) => {
            if (current()) {
              cancel();
              request.onError?.(
                error instanceof Error ? error.message : String(error),
              );
            }
          });
        },
        cancel,
        destroy() {
          if (destroyed) return;
          destroyed = true;
          cancel();
          players.delete(player);
        },
      };
      players.add(player);
      return player;
    },
    dispose() {
      life.abort();
      for (const player of [...players]) player.destroy();
      catalogue = undefined;
    },
  };
  return provider;
}
