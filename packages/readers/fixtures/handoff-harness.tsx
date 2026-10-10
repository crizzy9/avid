import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { unzipSync } from "fflate";
import { BookOrbitClient, type AudioManifest } from "../../core/src/bookorbit";
import { boundedBlob } from "../../core/src/boundedBlob";
import { accountScope, AvidDatabase } from "../../core/src/repository";
import { DexieLibraryStorage } from "../../core/src/storage";
import type { OfflineReadAlongDescriptor } from "../../core/src/offlineReadAlong";
import type { MediaOverlayPlaylist } from "../../core/src/media-overlay";
import type { Book, ReadingAnchor } from "../../core/src/types";
import { PlaybackController, type PlaybackBook } from "../../playback/src";
import {
  alignmentSha256,
  handoffToAudio,
  handoffToText,
  type VerifiedAudioAlignment,
} from "../../playback/src/standalone-alignment";
import { Reader } from "../src/Reader";
import type {
  AlignedPassageText,
  ReaderAlignmentHandle,
} from "../src/alignedPassage";
import { AlignmentControls } from "../../../apps/web/src/AlignmentControls";
import { OfflineDownloads } from "../../../apps/web/src/OfflineDownloads";
import { offlineReadAlongStore } from "../../../apps/web/src/DownloadReadAlongButton";

const epubUrl = new URL("sample-aligned.epub", import.meta.url).href;
const fixtureAudioUrls: Record<string, string> = {
  "audio1.wav": new URL("audio1.wav", import.meta.url).href,
  "audio2.wav": new URL("audio2.wav", import.meta.url).href,
};
const audioUrl = (name: string) => {
  const url = fixtureAudioUrls[name];
  if (!url) throw new Error("Unknown original audio fixture.");
  return url;
};
const session = {
  profile: {
    id: "original-fixture",
    name: "Original local fixture",
    url: "https://fixture.invalid",
  },
  userId: "fixture-reader",
  accessToken: "unused-local-fixture",
};
const scope = accountScope(session);
const book: Book = {
  id: "12",
  title: "A Quiet Hour · exact handoff fixture",
  authors: ["Avid original sample"],
  description: "Original EPUB and identical standalone WAV fixture",
  format: "EPUB",
  color: "#b99463",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "2026-10-09",
  files: [
    { id: "31", name: "sample-aligned.epub", format: "EPUB", url: epubUrl },
    {
      id: "41",
      name: "audio1.wav",
      format: "AUDIO",
      url: audioUrl("audio1.wav"),
    },
    {
      id: "42",
      name: "audio2.wav",
      format: "AUDIO",
      url: audioUrl("audio2.wav"),
    },
  ],
};
function wavDuration(bytes: Uint8Array): number {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = data.getUint32(offset + 4, true);
    if (new TextDecoder().decode(bytes.subarray(offset, offset + 4)) === "data")
      return length / data.getUint32(28, true);
    offset += 8 + length + (length % 2);
  }
  throw new Error("Original fixture has no WAV sample data.");
}
class FixtureClient extends BookOrbitClient {
  readonly requests = { playlist: 0, manifest: 0, assets: 0 };
  constructor(
    private readonly playlist: MediaOverlayPlaylist,
    private readonly manifest: AudioManifest,
  ) {
    super(session, {
      readOnly: true,
      fetch: async () => {
        throw new Error("This fixture never contacts a BookOrbit server.");
      },
    });
  }
  override async getMediaOverlayPlaylist(bookId: string, fileId: string) {
    if (bookId !== "12" || fileId !== "31")
      throw new Error("Wrong fixture EPUB identity.");
    this.requests.playlist++;
    return structuredClone(this.playlist);
  }
  override async getAudioManifest(bookId: string) {
    if (bookId !== "12") throw new Error("Wrong fixture book identity.");
    this.requests.manifest++;
    return structuredClone(this.manifest);
  }
  override async getAudioAssetBlob(
    bookId: string,
    assetId: string,
    options: { signal?: AbortSignal; maxBytes?: number } = {},
  ) {
    if (bookId !== "12" || !["audio1.wav", "audio2.wav"].includes(assetId))
      throw new Error("Wrong fixture audio identity.");
    this.requests.assets++;
    return boundedBlob(
      await fetch(audioUrl(assetId), { signal: options.signal }),
      options.maxBytes ?? 64 * 1024 * 1024,
      options.signal,
    );
  }
}
interface Fixture {
  source: Blob;
  client: FixtureClient;
  playback: PlaybackBook;
  playlist: MediaOverlayPlaylist;
  manifest: AudioManifest;
}
async function prepare(): Promise<Fixture> {
  const response = await fetch(epubUrl);
  if (!response.ok)
    throw new Error("Original aligned EPUB fixture is unavailable.");
  const source = await response.blob();
  const entries = unzipSync(new Uint8Array(await source.arrayBuffer()));
  const names = ["audio1.wav", "audio2.wav"];
  const durations = names.map((name) => wavDuration(entries[name]!));
  const playlist: MediaOverlayPlaylist = {
    bookId: 12,
    fileId: 31,
    durationSeconds: durations.reduce((sum, seconds) => sum + seconds, 0),
    sections: [],
    resources: names.map((name) => ({
      href: name,
      mediaType: "audio/wav",
      size: entries[name]!.byteLength,
    })),
    items: names.map((name, index) => ({
      index,
      sectionIndex: 0,
      smilHref: "timing.smil",
      textHref: "chapter.xhtml",
      textFragment: `p${index + 1}`,
      audioHref: name,
      audioMimeType: "audio/wav",
      clipBeginSeconds: 0,
      clipEndSeconds: durations[index]!,
      durationSeconds: durations[index]!,
      label: `Passage ${index + 1}`,
    })),
  };
  const manifest: AudioManifest = {
    schema: "bookorbit.audiobook-manifest",
    schemaVersion: 2,
    revision: "original-wav-fixture-v1",
    totalDurationMs: playlist.durationSeconds! * 1000,
    chapters: [],
    assets: names.map((name, index) => ({
      assetId: name,
      fileId: 41 + index,
      sequence: index,
      format: "wav",
      durationMs: durations[index]! * 1000,
      sizeBytes: entries[name]!.byteLength,
      etag: `original-${index}`,
    })),
  };
  return {
    source,
    playlist,
    manifest,
    client: new FixtureClient(playlist, manifest),
    playback: {
      bookId: "12",
      fileId: "41",
      title: book.title,
      authors: book.authors,
      manifestRevision: manifest.revision,
      tracks: names.map((name, index) => ({
        id: String(41 + index),
        title: `Original passage ${index + 1}`,
        url: audioUrl(name),
        duration: durations[index]!,
      })),
    },
  };
}
export function HandoffHarness() {
  const [fixture, setFixture] = useState<Fixture>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void prepare().then(
      (value) => {
        if (active) setFixture(value);
      },
      (failure) => {
        if (active) setError(String(failure));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return error ? (
    <p role="alert">{error}</p>
  ) : fixture ? (
    <HandoffFixture fixture={fixture} />
  ) : (
    <p>Opening original EPUB/WAV fixture…</p>
  );
}
function HandoffFixture({ fixture }: { fixture: Fixture }) {
  const [controller] = useState(() => new PlaybackController());
  const player = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [source, setSource] = useState(fixture.source);
  const [view, setView] = useState<
    "reader" | "player" | "closed" | "downloads"
  >("reader");
  const [handle, setHandle] = useState<ReaderAlignmentHandle | null>(null);
  const [map, setMap] = useState<VerifiedAudioAlignment | null>(null);
  const [readAlong, setReadAlong] = useState(false);
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<readonly AlignedPassageText[]>([]);
  const [activeLine, setActiveLine] = useState<string | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<ReadingAnchor>();
  const [savedCount, setSavedCount] = useState(0);
  const [offlineDescriptor, setOfflineDescriptor] =
    useState<OfflineReadAlongDescriptor>();
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [highlightDiagnostic, setHighlightDiagnostic] = useState("");
  const [storage] = useState(() => new DexieLibraryStorage(new AvidDatabase()));
  const offlineRequest = useRef<AbortController | null>(null);
  const [anchor, setAnchor] = useState<ReadingAnchor>({
    bookId: "12",
    fileId: "31",
    kind: "epub",
    locator: "chapter.xhtml#p1",
    progress: 0,
    updatedAt: new Date().toISOString(),
  });
  const [log, setLog] = useState("No handoff yet.");
  const [error, setError] = useState("");
  useEffect(
    () => () => {
      controller.destroy();
      offlineRequest.current?.abort();
    },
    [controller],
  );
  useEffect(() => {
    let active = true;
    if (map && handle?.getTimedText)
      void handle.getTimedText(map, map.edition).then(
        (value) => {
          if (active) setLines(value);
        },
        (failure) => {
          if (active) setError(String(failure));
        },
      );
    return () => {
      active = false;
    };
  }, [map, handle]);
  useEffect(() => {
    let active = true;
    if (readAlong && map && handle?.followAudio)
      void handle
        .followAudio(map, map.edition, player.currentTime, { follow })
        .then(
          (line) => {
            if (active) setActiveLine(line?.segmentId ?? null);
          },
          (failure) => {
            if (active) setError(String(failure));
          },
        );
    else {
      handle?.clearAudioHighlight?.();
      setActiveLine(null);
    }
    return () => {
      active = false;
    };
  }, [readAlong, map, handle, player.currentTime, follow]);
  const saveAnchor = (value: ReadingAnchor) => {
    setAnchor(value);
    setSavedCount((count) => count + 1);
  };
  const saveOffline = async () => {
    if (!map || !handle?.getTimedText) return;
    offlineRequest.current?.abort();
    const abort = new AbortController();
    offlineRequest.current = abort;
    setOfflineBusy(true);
    setError("");
    try {
      const timedText = await handle.getTimedText(map, map.edition);
      const pairings = ["audio1.wav", "audio2.wav"].map((name, index) => ({
        audioHref: name,
        assetId: name,
        fileId: String(41 + index),
      }));
      const audioAssets = await Promise.all(
        pairings.map(async (pair) => ({
          assetId: pair.assetId,
          blob: await fixture.client.getAudioAssetBlob("12", pair.assetId, {
            signal: abort.signal,
          }),
        })),
      );
      const descriptor = await offlineReadAlongStore().put(
        {
          scope,
          scopeLabel: "Original local EPUB/WAV fixture",
          book,
          textFileId: "31",
          epub: source,
          alignment: map,
          manifest: fixture.manifest,
          playlist: fixture.playlist,
          pairings,
          audioAssets,
          timedText,
        },
        { signal: abort.signal },
      );
      if (!abort.signal.aborted) {
        setOfflineDescriptor(descriptor);
        controller.pause();
        setReadAlong(false);
        setView("downloads");
      }
    } catch (failure) {
      if (!abort.signal.aborted) setError(String(failure));
    } finally {
      if (!abort.signal.aborted) setOfflineBusy(false);
    }
  };
  const inspectHighlights = () => {
    const view = document.querySelector("foliate-view") as
      | (HTMLElement & {
          renderer?: { getContents(): { doc: Document; index: number }[] };
        })
      | null;
    const snapshot = controller.getSnapshot();
    setHighlightDiagnostic(
      JSON.stringify(
        {
          clock: snapshot.currentTime,
          status: snapshot.status,
          playerDuration: snapshot.duration,
          mapDuration: map?.duration,
          remainingToMapEnd: map ? map.duration - snapshot.currentTime : null,
          tracks: controller
            .getBook()
            ?.tracks.map((track) => ({
              id: track.id,
              duration: track.duration,
              decodedDuration: track.decodedDuration,
            })),
          documents:
            view?.renderer?.getContents().map(({ doc, index }) => ({
              index,
              selection: doc.getSelection()?.toString(),
              passages: ["p1", "p2"].map((id) => {
                const element = doc.getElementById(id);
                return {
                  id,
                  class: element?.className,
                  segment: element?.getAttribute("data-avid-audio-segment"),
                  background:
                    element &&
                    doc.defaultView?.getComputedStyle(element).backgroundColor,
                };
              }),
            })) ?? [],
        },
        null,
        2,
      ),
    );
  };
  const listen = async (
    alignment: VerifiedAudioAlignment,
    reader: ReaderAlignmentHandle,
    stayOpen = false,
  ) => {
    const passage = await reader.currentPassage(alignment, {
      ...alignment.edition,
      accountScope: scope,
    });
    if (!passage)
      throw new Error(
        "Select a narrated passage or move to a page with mapped text.",
      );
    reader.pauseNarration();
    const audio = handoffToAudio(
      alignment,
      { ...alignment.edition, accountScope: scope },
      passage.textLocator,
      controller,
      fixture.playback,
    );
    if (!audio) throw new Error("This passage has no exact audio target.");
    setLog(`Text ${passage.textFragment} → ${audio.locator}`);
    setError("");
    setReadAlong(stayOpen);
    setView(stayOpen ? "reader" : "player");
    await controller.play();
  };
  const read = async () => {
    try {
      if (!map)
        throw new Error("Verify the standalone resources before handoff.");
      const target = handoffToText(
        map,
        { ...map.edition, accountScope: scope },
        controller,
      );
      if (!target)
        throw new Error("This audio point is not inside a mapped passage.");
      const response = await fetch(epubUrl);
      if (!response.ok) throw new Error("Could not reopen the original EPUB.");
      const fresh = await response.blob();
      if (
        (await alignmentSha256(await fresh.arrayBuffer())) !==
        map.edition.textSha256
      )
        throw new Error("The EPUB bytes changed after alignment verification.");
      setSource(fresh);
      setAnchor({
        bookId: target.bookId,
        fileId: target.fileId,
        kind: "epub",
        locator: target.locator,
        progress: anchor.progress,
        updatedAt: new Date().toISOString(),
      });
      setLog(
        `Audio ${controller.getSnapshot().currentTime.toFixed(3)}s → ${target.locator}; fresh EPUB SHA-256 matched.`,
      );
      setError("");
      setView("reader");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <div className="fixture-handoff">
      <style>{`.fixture-handoff{font:16px/1.6 system-ui;background:#f6f1e5;color:#292b28;min-height:100vh;padding:30px;box-sizing:border-box}.fixture-handoff button{padding:10px 16px;margin:6px;border-radius:8px;border:1px solid #ad9d7b;background:#eee6d3;color:#252a26;cursor:pointer}.fixture-handoff pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff9;padding:18px;border-radius:10px}.fixture-handoff .alignment-controls{width:100%;max-height:40vh;overflow:auto}.fixture-handoff .alignment-actions{display:flex;gap:8px;justify-content:center}.fixture-handoff .alignment-pairings{max-width:800px;margin:auto}.fixture-handoff .alignment-pairings label{display:flex;justify-content:space-between;flex-wrap:wrap;margin:9px 0}.fixture-handoff .alignment-controls p{margin:6px 0}.fixture-handoff .fixture-clock{font:32px ui-monospace,monospace;margin:20px 0}.fixture-handoff .fixture-timeline{width:min(700px,100%);display:block}`}</style>
      <h1>Original EPUB ↔ standalone WAV handoff</h1>
      <p>
        Development fixture only. These two audio assets are identical to the
        original EPUB narration resources. No external server is contacted.
      </p>
      {view === "reader" && (
        <Reader
          book={book}
          file={book.files[0]}
          source={source}
          accountScope={scope}
          initialAnchor={anchor}
          annotations={[]}
          onAnchor={saveAnchor}
          persistProgress={!readAlong}
          onPreviewAnchor={setPreviewAnchor}
          onAnnotation={() => {}}
          onClose={() => {
            setReadAlong(false);
            setView(controller.getBook() ? "player" : "closed");
          }}
          onAlignmentReady={setHandle}
          modeControls={
            <>
              <AlignmentControls
                client={fixture.client}
                book={book}
                fileId="31"
                handle={handle}
                alignment={map}
                onVerified={setMap}
                onListen={listen}
              />
              {map && handle && (
                <div
                  style={{ maxHeight: "28vh", overflow: "auto", width: "100%" }}
                >
                  <button
                    onClick={() =>
                      void listen(map, handle, true).catch((failure) =>
                        setError(String(failure)),
                      )
                    }
                  >
                    Listen alongside text
                  </button>
                  <button
                    disabled={offlineBusy}
                    onClick={() => void saveOffline()}
                  >
                    {offlineBusy
                      ? "Saving original fixture…"
                      : "Save verified fixture offline"}
                  </button>
                  {readAlong && (
                    <>
                      <button
                        onClick={() =>
                          player.status === "playing"
                            ? controller.pause()
                            : void controller.play()
                        }
                      >
                        {player.status === "playing"
                          ? "Pause standalone audio"
                          : "Play standalone audio"}
                      </button>
                      <label>
                        <input
                          type="checkbox"
                          checked={follow}
                          onChange={(event) => setFollow(event.target.checked)}
                        />
                        Follow standalone text
                      </label>
                      <button
                        onClick={() => {
                          controller.pause();
                          controller.seek(0.1);
                        }}
                      >
                        Paused first passage
                      </button>
                      <button
                        onClick={() => {
                          controller.pause();
                          controller.seek(map.segments[1]!.start + 0.1);
                        }}
                      >
                        Paused second passage
                      </button>
                      <button
                        onClick={() => {
                          controller.pause();
                          controller.seek(map.duration);
                        }}
                      >
                        End gap
                      </button>
                      <button
                        disabled={!previewAnchor}
                        onClick={() => {
                          if (previewAnchor) saveAnchor(previewAnchor);
                        }}
                      >
                        Save displayed position
                      </button>
                      <button onClick={inspectHighlights}>
                        Inspect highlight DOM
                      </button>
                      <p>
                        Saved checkpoints: {savedCount} · preview:{" "}
                        {previewAnchor?.locator ?? "none"} · active passage:{" "}
                        {activeLine ?? "none"}
                      </p>
                      <p>
                        Source clock: {player.currentTime.toPrecision(17)} /{" "}
                        {map.duration.toPrecision(17)} seconds
                      </p>
                      <ol aria-label="Verified timed passages">
                        {lines.map((line) => (
                          <li key={line.segmentId}>
                            <button
                              aria-current={
                                line.segmentId === activeLine
                                  ? "true"
                                  : undefined
                              }
                              onClick={() => controller.seek(line.start)}
                            >
                              {line.text}
                            </button>
                          </li>
                        ))}
                      </ol>
                      {highlightDiagnostic && <pre>{highlightDiagnostic}</pre>}
                    </>
                  )}
                </div>
              )}
              {error && <p role="alert">{error}</p>}
              <span>{log}</span>
            </>
          }
        />
      )}
      {view === "downloads" && (
        <>
          <p>
            Saved offline package: {offlineDescriptor?.id ?? "existing"} ·{" "}
            {offlineDescriptor?.assets.length ?? 0} audio assets ·{" "}
            {offlineDescriptor?.timedText.length ?? 0} exact timed passages
          </p>
          <OfflineDownloads
            storage={storage}
            store={offlineReadAlongStore()}
            onClose={() => setView("reader")}
          />
        </>
      )}
      {(view === "player" || view === "closed") && (
        <>
          <p>
            Playback: <strong>{player.status}</strong> · Track{" "}
            {player.trackIndex + 1} · Rate {player.rate}×
          </p>
          <div className="fixture-clock">
            {player.currentTime.toFixed(3)} / {player.duration.toFixed(3)}{" "}
            source seconds
          </div>
          <input
            className="fixture-timeline"
            aria-label="Audiobook source time"
            type="range"
            min="0"
            max={player.duration || 1}
            step="0.01"
            value={player.currentTime}
            disabled={!controller.getBook()}
            onChange={(event) => controller.seek(Number(event.target.value))}
          />
          <button
            disabled={!controller.getBook()}
            onClick={() =>
              player.status === "playing"
                ? controller.pause()
                : void controller.play()
            }
          >
            {player.status === "playing" ? "Pause audiobook" : "Play audiobook"}
          </button>
          <button
            disabled={!map || !controller.getBook()}
            onClick={() => {
              controller.pause();
              controller.seek(map!.segments[1]!.start + 0.2);
            }}
          >
            Second audio passage
          </button>
          <button
            disabled={!map || !controller.getBook()}
            onClick={() => void read()}
          >
            Read from here
          </button>
          <button
            onClick={() => {
              controller.pause();
              setView("reader");
            }}
          >
            Reopen reader
          </button>
          <pre>{log}</pre>
          <pre>Fixture reads: {JSON.stringify(fixture.client.requests)}</pre>
          {(error || player.error) && (
            <p role="alert">{error || player.error}</p>
          )}
        </>
      )}
    </div>
  );
}
