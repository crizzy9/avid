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
  verifyAudioResource,
  type VerifiedAudioAlignment,
} from "../../../packages/playback/src/standalone-alignment";
import { handoffPolicyKey } from "./readAlongState";
import { LOCALES, setLocale, translate } from "../../../packages/i18n/src";
import { readAlongMessages } from "./readAlongMessages";

const harness = vi.hoisted(() => ({
  props: null as ReaderProps | null,
  handle: null as ReaderAlignmentHandle | null,
  locator: "",
}));
const firstCfi = "epubcfi(/6/2!/4/2)",
  secondCfi = "epubcfi(/6/2!/4/4)";
vi.mock("../../../packages/readers/src/Reader", () => ({
  Reader: (props: ReaderProps) => {
    harness.props = props;
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
  database.close();
  mainDatabase.close();
  await store.database.delete();
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
          <OfflineReadAlong
            pkg={pkg}
            storage={mainRepo.storage}
            onClose={vi.fn()}
          />
        </StrictMode>
      ) : (
        <OfflineReadAlong
          pkg={pkg}
          storage={mainRepo.storage}
          onClose={vi.fn()}
        />
      ),
    ),
  );
  await until(() => expect(button("Open player").disabled).toBe(false));
}
const textAnchor = (locator = secondCfi): ReadingAnchor => ({
  bookId: "12",
  fileId: "31",
  kind: "epub",
  locator,
  progress: 0.5,
  updatedAt: "2020-10-10T12:02:00Z",
});
const audioAnchor = (): ReadingAnchor => ({
  bookId: "12",
  fileId: "41",
  kind: "audio",
  locator: JSON.stringify({
    version: 1,
    trackId: "41",
    trackTime: 1,
    time: 1,
    manifestRevision: "original-v1",
  }),
  progress: 1 / verified.duration,
  updatedAt: "2020-10-10T12:01:00Z",
});

describe("offline read-along component", () => {
  it("keeps healthy downloads visible and removes damaged metadata only after an explicit localized recovery action", async () => {
    const input = await makeFixture();
    const damaged = await store.put({
      scope,
      scopeLabel: "Damaged fixture",
      book: input.book,
      textFileId: input.textFileId,
      epub: input.epub,
    });
    await store.database
      .table("packages")
      .update(JSON.stringify([scope, damaged.id]), {
        scopeLabel:
          "https://user:private-password@private.invalid/?token=private-token",
        textFileId: "corrupt",
      });
    const remove = vi.spyOn(store, "removeIssue");
    await act(async () =>
      root!.render(<OfflineDownloads store={store} onClose={vi.fn()} />),
    );
    await until(() =>
      expect(button("Remove damaged download").disabled).toBe(false),
    );
    expect(button("Open download").disabled).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(await store.database.table("payloads").count()).toBe(2);
    expect(host.textContent).not.toMatch(
      /private-password|private-token|private\.invalid/,
    );
    for (const [index, locale] of LOCALES.entries()) {
      await act(async () => setLocale(locale.code));
      expect(host.textContent).toContain(
        readAlongMessages.damagedDownload[index],
      );
      expect(host.textContent).toContain(
        readAlongMessages.damagedDetails[index],
      );
      expect(button(readAlongMessages.removeDamaged[index]!).disabled).toBe(
        false,
      );
    }
    await act(async () => setLocale("en"));
    remove.mockRejectedValueOnce(new Error("Storage removal failed"));
    await click("Remove damaged download");
    await until(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "Storage removal failed",
      ),
    );
    expect(await store.database.table("payloads").count()).toBe(2);
    expect(button("Open download").disabled).toBe(false);
    await click("Remove damaged download");
    await until(() =>
      expect(host.textContent).not.toContain("Damaged download"),
    );
    expect(remove).toHaveBeenCalledTimes(2);
    expect(button("Open download").disabled).toBe(false);
    expect(await store.database.table("payloads").count()).toBe(1);
    expect((await store.get(scope, pkg.id))?.id).toBe(pkg.id);
    expect(await store.listIssues()).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
  it("opens a cold saved package without a network/client and re-verifies its restored alignment", async () => {
    // A live server can reuse file IDs for a different edition. Offline opening
    // must not import that repository's reading position implicitly.
    await mainRepo.checkpoint(textAnchor(), { readOnly: true });
    await act(async () =>
      root!.render(
        <OfflineDownloads
          storage={mainRepo.storage}
          store={store}
          onClose={vi.fn()}
        />,
      ),
    );
    await until(() => expect(button("Open download").disabled).toBe(false));
    await click("Open download");
    await until(() => expect(button("Open player").disabled).toBe(false));
    expect(harness.props?.source).toBeInstanceOf(NodeBlob);
    expect(harness.props?.accountScope).toBe(scope);
    expect(harness.props?.initialAnchor).toBeUndefined();
    expect(harness.handle?.verifyAudiobook).toHaveBeenCalled();
    expect(created).toHaveBeenCalledTimes(2);
    expect(network).not.toHaveBeenCalled();
  });
  it("restores the newer saved reading position under latest policy, despite passive audio metadata loading", async () => {
    await seedOfflineReadAlongProgress(pkg, {
      reading: textAnchor(),
      audio: audioAnchor(),
    });
    localStorage.setItem(handoffPolicyKey(scope, "12"), "latest");
    await render();
    expect(harness.props?.initialAnchor?.locator).toBe(secondCfi);
    await act(async () => audios[0]!.metadata(verified.tracks[0]!.duration));
    await click("Open player");
    expect(audios[0]!.src).toBe(created.mock.results[1]!.value);
    expect(
      host.querySelector<HTMLInputElement>('input[type="range"]')?.value,
    ).toBe(String(verified.segments[1]!.start));
    expect(network).not.toHaveBeenCalled();
  });
  it("does not persist preview navigation until the explicit save-position action", async () => {
    await seedOfflineReadAlongProgress(pkg, { reading: textAnchor() });
    await render();
    const preview = [...host.querySelectorAll("label")]
      .find((label) =>
        label.textContent?.includes("Preview without saving position"),
      )!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => preview.click());
    expect(harness.props?.persistProgress).toBe(false);
    await click("Fixture first passage");
    expect(
      (await repo.getAnchor({ bookId: "12", fileId: "31", kind: "epub" }))
        ?.locator,
    ).toBe(secondCfi);
    await click("Save this reading position");
    await until(async () =>
      expect(
        (await repo.getAnchor({ bookId: "12", fileId: "31", kind: "epub" }))
          ?.locator,
      ).toBe(firstCfi),
    );
    expect(await database.outbox.count()).toBe(0);
    expect(
      await mainRepo.getAnchor({ bookId: "12", fileId: "31", kind: "epub" }),
    ).toBeUndefined();
  });
  it.each(["manual", "separate"] as const)(
    "keeps independent reading and listening positions when reopening either view under %s policy",
    async (policy) => {
      await seedOfflineReadAlongProgress(pkg, {
        reading: textAnchor(),
        audio: audioAnchor(),
      });
      localStorage.setItem(handoffPolicyKey(scope, "12"), policy);
      await render();
      await act(async () => audios[0]!.metadata(verified.tracks[0]!.duration));
      await click("Open player");
      expect(audios[0]!.src).toBe(created.mock.results[0]!.value);
      expect(audios[0]!.currentTime).toBe(1);
      await click("Open book");
      await until(() => expect(button("Open player").disabled).toBe(false));
      expect(harness.props?.initialAnchor?.locator).toBe(secondCfi);
      const follow = vi.mocked(harness.handle!.followAudio!);
      expect(follow.mock.calls.at(-1)?.[3]).toEqual({ follow: false });
      expect(
        (await repo.getAnchor({ bookId: "12", fileId: "31", kind: "epub" }))
          ?.locator,
      ).toBe(secondCfi);
      await click("Open player");
      expect(audios[0]!.currentTime).toBe(1);
      expect(network).not.toHaveBeenCalled();
    },
  );
  it("uses a deliberate backward reading move under latest policy and preserves it after closing and reopening", async () => {
    const laterAudio = audioAnchor();
    laterAudio.locator = JSON.stringify({
      version: 1,
      trackId: "42",
      trackTime: 1,
      time: verified.tracks[0]!.duration + 1,
      manifestRevision: "original-v1",
    });
    await seedOfflineReadAlongProgress(pkg, {
      reading: textAnchor(),
      audio: laterAudio,
    });
    localStorage.setItem(handoffPolicyKey(scope, "12"), "latest");
    await render();
    await act(async () => audios[0]!.metadata(verified.tracks[1]!.duration));
    await click("Fixture first passage");
    await until(async () =>
      expect(
        (await repo.getAnchor({ bookId: "12", fileId: "31", kind: "epub" }))
          ?.locator,
      ).toBe(firstCfi),
    );
    await click("Open player");
    expect(audios[0]!.src).toBe(created.mock.results[0]!.value);
    await act(async () => audios[0]!.metadata(verified.tracks[0]!.duration));
    expect(audios[0]!.currentTime).toBe(0);
    await act(async () => {
      root!.unmount();
      root = null;
    });
    await until(() => expect(revoked).toHaveBeenCalledTimes(2));
    root = createRoot(host);
    await render();
    expect(harness.props?.initialAnchor?.locator).toBe(firstCfi);
    await click("Open player");
    expect(audios[1]!.src).toBe(created.mock.results[2]!.value);
    expect(audios[1]!.currentTime).toBe(0);
    expect(await database.outbox.count()).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });
  it("creates a real local audio note at the exact track-relative position", async () => {
    await render();
    await click("Open player");
    await act(async () => {
      audios[0]!.metadata(verified.tracks[0]!.duration);
      audios[0]!.currentTime = 2;
      audios[0]!.dispatchEvent(new Event("timeupdate"));
    });
    await click(translate("note.add"));
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, "Remember this passage");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(translate("note.save"));
    await until(async () =>
      expect((await repo.getAnnotations()).length).toBe(1),
    );
    const note = (await repo.getAnnotations())[0]!;
    expect(note).toMatchObject({
      bookId: "12",
      fileId: "41",
      kind: "audio",
      text: "Remember this passage",
    });
    expect(JSON.parse(note.locator)).toMatchObject({
      trackId: "41",
      trackTime: 2,
      time: 2,
      manifestRevision: "original-v1",
    });
    await until(() =>
      expect(host.querySelector(".offline-audio-notes")?.textContent).toContain(
        "Remember this passage",
      ),
    );
    await act(async () => {
      audios[0]!.currentTime = 3;
      audios[0]!.dispatchEvent(new Event("timeupdate"));
    });
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(".offline-audio-notes button")!
        .click(),
    );
    expect(audios[0]!.currentTime).toBe(2);
    expect(await database.outbox.count()).toBe(0);
    expect(await mainRepo.getAnnotations()).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
  it("allocates one playback owner in StrictMode and revokes its blob sources when closed", async () => {
    await render(true);
    expect(audios).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(2);
    await click("Open player");
    await act(async () => audios[0]!.metadata(verified.tracks[0]!.duration));
    // No timeupdate event: closing must capture time since the browser's last
    // throttled notification before releasing the owner or storage handle.
    audios[0]!.currentTime = 2;
    const urls = created.mock.results.map((result) => result.value);
    await act(async () => {
      root!.unmount();
      root = null;
    });
    await until(() => expect(revoked).toHaveBeenCalledTimes(urls.length));
    expect(revoked.mock.calls.map((call) => call[0]).sort()).toEqual(
      urls.sort(),
    );
    expect(audios[0]!.pause).toHaveBeenCalled();
    await until(async () => {
      const anchor = await repo.getAnchor({
        bookId: "12",
        fileId: "41",
        kind: "audio",
      });
      expect(anchor && JSON.parse(anchor.locator).trackTime).toBe(2);
    });
    expect(network).not.toHaveBeenCalled();
  });
});
