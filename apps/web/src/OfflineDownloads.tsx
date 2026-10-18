import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, BookOpen, Trash2 } from "lucide-react";
import {
  OfflineReadAlongStore,
  offlinePlaybackSource,
  type OfflineReadAlongDescriptor,
  type OfflineReadAlongPackage,
} from "../../../packages/core/src/offlineReadAlong";
import {
  PreparedReadListenStore,
  preparedReadListenStore,
  preparedPlaybackSource,
  type PreparedReadListenDescriptor,
  type PreparedReadListenPackage,
} from "../../../packages/core/src/preparedReadListen";
import type { LibraryStorage } from "../../../packages/core/src/storage";
import type { ReadingAnchor } from "../../../packages/core/src/types";
import { PlaybackController } from "../../../packages/playback/src";
import {
  alignedTextTarget,
  alignedPlaybackSeconds,
  type VerifiedAudioAlignment,
} from "../../../packages/playback/src/standalone-alignment";
import { Reader } from "../../../packages/readers/src/Reader";
import type {
  AlignedPassageText,
  ReaderAlignmentHandle,
} from "../../../packages/readers/src/alignedPassage";
import { Player } from "./Player";
import { ReadAlongPanel } from "./ReadAlongPanel";
import { useReadAlongI18n } from "./readAlongMessages";
import { usePreparedReadListenI18n } from "./preparedReadListenMessages";
import { useI18n } from "../../../packages/i18n/src";
import { createLazyPlaybackTransport } from "../../mobile/src/lazy-transport";
import "./read-along.css";

type Descriptor = PreparedReadListenDescriptor | OfflineReadAlongDescriptor;
type Package = PreparedReadListenPackage | OfflineReadAlongPackage;
function isPrepared(pkg: Descriptor): pkg is PreparedReadListenDescriptor {
  return "kind" in pkg && pkg.kind === "prepared-read-listen";
}
function isPreparedPackage(pkg: Package): pkg is PreparedReadListenPackage {
  return isPrepared(pkg);
}
let legacyStore: OfflineReadAlongStore | undefined;
function legacyReadAlongStore() {
  return (legacyStore ??= new OfflineReadAlongStore());
}

/** New prepared files and existing legacy packages share a read-only viewer, never a progress repository. */
export function OfflineDownloads({
  onClose,
  store = legacyReadAlongStore(),
  preparedStore = preparedReadListenStore(),
}: {
  storage?: LibraryStorage;
  onClose: () => void;
  store?: OfflineReadAlongStore;
  preparedStore?: PreparedReadListenStore;
}) {
  const t = usePreparedReadListenI18n();
  const [items, setItems] = useState<Descriptor[]>([]),
    [opened, setOpened] = useState<Package>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [damaged, setDamaged] = useState(false),
    [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      preparedStore.list(),
      store
        .listScopes()
        .then((scopes) =>
          Promise.all(scopes.map((scope) => store.list(scope.scope))),
        ),
      Promise.all([store.listIssues(), preparedStore.listIssues()]),
    ])
      .then(([prepared, legacy, issues]) => {
        if (active) {
          setItems([...prepared, ...legacy.flat()]);
          setDamaged(issues.some((group) => group.length > 0));
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
      request.current?.abort();
    };
  }, [store, preparedStore, revision]);
  async function open(item: Descriptor) {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    try {
      const pkg = isPrepared(item)
        ? await preparedStore.get(item.scope, item.id, { signal: abort.signal })
        : await store.get(item.scope, item.id, { signal: abort.signal });
      if (!abort.signal.aborted) {
        if (!pkg) throw new Error(t("missing"));
        setOpened(pkg);
      }
    } catch (cause) {
      if (!abort.signal.aborted) setError(String(cause));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  async function remove(item: Descriptor) {
    setBusy(true);
    setError("");
    try {
      await (isPrepared(item)
        ? preparedStore.remove(item.scope, item.id)
        : store.remove(item.scope, item.id));
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  if (opened)
    return (
      <PreparedReadListenViewer
        key={`${opened.scope}:${opened.id}`}
        pkg={opened}
        onClose={() => setOpened(undefined)}
      />
    );
  return (
    <div className="offline-workspace">
      <div className="offline-workspace-header">
        <h2>{t("title")}</h2>
        <button className="secondary-button" onClick={onClose}>
          <ArrowLeft size={17} />
          {t("back")}
        </button>
      </div>
      <p className="offline-disclosure">{t("about")}</p>
      <p className="offline-disclosure">{t("ephemeral")}</p>
      {busy && <p role="status">{t("verifying")}</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {damaged && <p role="status">{t("damaged")}</p>}
      <div className="offline-library">
        {!items.length && !busy && <p>{t("empty")}</p>}
        {items.map((item) => (
          <article
            className="offline-package"
            key={`${isPrepared(item) ? "prepared" : "legacy"}:${item.scope}:${item.id}`}
          >
            <h3>{item.book.title}</h3>
            <p>
              {item.scopeLabel} · {(item.totalBytes / 1024 ** 2).toFixed(1)} MiB
              · {t(isPrepared(item) ? "generated" : "legacy")}
            </p>
            <div className="offline-package-actions">
              <button
                disabled={busy}
                className="primary-button"
                onClick={() => void open(item)}
              >
                <BookOpen size={16} />
                {t("open")}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void remove(item)}
              >
                <Trash2 size={16} />
                {t("remove")}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
export const PreparedReadListen = OfflineDownloads;

/** Session-only transport and reading location. This component never opens the old progress/notes DB. */
export function PreparedReadListenViewer({
  pkg,
  onClose,
}: {
  pkg: Package;
  storage?: LibraryStorage;
  onClose: () => void;
}) {
  const t = usePreparedReadListenI18n(),
    along = useReadAlongI18n(),
    { t: common } = useI18n();
  const [controller] = useState(() =>
    createLazyPlaybackTransport(() => new PlaybackController()),
  );
  const playback = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [page, setPage] = useState<"book" | "player">("book"),
    [handle, setHandle] = useState<ReaderAlignmentHandle | null>(null);
  const [map, setMap] = useState<VerifiedAudioAlignment | null>(null),
    [lines, setLines] = useState<readonly AlignedPassageText[]>([]);
  const [anchor, setAnchor] = useState<ReadingAnchor>(),
    [error, setError] = useState(""),
    [follow, setFollow] = useState(true),
    [undo, setUndo] = useState<number>();
  const source = useRef<ReturnType<typeof preparedPlaybackSource> | undefined>(
      undefined,
    ),
    dispose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const paired = isPreparedPackage(pkg) || pkg.mode === "paired";
  const readerFile = pkg.book.files.find((file) => file.id === pkg.textFileId)!;
  const currentText = useRef<ReadingAnchor | undefined>(undefined);
  useEffect(() => {
    clearTimeout(dispose.current);
    if (paired) {
      try {
        controller.pause();
        source.current?.revoke();
        source.current = isPreparedPackage(pkg)
          ? preparedPlaybackSource(pkg)
          : offlinePlaybackSource(pkg);
        controller.load(source.current.source, 0);
      } catch (cause) {
        setError(String(cause));
      }
    }
    return () => {
      controller.pause();
      dispose.current = setTimeout(() => {
        controller.destroy();
        source.current?.revoke();
        source.current = undefined;
      }, 0);
    };
  }, [controller, pkg, paired]);
  useEffect(() => {
    let active = true;
    if (!handle || !paired) return;
    setMap(null);
    setLines([]);
    void (async () => {
      let verified: VerifiedAudioAlignment;
      if (isPreparedPackage(pkg)) {
        if (!handle.restorePreparedAlignment) throw new Error(t("unavailable"));
        verified = await handle.restorePreparedAlignment(
          pkg.alignmentSnapshot,
          pkg.manifest,
          pkg.sources.map((source) => ({
            assetId: source.assetId,
            fileId: pkg.assets.find(
              (asset) => asset.assetId === source.assetId,
            )!.fileId,
            blob: source.blob,
          })),
        );
      } else {
        if (!pkg.playlist || !pkg.manifest || !pkg.alignmentSnapshot)
          throw new Error(t("missing"));
        const candidates = await Promise.all(
          pkg.pairings.map(async (pair) => ({
            ...pair,
            bytes: await pkg.audioAssets
              .find((asset) => asset.assetId === pair.assetId)!
              .blob.arrayBuffer(),
          })),
        );
        verified = await handle.verifyAudiobook(
          pkg.playlist,
          pkg.manifest,
          pkg.alignmentSnapshot.edition.audioFileId,
          candidates,
        );
      }
      const text =
        (await handle.getTimedText?.(verified, verified.edition)) ?? [];
      if (active) {
        setMap(verified);
        setLines(text);
      }
    })().catch((cause) => {
      if (active) setError(String(cause));
    });
    return () => {
      active = false;
      handle.clearAudioHighlight?.();
    };
  }, [handle, pkg, paired]);
  useEffect(() => {
    if (!handle || !map || page !== "book") return;
    const seconds = alignedPlaybackSeconds(map, playback);
    if (seconds === null) {
      handle.clearAudioHighlight?.();
      return;
    }
    let active = true;
    void handle
      .followAudio?.(map, map.edition, seconds, {
        follow: follow && playback.status === "playing",
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [
    handle,
    map,
    page,
    follow,
    playback.currentTime,
    playback.status,
    playback.trackIndex,
    playback.bookId,
    playback.fileId,
  ]);
  async function listenHere() {
    try {
      if (!map || !handle) return;
      const passage = await handle.currentPassage(map, map.edition);
      if (!passage) throw new Error(along("readingUnaligned"));
      handle.pauseNarration();
      setUndo(playback.currentTime);
      controller.seek(passage.start);
      setPage("player");
      await controller.play();
    } catch (cause) {
      setError(String(cause));
    }
  }
  function readHere() {
    if (!map) return;
    const seconds = alignedPlaybackSeconds(map, playback);
    const target =
      seconds === null ? null : alignedTextTarget(map, map.edition, seconds);
    if (!target) {
      setError(along("audioUnaligned"));
      return;
    }
    setAnchor({
      bookId: pkg.book.id,
      fileId: pkg.textFileId,
      kind: "epub",
      locator: target.locator,
      progress: playback.currentTime / map.duration,
      updatedAt: new Date().toISOString(),
    });
    setFollow(true);
    setPage("book");
  }
  return (
    <div className="offline-workspace">
      <div className="offline-workspace-header">
        <button
          className="text-button"
          onClick={() => {
            controller.pause();
            handle?.pauseNarration();
            onClose();
          }}
        >
          <ArrowLeft size={18} />
          {t("title")}
        </button>
        <strong>{pkg.book.title}</strong>
      </div>
      <p className="offline-disclosure">{t("ephemeral")}</p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {page === "player" && (
        <Player
          controller={controller}
          book={pkg.book}
          onRead={map ? readHere : undefined}
          readAlong={
            map && (
              <ReadAlongPanel
                lines={lines}
                seconds={alignedPlaybackSeconds(map, playback)}
                onSeek={(seconds) => {
                  setUndo(playback.currentTime);
                  controller.seek(seconds);
                }}
                onUndo={
                  undo === undefined
                    ? undefined
                    : () => {
                        controller.seek(undo);
                        setUndo(undefined);
                      }
                }
              />
            )
          }
          offlineControl={
            <>
              <p className="offline-disclosure">{t("foreground")}</p>
              <button
                className="text-button"
                onClick={() => {
                  setFollow(false);
                  setAnchor(currentText.current);
                  setPage("book");
                }}
              >
                {along("openBook")}
              </button>
            </>
          }
        />
      )}
      {page === "book" && (
        <Reader
          book={pkg.book}
          file={readerFile}
          source={pkg.epub}
          accountScope={pkg.scope}
          initialAnchor={anchor}
          annotations={[]}
          annotationsEnabled={false}
          onAlignmentReady={setHandle}
          externalNarration={paired}
          persistProgress={false}
          onPreviewAnchor={(value) => {
            currentText.current = value;
          }}
          onAnchor={() => {}}
          onAnnotation={() => {}}
          onActivity={(activity) => {
            if (activity !== "reading") controller.pause();
          }}
          onClose={() => {
            handle?.pauseNarration();
            paired ? setPage("player") : onClose();
          }}
          modeControls={
            <div className="read-along-reader-controls">
              {paired && (
                <>
                  <button
                    className="reader-primary"
                    disabled={!map}
                    onClick={() => void listenHere()}
                  >
                    {along("listenHere")}
                  </button>
                  <button
                    className="reader-secondary"
                    disabled={!controller.getBook()}
                    onClick={() => {
                      handle?.pauseNarration();
                      setPage("player");
                    }}
                  >
                    {along("openPlayer")}
                  </button>
                  <button
                    className="reader-secondary"
                    disabled={!controller.getBook()}
                    onClick={() => {
                      if (playback.status === "playing") controller.pause();
                      else {
                        handle?.pauseNarration();
                        void controller
                          .play()
                          .catch((cause) => setError(String(cause)));
                      }
                    }}
                  >
                    {common(
                      playback.status === "playing"
                        ? "common.pause"
                        : "common.play",
                    )}
                  </button>
                  <label className="read-along-check">
                    <input
                      type="checkbox"
                      checked={follow}
                      onChange={(event) => setFollow(event.target.checked)}
                    />
                    {along("follow")}
                  </label>
                  {!map && !error && <p role="status">{t("verifying")}</p>}
                </>
              )}
            </div>
          }
        />
      )}
    </div>
  );
}
/** Existing fixture/callers retain this name; behavior is now the same ephemeral prepared viewer. */
export const OfflineReadAlong = PreparedReadListenViewer;
