import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackController, audioAtTextLocator, canBridgeAudio, textAtAudioTime, trackAtTime, validateAlignment, validateTimeline } from '../src';
import type { AlignmentMap, AudioCheckpoint, AudioElement, PlaybackBook } from '../src';

class FakeAudio extends EventTarget {
  src = ''; currentTime = 0; duration = 120; playbackRate = 1; preservesPitch = true;
  paused = true; ended = false; error = null; preload = '';
  play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('playing')); });
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')); });
  load = vi.fn(); removeAttribute = vi.fn();
  emit(name: string) { this.dispatchEvent(new Event(name)); }
}

const book: PlaybackBook = { bookId: 'book-1', fileId: 'audio-1', title: 'Test audiobook', authors: ['A Reader'],
  tracks: [{ id: 'track-1', url: '/one.mp3', duration: 120 }, { id: 'track-2', url: '/two.mp3', duration: 180 }],
  chapters: [{ id: 'ch1', title: 'One', start: 0, duration: 60 }, { id: 'ch2', title: 'Two', start: 60, duration: 240 }] };

const active: PlaybackController[] = [];
function setup() {
  const audio = new FakeAudio();
  const checkpoints: AudioCheckpoint[] = [];
  const controller = new PlaybackController({ audio: audio as unknown as AudioElement, mediaSession: null,
    persistCheckpoint: checkpoint => checkpoints.push(checkpoint) });
  active.push(controller);
  controller.load(book);
  audio.emit('loadedmetadata');
  return { audio, controller, checkpoints };
}
afterEach(() => { active.splice(0).forEach(controller => controller.destroy()); vi.useRealTimers(); });

describe('source timeline and transport', () => {
  it('resolves exact track boundaries and clamps overshoots', () => {
    expect(trackAtTime(book.tracks, 120)).toEqual({ index: 1, offset: 0 });
    expect(trackAtTime(book.tracks, 145)).toEqual({ index: 1, offset: 25 });
    expect(trackAtTime(book.tracks, 999)).toEqual({ index: 1, offset: 180 });
    expect(() => validateTimeline([{ id: 'a', url: 'a' }, { id: 'b', url: 'b' }], [])).toThrow(/durations/);
  });
  it('preserves track-relative checkpoints after a cross-track seek', () => {
    const { audio, controller, checkpoints } = setup();
    controller.seek(145);
    audio.duration = 180;
    audio.emit('loadedmetadata');
    expect(audio.src).toBe('/two.mp3');
    expect(audio.currentTime).toBe(25);
    controller.pause();
    expect(JSON.parse(checkpoints.at(-1)!.locator)).toEqual({ version: 1, trackId: 'track-2', trackTime: 25, time: 145 });
    expect(checkpoints.at(-1)!.progress).toBeCloseTo(145 / 300);
  });
  it('advances tracks while preserving the rate and playback state', async () => {
    const { audio, controller } = setup();
    controller.setRate(1.75);
    await controller.play();
    audio.currentTime = 120;
    audio.emit('ended');
    await Promise.resolve();
    expect(audio.src).toBe('/two.mp3');
    expect(controller.getSnapshot()).toMatchObject({ currentTime: 120, rate: 1.75, trackIndex: 1, status: 'playing' });
  });
  it('stops at the originally selected chapter end, including a skipped boundary', async () => {
    const { audio, controller } = setup();
    controller.setSleepTimer({ endOfChapter: true });
    await controller.play();
    audio.currentTime = 62;
    audio.emit('timeupdate');
    expect(controller.getSnapshot()).toMatchObject({ status: 'paused', currentTime: 60, sleepAtChapterEnd: null });
    expect(audio.currentTime).toBe(60);
  });
  it('does not advance tracks when chapter-end sleep expires at a track boundary', async () => {
    const { audio, controller } = setup();
    controller.load({ ...book, chapters: [{ id: 'end', title: 'End', start: 0, duration: 120 }] });
    audio.emit('loadedmetadata');
    controller.setSleepTimer({ endOfChapter: true });
    await controller.play();
    audio.currentTime = 120;
    audio.emit('ended');
    expect(controller.getSnapshot()).toMatchObject({ status: 'paused', trackIndex: 0 });
  });
  it('expires a wall-clock sleep timer without waiting for timeupdate', async () => {
    vi.useFakeTimers();
    const { controller } = setup();
    await controller.play();
    controller.setSleepTimer({ minutes: 1 });
    vi.advanceTimersByTime(60_000);
    expect(controller.getSnapshot()).toMatchObject({ status: 'paused', sleepUntil: null });
  });
  it('keeps an old asynchronous play rejection from failing the next book', async () => {
    const { audio, controller } = setup();
    let reject!: (reason: Error) => void;
    audio.play.mockImplementationOnce(() => new Promise<void>((_, rejectPromise) => { reject = rejectPromise; }));
    const pending = controller.play();
    controller.load({ ...book, bookId: 'new-book' });
    reject(new Error('Old request aborted'));
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ bookId: 'new-book', status: 'loading', error: null });
  });
  it('distinguishes a browser interruption from an explicit pause', async () => {
    const { audio, controller } = setup();
    await controller.play();
    audio.pause();
    expect(controller.getSnapshot().status).toBe('interrupted');
    await controller.toggle();
    expect(controller.getSnapshot().status).toBe('playing');
  });
  it('does not clamp a resume position to an incomplete total duration', () => {
    const { audio, controller } = setup();
    controller.load({ ...book, tracks: [book.tracks[0]!, { id: 'track-2', url: '/two.mp3' }] }, 145);
    expect(controller.getSnapshot()).toMatchObject({ duration: 0, currentTime: 145, trackIndex: 1 });
    audio.duration = 180;
    audio.emit('loadedmetadata');
    expect(controller.getSnapshot()).toMatchObject({ duration: 300, currentTime: 145 });
  });
});

describe('real alignment maps', () => {
  const map: AlignmentMap = { version: 'fixture-v1', source: 'epub-media-overlay', textFileId: 'epub', audioFileId: 'audio',
    segments: [
      { id: 'a', textFileId: 'epub', audioFileId: 'audio', textLocator: 'chapter.xhtml#s1', start: 0, end: 4 },
      { id: 'b', textFileId: 'epub', audioFileId: 'audio', textLocator: 'chapter.xhtml#s2', start: 5, end: 9 },
    ] };
  it('finds exact source ranges and leaves unaligned gaps unlinked', () => {
    validateAlignment(map);
    expect(textAtAudioTime(map, 2)?.id).toBe('a');
    expect(textAtAudioTime(map, 4)).toBeNull();
    expect(textAtAudioTime(map, 5)?.id).toBe('b');
    expect(audioAtTextLocator(map, 'epub', 'chapter.xhtml#s2')?.start).toBe(5);
    expect(audioAtTextLocator(map, 'wrong-edition', 'chapter.xhtml#s2')).toBeNull();
  });
  it('rejects overlapping ranges and mismatched editions', () => {
    expect(() => validateAlignment({ ...map, segments: [map.segments[0]!, { ...map.segments[1]!, start: 3 }] })).toThrow();
    expect(() => validateAlignment({ ...map, audioFileId: 'other-edition' })).toThrow();
  });
  it('requires both durations and applies the smaller of 5 percent or 5 minutes', () => {
    expect(canBridgeAudio(1_000, 1_049)).toBe(true);
    expect(canBridgeAudio(1_000, 1_051)).toBe(false);
    expect(canBridgeAudio(10_000, 10_301)).toBe(false);
    expect(canBridgeAudio(0, 0)).toBe(false);
  });
});
