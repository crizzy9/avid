import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BookOrbitClient,
  type AudioManifest,
} from "../../../../packages/core/src/bookorbit";
import { accountScope } from "../../../../packages/core/src/repository";
import { sha256Blob } from "../../../../packages/core/src/blobHash";
import type { PreparedReadListenStore } from "../../../../packages/core/src/preparedReadListen";
import type { Book } from "../../../../packages/core/src/types";
import { createGeneratedAlignment } from "../../../../packages/playback/src/standalone-alignment";
import { generateAlignment } from "../../../../packages/playback/src/generated-alignment";
import { prepareReadListen, type PreparationInput } from "./prepareReadListen";
import { mixAudioBuffer, speechWindows } from "./audioWindows";
import { recognizedWords } from "./transcription";
import { SPEECH_MODEL } from "./model";

afterEach(() => vi.unstubAllGlobals());
const text = "The reading room was quiet and a book lay open on the table.";
async function fixture() {
  vi.stubGlobal("navigator", {
    storage: {
      estimate: vi.fn().mockResolvedValue({ quota: 1e9, usage: 0 }),
      persist: vi.fn().mockResolvedValue(true),
    },
  });
  const session = {
    profile: { id: "server", url: "https://fixture.invalid", name: "Fixture" },
    userId: "reader",
    accessToken: "test-only",
  };
  const client = new BookOrbitClient(session, {
    readOnly: true,
    fetch: vi.fn(),
  });
  const epub = new Blob(["epub-fixture"]),
    audio = new Blob(["audio-fixture"]);
  const book: Book = {
    id: "12",
    title: "A quiet hour",
    authors: [],
    format: "EPUB",
    color: "#66736d",
    progress: 0,
    description: "",
    status: "unread",
    genres: [],
    addedAt: "",
    files: [
      { id: "31", name: "book.epub", format: "EPUB" },
      { id: "41", name: "audio.wav", format: "AUDIO" },
    ],
  };
  const manifest: AudioManifest = {
    schema: "bookorbit.audiobook-manifest",
    schemaVersion: 2,
    revision: "original",
    chapters: [],
    totalDurationMs: 30000,
    assets: [
      {
        assetId: "audio",
        fileId: 41,
        sequence: 0,
        durationMs: 30000,
        sizeBytes: audio.size,
        format: "wav",
        etag: "original",
      },
    ],
  };
  const publication = {
    version: 1 as const,
    textSha256: await sha256Blob(epub),
    passages: [
      {
        id: "0:1",
        text,
        textLocator: "epubcfi(/6/2!/4/4,/1:0,/1:74)",
        textHref: "chapter.xhtml",
        elementPath: [1],
        sectionIndex: 0,
      },
    ],
  };
  const words = text
    .split(" ")
    .map((text, i) => ({ text, start: i * 0.5 + 2, end: i * 0.5 + 2.4 }));
  const track = {
    assetId: "audio",
    fileId: "41",
    sha256: await sha256Blob(audio),
    sizeBytes: audio.size,
    duration: 30,
    words,
  };
  const getManifest = vi
      .spyOn(client, "getAudioManifest")
      .mockResolvedValue(manifest),
    getBlob = vi.spyOn(client, "getAudioAssetBlob").mockResolvedValue(audio);
  const smil = vi.spyOn(client, "getMediaOverlayPlaylist");
  const store = {
    findReusable: vi.fn().mockResolvedValue(undefined),
    findReusableSources: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockImplementation(async (input) => ({
      alignmentSnapshot: input.alignment,
      id: "saved",
    })),
  };
  const handle = {
    pauseNarration: vi.fn(),
    verifyAudiobook: vi.fn(),
    currentPassage: vi.fn(),
    extractAlignmentText: vi.fn().mockResolvedValue(publication),
    restorePreparedAlignment: vi
      .fn()
      .mockImplementation(async (snapshot) =>
        createGeneratedAlignment(snapshot, publication, [track]),
      ),
  };
  const abort = new AbortController(),
    recognizer = {
      transcribe: vi.fn().mockResolvedValue(words),
      dispose: vi.fn(),
    },
    factory = vi.fn().mockResolvedValue(recognizer);
  const input: PreparationInput = {
    client,
    scope: accountScope(session),
    scopeLabel: "Fixture",
    book,
    fileId: "31",
    epub,
    handle,
    store: store as unknown as PreparedReadListenStore,
    signal: abort.signal,
    isActive: () => true,
    onProgress: vi.fn(),
  };
  return {
    input,
    book,
    epub,
    audio,
    track,
    publication,
    manifest,
    getManifest,
    getBlob,
    smil,
    store,
    handle,
    abort,
    recognizer,
    factory,
  };
}
describe("ordinary ebook/audiobook preparation orchestration", () => {
  it("releases model memory before matching and still disposes exactly once if matching fails", async () => {
    const f = await fixture();
    await expect(
      prepareReadListen(f.input, f.factory, () => {
        expect(f.recognizer.transcribe).toHaveBeenCalledOnce();
        expect(f.recognizer.dispose).toHaveBeenCalledOnce();
        throw new Error("Matching failed after transcription");
      }),
    ).rejects.toThrow("Matching failed after transcription");
    expect(f.recognizer.dispose).toHaveBeenCalledOnce();
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it("compares genuine supplied speech intervals without SMIL and saves only a freshly restored map", async () => {
    const f = await fixture(),
      result = await prepareReadListen(f.input, f.factory, generateAlignment);
    expect(result.map.source).toBe("generated");
    expect(result.map.segments[0]!.start).toBe(2);
    expect(f.smil).not.toHaveBeenCalled();
    expect(f.handle.verifyAudiobook).not.toHaveBeenCalled();
    expect(f.store.put).toHaveBeenCalledOnce();
    expect(f.getManifest).toHaveBeenCalledTimes(2);
    expect(f.handle.restorePreparedAlignment).toHaveBeenCalledWith(
      expect.anything(),
      f.manifest,
      [{ assetId: "audio", fileId: "41", blob: f.audio }],
    );
    expect(f.recognizer.dispose).toHaveBeenCalledOnce();
  });
  it("reuses a complete preparation without downloads or another model run", async () => {
    const f = await fixture();
    const alignmentSnapshot = generateAlignment({
      edition: {
        accountScope: f.input.scope,
        bookId: "12",
        textFileId: "31",
        textSha256: f.publication.textSha256,
        audioFileId: "41",
        manifestRevision: "original",
      },
      publication: f.publication,
      tracks: [f.track],
      model: SPEECH_MODEL,
    });
    f.store.findReusable.mockResolvedValue({
      alignmentSnapshot,
      sources: [{ assetId: "audio", blob: f.audio }],
    });
    expect(
      (await prepareReadListen(f.input, f.factory, generateAlignment)).reused,
    ).toBe(true);
    expect(f.getBlob).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it("can compare previously verified legacy bytes without downloading them again", async () => {
    const f = await fixture();
    f.store.findReusableSources.mockResolvedValue({
      sources: [{ assetId: "audio", blob: f.audio }],
    });
    await prepareReadListen(f.input, f.factory, generateAlignment);
    expect(f.getBlob).not.toHaveBeenCalled();
    expect(f.recognizer.transcribe).toHaveBeenCalledOnce();
  });
  it("cancellation during transcription cannot publish a late completion", async () => {
    const f = await fixture();
    f.recognizer.transcribe.mockImplementation(async () => {
      f.abort.abort();
      return f.track.words;
    });
    await expect(
      prepareReadListen(f.input, f.factory, generateAlignment),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.recognizer.dispose).toHaveBeenCalledOnce();
  });
  it("refuses to save an edition changed during transcription", async () => {
    const f = await fixture();
    f.getManifest
      .mockResolvedValueOnce(f.manifest)
      .mockResolvedValue({ ...f.manifest, revision: "replaced" });
    await expect(
      prepareReadListen(f.input, f.factory, generateAlignment),
    ).rejects.toThrow("edition changed");
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it("refuses late work after an account switch", async () => {
    const f = await fixture();
    f.recognizer.transcribe.mockImplementation(async () => {
      f.input.client.session.userId = "other";
      return f.track.words;
    });
    await expect(
      prepareReadListen(f.input, f.factory, generateAlignment),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it("does not save unaligned audio or fabricate timing for the ebook", async () => {
    const f = await fixture();
    f.recognizer.transcribe.mockResolvedValue([
      {
        text: "A completely different story somewhere else without matching words",
        start: 1,
        end: 4,
      },
    ]);
    await expect(
      prepareReadListen(f.input, f.factory, generateAlignment),
    ).rejects.toThrow("No sufficiently clear");
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it("checks device space before downloading audio or loading the model", async () => {
    const f = await fixture();
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 1, usage: 1 }) },
    });
    await expect(
      prepareReadListen(f.input, f.factory, generateAlignment),
    ).rejects.toThrow("not enough device storage");
    expect(f.getBlob).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("rejects changed bytes before transcription", async () => {
    const f = await fixture();
    f.getBlob.mockResolvedValue(new Blob(["truncated"]));
    await expect(
      prepareReadListen(f.input, f.factory, generateAlignment),
    ).rejects.toThrow("recording changed");
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("does not save if exact EPUB locator restoration fails", async () => {
    const f = await fixture();
    f.handle.restorePreparedAlignment.mockRejectedValue(
      new Error("CFI changed"),
    );
    await expect(
      prepareReadListen(f.input, f.factory, generateAlignment),
    ).rejects.toThrow("CFI changed");
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.recognizer.dispose).toHaveBeenCalledOnce();
  });
});
describe("bounded speech windows", () => {
  it("covers every source second exactly once with overlapping recognition context", () => {
    const windows = speechWindows(95);
    expect(windows[0]!.acceptStart).toBe(0);
    expect(windows.at(-1)!.acceptEnd).toBe(95);
    windows.forEach((window, i) => {
      expect(window.end - window.start).toBeLessThanOrEqual(30);
      if (i) expect(window.acceptStart).toBe(windows[i - 1]!.acceptEnd);
    });
  });
  it("rejects absent/reversed/overrun word times and removes overlap duplicates without guessing", () => {
    expect(
      recognizedWords(
        [
          { text: "before", timestamp: [0, 1] },
          { text: "real", timestamp: [3, 4] },
          { text: "unknown", timestamp: [5, null] },
          { text: "overrun", timestamp: [29, 31] },
        ],
        { start: 26, end: 56, acceptStart: 28, acceptEnd: 54 },
      ),
    ).toEqual([{ text: "real", start: 29, end: 30 }]);
  });
  it("mixes source channels using real offsets and leaves silence unfilled", () => {
    const pcm = new Float32Array(16);
    mixAudioBuffer(
      pcm,
      0,
      {
        sampleRate: 16000,
        numberOfChannels: 2,
        length: 4,
        getChannelData: (n) => new Float32Array(4).fill(n ? 0.5 : 1),
      },
      4 / 16000,
    );
    expect([...pcm.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...pcm.slice(4, 8)]).toEqual([0.75, 0.75, 0.75, 0.75]);
    expect([...pcm.slice(8)]).toEqual(new Array(8).fill(0));
  });
});

it.each(["old-matcher", "different-model"] as const)(
  "recompares %s while reusing validated source media",
  async (reason) => {
    const f = await fixture();
    const alignmentSnapshot = generateAlignment({
      edition: {
        accountScope: f.input.scope,
        bookId: "12",
        textFileId: "31",
        textSha256: f.publication.textSha256,
        audioFileId: "41",
        manifestRevision: "original",
      },
      publication: f.publication,
      tracks: [f.track],
      model: SPEECH_MODEL,
    });
    if (reason === "old-matcher")
      alignmentSnapshot.algorithm = "avid-word-match-v1";
    else
      alignmentSnapshot.model = {
        id: "previous-model",
        revision: "previous-revision",
      };
    f.store.findReusable.mockResolvedValue({
      alignmentSnapshot,
      sources: [{ assetId: "audio", blob: f.audio }],
    });
    const result = await prepareReadListen(
      f.input,
      f.factory,
      generateAlignment,
    );
    expect(result.reused).toBe(false);
    expect(f.getBlob).not.toHaveBeenCalled();
    expect(f.recognizer.transcribe).toHaveBeenCalledOnce();
    expect(result.descriptor.alignmentSnapshot.algorithm).toBe(
      "avid-word-match-v2",
    );
    expect(result.descriptor.alignmentSnapshot.model).toEqual(SPEECH_MODEL);
  },
);
it("passes the selected compact profile to the worker and records its pinned model", async () => {
  const f = await fixture();
  f.input.profile = "compact";
  const result = await prepareReadListen(f.input, f.factory, generateAlignment);
  expect(f.factory).toHaveBeenCalledWith(
    f.abort.signal,
    expect.any(Function),
    "compact",
  );
  expect(result.descriptor.alignmentSnapshot.model.id).toBe(
    "Xenova/whisper-tiny.en",
  );
});
