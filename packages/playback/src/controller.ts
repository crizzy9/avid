import { chapterAtTime, clamp, trackAtTime, trackStart, validateTimeline } from './timeline';
import type { AudioCheckpoint, AudioElement, AudioLocator, PlaybackBook, PlaybackOptions, PlaybackSnapshot, SleepTimer } from './types';

const initial: PlaybackSnapshot = {
  status: 'stopped', bookId: null, fileId: null, title: '', currentTime: 0,
  duration: 0, trackIndex: 0, chapterIndex: -1, rate: 1,
  sleepUntil: null, sleepAtChapterEnd: null, error: null,
};

/** Browser transport. It intentionally makes no promise about suspended WebViews. */
export class PlaybackController {
  private readonly audio: AudioElement;
  private readonly media: MediaSession | null;
  private readonly options: PlaybackOptions;
  private snapshot: PlaybackSnapshot;
  private book: PlaybackBook | null = null;
  private listeners = new Set<() => void>();
  private checkpointListeners = new Set<(checkpoint: AudioCheckpoint) => void>();
  private events: Array<[string, EventListener]> = [];
  private sleepTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastCheckpoint = 0;
  private pendingSeek: number | null = null;
  private wantPlayback = false;
  private disposed = false;
  private generation = 0;

  constructor(options: PlaybackOptions = {}) {
    this.options = options;
    this.audio = options.audio ?? new Audio();
    this.media = options.mediaSession !== undefined ? options.mediaSession :
      (typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null);
    this.snapshot = { ...initial, rate: clamp(options.preferredRate ?? 1, 0.5, 3) };
    this.audio.preload = 'metadata';
    this.audio.preservesPitch = true;
    this.listen('loadedmetadata', () => this.metadataLoaded());
    this.listen('durationchange', () => this.updateDuration());
    this.listen('timeupdate', () => this.timeUpdated());
    this.listen('playing', () => {
      if (this.wantPlayback) this.update({ status: 'playing', error: null });
      else this.audio.pause();
    });
    this.listen('waiting', () => { if (this.wantPlayback) this.update({ status: 'buffering' }); });
    this.listen('stalled', () => { if (this.wantPlayback) this.update({ status: 'buffering' }); });
    this.listen('pause', () => {
      if (this.wantPlayback && !this.audio.ended && this.snapshot.status !== 'loading') {
        this.wantPlayback = false;
        this.update({ status: 'interrupted' });
        this.checkpoint();
        return;
      }
      if (!this.wantPlayback && this.book) {
        this.update({ status: 'paused' });
        this.checkpoint();
      }
    });
    this.listen('ended', () => this.ended());
    this.listen('error', () => {
      this.wantPlayback = false;
      const code = this.audio.error?.code;
      this.update({ status: 'failed', error: code === 4 ? 'This audio format or source is not supported by this browser.' :
        code === 2 ? 'Audio could not be loaded. Check the connection and server access.' : 'Audio playback failed. Try loading the file again.' });
      this.checkpoint();
    });
    this.bindMediaSession();
  }

  getSnapshot = (): PlaybackSnapshot => this.snapshot;
  getBook = (): PlaybackBook | null => this.book;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  onCheckpoint = (listener: (checkpoint: AudioCheckpoint) => void): (() => void) => {
    this.checkpointListeners.add(listener);
    return () => { this.checkpointListeners.delete(listener); };
  };

  load(book: PlaybackBook, position = 0): void {
    this.ensureActive();
    validateTimeline(book.tracks, book.chapters ?? []);
    this.checkpoint();
    this.generation++;
    this.wantPlayback = false;
    this.audio.pause();
    this.setSleepTimer(null);
    this.book = { ...book, tracks: book.tracks.map(track => ({ ...track })), chapters: book.chapters?.map(chapter => ({ ...chapter })) };
    const duration = this.totalDuration();
    const time = clamp(position, 0, duration || Infinity);
    const target = trackAtTime(this.book.tracks, time);
    this.update({ ...initial, rate: this.snapshot.rate, status: 'loading', bookId: book.bookId,
      fileId: book.fileId, title: book.title, duration, currentTime: time,
      trackIndex: target.index, chapterIndex: chapterAtTime(book.chapters ?? [], time) });
    this.changeTrack(target.index, target.offset);
    if (this.media && typeof MediaMetadata !== 'undefined') {
      this.media.metadata = new MediaMetadata({ title: book.title, artist: book.authors.join(', '), album: 'Avid',
        artwork: book.coverUrl ? [{ src: book.coverUrl }] : [] });
    }
  }

  async play(): Promise<void> {
    this.ensureActive();
    if (!this.book) return;
    this.wantPlayback = true;
    const generation = this.generation;
    this.update({ status: 'loading', error: null });
    try {
      await this.audio.play();
      if (generation === this.generation && this.wantPlayback) this.update({ status: 'playing' });
    } catch (error) {
      if (generation !== this.generation || !this.wantPlayback) return;
      this.wantPlayback = false;
      this.update({ status: 'failed', error: error instanceof Error ? error.message : 'Audio could not start.' });
    }
  }

  pause(): void {
    if (this.disposed) return;
    this.wantPlayback = false;
    this.audio.pause();
    if (this.book) this.update({ status: 'paused' });
    this.checkpoint();
  }

  toggle(): Promise<void> | void { return this.wantPlayback ? this.pause() : this.play(); }

  seek(seconds: number): void {
    if (!this.book || this.disposed) return;
    const time = clamp(seconds, 0, this.snapshot.duration || Infinity);
    const target = trackAtTime(this.book.tracks, time);
    this.update({ currentTime: time, chapterIndex: chapterAtTime(this.book.chapters ?? [], time) });
    if (target.index !== this.snapshot.trackIndex) {
      this.changeTrack(target.index, target.offset);
      if (this.wantPlayback) void this.play();
    } else {
      // Metadata may not yet exist when a resume seek arrives.
      this.pendingSeek = target.offset;
      try { this.audio.currentTime = target.offset; this.pendingSeek = null; } catch { /* applied on metadata */ }
    }
    this.enforceSleep();
    this.checkpoint();
  }

  skip(delta: number): void { this.seek(this.snapshot.currentTime + delta); }
  goToChapter(id: string): void {
    const chapter = this.book?.chapters?.find(candidate => candidate.id === id);
    if (chapter) this.seek(chapter.start);
  }

  setRate(rate: number): void {
    const next = clamp(rate, 0.5, 3);
    this.audio.playbackRate = next;
    this.update({ rate: next });
  }

  setSleepTimer(timer: SleepTimer): void {
    if (this.sleepTimeout) clearTimeout(this.sleepTimeout);
    this.sleepTimeout = null;
    let sleepUntil: number | null = null;
    let sleepAtChapterEnd: number | null = null;
    if (timer && 'minutes' in timer && Number.isFinite(timer.minutes) && timer.minutes > 0) {
      sleepUntil = Date.now() + Math.min(timer.minutes, 24 * 60) * 60_000;
      this.sleepTimeout = setTimeout(() => this.finishSleep(), sleepUntil - Date.now());
    } else if (timer && 'endOfChapter' in timer) {
      const chapter = this.book?.chapters?.[this.snapshot.chapterIndex];
      sleepAtChapterEnd = chapter ? chapter.start + chapter.duration : this.snapshot.duration || null;
    }
    this.update({ sleepUntil, sleepAtChapterEnd });
  }

  /** Persist on pagehide/account change; caller owns the account-scoped journal. */
  checkpoint(): AudioCheckpoint | null {
    if (!this.book) return null;
    const track = this.book.tracks[this.snapshot.trackIndex]!;
    const locator: AudioLocator = { version: 1, trackId: track.id,
      trackTime: Math.max(0, this.snapshot.currentTime - trackStart(this.book.tracks, this.snapshot.trackIndex)), time: this.snapshot.currentTime };
    const checkpoint: AudioCheckpoint = {
      bookId: this.book.bookId, fileId: this.book.fileId, kind: 'audio',
      locator: JSON.stringify(locator), progress: this.snapshot.duration ? clamp(this.snapshot.currentTime / this.snapshot.duration, 0, 1) : 0,
      updatedAt: new Date().toISOString(),
    };
    this.lastCheckpoint = Date.now();
    this.options.persistCheckpoint?.(checkpoint);
    this.checkpointListeners.forEach(listener => listener(checkpoint));
    return checkpoint;
  }

  destroy(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    this.generation++;
    if (this.sleepTimeout) clearTimeout(this.sleepTimeout);
    this.events.forEach(([type, handler]) => this.audio.removeEventListener(type, handler));
    this.audio.removeAttribute('src');
    this.audio.load();
    this.listeners.clear();
    this.checkpointListeners.clear();
    if (this.media) {
      for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'] as MediaSessionAction[]) {
        try { this.media.setActionHandler(action, null); } catch { /* engine lacks this action */ }
      }
      this.media.metadata = null;
      this.media.playbackState = 'none';
    }
  }

  private ensureActive(): void { if (this.disposed) throw new Error('Playback controller has been destroyed.'); }
  private listen(type: string, callback: () => void): void {
    const handler: EventListener = callback;
    this.audio.addEventListener(type, handler);
    this.events.push([type, handler]);
  }
  private update(patch: Partial<PlaybackSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.media) {
      this.media.playbackState = this.snapshot.status === 'playing' ? 'playing' : this.book ? 'paused' : 'none';
      if (this.snapshot.duration > 0) {
        try { this.media.setPositionState({ duration: this.snapshot.duration, playbackRate: this.snapshot.rate,
          position: clamp(this.snapshot.currentTime, 0, this.snapshot.duration) }); } catch { /* engine lacks position reporting */ }
      }
    }
    this.listeners.forEach(listener => listener());
  }
  private changeTrack(index: number, offset: number): void {
    if (!this.book) return;
    this.pendingSeek = offset;
    this.update({ trackIndex: index, status: 'loading' });
    this.audio.src = this.book.tracks[index]!.url;
    this.audio.playbackRate = this.snapshot.rate;
    this.audio.load();
  }
  private metadataLoaded(): void {
    this.updateDuration();
    if (this.pendingSeek != null) {
      this.audio.currentTime = clamp(this.pendingSeek, 0, Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity);
      this.pendingSeek = null;
    }
    this.audio.playbackRate = this.snapshot.rate;
    if (!this.wantPlayback) this.update({ status: 'paused' });
    this.timeUpdated();
  }
  private updateDuration(): void {
    if (!this.book || !Number.isFinite(this.audio.duration) || this.audio.duration <= 0) return;
    this.book.tracks[this.snapshot.trackIndex]!.duration = this.audio.duration;
    this.update({ duration: this.totalDuration() });
  }
  private totalDuration(): number {
    if (!this.book || this.book.tracks.some(track => track.duration == null)) return 0;
    return this.book.tracks.reduce((sum, track) => sum + track.duration!, 0);
  }
  private timeUpdated(): void {
    if (!this.book || this.pendingSeek != null) return;
    const time = trackStart(this.book.tracks, this.snapshot.trackIndex) + this.audio.currentTime;
    this.update({ currentTime: time, chapterIndex: chapterAtTime(this.book.chapters ?? [], time) });
    this.enforceSleep();
    if (Date.now() - this.lastCheckpoint >= 5_000) this.checkpoint();
  }
  private enforceSleep(): void {
    if ((this.snapshot.sleepUntil != null && Date.now() >= this.snapshot.sleepUntil) ||
      (this.snapshot.sleepAtChapterEnd != null && this.snapshot.currentTime >= this.snapshot.sleepAtChapterEnd)) this.finishSleep();
  }
  private finishSleep(): void {
    const boundary = this.snapshot.sleepAtChapterEnd;
    this.setSleepTimer(null);
    this.pause();
    if (boundary != null && this.snapshot.currentTime > boundary) this.seek(boundary);
  }
  private ended(): void {
    if (!this.book) return;
    this.timeUpdated();
    const next = this.snapshot.trackIndex + 1;
    if (this.wantPlayback && next < this.book.tracks.length) {
      this.update({ currentTime: trackStart(this.book.tracks, next) });
      this.changeTrack(next, 0);
      void this.play();
    } else {
      this.wantPlayback = false;
      this.update({ status: 'paused' });
      this.checkpoint();
    }
  }
  private bindMediaSession(): void {
    if (!this.media) return;
    const skip = this.options.skipSeconds ?? 30;
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { void this.play(); }, pause: () => this.pause(), stop: () => this.pause(),
      seekbackward: details => this.skip(-(details.seekOffset ?? skip)),
      seekforward: details => this.skip(details.seekOffset ?? skip),
      seekto: details => { if (details.seekTime != null) this.seek(details.seekTime); },
      previoustrack: () => {
        const chapters = this.book?.chapters ?? [];
        const current = chapters[this.snapshot.chapterIndex];
        this.seek(current && this.snapshot.currentTime - current.start > 3 ? current.start : chapters[Math.max(0, this.snapshot.chapterIndex - 1)]?.start ?? 0);
      },
      nexttrack: () => {
        const next = this.book?.chapters?.[this.snapshot.chapterIndex + 1];
        if (next) this.seek(next.start); else this.skip(skip);
      },
    };
    for (const [action, handler] of Object.entries(actions)) {
      try { this.media.setActionHandler(action as MediaSessionAction, handler!); } catch { /* optional OS action */ }
    }
  }
}
