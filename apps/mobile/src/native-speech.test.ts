import { describe, expect, it, vi } from "vitest";
import {
  NativeSpeechPlayer,
  nativeSpeechProvider,
  type NativeSpeechEvent,
  type NativeSpeechPlugin,
} from "./native-speech";
import { speechChunks } from "../../../packages/playback/src/speechRuntime";

function fixture() {
  let receive: (event: NativeSpeechEvent) => void = () => {};
  const remove = vi.fn(async () => {});
  const native: NativeSpeechPlugin = {
    voices: vi.fn(async () => ({
      voices: [
        {
          voiceURI: "local",
          name: "Local",
          lang: "en",
          localService: true,
          default: true,
        },
        {
          voiceURI: "network",
          name: "Network",
          lang: "en",
          localService: false,
          default: false,
        },
      ],
    })),
    speak: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(async (_, callback) => {
      receive = callback;
      return { remove };
    }),
  };
  const player = new NativeSpeechPlayer(native);
  return {
    native,
    player,
    remove,
    event: (event: NativeSpeechEvent) => receive(event),
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
describe("native installed speech", () => {
  it("preserves text and UTF-16 offsets across bounded chunks without splitting surrogate pairs", () => {
    const text = "x".repeat(3999) + "😀" + " word".repeat(1300);
    const chunks = speechChunks(text);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    let end = 0;
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(end);
      expect(chunk.text.length).toBeLessThanOrEqual(4000);
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      end += chunk.text.length;
    }
  });
  it("uses installed local voices and genuine boundary events only", async () => {
    const f = fixture(),
      onBoundary = vi.fn(),
      onStart = vi.fn();
    expect(
      (await nativeSpeechProvider(f.native).voices()).map((v) => v.voiceURI),
    ).toEqual(["local"]);
    f.player.speak({
      text: "A 😀 word",
      voiceURI: "local",
      rate: 1.5,
      onBoundary,
      onStart,
    });
    await flush();
    const call = vi.mocked(f.native.speak).mock.calls[0][0];
    expect(call).toMatchObject({
      text: "A 😀 word",
      voiceURI: "local",
      rate: 1.5,
    });
    expect(onBoundary).not.toHaveBeenCalled();
    f.event({ id: call.id, type: "start" });
    f.event({
      id: call.id,
      type: "boundary",
      start: 5,
      end: 9,
      elapsedTime: 0.6,
    });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onBoundary).toHaveBeenCalledWith({
      start: 5,
      end: 9,
      elapsedTime: 0.6,
      kind: "word",
    });
    f.player.destroy();
  });
  it("serializes chunks and maps their events back to original selection offsets", async () => {
    const f = fixture(),
      onBoundary = vi.fn(),
      onEnd = vi.fn(),
      onStart = vi.fn();
    const text = "prefix " + "one ".repeat(1500),
      start = 7,
      chunks = speechChunks(text.slice(start));
    f.player.speak({ text, start, onBoundary, onEnd, onStart });
    await flush();
    const first = vi.mocked(f.native.speak).mock.calls[0][0];
    f.event({ id: first.id, type: "start" });
    f.event({ id: first.id, type: "end" });
    await flush();
    const second = vi.mocked(f.native.speak).mock.calls[1][0];
    f.event({ id: second.id, type: "start" });
    f.event({ id: second.id, type: "boundary", start: 0, end: 3 });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onBoundary.mock.calls[0][0]).toMatchObject({
      start: start + chunks[1].offset,
      end: start + chunks[1].offset + 3,
    });
    f.event({ id: second.id, type: "end" });
    expect(onEnd).toHaveBeenCalledOnce();
    f.player.destroy();
  });
  it("rejects canceled and malformed callbacks without advancing a new section", async () => {
    const f = fixture(),
      oldEnd = vi.fn(),
      onBoundary = vi.fn(),
      onEnd = vi.fn();
    f.player.speak({ text: "old", onEnd: oldEnd });
    await flush();
    const old = vi.mocked(f.native.speak).mock.calls[0][0];
    f.player.speak({ text: "new section", onBoundary, onEnd });
    await flush();
    const next = vi.mocked(f.native.speak).mock.calls[1][0];
    expect(f.native.cancel).toHaveBeenCalledWith({ id: old.id });
    f.event({ id: old.id, type: "end" });
    f.event({ id: old.id, type: "boundary", start: 0, end: 2 });
    for (const [start, end] of [
      [-1, 2],
      [0, 999],
      [2, 1],
      [0.5, 2],
    ])
      f.event({ id: next.id, type: "boundary", start, end });
    expect(oldEnd).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onBoundary).not.toHaveBeenCalled();
    f.player.destroy();
  });
  it("cancels before listener attachment without starting or leaking the listener", async () => {
    let ready!: (value: { remove: () => Promise<void> }) => void;
    const f = fixture(),
      remove = vi.fn(async () => {});
    vi.mocked(f.native.addListener).mockImplementation(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const player = new NativeSpeechPlayer(f.native);
    player.speak({ text: "never spoken" });
    player.destroy();
    ready({ remove });
    await flush();
    expect(f.native.speak).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    f.player.destroy();
  });
  it("reports native initialization failure and never invents completion", async () => {
    const f = fixture(),
      onError = vi.fn(),
      onEnd = vi.fn();
    vi.mocked(f.native.speak).mockRejectedValue(
      new Error("No installed voice"),
    );
    f.player.speak({ text: "cannot speak", onError, onEnd });
    await flush();
    expect(onError).toHaveBeenCalledWith("No installed voice");
    expect(onEnd).not.toHaveBeenCalled();
    f.player.destroy();
  });
  it("does not let cleanup from an old player stop a new utterance", async () => {
    const f = fixture();
    f.player.speak({ text: "old" });
    await flush();
    const old = vi.mocked(f.native.speak).mock.calls[0][0];
    const next = new NativeSpeechPlayer(f.native);
    next.speak({ text: "new" });
    await flush();
    f.player.destroy();
    await flush();
    expect(f.native.cancel).toHaveBeenLastCalledWith({ id: old.id });
    next.destroy();
  });
});
