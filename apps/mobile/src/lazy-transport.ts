import type { AudioCheckpoint, PlaybackBook, PlaybackSnapshot, SleepTimer } from '../../../packages/playback/src';
import type { PlaybackTransport } from './native-transport';

const empty: PlaybackSnapshot = Object.freeze({ status: 'stopped', bookId: null, fileId: null, title: '', currentTime: 0, duration: 0, trackIndex: 0, chapterIndex: -1, rate: 1, sleepUntil: null, sleepAtChapterEnd: null, error: null });

/** Render-safe facade: abandoned React StrictMode initializers allocate no audio, listener, or timer. */
export function createLazyPlaybackTransport(factory: () => PlaybackTransport): PlaybackTransport {
  let owner: PlaybackTransport | null = null;
  let destroyed = false;
  const active = (): PlaybackTransport => {
    if (destroyed) throw new Error('Playback transport has been destroyed.');
    return owner ??= factory();
  };
  return {
    getSnapshot: () => owner?.getSnapshot() ?? empty,
    getBook: () => owner?.getBook() ?? null,
    getRemotePolicy: () => active().getRemotePolicy(),
    configureRemote: policy => active().configureRemote(policy),
    remoteSkip: direction => active().remoteSkip(direction),
    subscribe: (listener: () => void) => active().subscribe(listener),
    onCheckpoint: (listener: (value: AudioCheckpoint) => void) => active().onCheckpoint(listener),
    load: (book: PlaybackBook, position?: number) => active().load(book, position),
    adoptNative: (book: PlaybackBook) => active().adoptNative?.(book) ?? Promise.resolve(false),
    play: () => active().play(),
    pause: () => owner?.pause(),
    toggle: () => active().toggle(),
    seek: (seconds: number) => active().seek(seconds),
    skip: (delta: number) => active().skip(delta),
    goToChapter: (id: string) => active().goToChapter(id),
    setRate: (rate: number) => active().setRate(rate),
    setSleepTimer: (timer: SleepTimer) => active().setSleepTimer(timer),
    checkpoint: () => owner?.checkpoint() ?? null,
    destroy: () => { if (!destroyed) { destroyed = true; owner?.destroy(); } },
  };
}
