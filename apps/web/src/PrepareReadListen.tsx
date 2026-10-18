import { useEffect, useRef, useState } from "react";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import { accountScope } from "../../../packages/core/src/repository";
import type { Book } from "../../../packages/core/src/types";
import { preparedReadListenStore } from "../../../packages/core/src/preparedReadListen";
import type { VerifiedAudioAlignment } from "../../../packages/playback/src/standalone-alignment";
import type { ReaderAlignmentHandle } from "../../../packages/readers/src/alignedPassage";
import type {
  PreparationProgress,
  PreparationResult,
} from "./preparation/prepareReadListen";
import {
  DEFAULT_SPEECH_PROFILE,
  type SpeechProfile,
} from "./preparation/model";
import { usePreparationI18n } from "./preparationMessages";

export interface PrepareReadListenProps {
  client: BookOrbitClient;
  scopeLabel: string;
  book: Book;
  fileId: string;
  source: Blob;
  handle: ReaderAlignmentHandle | null;
  onPrepared: (map: VerifiedAudioAlignment) => void | Promise<void>;
  onListen: (
    map: VerifiedAudioAlignment,
    handle: ReaderAlignmentHandle,
  ) => void | Promise<void>;
  onOpenPrepared: () => void;
}

export function PrepareReadListen(props: PrepareReadListenProps) {
  const t = usePreparationI18n();
  const { client, book, fileId, source, handle } = props;
  const scope = accountScope(client.session);
  const [profile, setProfile] = useState<SpeechProfile>(DEFAULT_SPEECH_PROFILE);
  const [expanded, setExpanded] = useState(false),
    [progress, setProgress] = useState<PreparationProgress>();
  const [result, setResult] = useState<PreparationResult>(),
    [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const request = useRef<AbortController | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const generation = useRef(0);
  const resultOrigin = useRef<{
    client: BookOrbitClient;
    scope: string;
    bookId: string;
    fileId: string;
    source: Blob;
    handle: ReaderAlignmentHandle;
  } | null>(null);
  const originMatches = (origin: NonNullable<typeof resultOrigin.current>) =>
    latest.current.client === origin.client &&
    accountScope(origin.client.session) === origin.scope &&
    latest.current.book.id === origin.bookId &&
    latest.current.fileId === origin.fileId &&
    latest.current.source === origin.source &&
    latest.current.handle === origin.handle;
  const visibleResult =
    result && resultOrigin.current && originMatches(resultOrigin.current)
      ? result
      : undefined;
  useEffect(() => {
    generation.current++;
    resultOrigin.current = null;
    setExpanded(false);
    setProgress(undefined);
    setResult(undefined);
    setError("");
    setListening(false);
    return () => {
      generation.current++;
      request.current?.abort();
      request.current = null;
    };
  }, [client, scope, book.id, fileId, source, handle]);
  const cancel = () => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    setProgress(undefined);
    setListening(false);
  };
  async function prepare() {
    if (!handle) return;
    cancel();
    const abort = new AbortController();
    request.current = abort;
    setError("");
    setResult(undefined);
    resultOrigin.current = null;
    setProgress({ stage: "checking" });
    const origin = { client, scope, bookId: book.id, fileId, source, handle };
    const active = () =>
      request.current === abort &&
      !abort.signal.aborted &&
      originMatches(origin);
    try {
      const { prepareReadListen } =
        await import("./preparation/prepareReadListen");
      if (!active()) return;
      const prepared = await prepareReadListen({
        client,
        profile,
        scope,
        scopeLabel: props.scopeLabel,
        book,
        fileId,
        epub: source,
        handle,
        store: preparedReadListenStore(),
        signal: abort.signal,
        isActive: active,
        onProgress: (value) => {
          if (active()) setProgress(value);
        },
      });
      if (!active()) return;
      await latest.current.onPrepared(prepared.map);
      if (active()) {
        resultOrigin.current = origin;
        setResult(prepared);
      }
    } catch (failure) {
      if (active())
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active()) {
        setProgress(undefined);
        request.current = null;
      }
    }
  }
  async function listen() {
    const origin = resultOrigin.current;
    if (!visibleResult || !origin || !originMatches(origin)) return;
    const token = ++generation.current;
    const active = () =>
      generation.current === token &&
      resultOrigin.current === origin &&
      originMatches(origin);
    setListening(true);
    setError("");
    try {
      await latest.current.onListen(visibleResult.map, origin.handle);
    } catch (failure) {
      if (active())
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active()) setListening(false);
    }
  }
  return (
    <section
      className="prepare-read-listen alignment-controls"
      aria-label={t("prepare")}
    >
      <button
        type="button"
        className="reader-secondary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {t("prepare")}
      </button>
      {expanded && (
        <div className="preparation-details">
          <p>{t("intro")}</p>
          <p>{t("requirements")}</p>
          <p>{t("limits")}</p>
          <p>{t("timing")}</p>
          <label>
            {t("modelLabel")}
            <select
              value={profile}
              disabled={Boolean(progress) || listening}
              onChange={(event) => {
                setProfile(event.target.value as SpeechProfile);
                setResult(undefined);
                resultOrigin.current = null;
              }}
            >
              <option value="balanced">{t("balancedModel")}</option>
              <option value="compact">{t("compactModel")}</option>
            </select>
          </label>
          <p>{t("modelHint")}</p>
          {!progress && (
            <button
              type="button"
              className="reader-primary"
              disabled={
                !handle?.extractAlignmentText ||
                !handle.restorePreparedAlignment ||
                listening
              }
              onClick={() => void prepare()}
            >
              {t(visibleResult ? "checkSaved" : "prepareDevice")}
            </button>
          )}
          {progress && (
            <div role="status" aria-live="polite">
              <p>
                {t(progress.stage)}{" "}
                {progress.fraction !== undefined
                  ? `${Math.round(progress.fraction * 100)}%`
                  : ""}
              </p>
              <progress
                max={1}
                value={progress.fraction}
                aria-label={t(progress.stage)}
              />
              <button
                type="button"
                className="reader-secondary"
                onClick={cancel}
              >
                {t("cancel")}
              </button>
            </div>
          )}
          {visibleResult && (
            <>
              <p role="status">
                {t("ready", {
                  matched:
                    visibleResult.descriptor.alignmentSnapshot.coverage
                      .matchedPassages,
                  total:
                    visibleResult.descriptor.alignmentSnapshot.coverage
                      .totalPassages,
                })}
              </p>
              <p>
                {t("coverage", {
                  percent: Math.round(
                    (100 *
                      visibleResult.descriptor.alignmentSnapshot.coverage
                        .matchedWords) /
                      Math.max(
                        1,
                        visibleResult.descriptor.alignmentSnapshot.coverage
                          .totalWords,
                      ),
                  ),
                })}
              </p>
              <div className="alignment-actions">
                <button
                  type="button"
                  className="reader-primary"
                  disabled={listening}
                  onClick={() => void listen()}
                >
                  {t("listenHere")}
                </button>
                <button
                  type="button"
                  className="reader-secondary"
                  onClick={props.onOpenPrepared}
                >
                  {t("openPrepared")}
                </button>
              </div>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
