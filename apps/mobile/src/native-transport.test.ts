import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativePlaybackTransport } from './native-transport';
import type { NativePlaybackPlugin, NativePlaybackSnapshot } from './native-playback';

const book = { bookId: 'b', fileId: 'f', title: 'Book', authors: ['Author'], tracks: [{ id: 't', url: 'https://books.test/audio', duration: 120 }], chapters: [{ id: 'c1', title: 'One', start: 0, duration: 60 }, { id: 'c2', title: 'Two', start: 60, duration: 60 }] };
function setup() {
  let scope = 'account-a';
  let listener: (value: NativePlaybackSnapshot) => void = () => {};
  let state: NativePlaybackSnapshot = { accountScope: scope, bookId: 'b', fileId: 'f', position: 0, duration: 120, rate: 1, playing: false, status: 'paused', updatedAt: new Date(0).toISOString() };
  const operations: string[] = [];
  const remove = vi.fn(async () => {});
  const plugin: NativePlaybackPlugin = {
    load: vi.fn(async () => { operations.push('load'); }),
    play: vi.fn(async () => { operations.push('play'); state = { ...state, playing: true, status: 'playing' }; }),
    pause: vi.fn(async () => { state = { ...state, playing: false, status: 'paused' }; }),
    seek: vi.fn(async ({ position }) => { state = { ...state, position }; }),
    setRate: vi.fn(async ({ rate }) => { state = { ...state, rate }; }),
    setSleepTimer: vi.fn(async () => {}), snapshot: vi.fn(async () => state), clear: vi.fn(async () => { operations.push('clear'); }),
    addListener: vi.fn(async (_, fn) => { listener = fn; return { remove }; }),
  };
  const transport = new NativePlaybackTransport(plugin, { accountScope: () => scope });
  return { transport, plugin, operations, remove, emit: (patch: Partial<NativePlaybackSnapshot>) => { state = { ...state, ...patch }; listener(state); }, account: (value: string) => { scope = value; } };
}
const transports: NativePlaybackTransport[] = [];
afterEach(() => { transports.splice(0).forEach(value => value.destroy()); vi.useRealTimers(); });
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('native authoritative playback transport', () => {
  it('serializes native load then play and uses source snapshots for seek/chapter/checkpoints', async () => {
    const { transport, operations, emit, plugin } = setup(); transports.push(transport);
    const checkpoint = vi.fn(); transport.onCheckpoint(checkpoint);
    transport.load(book); await transport.play();
    expect(operations).toEqual(['load', 'play']);
    emit({ position: 72, status: 'buffering', playing: false, updatedAt: new Date(2000).toISOString() });
    expect(transport.getSnapshot()).toMatchObject({ status: 'buffering', currentTime: 72, chapterIndex: 1 });
    expect(JSON.parse(checkpoint.mock.lastCall![0].locator)).toMatchObject({ trackId: 't', trackTime: 72, time: 72 });
    transport.skip(-30); await drain();
    expect(plugin.seek).toHaveBeenCalledWith({ position: 42 });
  });
  it('never accepts another account or a stale owner callback', async () => {
    const { transport, emit, account, plugin } = setup(); transports.push(transport);
    transport.load(book); await transport.play();
    emit({ position: 30, updatedAt: new Date(3000).toISOString() });
    emit({ position: 4, updatedAt: new Date(1000).toISOString() });
    expect(transport.getSnapshot().currentTime).toBe(30);
    account('account-b'); emit({ position: 90, updatedAt: new Date(4000).toISOString() });
    expect(transport.getSnapshot().currentTime).toBe(30);
    expect(transport.checkpoint()).toBeNull();
    transport.pause(); await drain(); expect(plugin.clear).toHaveBeenCalledOnce();
  });
  it('delegates the chapter and wall deadlines to native with no JS stop approximation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const { transport, emit, plugin } = setup(); transports.push(transport);
    transport.load(book); await transport.play();
    emit({ position: 70 }); transport.setSleepTimer({ endOfChapter: true }); await drain();
    expect(plugin.setSleepTimer).toHaveBeenLastCalledWith({ deadline: undefined, chapterEnd: 120 });
    transport.setSleepTimer({ minutes: 10 }); await drain();
    expect(plugin.setSleepTimer).toHaveBeenLastCalledWith({ deadline: 700_000, chapterEnd: undefined });
    transport.setSleepTimer(null); await drain();
    expect(transport.getSnapshot()).toMatchObject({ sleepUntil: null, sleepAtChapterEnd: null });
  });
  it('rejects unsupported sources without loading either native or browser audio', () => {
    const { transport, plugin } = setup(); transports.push(transport);
    expect(() => transport.load({ ...book, tracks: [...book.tracks, { id: 'two', url: 'https://books.test/two' }] })).toThrow('Multi-file');
    expect(() => transport.load({ ...book, tracks: [{ id: 'blob', url: 'blob:https://books.test/id' }] })).toThrow('blob URLs');
    expect(plugin.load).not.toHaveBeenCalled();
  });
  it('exposes command errors and clears its native source on teardown', async () => {
    const { transport, plugin, remove } = setup(); transports.push(transport);
    vi.mocked(plugin.load).mockRejectedValueOnce(new Error('Source access expired'));
    transport.load(book); await drain();
    expect(transport.getSnapshot()).toMatchObject({ status: 'failed', error: 'Source access expired' });
    await transport.play(); expect(plugin.play).not.toHaveBeenCalled();
    transport.destroy(); await drain();
    expect(plugin.clear).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledOnce();
  });
});
