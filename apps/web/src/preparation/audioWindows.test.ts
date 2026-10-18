import { beforeEach, expect, it, vi } from "vitest";
const decoder = vi.hoisted(() => ({
  actualDuration: 15.86,
  canDecode: true,
  dispose: vi.fn(),
  calls: [] as [number, number][],
  timestamp: 0.25,
}));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    getPrimaryAudioTrack = async () => ({
      canDecode: async () => decoder.canDecode,
      computeDuration: async () => decoder.actualDuration,
    });
    dispose = decoder.dispose;
  },
  AudioBufferSink: class {
    async *buffers(start: number, end: number) {
      decoder.calls.push([start, end]);
      yield {
        timestamp: decoder.timestamp,
        buffer: {
          sampleRate: 16000,
          numberOfChannels: 1,
          length: 1,
          getChannelData: () => new Float32Array([0.75]),
        },
      };
    }
  },
}));
import { decodeSpeechWindows } from "./audioWindows";

beforeEach(() => {
  decoder.actualDuration = 15.86;
  decoder.canDecode = true;
  decoder.calls = [];
  decoder.timestamp = 0.25;
  decoder.dispose.mockClear();
});
const decode = async (duration = 16, signal = new AbortController().signal) => {
  const windows = [];
  for await (const window of decodeSpeechWindows(
    new Blob(["source bytes"]),
    duration,
    signal,
  ))
    windows.push(window);
  return windows;
};

it("accepts the real BookOrbit whole-second rounding case without adding silence or stretching source samples", async () => {
  const [window] = await decode();
  expect(window!.start).toBe(0);
  expect(window!.end).toBe(15.86);
  expect(window!.acceptEnd).toBe(15.86);
  expect(window!.pcm.length).toBe(253760);
  expect(window!.pcm[4000]).toBe(0.75);
  expect(decoder.calls).toEqual([[0, 15.86]]);
  expect(decoder.dispose).toHaveBeenCalledOnce();
});
it("does not decode a longer rounded tail beyond the canonical next-track boundary", async () => {
  decoder.actualDuration = 16.4;
  decoder.timestamp = 16.2;
  const [window] = await decode();
  expect(window!.end).toBe(16);
  expect(window!.acceptEnd).toBe(16);
  expect(window!.pcm.every((value) => value === 0)).toBe(true);
  expect(decoder.calls).toEqual([[0, 16]]);
});
it.each([
  [15.86, 15.9],
  [16.6, 16],
  [NaN, 16],
  [0, 16],
  [15.86, NaN],
])(
  "rejects incompatible observed %s versus canonical %s duration",
  async (observed, canonical) => {
    decoder.actualDuration = observed;
    await expect(decode(canonical)).rejects.toThrow("duration does not match");
    expect(decoder.calls).toEqual([]);
    expect(decoder.dispose).toHaveBeenCalledOnce();
  },
);
it("retains cancellation and decoder cleanup before any window is published", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(decode(16, abort.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(decoder.calls).toEqual([]);
  expect(decoder.dispose).toHaveBeenCalledOnce();
});
