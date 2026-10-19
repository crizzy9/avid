import type { PlaybackBook, PlaybackSnapshot } from './types';

/** Stable source identity. Deliberately contains no URL, credential or display metadata. */
export interface PlaybackSourceIdentity {
  accountScope: string;
  bookId: string;
  fileId: string;
  manifestRevision: string | null;
}
/** A token for this exact load/adoption, even when the same edition is loaded twice. */
export interface PlaybackSessionIdentity extends PlaybackSourceIdentity {
  version: 1;
  sessionId: string;
}
export type PlaybackReason = 'user-play' | 'user-pause' | 'user-seek' | 'user-skip' | 'chapter'
  | 'remote' | 'read-listen-handoff' | 'recovery' | 'sleep' | 'interruption' | 'source-load'
  | 'track-transition' | 'completion' | 'rate-change' | 'native-observation' | 'failure';
export interface PlaybackClock {
  version: 1;
  /** Original book/source seconds. The only clock allowed in locators, chapters and alignment. */
  sourceSeconds: number;
  playbackRate: number;
  /** Estimate only; neither a timestamp nor measured listening activity. */
  estimatedRemainingWallSeconds: number | null;
  /** No engine currently reports a measured DSP output clock. Null is not zero. */
  processedOutputSeconds: null;
  processing: 'none';
}
export function playbackClock(snapshot: Pick<PlaybackSnapshot, 'currentTime' | 'duration' | 'rate'>): PlaybackClock {
  const sourceSeconds = Number.isFinite(snapshot.currentTime) ? Math.max(0, snapshot.currentTime) : 0;
  const rate = Number.isFinite(snapshot.rate) && snapshot.rate > 0 ? snapshot.rate : 1;
  return { version: 1, sourceSeconds, playbackRate: rate,
    estimatedRemainingWallSeconds: snapshot.duration > 0 && Number.isFinite(snapshot.duration) ? Math.max(0, snapshot.duration - sourceSeconds) / rate : null,
    processedOutputSeconds: null, processing: 'none' };
}
export interface PlaybackEvent {
  version: 1;
  sequence: number;
  session: PlaybackSessionIdentity;
  kind: 'load' | 'adopt' | 'play' | 'pause' | 'seek' | 'rate' | 'status';
  reason: PlaybackReason;
  observedAt: string;
  origin: "transport" | "native-owner";
  fromSourceSeconds: number;
  toSourceSeconds: number;
  rate: number;
  status: PlaybackSnapshot['status'];
}
export interface NativeOwnerEventTail extends PlaybackSourceIdentity {
  version: 1;
  ownerId: string;
  events: { sequence: number; kind: PlaybackEvent['kind']; reason: PlaybackReason; observedAt: string;
    fromSourceSeconds: number; toSourceSeconds: number; rate: number; status: PlaybackSnapshot['status'] }[];
}
export type PlaybackCommand = { version: 1; expected: PlaybackSessionIdentity; reason: PlaybackReason } & (
  { action: 'play' | 'pause' } | { action: 'seek'; sourceSeconds: number } |
  { action: 'skip'; direction: 1 | -1 } | { action: 'rate'; rate: number } |
  { action: 'chapter'; chapterId: string }
);
/** Versioned source references for the later cross-book queue. URLs must be resolved afresh. */
export interface PlaybackQueueEntry extends PlaybackSourceIdentity { version: 1; entryId: string; addedAt: string }
export interface PlaybackQueueState { version: 1; accountScope: string; entries: PlaybackQueueEntry[]; autoplay: 'off' | 'queue' }

let fallbackId = 0;
/** Bounded, session-only command history; it is not the Phase 3 offline activity journal. */
export class PlaybackSession {
  private current: PlaybackSessionIdentity | null = null;
  private sequence = 0;
  private nativeOwnerId: string | null = null;
  private nativeSequence = 0;
  private history: PlaybackEvent[] = [];
  private listeners = new Set<(event: PlaybackEvent) => void>();
  bind(book: PlaybackBook, accountScope: string): void {
    this.current = Object.freeze({ version: 1, sessionId: globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${++fallbackId}`,
      accountScope, bookId: book.bookId, fileId: book.fileId, manifestRevision: book.manifestRevision ?? null });
    this.history = []; this.sequence = 0; this.nativeOwnerId = null; this.nativeSequence = 0;
  }
  identity(accountScope: string | null): PlaybackSessionIdentity | null {
    return this.current && this.current.accountScope === accountScope ? { ...this.current } : null;
  }
  matches(expected: PlaybackSessionIdentity, accountScope: string | null): boolean {
    const current = this.identity(accountScope);
    return !!current && expected.version === 1 && current.sessionId === expected.sessionId && current.accountScope === expected.accountScope &&
      current.bookId === expected.bookId && current.fileId === expected.fileId && current.manifestRevision === expected.manifestRevision;
  }
  subscribe = (listener: (event: PlaybackEvent) => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  events(accountScope: string | null): PlaybackEvent[] {
    return this.identity(accountScope) ? this.history.map(event => ({ ...event, session: { ...event.session } })) : [];
  }
  record(kind: PlaybackEvent['kind'], reason: PlaybackReason, before: PlaybackSnapshot, after: PlaybackSnapshot, accountScope: string | null): void {
    const session = this.identity(accountScope);
    if (!session) return;
    const event: PlaybackEvent = Object.freeze({ version: 1, sequence: ++this.sequence, session: Object.freeze(session), kind, reason,
      origin: "transport", observedAt: new Date().toISOString(), fromSourceSeconds: before.currentTime, toSourceSeconds: after.currentTime, rate: after.rate, status: after.status });
    this.append(event);
  }
  private append(event: PlaybackEvent): void {
    this.history.push(event);
    if (this.history.length > 256) this.history.shift();
    // Observers must never stop playback or prevent other observers from receiving an event.
    this.listeners.forEach(listener => { try { listener(event); } catch { /* observer owns error reporting */ } });
  }
  /** Replay only a bounded, exact-source owner tail; duplicate polls never duplicate history. */
  importNative(tail: NativeOwnerEventTail | undefined, accountScope: string | null): void {
    const session = this.identity(accountScope);
    if (!tail || !session || tail.version !== 1 || typeof tail.ownerId !== 'string' || !tail.ownerId || tail.ownerId.length > 200 ||
      tail.accountScope !== session.accountScope || tail.bookId !== session.bookId || tail.fileId !== session.fileId ||
      tail.manifestRevision !== session.manifestRevision || !Array.isArray(tail.events) || tail.events.length > 64) return;
    const kinds = ['load','adopt','play','pause','seek','rate','status'];
    const reasons = ['source-load','native-observation','user-play','user-pause','user-seek','remote','rate-change','sleep','interruption','track-transition','completion','failure','recovery'];
    let previous = 0;
    for (const event of tail.events) {
      if (!event || typeof event !== "object" || !Number.isSafeInteger(event.sequence) || event.sequence <= previous || !kinds.includes(event.kind) || !reasons.includes(event.reason) ||
        !['stopped','loading','playing','paused','buffering','interrupted','failed'].includes(event.status) ||
        !Number.isFinite(event.fromSourceSeconds) || event.fromSourceSeconds < 0 || !Number.isFinite(event.toSourceSeconds) || event.toSourceSeconds < 0 ||
        !Number.isFinite(event.rate) || event.rate < .5 || event.rate > 3 || typeof event.observedAt !== 'string' || !Number.isFinite(Date.parse(event.observedAt))) return;
      previous = event.sequence;
    }
    if (tail.ownerId !== this.nativeOwnerId) { this.nativeOwnerId = tail.ownerId; this.nativeSequence = 0; }
    for (const event of tail.events) if (event.sequence > this.nativeSequence) {
      this.append(Object.freeze({ ...event, version: 1, sequence: ++this.sequence, session: Object.freeze({...session}), origin: 'native-owner' }));
      this.nativeSequence = event.sequence;
    }
  }
  clear(): void { this.current = null; this.history = []; this.listeners.clear(); }
}
export type PlaybackEngine = 'browser' | 'desktop-webview' | 'ios-avqueue' | 'android-media3';
/** Implementation facts, not installed-device certification or server capabilities. */
export function playbackEngineCapabilities(engine: PlaybackEngine) {
  return { version: 1 as const, engine, rate: { min: .5, max: 3 }, sourceClock: true as const,
    independentBackgroundOwner: engine === 'ios-avqueue' || engine === 'android-media3',
    independentSkipIntervals: true as const, processing: false as const,
    gapless: 'unqualified' as const, physicalDeviceQualified: false as const };
}
