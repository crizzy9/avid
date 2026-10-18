import { describe, it, expect, vi } from "vitest";
import { BookOrbitClient } from "../src/bookorbit";
import { decodeServerSpeech } from "../src/serverSpeech";
const session = {
  profile: { id: "a", name: "Server", url: "https://books.example" },
  userId: "1",
  accessToken: "token",
};
const provider = {
  id: "voice-provider",
  name: "Studio",
  type: "openai-compatible",
};
const voice = {
  id: "amy",
  name: "Amy",
  shortName: "Amy",
  language: "English",
  locale: "en-US",
  gender: "female",
  providerId: "voice-provider",
  providerName: "Studio",
};
describe("BookOrbit named online speech contract", () => {
  it("reads only public provider and voice routes", async () => {
    const fetcher = vi.fn(async (input) =>
      Response.json(
        String(input).endsWith("tts/providers") ? [provider] : [voice],
      ),
    );
    const result = await new BookOrbitClient(session, {
      fetch: fetcher,
    }).getServerSpeechCapabilities();
    expect(result).toEqual({
      available: true,
      providers: [provider],
      voices: [voice],
    });
    expect(
      fetcher.mock.calls.map(([url]) => String(url).split("/api/v1/")[1]),
    ).toEqual(["tts/providers", "tts/voices"]);
  });
  it("rejects a voice claiming an unknown provider", async () => {
    const fetcher = vi.fn(async (input) =>
      Response.json(
        String(input).endsWith("tts/providers")
          ? [provider]
          : [{ ...voice, providerId: "wrong" }],
      ),
    );
    await expect(
      new BookOrbitClient(session, {
        fetch: fetcher,
      }).getServerSpeechCapabilities(),
    ).rejects.toThrow("identities");
  });
  it("synthesizes explicitly selected speech in read-only connections with exact fields and captions", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        audio: btoa("audio"),
        format: "mp3",
        words: [{ word: "Hello", startTime: 0, endTime: 1 }],
      }),
    );
    const abort = new AbortController();
    const result = await new BookOrbitClient(session, {
      fetch: fetcher,
      readOnly: true,
    }).synthesizeServerSpeech(
      {
        text: "Hello",
        voiceId: "amy",
        providerId: "voice-provider",
        speed: 1.1,
      },
      abort.signal,
    );
    expect(await result.audio.text()).toBe("audio");
    expect(result.words[0].word).toBe("Hello");
    expect(fetcher).toHaveBeenCalledWith(
      "https://books.example/api/v1/tts/synthesize/captioned",
      expect.objectContaining({
        method: "POST",
        signal: abort.signal,
        body: JSON.stringify({
          text: "Hello",
          voiceId: "amy",
          providerId: "voice-provider",
          speed: 1.1,
          format: "mp3",
        }),
      }),
    );
  });
  it("accepts uncaptioned audio without inventing word timings", () => {
    expect(
      decodeServerSpeech({ audio: btoa("audio"), format: "mp3", words: [] })
        .words,
    ).toEqual([]);
  });
  it("rejects incomplete/oversized payload before decoding and invalid captions", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", {
          headers: { "content-length": String(30 * 1024 ** 2) },
        }),
    );
    await expect(
      new BookOrbitClient(session, { fetch: fetcher }).synthesizeServerSpeech({
        text: "Hello",
        voiceId: "amy",
        providerId: "voice-provider",
        speed: 1,
      }),
    ).rejects.toThrow("byte limit");
    expect(() =>
      decodeServerSpeech({
        audio: btoa("audio"),
        format: "mp3",
        words: [{ word: "Hi", startTime: 1, endTime: 0 }],
      }),
    ).toThrow("timings");
  });
  it("does not send invalid or excessive synthesis input", async () => {
    const fetcher = vi.fn();
    await expect(
      new BookOrbitClient(session, { fetch: fetcher }).synthesizeServerSpeech({
        text: "a".repeat(5001),
        voiceId: "amy",
        providerId: "voice-provider",
        speed: 1,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
