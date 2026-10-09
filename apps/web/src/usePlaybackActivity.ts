import { useEffect, useRef } from 'react';
import type { ReadingSession } from '../../../packages/core/src/types';
import { ActivitySessionTracker, createActivityJournal, type ActivityObservation,
  type PlaybackBook, type PlaybackController, type SpeechController } from '../../../packages/playback/src';

export interface PlaybackActivityOptions {
  /** Required for account-safe recovery after reload. Use LibraryRepository.scope. */
  accountScope?: string;
  onError?: (message: string) => void;
  /** Repository flush interval, constrained to 5–60 seconds. */
  flushIntervalMs?: number;
}

export type RecordPlaybackActivity = (session: ReadingSession, fileId: string, options?: { endedAt: string }) => Promise<void>;

/**
 * Record new source-clock progress, not how long the player UI is open. This hook
 * never owns or destroys the playback controller. Supply an account-scoped stable
 * recorder; cleanup retains that recorder for the old account's pending writes.
 */
export function usePlaybackActivity(controller: PlaybackController, record: RecordPlaybackActivity, options: PlaybackActivityOptions = {}): void {
  const onError = useRef(options.onError);
  onError.current = options.onError;
  const scope = useRef<string | undefined>(options.accountScope);
  const blockedBook = useRef<PlaybackBook | null>(null);
  const interval = Math.min(60_000, Math.max(5_000, options.flushIntervalMs ?? 30_000));

  useEffect(() => {
    if (scope.current !== options.accountScope) {
      // A paused old-account title must not be attributed to the newly selected
      // account if its mini player survives the account transition.
      blockedBook.current = controller.getBook();
      controller.pause();
      scope.current = options.accountScope;
    }
    const tracker = createTracker(record, options.accountScope, message => onError.current?.(message));
    let lastFlush = performance.now();
    let lastActive = false;
    const sample = (forceFlush = false) => {
      const snapshot = controller.getSnapshot();
      const book = controller.getBook();
      if (blockedBook.current && blockedBook.current !== book) blockedBook.current = null;
      const active = snapshot.status === 'playing' && (!book || book !== blockedBook.current);
      const now = performance.now();
      tracker.observe({ bookId: snapshot.bookId, fileId: snapshot.fileId, kind: 'listening',
        active, position: snapshot.currentTime, rate: snapshot.rate }, now, Date.now());
      if (forceFlush || (lastActive && !active) || now - lastFlush >= interval) {
        lastFlush = now;
        void tracker.flush();
      }
      lastActive = active;
    };
    const unsubscribe = controller.subscribe(() => sample());
    sample();
    void tracker.flush(); // Recover previous immutable chunks for this account.
    const heartbeat = window.setInterval(() => sample(), 1_000);
    const pagehide = () => { controller.checkpoint(); sample(true); };
    const visibility = () => { if (document.hidden) sample(true); };
    const online = () => sample(true);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      unsubscribe();
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visibility);
      sample(true);
    };
  }, [controller, record, options.accountScope, interval]);
}

/** Optional adapter for a reader using the shared speech controller. */
export function useSpeechActivity(controller: SpeechController, identity: { bookId: string; fileId: string } | null,
  record: RecordPlaybackActivity, options: PlaybackActivityOptions = {}): void {
  const onError = useRef(options.onError);
  onError.current = options.onError;
  const previousScope = useRef(options.accountScope);
  const interval = Math.min(60_000, Math.max(5_000, options.flushIntervalMs ?? 30_000));
  useEffect(() => {
    if (previousScope.current !== options.accountScope) {
      controller.cancel();
      previousScope.current = options.accountScope;
    }
    const tracker = createTracker(record, options.accountScope, message => onError.current?.(message));
    let lastFlush = performance.now();
    let lastActive = false;
    const sample = (forceFlush = false) => {
      const now = performance.now();
      const observation: ActivityObservation = { bookId: identity?.bookId ?? null, fileId: identity?.fileId ?? null,
        kind: 'speech', active: controller.getSnapshot().status === 'speaking' };
      tracker.observe(observation, now, Date.now());
      if (forceFlush || (lastActive && !observation.active) || now - lastFlush >= interval) {
        lastFlush = now; void tracker.flush();
      }
      lastActive = observation.active;
    };
    const unsubscribe = controller.subscribe(() => sample());
    sample(); void tracker.flush();
    const heartbeat = window.setInterval(() => sample(), 1_000);
    const pagehide = () => sample(true);
    window.addEventListener('pagehide', pagehide);
    return () => { unsubscribe(); window.clearInterval(heartbeat); window.removeEventListener('pagehide', pagehide); sample(true); };
  }, [controller, identity?.bookId, identity?.fileId, record, options.accountScope, interval]);
}

function createTracker(record: RecordPlaybackActivity, scope: string | undefined, onError: (message: string) => void): ActivitySessionTracker {
  let journal;
  if (scope) {
    try { journal = createActivityJournal(window.localStorage, scope); }
    catch (error) { onError(error instanceof Error ? error.message : 'Activity recovery storage is unavailable.'); }
  }
  return new ActivitySessionTracker(record, { journal,
    onError: error => onError(`Listening activity could not be saved: ${error.message}`) });
}
