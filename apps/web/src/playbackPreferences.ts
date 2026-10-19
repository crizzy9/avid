import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  PlaybackPreferenceStore,
  playbackPreferenceStorageKey,
  projectPlaybackPreferences,
  type PlaybackPreferenceContext,
  type PlaybackPreferenceStorage,
} from "../../../packages/playback/src/preferences";
import { remoteSkipSeconds } from "../../../packages/playback/src/remotePolicy";
import type { PlaybackSessionIdentity } from "../../../packages/playback/src/foundation";
import type { PlaybackTransport } from "../../mobile/src/native-transport";
import type { Book } from "../../../packages/core/src/types";

function browserStorage(): PlaybackPreferenceStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
type PreferenceOwner = Pick<
  PlaybackTransport,
  | "configureRemote"
  | "getRemotePolicy"
  | "dispatch"
  | "getSnapshot"
  | "getBook"
  | "getPlaybackSession"
>;

/** A matching UI book is insufficient: another account or edition can reuse its ID. */
function settingsOwner(
  controller: PreferenceOwner,
  store: PlaybackPreferenceStore,
  context: PlaybackPreferenceContext,
): PlaybackSessionIdentity | null {
  const session = controller.getPlaybackSession();
  const source = controller.getBook();
  const snapshot = controller.getSnapshot();
  if (
    !session ||
    !source ||
    session.accountScope !== store.accountId ||
    (context.bookId !== undefined && context.bookId !== session.bookId) ||
    source.bookId !== session.bookId ||
    source.fileId !== session.fileId ||
    (source.manifestRevision ?? null) !== session.manifestRevision ||
    snapshot.bookId !== session.bookId ||
    snapshot.fileId !== session.fileId
  )
    return null;
  return session;
}

/** Apply supported settings to the existing, verified owner. Never load, seek or
 * autoplay. Native commands retain the exact session token through their queue. */
export function applyListeningPreferences(
  controller: PreferenceOwner,
  store: PlaybackPreferenceStore,
  context: PlaybackPreferenceContext = {},
  options: { preserveUnspecifiedRate?: boolean } = {},
) {
  const expected = settingsOwner(controller, store, context);
  if (!expected) return null;
  const resolved = store.resolve(context);
  const currentRate = controller.getSnapshot().rate;
  if (
    options.preserveUnspecifiedRate &&
    resolved.sources.rate.kind === "default" &&
    Number.isFinite(currentRate) &&
    currentRate >= 0.5 &&
    currentRate <= 3
  ) {
    resolved.values.rate = currentRate;
    resolved.sources.rate = { kind: "session" };
  }
  const effective = projectPlaybackPreferences(resolved);
  const previous = controller.getRemotePolicy();
  if (
    previous.mode !== effective.values.remoteMode ||
    remoteSkipSeconds(previous, -1) !== effective.values.skipBackwardSeconds ||
    remoteSkipSeconds(previous, 1) !== effective.values.skipForwardSeconds
  ) {
    controller.configureRemote({
      mode: effective.values.remoteMode,
      seconds: effective.values.skipForwardSeconds,
      backwardSeconds: effective.values.skipBackwardSeconds,
      forwardSeconds: effective.values.skipForwardSeconds,
    });
  }
  if (currentRate !== effective.values.rate) {
    void controller.dispatch({
      version: 1,
      expected,
      action: "rate",
      reason: "rate-change",
      rate: effective.values.rate,
    });
  }
  return effective;
}

export function usePlaybackPreferences({
  scope,
  controller,
  book,
  active,
  isActive,
  allowLegacyMigration,
}: {
  scope: string;
  controller: PlaybackTransport;
  book: Book | null;
  active: boolean;
  /** Check refs at effect/command time; a boolean captured during render can be stale. */
  isActive?: () => boolean;
  allowLegacyMigration: boolean;
}) {
  const storage = useMemo(browserStorage, [scope]);
  const store = useMemo(
    () => new PlaybackPreferenceStore(scope, storage),
    [scope, storage],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const playback = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const liveSession = controller.getPlaybackSession();
  const context = { bookId: book?.id, seriesId: book?.seriesId };
  const latest = useRef({ scope, active, isActive, allowLegacyMigration });
  latest.current = { scope, active, isActive, allowLegacyMigration };
  const evaluatedSession = useRef<string | null>(null);
  const preserveRate = useRef<string | null>(null);
  const [preservedSession, setPreservedSession] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    // Sample/local sessions cannot claim a previous real account's unscoped value.
    // A queued lock also checks whether the account is still current when acquired.
    if (allowLegacyMigration)
      void store.migrateLegacyRemotePolicy(
        () =>
          mounted &&
          latest.current.scope === scope &&
          latest.current.allowLegacyMigration,
      );
    const changed = (event: StorageEvent) => {
      if (event.storageArea !== null && event.storageArea !== storage) return;
      if (
        event.key === null ||
        event.key === playbackPreferenceStorageKey(scope)
      )
        store.reload();
    };
    window.addEventListener("storage", changed);
    return () => {
      mounted = false;
      window.removeEventListener("storage", changed);
    };
  }, [store, storage, scope, allowLegacyMigration]);

  useEffect(() => {
    if (
      !active ||
      !book ||
      latest.current.scope !== scope ||
      latest.current.isActive?.() === false
    )
      return;
    const expected = settingsOwner(controller, store, context);
    if (!expected) return;
    const explicitRate = store.resolve(context).sources.rate.kind !== "default";
    if (evaluatedSession.current !== expected.sessionId) {
      evaluatedSession.current = expected.sessionId;
      const adopted = controller
        .getPlaybackHistory()
        .some(
          (event) =>
            event.kind === "adopt" &&
            event.session.sessionId === expected.sessionId,
        );
      preserveRate.current =
        adopted && !explicitRate ? expected.sessionId : null;
      setPreservedSession(preserveRate.current);
    } else if (explicitRate && preserveRate.current === expected.sessionId) {
      preserveRate.current = null;
      setPreservedSession(null);
    }
    applyListeningPreferences(controller, store, context, {
      preserveUnspecifiedRate: preserveRate.current === expected.sessionId,
    });
  }, [
    store,
    snapshot.document,
    controller,
    active,
    scope,
    book?.id,
    book?.seriesId,
    liveSession?.sessionId,
    playback.bookId,
    playback.fileId,
  ]);

  const resetSessionRate = useCallback(() => {
    if (
      !book ||
      !latest.current.active ||
      latest.current.scope !== scope ||
      latest.current.isActive?.() === false
    )
      return;
    const expected = settingsOwner(controller, store, {
      bookId: book.id,
      seriesId: book.seriesId,
    });
    if (!expected || preserveRate.current !== expected.sessionId) return;
    preserveRate.current = null;
    setPreservedSession(null);
    applyListeningPreferences(controller, store, {
      bookId: book.id,
      seriesId: book.seriesId,
    });
  }, [controller, store, scope, book?.id, book?.seriesId]);

  const sessionRate =
    active &&
    book &&
    preservedSession === liveSession?.sessionId &&
    settingsOwner(controller, store, context) &&
    store.resolve(context).sources.rate.kind === "default"
      ? playback.rate
      : undefined;
  return { store, sessionRate, resetSessionRate };
}
