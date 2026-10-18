// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { unzipSync } from "fflate";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderProps } from "../../../packages/readers/src/contracts";
import type { ReaderAlignmentHandle } from "../../../packages/readers/src/alignedPassage";
import { OfflineReadAlong, OfflineDownloads } from "./OfflineDownloads";
import {
  OfflineReadAlongStore,
  type OfflineReadAlongInput,
  type OfflineReadAlongPackage,
} from "../../../packages/core/src/offlineReadAlong";
import {
  AvidDatabase,
  LibraryRepository,
} from "../../../packages/core/src/repository";
import {
  createOfflineReadAlongRepository,
  seedOfflineReadAlongProgress,
} from "../../../packages/core/src/offlineReadAlongProgress";
import type { AudioManifest } from "../../../packages/core/src/bookorbit";
import type { MediaOverlayPlaylist } from "../../../packages/core/src/media-overlay";
import type { ReadingAnchor } from "../../../packages/core/src/types";
import {
  alignmentSha256,
  createStandaloneAlignment,
  createGeneratedAlignment,
  verifyAudioResource,
  type VerifiedAudioAlignment,
} from "../../../packages/playback/src/standalone-alignment";
import {
  PreparedReadListenStore,
  sha256Blob,
  type PreparedReadListenInput,
} from "../../../packages/core/src/preparedReadListen";
import { alignmentTokens } from "../../../packages/playback/src/generated-alignment";
import { handoffPolicyKey } from "./readAlongState";
import { LOCALES, setLocale, translate } from "../../../packages/i18n/src";
import { readAlongMessages } from "./readAlongMessages";

const harness = vi.hoisted(() => ({
  props: null as ReaderProps | null,
  handle: null as ReaderAlignmentHandle | null,
  locator: "",
  mounts: 0,
  unmounts: 0,
}));
const firstCfi = "epubcfi(/6/2!/4/2)",
  secondCfi = "epubcfi(/6/2!/4/4)";
vi.mock("../../../packages/readers/src/Reader", () => ({
  Reader: (props: ReaderProps) => {
    harness.props = props;
    useEffect(() => {
      harness.mounts++;
      return () => {
        harness.unmounts++;
      };
    }, []);
    useEffect(() => {
      harness.locator = props.initialAnchor?.locator ?? firstCfi;
    }, [props.initialAnchor?.locator]);
    useEffect(() => {
      props.onAlignmentReady?.(harness.handle);
      return () => props.onAlignmentReady?.(null);
    }, [props.onAlignmentReady]);
    const move = (locator: string, progress: number) => {
      harness.locator = locator;
      const anchor: ReadingAnchor = {
        bookId: props.book.id,
        fileId: props.file!.id,
        kind: "epub",
        locator,
        progress,
        updatedAt: new Date().toISOString(),
      };
      if (props.persistProgress === false) props.onPreviewAnchor?.(anchor);
      else props.onAnchor(anchor);
    };
    return (
      <div
        data-testid="fixture-reader"
        data-persist={String(props.persistProgress)}
      >
        {props.modeControls}
        <button onClick={() => move(firstCfi, 0)}>Fixture first passage</button>
        <button onClick={() => move(secondCfi, 0.5)}>
          Fixture second passage
        </button>
      </div>
    );
  },
}));

const scope = JSON.stringify(["https://fixture.invalid", "reader"]);
const original = new Uint8Array(
  readFileSync("packages/readers/fixtures/sample-aligned.epub"),
);
const archive = unzipSync(original);
const audioNames = ["audio1.wav", "audio2.wav"];
const asBuffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
const blob = (bytes: Uint8Array) =>
  new NodeBlob([asBuffer(bytes)]) as unknown as Blob;
function wavDuration(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  for (let offset = 12; offset + 8 < data.length;) {
    const size = data.readUInt32LE(offset + 4);
    if (data.toString("ascii", offset, offset + 4) === "data")
      return size / data.readUInt32LE(28);
    offset += 8 + size + (size % 2);
  }
  throw new Error("Missing fixture audio data");
}
async function makeFixture(): Promise<OfflineReadAlongInput> {
  const duration = audioNames.map((name) => wavDuration(archive[name]!));
  const edition = {
    accountScope: scope,
    bookId: "12",
    textFileId: "31",
    audioFileId: "41",
    textSha256: await alignmentSha256(asBuffer(original)),
    manifestRevision: "original-v1",
  };
  const manifest: AudioManifest = {
    schema: "bookorbit.audiobook-manifest",
    schemaVersion: 2,
    revision: edition.manifestRevision,
    chapters: [],
    totalDurationMs: duration.reduce((sum, value) => sum + value, 0) * 1000,
    assets: audioNames.map((name, index) => ({
      assetId: name,
      fileId: 41 + index,
      sequence: index,
      format: "wav",
      durationMs: duration[index]! * 1000,
      sizeBytes: archive[name]!.length,
      etag: "original",
    })),
  };
  const playlist: MediaOverlayPlaylist = {
    bookId: 12,
    fileId: 31,
    durationSeconds: manifest.totalDurationMs / 1000,
    sections: [],
    resources: audioNames.map((name) => ({
      href: name,
      size: archive[name]!.length,
      mediaType: "audio/wav",
    })),
    items: audioNames.map((name, index) => ({
      index,
      sectionIndex: 0,
      smilHref: "timing.smil",
      textHref: "chapter.xhtml",
      textFragment: `p${index + 1}`,
      audioHref: name,
      audioMimeType: "audio/wav",
      clipBeginSeconds: 0,
      clipEndSeconds: duration[index]!,
      durationSeconds: duration[index]!,
      label: null,
    })),
  };
  const proofs = await Promise.all(
    audioNames.map((name, index) =>
      verifyAudioResource(
        edition,
        { audioHref: name, assetId: name, audioFileId: String(41 + index) },
        asBuffer(archive[name]!),
        asBuffer(archive[name]!),
      ),
    ),
  );
  return {
    scope,
    scopeLabel: "Fixture reader",
    textFileId: "31",
    epub: blob(original),
    book: {
      id: "12",
      title: "Original aligned fixture",
      authors: ["Avid"],
      description: "",
      format: "EPUB",
      color: "#66736d",
      progress: 0,
      status: "unread",
      genres: [],
      addedAt: "2026-10-10",
      files: [
        { id: "31", name: "Original.epub", format: "EPUB" },
        ...audioNames.map((name, index) => ({
          id: String(41 + index),
          name,
          format: "AUDIO" as const,
        })),
      ],
    },
    manifest,
    playlist,
    alignment: createStandaloneAlignment(edition, playlist, manifest, proofs),
    pairings: audioNames.map((name, index) => ({
      audioHref: name,
      assetId: name,
      fileId: String(41 + index),
    })),
    audioAssets: audioNames.map((name) => ({
      assetId: name,
      blob: blob(archive[name]!),
    })),
  };
}
class TestAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 0;
  playbackRate = 1;
  preservesPitch = true;
  paused = true;
  ended = false;
  error = null;
  preload = "";
  constructor() {
    super();
    audios.push(this);
  }
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  metadata(duration: number) {
    this.duration = duration;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
}
let audios: TestAudio[] = [],
  store: OfflineReadAlongStore,
  prepared: PreparedReadListenStore,
  database: AvidDatabase,
  repo: LibraryRepository,
  mainDatabase: AvidDatabase,
  mainRepo: LibraryRepository;
let host: HTMLDivElement,
  root: Root | null,
  pkg: OfflineReadAlongPackage,
  verified: VerifiedAudioAlignment;
let created: ReturnType<typeof vi.fn>,
  revoked: ReturnType<typeof vi.fn>,
  network: ReturnType<typeof vi.fn>;
let oldShowModal: PropertyDescriptor | undefined,
  oldClose: PropertyDescriptor | undefined;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("Audio", TestAudio);
  network = vi.fn(() => {
    throw new Error("Offline: unexpected network call");
  });
  vi.stubGlobal("fetch", network);
  created = vi.fn(() => `blob:offline-fixture-${crypto.randomUUID()}`);
  revoked = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = created;
      static revokeObjectURL = revoked;
    },
  );
  oldShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );
  oldClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "close",
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });
  setLocale("en");
  localStorage.clear();
  audios = [];
  store = new OfflineReadAlongStore(`offline-ui-${crypto.randomUUID()}`);
  prepared = new PreparedReadListenStore(`prepared-ui-${crypto.randomUUID()}`);
  mainDatabase = new AvidDatabase(`offline-library-ui-${crypto.randomUUID()}`);
  mainRepo = new LibraryRepository(mainDatabase, {
    profile: { id: "fixture", name: "Fixture", url: "https://fixture.invalid" },
    userId: "reader",
  });
  const input = await makeFixture(),
    saved = await store.put(input);
  store.close();
  store = new OfflineReadAlongStore(store.database.name);
  pkg = (await store.get(scope, saved.id))!;
  repo = createOfflineReadAlongRepository(pkg);
  database = repo.db;
  verified = input.alignment!;
  const passageAtLocator = vi.fn(
    async (map: VerifiedAudioAlignment, _edition: unknown, locator: string) =>
      locator === secondCfi
        ? map.segments[1]!
        : locator === firstCfi
          ? map.segments[0]!
          : (map.segments.find((segment) => segment.textLocator === locator) ??
            null),
  );
  harness.locator = firstCfi;
  harness.mounts = 0;
  harness.unmounts = 0;
  harness.handle = {
    pauseNarration: vi.fn(),
    currentPassage: vi.fn<ReaderAlignmentHandle["currentPassage"]>(
      async (map) => passageAtLocator(map, map.edition, harness.locator),
    ),
    passageAtLocator,
    verifyAudiobook: vi.fn<ReaderAlignmentHandle["verifyAudiobook"]>(
      async (playlist, manifest, _file, candidates) => {
        const proofs = await Promise.all(
          candidates.map((candidate) =>
            verifyAudioResource(
              verified.edition,
              {
                audioHref: candidate.audioHref,
                assetId: candidate.assetId,
                audioFileId: candidate.fileId,
              },
              asBuffer(archive[candidate.audioHref]!),
              candidate.bytes,
            ),
          ),
        );
        return createStandaloneAlignment(
          verified.edition,
          playlist,
          manifest,
          proofs,
        );
      },
    ),
    getTimedText: vi.fn<NonNullable<ReaderAlignmentHandle["getTimedText"]>>(
      async (map) =>
        map.segments.map((segment) => ({
          segmentId: segment.id,
          text: `Passage ${segment.id}`,
          textLocator: segment.textLocator,
          sectionIndex: segment.sectionIndex,
          start: segment.start,
          end: segment.end,
          trackId: segment.trackId,
          trackTime: segment.trackTime,
        })),
    ),
    followAudio: vi.fn(async () => null),
    clearAudioHighlight: vi.fn(),
  } as ReaderAlignmentHandle;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  host.remove();
  store.close();
  prepared.close();
  database.close();
  mainDatabase.close();
  await store.database.delete();
  await prepared.database.delete();
  await database.delete();
  await mainDatabase.delete();
  if (oldShowModal)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      oldShowModal,
    );
  else
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)
      .showModal;
  if (oldClose)
    Object.defineProperty(HTMLDialogElement.prototype, "close", oldClose);
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  harness.props = null;
  harness.handle = null;
});
function button(name: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (value) =>
      value.textContent?.trim() === name ||
      value.getAttribute("aria-label") === name,
  );
  if (!element) throw new Error(`Missing button ${name}: ${host.textContent}`);
  return element;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function until(check: () => void | Promise<void>) {
  const deadline = Date.now() + 2500;
  while (true) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      await act(async () => {
        await check();
      });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}
async function render(strict = false) {
  await act(async () =>
    root!.render(
      strict ? (
        <StrictMode>
          <OfflineReadAlong pkg={pkg} onClose={() => {}} />
        </StrictMode>
      ) : (
        <OfflineReadAlong pkg={pkg} onClose={() => {}} />
      ),
    ),
  );
  await until(() => expect(harness.handle!.verifyAudiobook).toHaveBeenCalled());
  await until(() => expect(button("Listen from here").disabled).toBe(false));
}
async function generatedInput(): Promise<PreparedReadListenInput> {
  const original = await makeFixture(),
    edition = original.alignment!.edition;
  const document = new DOMParser().parseFromString(
    new TextDecoder().decode(archive["chapter.xhtml"]!),
    "application/xhtml+xml",
  );
  const passages = original.alignment!.segments.map((segment, i) => ({
    id: segment.id,
    text: document.getElementById(`p${i + 1}`)!.textContent!,
    textLocator: i === 0 ? firstCfi : secondCfi,
    sectionIndex: 0,
    textHref: "chapter.xhtml",
    elementPath: [i],
  }));
  const tracks = await Promise.all(
    original.audioAssets!.map(async (source, i) => ({
      assetId: source.assetId,
      fileId: String(41 + i),
      sha256: await sha256Blob(source.blob),
      sizeBytes: source.blob.size,
      duration: original.manifest!.assets[i]!.durationMs! / 1000,
    })),
  );
  const wordCount = passages.reduce(
    (count, p) => count + alignmentTokens(p.text).length,
    0,
  );
  return {
    scope,
    scopeLabel: original.scopeLabel,
    book: original.book,
    textFileId: "31",
    epub: original.epub,
    manifest: original.manifest!,
    sources: original.audioAssets!,
    alignment: {
      version: 1,
      source: "generated",
      algorithm: "avid-word-match-v1",
      edition: { ...edition },
      model: { id: "fixture", revision: "one" },
      tracks,
      passages,
      segments: original.alignment!.segments.map((s, i) => ({
        ...s,
        textLocator: passages[i]!.textLocator,
        textFragment: "",
        textElementPath: passages[i]!.elementPath,
        confidence: 1,
      })),
      coverage: {
        matchedPassages: 2,
        totalPassages: 2,
        matchedWords: wordCount,
        totalWords: wordCount,
      },
    },
  };
}
it("opens prior narrated packages without a session, re-verifies bytes, and disables annotations/progress UI", async () => {
  await render();
  expect(network).not.toHaveBeenCalled();
  expect(harness.props).toMatchObject({
    annotationsEnabled: false,
    persistProgress: false,
    annotations: [],
  });
  expect(harness.props?.initialAnchor).toBeUndefined();
  await click("Open player");
  expect(host.textContent).not.toContain(translate("note.add", {}, "en"));
  expect(host.textContent).not.toContain(translate("nav.notebook", {}, "en"));
  expect(host.textContent).toContain(
    "does not save reading positions, notes or highlights",
  );
  expect(created).toHaveBeenCalledTimes(2);
});
it("does not follow or hand off to the next track during the current recording's decoded tail", async () => {
  await render();
  const audio = audios.at(-1)!;
  const boundary = pkg.manifest!.assets[0]!.durationMs! / 1000;
  await act(async () => {
    audio.metadata(boundary + 0.3);
    audio.currentTime = boundary + 0.1;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  expect(harness.handle!.clearAudioHighlight).toHaveBeenCalled();
  expect(
    vi.mocked(harness.handle!.followAudio!).mock.calls.at(-1)?.[2],
  ).not.toBe(boundary + 0.1);
  await click("Open player");
  await click("Show text");
  expect(
    host.querySelector('.read-along-lines [aria-current="true"]'),
  ).toBeNull();
  expect(host.textContent).toContain("No aligned text at this moment.");
  await click("Read from here");
  expect(host.querySelector('[data-testid="fixture-reader"]')).toBeNull();
  expect(network).not.toHaveBeenCalled();
});
it("keeps legacy progress and notes unchanged through reading, playback, seeking and close", async () => {
  const saved: ReadingAnchor = {
    bookId: "12",
    fileId: "31",
    kind: "epub",
    locator: secondCfi,
    progress: 0.5,
    updatedAt: "2026-10-17T10:00:00Z",
  };
  await repo.checkpoint(saved, { readOnly: true });
  await repo.putAnnotation(
    {
      id: "old-note",
      bookId: "12",
      fileId: "31",
      kind: "note",
      quote: "Original",
      text: "Preserved",
      color: "#ffffff",
      locator: secondCfi,
      createdAt: saved.updatedAt,
      updatedAt: saved.updatedAt,
    },
    { readOnly: true },
  );
  await render();
  await click("Fixture second passage");
  await click("Listen from here");
  await act(async () => {
    audios[0]!.currentTime = 0.7;
    audios[0]!.dispatchEvent(new Event("timeupdate"));
  });
  await act(async () => root!.unmount());
  root = null;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(
    await repo.getAnchor({ bookId: "12", fileId: "31", kind: "epub" }),
  ).toEqual(saved);
  expect((await repo.getAnnotations()).map((n) => n.text)).toEqual([
    "Preserved",
  ]);
  expect(
    await repo.getAnchor({ bookId: "12", fileId: "41", kind: "audio" }),
  ).toBeUndefined();
  expect(await mainRepo.getAnnotations()).toEqual([]);
  expect(network).not.toHaveBeenCalled();
});
it("keeps navigation and automatic highlights session-only and starts a reopened player at zero", async () => {
  await render();
  await click("Fixture second passage");
  await click("Listen from here");
  expect(audios[0]!.currentTime).toBe(0); // the second physical track begins at zero
  await click("Read from here");
  await until(() => expect(harness.handle!.followAudio).toHaveBeenCalled());
  expect(harness.props?.initialAnchor?.locator).toBe(
    verified.segments[1]!.textLocator,
  );
  await act(async () => root!.unmount());
  root = null;
  await new Promise((resolve) => setTimeout(resolve, 10));
  root = createRoot(host);
  await render();
  await click("Open player");
  expect(audios.at(-1)?.currentTime).toBe(0);
  expect(
    await repo.getAnchor({ bookId: "12", fileId: "41", kind: "audio" }),
  ).toBeUndefined();
});
it("cold-opens generated preparation through fresh reader verification and never fetches sources", async () => {
  const input = await generatedInput(),
    saved = await prepared.put(input);
  prepared.close();
  prepared = new PreparedReadListenStore(prepared.database.name);
  harness.handle!.restorePreparedAlignment = vi.fn<
    NonNullable<ReaderAlignmentHandle["restorePreparedAlignment"]>
  >(async (snapshot, _manifest, assets) => {
    const actual = await Promise.all(
      assets.map(async (asset, i) => ({
        ...snapshot.tracks[i]!,
        sha256: await sha256Blob(asset.blob),
        sizeBytes: asset.blob.size,
      })),
    );
    return createGeneratedAlignment(
      snapshot,
      {
        version: 1,
        textSha256: await sha256Blob(input.epub),
        passages: snapshot.passages,
      },
      actual,
    );
  });
  await act(async () =>
    root!.render(
      <OfflineDownloads
        store={store}
        preparedStore={prepared}
        onClose={() => {}}
      />,
    ),
  );
  await until(() =>
    expect(host.textContent).toContain("Compared book and audio"),
  );
  await click("Open");
  await until(() =>
    expect(harness.handle!.restorePreparedAlignment).toHaveBeenCalled(),
  );
  await until(() => expect(button("Listen from here").disabled).toBe(false));
  expect(harness.handle!.verifyAudiobook).not.toHaveBeenCalled();
  await click("Listen from here");
  expect(audios[0]!.play).toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect((await prepared.get(scope, saved.id))!.alignmentSnapshot.source).toBe(
    "generated",
  );
});
it("reuses existing paired-package audio bytes for comparison without deleting or downloading them", async () => {
  const cached = await prepared.findReusableSources(
    {
      scope,
      bookId: "12",
      textFileId: "31",
      textSha256: pkg.textSha256,
      manifest: pkg.manifest!,
    },
    {},
    store,
  );
  expect(cached?.sources.map((s) => s.assetId)).toEqual(audioNames);
  expect(cached?.alignmentSnapshot).toBeUndefined();
  expect(await store.get(scope, pkg.id)).toBeDefined();
  expect(network).not.toHaveBeenCalled();
});
it("preserves damaged legacy rows and shows a bounded recovery notice", async () => {
  await store.database.table("packages").put({
    key: JSON.stringify([scope, "damaged"]),
    scope,
    id: "damaged",
    version: 1,
  });
  await act(async () =>
    root!.render(
      <OfflineDownloads
        store={store}
        preparedStore={prepared}
        onClose={() => {}}
      />,
    ),
  );
  await until(() =>
    expect(host.textContent).toContain("They have been preserved"),
  );
  expect(host.textContent).toContain(pkg.book.title);
  expect(await store.database.table("packages").count()).toBe(2);
  expect(
    [...host.querySelectorAll("button")].some((b) =>
      b.textContent?.includes("damaged"),
    ),
  ).toBe(false);
});
it("releases every source URL and player owner after StrictMode cleanup without saving a checkpoint", async () => {
  await render(true);
  const playing = audios.at(-1)!;
  await click("Listen from here");
  await act(async () => root!.unmount());
  root = null;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(playing.pause).toHaveBeenCalled();
  expect(playing.removeAttribute).toHaveBeenCalledWith("src");
  expect(new Set(revoked.mock.calls.map(([url]) => url))).toEqual(
    new Set(created.mock.results.map((result) => result.value)),
  );
  expect(
    await repo.getAnchor({ bookId: "12", fileId: "41", kind: "audio" }),
  ).toBeUndefined();
});
it("hands playback ownership between reader speech and audiobook without overlap", async () => {
  await render();
  await click("Play");
  const audio = audios.at(-1)!;
  expect(audio.paused).toBe(false);
  await act(async () => harness.props!.onActivity?.("speech"));
  expect(audio.paused).toBe(true);
  vi.mocked(harness.handle!.pauseNarration).mockClear();
  await act(async () => harness.props!.onClose());
  expect(harness.handle!.pauseNarration).toHaveBeenCalledTimes(1);
  await click("Open book");
  vi.mocked(harness.handle!.pauseNarration).mockClear();
  await click("Play");
  expect(harness.handle!.pauseNarration).toHaveBeenCalledTimes(1);
  expect(audio.paused).toBe(false);
});
it("unmounts the modal reader in player view and applies paused Read from here on a fresh reader", async () => {
  await render();
  expect(harness.mounts).toBe(1);
  await click("Fixture second passage");
  await click("Listen from here");
  expect(host.querySelector('[data-testid="fixture-reader"]')).toBeNull();
  expect(harness.unmounts).toBe(1);
  await click("Pause");
  await click("Read from here");
  await until(() => expect(harness.mounts).toBe(2));
  expect(harness.props?.initialAnchor?.locator).toBe(
    verified.segments[1]!.textLocator,
  );
  expect(audios[0]!.paused).toBe(true);
});
it("keeps manual reading location only in the current viewer session across player switches", async () => {
  await render();
  await click("Fixture second passage");
  await click("Open player");
  expect(host.querySelector('[data-testid="fixture-reader"]')).toBeNull();
  await click("Open book");
  await until(() => expect(harness.mounts).toBe(2));
  expect(harness.props?.initialAnchor?.locator).toBe(secondCfi);
  expect(
    await repo.getAnchor({ bookId: "12", fileId: "31", kind: "epub" }),
  ).toBeUndefined();
});
