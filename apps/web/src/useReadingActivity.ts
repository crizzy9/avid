import { useCallback, useEffect, useRef } from "react";
import {
  ActivitySessionTracker,
  createActivityJournal,
} from "../../../packages/playback/src";
import type { ReadingSession } from "../../../packages/core/src/types";
import type {
  PlaybackActivityOptions,
  RecordPlaybackActivity,
} from "./usePlaybackActivity";

type ReadingIdentity = { book: { id: string }; file: { id: string } };
/** Visible reading is journaled periodically, on hide and on close, with immutable retry IDs. */
export function useReadingActivity(
  identity: ReadingIdentity | null,
  record: RecordPlaybackActivity,
  options: PlaybackActivityOptions,
): (kind: ReadingSession["kind"]) => void {
  const onError = useRef(options.onError);
  onError.current = options.onError;
  const previousScope = useRef(options.accountScope);
  const blockedIdentity = useRef<ReadingIdentity | null>(null);
  const changeKind = useRef<((kind: ReadingSession["kind"]) => void) | null>(
    null,
  );
  const interval = Math.min(
    60_000,
    Math.max(5_000, options.flushIntervalMs ?? 15_000),
  );
  useEffect(() => {
    if (previousScope.current !== options.accountScope) {
      blockedIdentity.current = identity;
      previousScope.current = options.accountScope;
    }
    if (blockedIdentity.current !== identity) blockedIdentity.current = null;
    let journal;
    try {
      if (options.accountScope)
        journal = createActivityJournal(
          localStorage,
          `${options.accountScope}:visible-reader`,
        );
    } catch (e) {
      onError.current?.(
        e instanceof Error
          ? e.message
          : "Reading activity recovery is unavailable.",
      );
    }
    const tracker = new ActivitySessionTracker(record, {
      journal,
      readOnly: options.readOnly !== false,
      onError: (error) => onError.current?.(error.message),
    });
    let kind: ReadingSession["kind"] = "reading";
    let lastFlush = performance.now();
    const sample = (force = false, stop = false) => {
      const now = performance.now();
      tracker.observe(
        {
          bookId: identity?.book.id ?? null,
          fileId: identity?.file.id ?? null,
          kind,
          active:
            !!identity &&
            identity !== blockedIdentity.current &&
            !document.hidden &&
            !stop,
        },
        now,
        Date.now(),
      );
      if (force || now - lastFlush >= interval) {
        lastFlush = now;
        void tracker.flush();
      }
    };
    changeKind.current = (next) => {
      if (next !== kind) {
        sample(true);
        kind = next;
        sample();
      }
    };
    sample();
    void tracker.flush();
    const timer = setInterval(() => sample(), 1000);
    const visibility = () => sample(document.hidden);
    const pagehide = () => sample(true, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      sample(true, true);
      changeKind.current = null;
    };
  }, [identity, record, options.accountScope, options.readOnly, interval]);
  return useCallback(
    (kind: ReadingSession["kind"]) => changeKind.current?.(kind),
    [],
  );
}
