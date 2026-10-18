import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import { generatedDurationCompatible } from "../../../../packages/playback/src/audioDuration";

export const SPEECH_SAMPLE_RATE = 16_000;
export interface SpeechWindow {
  pcm: Float32Array;
  start: number;
  end: number;
  acceptStart: number;
  acceptEnd: number;
}
export function speechWindows(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("The audiobook duration is unavailable.");
  const windows: Omit<SpeechWindow, "pcm">[] = [];
  for (let start = 0; start < duration; start += 26) {
    const end = Math.min(duration, start + 30);
    windows.push({
      start,
      end,
      acceptStart: start ? start + 2 : 0,
      acceptEnd: end === duration ? end : end - 2,
    });
    if (end === duration) break;
  }
  return windows;
}

/** Mix into a bounded 16 kHz window using source timestamps, including real silence/gaps. */
export function mixAudioBuffer(
  target: Float32Array,
  windowStart: number,
  buffer: Pick<
    AudioBuffer,
    "sampleRate" | "numberOfChannels" | "length" | "getChannelData"
  >,
  timestamp: number,
) {
  const first = Math.max(
    0,
    Math.ceil((timestamp - windowStart) * SPEECH_SAMPLE_RATE),
  );
  const last = Math.min(
    target.length,
    Math.ceil(
      (timestamp + buffer.length / buffer.sampleRate - windowStart) *
        SPEECH_SAMPLE_RATE,
    ),
  );
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  );
  for (let i = first; i < last; i++) {
    const position =
      (windowStart + i / SPEECH_SAMPLE_RATE - timestamp) * buffer.sampleRate;
    const left = Math.max(0, Math.floor(position)),
      right = Math.min(buffer.length - 1, left + 1),
      weight = position - left;
    let value = 0;
    for (const channel of channels)
      value += channel[left]! * (1 - weight) + channel[right]! * weight;
    target[i] = value / channels.length;
  }
}

/** Decode one short window at a time; never decode an entire audiobook into RAM. */
export async function* decodeSpeechWindows(
  blob: Blob,
  duration: number,
  signal: AbortSignal,
): AsyncGenerator<SpeechWindow> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob),
  });
  const cancel = () => input.dispose();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode()))
      throw new Error(
        "This device cannot decode this audiobook for preparation. Try a current browser or a supported audio format.",
      );
    const actualDuration = await track.computeDuration();
    if (!generatedDurationCompatible(duration, actualDuration))
      throw new Error(
        "The decoded recording duration does not match this edition. Refresh its audiobook metadata before preparing.",
      );
    const sink = new AudioBufferSink(track);
    // The server's whole-second rounding is not a reason to stretch source time
    // or transcribe beyond the canonical boundary into the next track's range.
    for (const window of speechWindows(Math.min(duration, actualDuration))) {
      signal.throwIfAborted();
      const pcm = new Float32Array(
        Math.ceil((window.end - window.start) * SPEECH_SAMPLE_RATE),
      );
      for await (const { buffer, timestamp } of sink.buffers(
        window.start,
        window.end,
      )) {
        signal.throwIfAborted();
        mixAudioBuffer(pcm, window.start, buffer, timestamp);
      }
      signal.throwIfAborted();
      yield { ...window, pcm };
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    input.dispose();
  }
}
