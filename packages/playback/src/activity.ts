export type AudioActivityKind = 'listening' | 'speech';

export interface ActivitySession {
  id: string;
  bookId: string;
  kind: AudioActivityKind;
  startedAt: string;
  /** Actual active seconds, not source-audio seconds at an accelerated rate. */
  duration: number;
}

export interface ActivityChunk {
  session: ActivitySession;
  fileId: string;
  endedAt: string;
}

export interface ActivityObservation {
  bookId: string | null;
  fileId: string | null;
  kind: AudioActivityKind;
  active: boolean;
  /** Supply the real source clock for audio. Omit only for speech without a media clock. */
  position?: number;
  rate?: number;
}

interface Measurement { position?: number; rate: number; monotonicMs: number; wallMs: number }
interface ActivityGroup {
  bookId: string; fileId: string; kind: AudioActivityKind;
  startedWallMs: number; endedWallMs: number; activeMs: number;
}

/**
 * Accounts only new source-clock advancement. Repeated snapshots never add time.
 * Speech without a source clock counts observed active intervals, dropping long
 * unobserved gaps instead of treating a suspended JavaScript runtime as activity.
 */
export class ActivityAccumulator {
  private previous: ActivityObservation | null = null;
  private measurement: Measurement | null = null;
  private group: ActivityGroup | null = null;
  private readonly makeId: () => string;
  private readonly maxSpeechGapMs: number;

  constructor(options: { makeId?: () => string; maxSpeechGapMs?: number } = {}) {
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.maxSpeechGapMs = options.maxSpeechGapMs ?? 2_500;
  }

  observe(sample: ActivityObservation, monotonicMs: number, wallMs: number): ActivityChunk[] {
    if (!Number.isFinite(monotonicMs) || !Number.isFinite(wallMs)) throw new Error('Activity clocks must be finite.');
    const ready: ActivityChunk[] = [];
    const sameIdentity = this.previous?.bookId === sample.bookId && this.previous?.fileId === sample.fileId && this.previous?.kind === sample.kind;
    if (!sameIdentity) {
      ready.push(...this.flush());
      // Less than one second is deliberately not turned into a fabricated whole second.
      this.group = null;
      this.measurement = null;
    }
    if (!sample.bookId || !sample.fileId) {
      this.previous = sample;
      return ready;
    }
    const rate = Number.isFinite(sample.rate) && sample.rate! > 0 ? sample.rate! : 1;
    const position = Number.isFinite(sample.position) ? sample.position : undefined;
    const next: Measurement = { position, rate, monotonicMs, wallMs };
    if (sameIdentity && this.previous?.active && this.measurement) {
      const base = this.measurement;
      const elapsed = Math.max(0, monotonicMs - base.monotonicMs);
      let activeMs = 0;
      if (position != null && base.position != null) {
        const advance = position - base.position;
        // Seeks are discontinuities, never evidence of listening. Permit ordinary
        // media timestamp quantization but cap credit by real elapsed time.
        if (advance > 0 && advance <= elapsed / 1000 * base.rate + 0.5) {
          activeMs = Math.min(elapsed, advance / base.rate * 1000);
        }
        // Retain the measurement when a repeated snapshot has no new source time.
        // Reset at state/rate changes and every actual movement (including seeks).
        if (advance !== 0 || rate !== base.rate || !sample.active) this.measurement = next;
      } else {
        if (elapsed <= this.maxSpeechGapMs) activeMs = elapsed;
        this.measurement = next;
      }
      if (activeMs > 0) {
        this.group ??= { bookId: sample.bookId, fileId: sample.fileId, kind: sample.kind,
          startedWallMs: base.wallMs, endedWallMs: wallMs, activeMs: 0 };
        this.group.activeMs += activeMs;
        this.group.endedWallMs = wallMs;
      }
    } else this.measurement = next;
    this.previous = { ...sample };
    if (!sample.active) ready.push(...this.flush());
    return ready;
  }

  /** Whole-second immutable chunks; a fractional remainder carries to the next flush. */
  flush(): ActivityChunk[] {
    if (!this.group) return [];
    const duration = Math.floor((this.group.activeMs + 0.0001) / 1000);
    if (duration < 1) return [];
    const group = this.group;
    const chunk: ActivityChunk = {
      session: { id: this.makeId(), bookId: group.bookId, kind: group.kind,
        startedAt: new Date(group.startedWallMs).toISOString(), duration },
      fileId: group.fileId,
      endedAt: new Date(group.endedWallMs).toISOString(),
    };
    group.activeMs = Math.max(0, group.activeMs - duration * 1000);
    group.startedWallMs = group.endedWallMs - group.activeMs;
    return [chunk];
  }
}

export type ActivityRecorder = (session: ActivitySession, fileId: string, options?: { endedAt: string }) => Promise<void>;
export interface ActivityJournal {
  read(): ActivityChunk[];
  append(chunks: ActivityChunk[]): void;
  acknowledge(ids: string[]): void;
}

export class ActivitySessionTracker {
  readonly accumulator: ActivityAccumulator;
  private pending = new Map<string, ActivityChunk>();
  private inFlight: Promise<void> | null = null;
  private readonly record: ActivityRecorder;
  private readonly journal?: ActivityJournal;
  private readonly onError?: (error: Error) => void;

  constructor(record: ActivityRecorder, options: { journal?: ActivityJournal; onError?: (error: Error) => void; makeId?: () => string } = {}) {
    this.record = record;
    this.journal = options.journal;
    this.onError = options.onError;
    this.accumulator = new ActivityAccumulator({ makeId: options.makeId });
    try { this.journal?.read().forEach(chunk => this.pending.set(chunk.session.id, chunk)); }
    catch (error) { this.report(error); }
  }

  observe(sample: ActivityObservation, monotonicMs: number, wallMs: number): void {
    this.enqueue(this.accumulator.observe(sample, monotonicMs, wallMs));
  }
  get pendingCount(): number { return this.pending.size; }

  /** Serializes writes, preserving chunk IDs on failure and concurrent flushes. */
  flush(): Promise<void> {
    this.enqueue(this.accumulator.flush());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drain().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private enqueue(chunks: ActivityChunk[]): void {
    if (!chunks.length) return;
    chunks.forEach(chunk => this.pending.set(chunk.session.id, chunk));
    try { this.journal?.append(chunks); } catch (error) { this.report(error); }
  }
  private async drain(): Promise<void> {
    for (const [id, chunk] of this.pending) {
      try {
        await this.record(chunk.session, chunk.fileId, { endedAt: chunk.endedAt });
      } catch (error) { this.report(error); return; }
      // The repository callback must deduplicate immutable session IDs. If a page
      // closes after repository commit but before journal acknowledgement, recovery
      // submits the same ID and payload, never a fresh copy of that activity.
      try { this.journal?.acknowledge([id]); } catch (error) { this.report(error); }
      this.pending.delete(id);
    }
  }
  private report(error: unknown): void { this.onError?.(error instanceof Error ? error : new Error(String(error))); }
}

/** Merge/acknowledge by ID so a StrictMode remount cannot erase another instance's new chunks. */
export function createActivityJournal(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, accountScope: string): ActivityJournal {
  if (!accountScope) throw new Error('Account scope is required for activity recovery.');
  const key = `avid:pending-playback:v1:${encodeURIComponent(accountScope)}`;
  const read = (): ActivityChunk[] => {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isActivityChunk)) throw new Error('Saved playback activity is invalid and was not replayed.');
    return parsed;
  };
  const write = (chunks: ActivityChunk[]) => {
    if (chunks.length) storage.setItem(key, JSON.stringify(chunks));
    else storage.removeItem(key);
  };
  return {
    read,
    append(chunks) {
      const merged = new Map(read().map(chunk => [chunk.session.id, chunk]));
      chunks.forEach(chunk => merged.set(chunk.session.id, chunk));
      write([...merged.values()]);
    },
    acknowledge(ids) {
      const acknowledged = new Set(ids);
      write(read().filter(chunk => !acknowledged.has(chunk.session.id)));
    },
  };
}

function isActivityChunk(value: unknown): value is ActivityChunk {
  if (!value || typeof value !== 'object') return false;
  const chunk = value as ActivityChunk;
  return typeof chunk.fileId === 'string' && !!chunk.fileId && typeof chunk.endedAt === 'string' && Number.isFinite(Date.parse(chunk.endedAt)) &&
    !!chunk.session && typeof chunk.session.id === 'string' && !!chunk.session.id && typeof chunk.session.bookId === 'string' && !!chunk.session.bookId &&
    (chunk.session.kind === 'listening' || chunk.session.kind === 'speech') &&
    typeof chunk.session.startedAt === 'string' && Number.isFinite(Date.parse(chunk.session.startedAt)) &&
    Number.isSafeInteger(chunk.session.duration) && chunk.session.duration > 0 && Date.parse(chunk.endedAt) >= Date.parse(chunk.session.startedAt);
}
