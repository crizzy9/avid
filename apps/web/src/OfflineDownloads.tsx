import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Download, Trash2 } from "lucide-react";
import {
  OfflineReadAlongStore,
  offlinePlaybackSource,
  type OfflineReadAlongDescriptor,
  type OfflineReadAlongPackage,
  type OfflineReadAlongIssue,
} from "../../../packages/core/src/offlineReadAlong";
import { createOfflineReadAlongRepository } from "../../../packages/core/src/offlineReadAlongProgress";
import type { LibraryStorage } from "../../../packages/core/src/storage";
import type {
  Annotation,
  ReadingAnchor,
} from "../../../packages/core/src/types";
import {
  PlaybackController,
  resolveAudioResume,
} from "../../../packages/playback/src";
import {
  alignedAudioAnchor,
  alignedTextTarget,
  type VerifiedAudioAlignment,
} from "../../../packages/playback/src/standalone-alignment";
import { Reader } from "../../../packages/readers/src/Reader";
import type {
  AlignedPassageText,
  ReaderAlignmentHandle,
} from "../../../packages/readers/src/alignedPassage";
import { Player } from "./Player";
import { ReadAlongPanel } from "./ReadAlongPanel";
import { HandoffControls } from "./HandoffControls";
import {
  handoffPolicyKey,
  readHandoffPolicy,
  latestConfirmedPosition,
  type HandoffPolicy,
  type ConfirmedLinkedPosition,
} from "./readAlongState";
import { useReadAlongI18n } from "./readAlongMessages";
import { offlineReadAlongStore } from "./DownloadReadAlongButton";
import { useI18n } from "../../../packages/i18n/src";
import { createLazyPlaybackTransport } from "../../mobile/src/lazy-transport";
import { Modal, formatTime } from "./ui";

export function OfflineDownloads({
  storage,
  onClose,
  store = offlineReadAlongStore(),
}: {
  storage?: LibraryStorage;
  onClose: () => void;
  store?: OfflineReadAlongStore;
}) {
  const t = useReadAlongI18n();
  const [items, setItems] = useState<OfflineReadAlongDescriptor[]>([]),
    [opened, setOpened] = useState<OfflineReadAlongPackage>();
  const [issues, setIssues] = useState<OfflineReadAlongIssue[]>([]),
    [removingIssue, setRemovingIssue] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0),
    [shellReady, setShellReady] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      store
        .listScopes()
        .then((scopes) =>
          Promise.all(scopes.map((scope) => store.list(scope.scope))),
        ),
      store.listIssues(),
    ])
      .then(([groups, damaged]) => {
        if (active) {
          setItems(groups.flat());
          setIssues(damaged);
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.getRegistration("/").then((registration) => {
        if (active)
          setShellReady(
            Boolean(registration?.active && navigator.serviceWorker.controller),
          );
      });
    return () => {
      active = false;
      request.current?.abort();
    };
  }, [store, revision]);
  async function open(item: OfflineReadAlongDescriptor) {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    try {
      const pkg = await store.get(item.scope, item.id, {
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        if (!pkg) throw new Error(t("missingDownload"));
        setOpened(pkg);
      }
    } catch (cause) {
      if (!abort.signal.aborted) setError(String(cause));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  async function removeDamaged(issue: OfflineReadAlongIssue) {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setRemovingIssue(true);
    setError("");
    try {
      await store.removeIssue(issue.recoveryId);
      if (!abort.signal.aborted) setRevision((value) => value + 1);
    } catch (cause) {
      if (!abort.signal.aborted) setError(String(cause));
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        setRemovingIssue(false);
      }
    }
  }
  if (opened)
    return (
      <OfflineReadAlong
        key={`${opened.scope}:${opened.id}`}
        pkg={opened}
        storage={storage}
        onClose={() => setOpened(undefined)}
      />
    );
  return (
    <div className="offline-workspace">
      <div className="offline-workspace-header">
        <h2>{t("downloads")}</h2>
        <button className="secondary-button" onClick={onClose}>
          <ArrowLeft size={17} />
          {t("backLibrary")}
        </button>
      </div>
      <p className="offline-disclosure">{t("device")}</p>
      <p className="offline-disclosure">{t("foreground")}</p>
      {!shellReady && location.protocol.startsWith("http") && (
        <p role="status" className="offline-disclosure">
          {t("shellUnavailable")}
        </p>
      )}
      {busy && (
        <p role="status">{t(removingIssue ? "removingDamaged" : "verify")}</p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="offline-library">
        {!items.length && !issues.length && !busy && <p>{t("empty")}</p>}
        {items.map((item) => (
          <article className="offline-package" key={`${item.scope}:${item.id}`}>
            <h3>{item.book.title}</h3>
            <p>
              {item.scopeLabel} · {(item.totalBytes / 1024 ** 2).toFixed(1)} MiB
              · {t(item.mode === "paired" ? "paired" : "narrated")}
            </p>
            <div className="offline-package-actions">
              <button
                disabled={busy}
                className="primary-button"
                onClick={() => void open(item)}
              >
                <Download size={16} />
                {t("open")}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void store
                    .remove(item.scope, item.id)
                    .then(() => setRevision((value) => value + 1))
                    .catch((cause) => setError(String(cause)))
                }
              >
                <Trash2 size={16} />
                {t("remove")}
              </button>
            </div>
          </article>
        ))}
        {issues.map((issue) => (
          <article className="offline-package" key={issue.recoveryId}>
            <h3>{t("damagedDownload")}</h3>
            <p>{t("damagedDetails")}</p>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void removeDamaged(issue)}
            >
              <Trash2 size={16} />
              {t("removeDamaged")}
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}

/** Foreground browser audio uses only freshly created blob URLs. No client/session/network is restored. */
export function OfflineReadAlong({
  pkg,
  onClose,
}: {
  pkg: OfflineReadAlongPackage;
  storage?: LibraryStorage;
  onClose: () => void;
}) {
  const t = useReadAlongI18n(),
    { t: common } = useI18n();
  const [repo] = useState(() => createOfflineReadAlongRepository(pkg));
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
    [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false),
    [follow, setFollow] = useState(false);
  const [note, setNote] = useState<Annotation | null>(null),
    [noteText, setNoteText] = useState("");
  const [policy, setPolicy] = useState<HandoffPolicy>(() =>
    readHandoffPolicy(pkg.scope, pkg.book.id),
  );
  const previewAnchor = useRef<ReadingAnchor | undefined>(undefined),
    confirmed = useRef<ConfirmedLinkedPosition[]>([]),
    [undo, setUndo] = useState<number>();
  const mounted = useRef(true),
    dispose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playbackSource = useRef<
    ReturnType<typeof offlinePlaybackSource> | undefined
  >(undefined);
  const restoredText = useRef<ReadingAnchor | undefined>(undefined);
  const lastAudioTime = useRef<number | undefined>(undefined);
  const readingConfirmation = useRef(0);
  const pendingWrites = useRef(new Set<Promise<unknown>>());
  function trackWrite<T>(write: Promise<T>): Promise<T> {
    pendingWrites.current.add(write);
    void write.then(
      () => pendingWrites.current.delete(write),
      () => pendingWrites.current.delete(write),
    );
    return write;
  }
  const readerFile = pkg.book.files.find((file) => file.id === pkg.textFileId)!;
  useEffect(() => {
    clearTimeout(dispose.current);
    mounted.current = true;
    let active = true;
    void Promise.all([
      repo.getAnchor({
        bookId: pkg.book.id,
        fileId: pkg.textFileId,
        kind: "epub",
      }),
      repo.getAnnotations(),
      pkg.alignmentSnapshot
        ? repo.getAnchor({
            bookId: pkg.book.id,
            fileId: pkg.alignmentSnapshot.edition.audioFileId,
            kind: "audio",
          })
        : undefined,
    ])
      .then(([text, notes, audio]) => {
        if (!active) return;
        setAnchor(text);
        restoredText.current = text;
        setAnnotations(notes.filter((note) => note.bookId === pkg.book.id));
        if (pkg.mode === "paired") {
          playbackSource.current?.revoke();
          const source = offlinePlaybackSource(pkg);
          playbackSource.current = source;
          const seconds = audio
            ? resolveAudioResume(source.source, audio.locator)
            : 0;
          lastAudioTime.current = seconds;
          if (audio)
            confirmed.current = [
              { source: "listening", seconds, updatedAt: audio.updatedAt },
            ];
          controller.load(source.source, seconds);
        }
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    const stop = controller.onCheckpoint((value) => {
      if (mounted.current) {
        const seconds: number = JSON.parse(value.locator).time;
        if (
          lastAudioTime.current === seconds &&
          controller.getSnapshot().status !== "playing"
        )
          return;
        lastAudioTime.current = seconds;
        confirmed.current = [
          ...confirmed.current.filter((item) => item.source !== "listening"),
          { source: "listening", seconds, updatedAt: value.updatedAt },
        ];
        void trackWrite(repo.checkpoint(value, { readOnly: true })).catch(
          (cause) => {
            if (mounted.current) setError(String(cause));
          },
        );
      }
    });
    return () => {
      active = false;
      controller.pause();
      controller.checkpoint();
      mounted.current = false;
      stop();
      dispose.current = setTimeout(() => {
        controller.destroy();
        playbackSource.current?.revoke();
        void Promise.allSettled([...pendingWrites.current]).then(() =>
          repo.db?.close(),
        );
      }, 0);
    };
  }, [repo, pkg, controller]);
  useEffect(() => {
    let active = true;
    if (
      !handle ||
      pkg.mode !== "paired" ||
      !pkg.playlist ||
      !pkg.manifest ||
      !pkg.alignmentSnapshot
    )
      return;
    void (async () => {
      const candidates = await Promise.all(
        pkg.pairings.map(async (pair) => ({
          audioHref: pair.audioHref,
          assetId: pair.assetId,
          fileId: pair.fileId,
          bytes: await pkg.audioAssets
            .find((asset) => asset.assetId === pair.assetId)!
            .blob.arrayBuffer(),
        })),
      );
      const verified = await handle.verifyAudiobook(
        pkg.playlist!,
        pkg.manifest!,
        pkg.alignmentSnapshot!.edition.audioFileId,
        candidates,
      );
      const text =
        (await handle.getTimedText?.(verified, verified.edition)) ?? [];
      const savedText = restoredText.current;
      if (savedText) {
        const passage = await handle.passageAtLocator?.(
          verified,
          verified.edition,
          savedText.locator,
        );
        if (
          active &&
          passage &&
          !confirmed.current.some((item) => item.source === "reading")
        )
          confirmed.current.push({
            source: "reading",
            seconds: passage.start,
            updatedAt: savedText.updatedAt,
            textAnchor: savedText,
          });
      }
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
  }, [handle, pkg]);
  useEffect(() => {
    if (preview) {
      handle?.clearAudioHighlight?.();
      return;
    }
    if (!map || !handle || page !== "book" || !controller.getBook()) return;
    void handle
      .followAudio?.(map, map.edition, playback.currentTime, {
        follow: follow && playback.status === "playing",
      })
      .catch((cause) => setError(String(cause)));
  }, [
    map,
    handle,
    page,
    preview,
    follow,
    playback.currentTime,
    playback.status,
    controller,
  ]);
  function changePolicy(value: HandoffPolicy) {
    setPolicy(value);
    try {
      localStorage.setItem(handoffPolicyKey(pkg.scope, pkg.book.id), value);
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function saveReading(value: ReadingAnchor) {
    const confirmation = ++readingConfirmation.current;
    try {
      await trackWrite(repo.checkpoint(value, { readOnly: true }));
      if (map && handle) {
        const passage = await handle.passageAtLocator?.(
          map,
          map.edition,
          value.locator,
        );
        if (
          passage &&
          confirmation === readingConfirmation.current &&
          mounted.current
        )
          confirmed.current = [
            ...confirmed.current.filter((item) => item.source !== "reading"),
            {
              source: "reading",
              seconds: passage.start,
              updatedAt: value.updatedAt,
              textAnchor: value,
            },
          ];
      }
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    }
  }
  async function listenHere(explicit: boolean) {
    try {
      if (!map || !handle) return;
      if (
        explicit ||
        (policy === "latest" &&
          latestConfirmedPosition(confirmed.current)?.source === "reading")
      ) {
        const passage = explicit
          ? await handle.currentPassage(map, map.edition)
          : null;
        const seconds =
          passage?.start ??
          (!explicit
            ? latestConfirmedPosition(confirmed.current)?.seconds
            : undefined);
        if (seconds === undefined) throw new Error(t("readingUnaligned"));
        setUndo(controller.getSnapshot().currentTime);
        controller.seek(seconds);
      }
      handle.pauseNarration();
      setPage("player");
      await controller.play();
    } catch (cause) {
      setError(String(cause));
    }
  }
  function readHere(explicit: boolean) {
    let shouldFollow = explicit;
    if (map && (explicit || policy === "latest")) {
      const latest = latestConfirmedPosition(confirmed.current);
      const seconds =
        explicit || latest?.source !== "reading"
          ? playback.currentTime
          : latest.seconds;
      const target = alignedTextTarget(map, map.edition, seconds);
      shouldFollow = explicit || latest?.source !== "reading";
      if (!explicit && latest?.source === "reading" && latest.textAnchor)
        setAnchor(latest.textAnchor);
      else if (target)
        setAnchor({
          bookId: pkg.book.id,
          fileId: pkg.textFileId,
          kind: "epub",
          locator: target.locator,
          progress: seconds / map.duration,
          updatedAt: latest?.updatedAt ?? new Date().toISOString(),
        });
      else {
        setError(t("audioUnaligned"));
        return;
      }
    }
    setFollow(shouldFollow);
    setPreview(false);
    setPage("book");
  }
  function addAudioNote() {
    const checkpoint = controller.checkpoint();
    if (!checkpoint) return;
    const now = new Date().toISOString();
    setNoteText("");
    setNote({
      id: crypto.randomUUID(),
      bookId: pkg.book.id,
      fileId: checkpoint.fileId,
      kind: "audio",
      quote: "",
      text: "",
      color: "#b69b66",
      locator: checkpoint.locator,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (!loaded)
    return (
      <div className="offline-workspace">
        <button onClick={onClose}>{common("common.close")}</button>
        <p role={error ? "alert" : "status"}>{error || t("verify")}</p>
      </div>
    );
  return (
    <div className="offline-workspace">
      <div className="offline-workspace-header">
        <button
          className="text-button"
          onClick={() => {
            controller.pause();
            controller.checkpoint();
            onClose();
          }}
        >
          <ArrowLeft size={18} />
          {t("downloads")}
        </button>
        <strong>{t("ready")}</strong>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {page === "player" && (
        <Player
          controller={controller}
          book={pkg.book}
          onNote={addAudioNote}
          onRead={map ? () => readHere(true) : undefined}
          readAlong={
            map && (
              <ReadAlongPanel
                lines={lines}
                seconds={playback.currentTime}
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
              >
                <HandoffControls policy={policy} onPolicy={changePolicy} />
              </ReadAlongPanel>
            )
          }
          offlineControl={
            <>
              <p className="offline-disclosure">{t("foreground")}</p>
              <button className="text-button" onClick={() => readHere(false)}>
                {t("openBook")}
              </button>
              {annotations.some(
                (value) => value.kind === "audio" && !value.deleted,
              ) && (
                <details className="offline-audio-notes">
                  <summary>{common("nav.notebook")}</summary>
                  {annotations
                    .filter((value) => value.kind === "audio" && !value.deleted)
                    .map((value) => {
                      const source = controller.getBook();
                      const seconds = source
                        ? resolveAudioResume(source, value.locator)
                        : 0;
                      return (
                        <button
                          className="secondary-button"
                          key={value.id}
                          onClick={() => {
                            setUndo(playback.currentTime);
                            controller.seek(seconds);
                          }}
                        >
                          <time>{formatTime(seconds)}</time>
                          <span>{value.text || value.quote}</span>
                        </button>
                      );
                    })}
                </details>
              )}
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
          annotations={annotations}
          onAlignmentReady={setHandle}
          externalNarration={pkg.mode === "paired"}
          persistProgress={
            !preview &&
            playback.status !== "playing" &&
            (pkg.mode !== "paired" || Boolean(map))
          }
          onPreviewAnchor={(value) => {
            previewAnchor.current = value;
          }}
          onAnchor={(value) => {
            setAnchor(value);
            void saveReading(value);
          }}
          onAnnotation={(value) =>
            void trackWrite(repo.putAnnotation(value, { readOnly: true }))
              .then(() => repo.getAnnotations())
              .then(setAnnotations)
              .catch((cause) => setError(String(cause)))
          }
          onClose={() =>
            pkg.mode === "paired" ? setPage("player") : onClose()
          }
          modeControls={
            <div className="read-along-reader-controls">
              <HandoffControls
                policy={policy}
                onPolicy={changePolicy}
                preview={preview}
                onPreview={(value) => {
                  setPreview(value);
                  if (value) setFollow(false);
                }}
                onConfirm={() => {
                  if (previewAnchor.current)
                    void saveReading({
                      ...previewAnchor.current,
                      updatedAt: new Date().toISOString(),
                    });
                }}
              />
              {pkg.mode === "paired" && (
                <>
                  <button
                    className="reader-primary"
                    disabled={!map}
                    onClick={() => void listenHere(true)}
                  >
                    {t("listenHere")}
                  </button>
                  <button
                    className="reader-secondary"
                    disabled={!map}
                    onClick={() => void listenHere(false)}
                  >
                    {t("openPlayer")}
                  </button>
                  <button
                    className="reader-secondary"
                    onClick={() =>
                      playback.status === "playing"
                        ? controller.pause()
                        : void controller.play()
                    }
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
                      onChange={(event) => {
                        setFollow(event.target.checked);
                        if (event.target.checked) setPreview(false);
                      }}
                    />
                    {t("follow")}
                  </label>
                </>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
          }
        />
      )}
      {note && (
        <Modal title={common("note.moment")} onClose={() => setNote(null)}>
          <form
            className="form-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void trackWrite(
                repo.putAnnotation(
                  {
                    ...note,
                    text: noteText,
                    updatedAt: new Date().toISOString(),
                  },
                  { readOnly: true },
                ),
              )
                .then(() => repo.getAnnotations())
                .then((values) => {
                  setAnnotations(values);
                  setNote(null);
                })
                .catch((cause) => setError(String(cause)));
            }}
          >
            <textarea
              aria-label={common("note.add")}
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              required
            />
            <button className="primary-button" type="submit">
              {common("note.save")}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
