import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BookOrbitClient, type AudioManifest } from "../../core/src/bookorbit";
import { boundedFileBlob } from "../../core/src/boundedBlob";
import { accountScope } from "../../core/src/repository";
import {
  preparedReadListenStore,
  preparedPlaybackSource,
  type PreparedReadListenPackage,
} from "../../core/src/preparedReadListen";
import type { Book } from "../../core/src/types";
import { PlaybackController } from "../../playback/src";
import type { VerifiedAudioAlignment } from "../../playback/src/standalone-alignment";
import { Reader } from "../src/Reader";
import type {
  AlignedPassageText,
  ReaderAlignmentHandle,
} from "../src/alignedPassage";
import { PrepareReadListen } from "../../../apps/web/src/PrepareReadListen";
import { PreparedReadListenViewer } from "../../../apps/web/src/OfflineDownloads";
import "../../../apps/web/src/styles.css";
import "./preparation-harness.css";

const epubUrl = new URL("preparation-text.epub", import.meta.url).href;
const audioUrl = new URL("preparation-speech.wav", import.meta.url).href;
const manifestUrl = new URL("preparation-manifest.json", import.meta.url).href;
const session = {
  profile: {
    id: "librispeech-qa",
    name: "Local LibriSpeech QA",
    url: "https://librispeech-fixture.invalid",
  },
  userId: "fixture-reader",
  accessToken: "unused-local-fixture",
};
const scope = accountScope(session),
  bookId = "174168635",
  textFileId = "31835";
const roundedManifest =
  new URLSearchParams(location.search).get("rounded") === "1";
const book: Book = {
  id: bookId,
  title: "Les Misérables · real speech preparation check",
  authors: ["Victor Hugo / LibriSpeech"],
  description:
    "CC BY 4.0 LibriSpeech 174-168635-0002. Ordinary EPUB without media overlays; real narration, no supplied timestamps.",
  format: "EPUB",
  color: "#a58b55",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "2026-10-18",
  files: [
    { id: textFileId, name: "preparation-text.epub", format: "EPUB" },
    { id: "41835", name: "preparation-speech.wav", format: "AUDIO" },
  ],
};
class FixtureClient extends BookOrbitClient {
  readonly requests = { manifest: 0, audio: 0 };
  blocked = false;
  onRead?: () => void;
  constructor(readonly manifest: AudioManifest) {
    super(session, {
      readOnly: true,
      fetch: async () => {
        throw new Error("Fixture cannot contact a BookOrbit server.");
      },
    });
  }
  override async getAudioManifest(id: string) {
    if (id !== bookId) throw new Error("Wrong fixture book.");
    this.requests.manifest++;
    this.onRead?.();
    return structuredClone(this.manifest);
  }
  override async getAudioAssetBlob(
    id: string,
    assetId: string,
    options: { signal?: AbortSignal; maxBytes?: number } = {},
  ) {
    if (id !== bookId || assetId !== this.manifest.assets[0]!.assetId)
      throw new Error("Wrong fixture audio.");
    if (this.blocked)
      throw new Error(
        "Fixture audio downloads are blocked for this offline check.",
      );
    this.requests.audio++;
    this.onRead?.();
    return boundedFileBlob(
      await fetch(audioUrl, { signal: options.signal }),
      options.maxBytes ?? 1024 ** 2,
      options.signal,
    );
  }
}
interface Fixture {
  source: Blob;
  client: FixtureClient;
}
export function PreparationHarness() {
  const [fixture, setFixture] = useState<Fixture>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    void Promise.all([
      fetch(epubUrl, { signal: abort.signal }).then((response) => {
        if (!response.ok) throw new Error("Fixture EPUB unavailable.");
        return response.blob();
      }),
      fetch(manifestUrl, { signal: abort.signal }).then((response) => {
        if (!response.ok) throw new Error("Fixture manifest unavailable.");
        return response.json() as Promise<AudioManifest>;
      }),
    ])
      .then(([source, manifest]) => {
        if (roundedManifest) {
          manifest.revision += "-whole-seconds";
          for (const asset of manifest.assets)
            asset.durationMs = Math.round(asset.durationMs! / 1000) * 1000;
          manifest.totalDurationMs = manifest.assets.reduce(
            (sum, asset) => sum + asset.durationMs!,
            0,
          );
        }
        if (active) setFixture({ source, client: new FixtureClient(manifest) });
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, []);
  return fixture ? (
    <PreparationFixture fixture={fixture} />
  ) : (
    <p role={error ? "alert" : "status"}>
      {error || "Opening the local real-speech fixture…"}
    </p>
  );
}
function PreparationFixture({ fixture }: { fixture: Fixture }) {
  const [controller] = useState(() => new PlaybackController()),
    playback = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
    );
  const [handle, setHandle] = useState<ReaderAlignmentHandle | null>(null),
    [map, setMap] = useState<VerifiedAudioAlignment | null>(null),
    [lines, setLines] = useState<readonly AlignedPassageText[]>([]);
  const [activeLine, setActiveLine] = useState<string | null>(null),
    [error, setError] = useState(""),
    [follow, setFollow] = useState(true),
    [preview, setPreview] = useState(""),
    [savedCount, setSavedCount] = useState(0),
    [inspection, setInspection] = useState("");
  const [closed, setClosed] = useState(false),
    [cold, setCold] = useState<PreparedReadListenPackage>(),
    [blocked, setBlocked] = useState(false),
    [, redraw] = useState(0);
  const playbackSource = useRef<
      ReturnType<typeof preparedPlaybackSource> | undefined
    >(undefined),
    mounted = useRef(true),
    latestHandle = useRef(handle);
  latestHandle.current = handle;
  useEffect(() => {
    mounted.current = true;
    fixture.client.onRead = () => redraw((value) => value + 1);
    return () => {
      mounted.current = false;
      fixture.client.onRead = undefined;
      controller.destroy();
      playbackSource.current?.revoke();
    };
  }, [controller, fixture]);
  useEffect(() => {
    let active = true;
    if (!map || !handle?.followAudio) return;
    void handle
      .followAudio(map, map.edition, playback.currentTime, { follow })
      .then((line) => {
        if (active) setActiveLine(line?.segmentId ?? null);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [handle, map, playback.currentTime, follow]);
  async function savedPackage() {
    const store = preparedReadListenStore(),
      descriptor = (await store.list(scope)).find(
        (item) =>
          item.book.id === bookId &&
          item.textFileId === textFileId &&
          item.manifest.revision === fixture.client.manifest.revision,
      );
    if (!descriptor)
      throw new Error("Prepare this fixture once before reopening it.");
    const pkg = await store.get(scope, descriptor.id);
    if (!pkg) throw new Error("Saved fixture package is missing.");
    return pkg;
  }
  async function acceptMap(value: VerifiedAudioAlignment) {
    const origin = latestHandle.current;
    if (!origin) throw new Error("Fixture reader is closed.");
    const [pkg, text] = await Promise.all([
      savedPackage(),
      origin.getTimedText?.(value, value.edition) ?? [],
    ]);
    if (!mounted.current || origin !== latestHandle.current) return;
    controller.pause();
    playbackSource.current?.revoke();
    playbackSource.current = preparedPlaybackSource(pkg);
    controller.load(playbackSource.current.source, 0);
    setMap(value);
    setLines(text);
    setError("");
  }
  async function openSaved() {
    try {
      const pkg = await savedPackage();
      if (!mounted.current) return;
      controller.pause();
      handle?.pauseNarration();
      handle?.clearAudioHighlight?.();
      setMap(null);
      setCold(pkg);
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function listen(
    value: VerifiedAudioAlignment,
    origin: ReaderAlignmentHandle,
  ) {
    try {
      const passage = await origin.currentPassage(value, value.edition);
      if (!passage)
        throw new Error("Current passage did not receive a confident match.");
      if (origin !== latestHandle.current) return;
      origin.pauseNarration();
      controller.seek(passage.start);
      await controller.play();
    } catch (cause) {
      setError(String(cause));
    }
  }
  const seek = (seconds: number) => {
    controller.pause();
    controller.seek(seconds);
  };
  const first = map?.segments[0],
    last = map?.segments.at(-1);
  const controls = (
    <div className="preparation-qa-controls">
      <p>
        <strong>Local QA · real LibriSpeech narration</strong> · 15.86 s actual
        / {fixture.client.manifest.totalDurationMs / 1000} s manifest · ordinary
        EPUB · no authored timing. No BookOrbit server is contacted.
      </p>
      <PrepareReadListen
        client={fixture.client}
        scopeLabel="LibriSpeech local QA"
        book={book}
        fileId={textFileId}
        source={fixture.source}
        handle={handle}
        onPrepared={acceptMap}
        onListen={listen}
        onOpenPrepared={() => void openSaved()}
      />
      <div className="preparation-qa-buttons">
        <button onClick={() => void openSaved()}>
          Open saved preparation (no ASR)
        </button>
        <label>
          <input
            type="checkbox"
            checked={blocked}
            onChange={(event) => {
              fixture.client.blocked = event.target.checked;
              setBlocked(event.target.checked);
            }}
          />
          Block fixture audio downloads
        </label>
      </div>
      {map && (
        <>
          <div className="preparation-qa-buttons">
            <button
              onClick={() => {
                handle?.pauseNarration();
                void controller
                  .play()
                  .catch((cause) => setError(String(cause)));
              }}
            >
              Play real narration
            </button>
            <button onClick={() => controller.pause()}>Pause narration</button>
            <button
              disabled={!first}
              onClick={() =>
                seek(first!.start + (first!.end - first!.start) / 2)
              }
            >
              Paused first match
            </button>
            <button
              disabled={!last}
              onClick={() => seek(last!.start + (last!.end - last!.start) / 2)}
            >
              Paused last match
            </button>
            <button onClick={() => seek(map.duration)}>End gap</button>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              Follow passage
            </label>
            <button
              onClick={() => {
                const view = document.querySelector("foliate-view") as
                  | (HTMLElement & {
                      renderer?: { getContents(): { doc: Document | null }[] };
                    })
                  | null;
                setInspection(
                  JSON.stringify(
                    view?.renderer
                      ?.getContents()
                      .flatMap(({ doc }) =>
                        doc
                          ? [...doc.querySelectorAll(".avid-audio-active")].map(
                              (node) => node.textContent,
                            )
                          : [],
                      ) ?? [],
                  ),
                );
              }}
            >
              Inspect highlight text
            </button>
          </div>
          <p role="status">
            Active passage: {activeLine ?? "none"} · {playback.status} · source{" "}
            {playback.currentTime.toFixed(4)} / {map.duration.toFixed(4)} s ·
            saved checkpoints: {savedCount}
          </p>
          <ol className="preparation-qa-lines">
            {lines.map((line) => (
              <li key={line.segmentId}>
                <button
                  aria-current={
                    activeLine === line.segmentId ? "true" : undefined
                  }
                  onClick={() => seek(line.start)}
                >
                  {line.start.toFixed(2)}–{line.end.toFixed(2)} s · {line.text}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      <p>
        Local reads: manifest {fixture.client.requests.manifest}, audio{" "}
        {fixture.client.requests.audio}.{" "}
        {map && `Matched segments: ${map.segments.length}.`}
      </p>
      {inspection && (
        <output aria-label="Actual reader highlight text">{inspection}</output>
      )}
      {preview && (
        <details>
          <summary>Preview locator (not saved)</summary>
          <code>{preview}</code>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
  if (cold)
    return (
      <div className="preparation-qa">
        <p>
          Reopened from IndexedDB only. No speech model is loaded by this
          viewer. Fixture audio reads remain {fixture.client.requests.audio}.
        </p>
        <PreparedReadListenViewer
          pkg={cold}
          onClose={() => {
            setCold(undefined);
            setLines([]);
            setActiveLine(null);
          }}
        />
      </div>
    );
  if (closed)
    return (
      <div className="preparation-qa">
        <button onClick={() => setClosed(false)}>Reopen fixture reader</button>
        <button onClick={() => void openSaved()}>
          Open saved preparation (no ASR)
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  return (
    <div className="preparation-qa">
      <Reader
        book={book}
        file={book.files[0]}
        source={fixture.source}
        accountScope={scope}
        annotations={[]}
        annotationsEnabled={false}
        externalNarration
        persistProgress={false}
        onPreviewAnchor={(anchor) => setPreview(anchor.locator)}
        onAnchor={() => setSavedCount((count) => count + 1)}
        onAnnotation={() => {
          throw new Error("Prepared fixture must not save annotations.");
        }}
        onAlignmentReady={setHandle}
        onClose={() => {
          controller.pause();
          setMap(null);
          setClosed(true);
        }}
        modeControls={controls}
      />
    </div>
  );
}
