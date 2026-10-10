import { PlaybackController, chapterAtTime, trackAtTime, trackStart, clamp, validateTimeline, type AudioCheckpoint, type PlaybackBook, type PlaybackSnapshot, type SleepTimer } from '../../../packages/playback/src';
import { createLazyPlaybackTransport } from './lazy-transport';
import { getNativePlayback, type NativePlaybackPlugin, type NativePlaybackSnapshot } from './native-playback';

/** Shared public transport shape; browser and native owners never run simultaneously. */
export type PlaybackTransport = Pick<PlaybackController, keyof PlaybackController> & {
  /** Attach to a verified live native owner without replacing its newer position or play state. */
  adoptNative?(book: PlaybackBook): Promise<boolean>;
};
export interface NativeTransportOptions { accountScope: () => string | null; readOnly?: () => boolean }

const initial: PlaybackSnapshot = { status: 'stopped', bookId: null, fileId: null, title: '', currentTime: 0, duration: 0, trackIndex: 0, chapterIndex: -1, rate: 1, sleepUntil: null, sleepAtChapterEnd: null, error: null };

/** A native owner remains authoritative while JS is suspended. No HTMLAudioElement is created. */
export class NativePlaybackTransport implements PlaybackTransport {
  private state = { ...initial };
  private book: PlaybackBook | null = null;
  private scope: string | null = null;
  private listeners = new Set<() => void>();
  private checkpoints = new Set<(value: AudioCheckpoint) => void>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private loaded = false;
  private revision = 0;
  private listener: ReturnType<NativePlaybackPlugin['addListener']>;
  private poll: ReturnType<typeof setInterval>;
  private refreshing = false;
  private lastNativeTime: string | null = null;

  constructor(private readonly plugin: NativePlaybackPlugin, private readonly options: NativeTransportOptions) {
    this.listener = plugin.addListener('checkpoint', (value) => this.accept(value));
    // Active UI progress. Background safety comes from the native service/AVPlayer, not this timer.
    this.poll = setInterval(() => { void this.refresh(); }, 1000);
    this.listener.catch(error => this.fail(error));
  }
  getSnapshot = (): PlaybackSnapshot => this.state;
  getBook = (): PlaybackBook | null => this.book;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  onCheckpoint = (fn: (value: AudioCheckpoint) => void): (() => void) => { this.checkpoints.add(fn); return () => { this.checkpoints.delete(fn); }; };

  async adoptNative(book: PlaybackBook): Promise<boolean> {
    if (this.disposed || this.book) return false;
    validateTimeline(book.tracks, book.chapters ?? []);
    const scope = this.options.accountScope();
    const revision = this.revision;
    if (!scope) return false;
    const value = await this.plugin.snapshot();
    if (this.disposed || this.book || revision !== this.revision || scope !== this.options.accountScope() || value.accountScope !== scope ||
      value.bookId !== book.bookId || value.fileId !== book.fileId || value.manifestRevision !== book.manifestRevision ||
      !value.trackIds || value.trackIds.length !== book.tracks.length || value.trackIds.some((id, index) => id !== book.tracks[index]!.id) ||
      !value.trackId || !book.tracks.some(track => track.id === value.trackId) || !Number.isFinite(value.position) || !Number.isFinite(value.duration) || !Number.isFinite(value.rate)) return false;
    this.scope = scope;
    this.book = structuredClone(book);
    this.loaded = true;
    this.lastNativeTime = null;
    this.update({ ...initial, bookId: book.bookId, fileId: book.fileId, title: book.title });
    this.accept(value);
    return true;
  }

  load(book: PlaybackBook, position = 0): void {
    if (this.disposed) throw new Error('Playback transport has been destroyed.');
    validateTimeline(book.tracks, book.chapters ?? []);
    const scope = this.options.accountScope();
    if (!scope) throw new Error('An account scope is required for native playback.');
    if (book.tracks.some(track => !/^(https?|file|content):/i.test(track.url))) throw new Error('Native playback requires a server URL or native file URL. WebView blob URLs cannot be played by the native owner.');
    this.checkpoint();
    this.loaded = false;
    this.scope = scope;
    this.book = structuredClone(book);
    const revision = ++this.revision;
    this.lastNativeTime = null;
    const rate = this.state.rate;
    const readOnly = this.options.readOnly?.() ?? true;
    const duration = book.tracks.every(track => track.duration !== undefined) ? book.tracks.reduce((sum, track) => sum + track.duration!, 0) : 0;
    this.update({ ...initial, rate, bookId: book.bookId, fileId: book.fileId, title: book.title, currentTime: Math.max(0, position), duration, trackIndex: trackAtTime(book.tracks, position).index, status: 'loading', chapterIndex: chapterAtTime(book.chapters ?? [], position) });
    this.command(async () => {
      if (revision !== this.revision) return;
      try {
        await this.plugin.load({ accountScope: scope, bookId: book.bookId, fileId: book.fileId, url: book.tracks[0]!.url, tracks: book.tracks.map(({ id, url, duration }) => ({ id, url, duration })), manifestRevision: book.manifestRevision, readOnly, title: book.title, author: book.authors.join(', '), position, rate });
        this.loaded = true;
      } catch (error) { await this.plugin.clear().catch(() => {}); throw error; }
    });
  }
  async play(): Promise<void> { await this.command(async () => { if (this.loaded) await this.plugin.play(); }); }
  pause(): void { this.command(() => this.plugin.pause()); }
  toggle(): Promise<void> | void { return this.state.status === 'playing' || this.state.status === 'loading' ? this.pause() : this.play(); }
  seek(position: number): void {
    if (!Number.isFinite(position)) return;
    this.command(() => this.plugin.seek({ position: clamp(position, 0, this.state.duration || Infinity) }));
  }
  skip(delta: number): void { this.seek(this.state.currentTime + delta); }
  goToChapter(id: string): void { const chapter = this.book?.chapters?.find(value => value.id === id); if (chapter) this.seek(chapter.start); }
  setRate(rate: number): void {
    if (!Number.isFinite(rate)) return;
    const next = clamp(rate, .5, 3);
    if (!this.book) { this.update({ rate: next }); return; }
    this.command(() => this.plugin.setRate({ rate: next }));
  }
  setSleepTimer(timer: SleepTimer): void {
    const chapter = this.book?.chapters?.[this.state.chapterIndex];
    const deadline = timer && 'minutes' in timer && Number.isFinite(timer.minutes) && timer.minutes > 0 ? Date.now() + Math.min(1440, timer.minutes) * 60_000 : undefined;
    const chapterEnd = timer && 'endOfChapter' in timer ? chapter ? chapter.start + chapter.duration : this.state.duration || undefined : undefined;
    this.command(async () => {
      await this.plugin.setSleepTimer({ deadline, chapterEnd });
      this.update({ sleepUntil: deadline ?? null, sleepAtChapterEnd: chapterEnd ?? null });
    });
  }
  checkpoint(): AudioCheckpoint | null {
    if (!this.book || this.scope !== this.options.accountScope()) return null;
    const track = this.book.tracks[this.state.trackIndex]!;
    const value: AudioCheckpoint = { bookId: this.book.bookId, fileId: this.book.fileId, kind: 'audio',
      locator: JSON.stringify({ version: 1, trackId: track.id, trackTime: Math.max(0, this.state.currentTime - trackStart(this.book.tracks, this.state.trackIndex)), time: this.state.currentTime, ...(this.book.manifestRevision ? { manifestRevision: this.book.manifestRevision } : {}) }),
      progress: this.state.duration > 0 ? clamp(this.state.currentTime / this.state.duration, 0, 1) : 0,
      updatedAt: this.lastNativeTime ?? new Date().toISOString() };
    this.checkpoints.forEach(fn => fn(value));
    return value;
  }
  destroy(): void {
    if (this.disposed) return;
    this.checkpoint();
    this.disposed = true;
    this.revision++;
    clearInterval(this.poll);
    void this.listener.then(handle => handle.remove()).catch(() => {});
    // Explicit app teardown/account transition must clear the native source too.
    void this.queue.then(() => this.plugin.clear()).catch(() => {});
    this.listeners.clear(); this.checkpoints.clear();
  }
  private command(action: () => Promise<void>): Promise<void> {
    const revision = this.revision;
    this.queue = this.queue.then(async () => {
      if (this.disposed || revision !== this.revision) return;
      if (this.scope && this.scope !== this.options.accountScope()) {
        await this.plugin.clear(); this.loaded = false; this.book = null; this.scope = null; this.update({ ...initial }); return;
      }
      await action();
      await this.refresh();
    }).catch(error => { if (!this.disposed && revision === this.revision) this.fail(error); });
    return this.queue;
  }
  private async refresh(): Promise<void> {
    if (this.disposed || this.refreshing || !this.book || !this.loaded) return;
    this.refreshing = true;
    try { this.accept(await this.plugin.snapshot()); }
    catch (error) { this.fail(error); }
    finally { this.refreshing = false; }
  }
  private accept(value: NativePlaybackSnapshot): void {
    if (this.disposed || !this.book || this.scope !== this.options.accountScope() || value.accountScope !== this.scope || value.bookId !== this.book.bookId || value.fileId !== this.book.fileId) return;
    if (!Number.isFinite(value.position) || !Number.isFinite(value.duration) || !Number.isFinite(value.rate)) return;
    if (value.manifestRevision !== undefined && value.manifestRevision !== this.book.manifestRevision) return;
    const trackIndex = value.trackId ? this.book.tracks.findIndex(track => track.id === value.trackId) : trackAtTime(this.book.tracks, value.position).index;
    if (trackIndex < 0) return;
    // Ignore stale native callbacks from a previous command/load generation.
    if (this.lastNativeTime && value.updatedAt < this.lastNativeTime) return;
    this.lastNativeTime = value.updatedAt;
    const currentTime = Math.max(0, value.position);
    const duration = Math.max(0, value.duration || this.state.duration);
    this.update({ currentTime, duration, trackIndex, rate: value.rate, chapterIndex: chapterAtTime(this.book.chapters ?? [], currentTime),
      status: value.status ?? (value.playing ? 'playing' : 'paused'), error: value.error || null,
      sleepUntil: value.sleepUntil ?? null, sleepAtChapterEnd: value.sleepAtChapterEnd ?? null });
    this.checkpoint();
  }
  private fail(error: unknown): void { if (!this.disposed) this.update({ status: 'failed', error: error instanceof Error ? error.message : String(error) }); }
  private update(value: Partial<PlaybackSnapshot>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
}

export function createPlaybackTransport(options: NativeTransportOptions): PlaybackTransport {
  return createLazyPlaybackTransport(() => {
    const native = getNativePlayback();
    return native ? new NativePlaybackTransport(native, options) : new PlaybackController();
  });
}
