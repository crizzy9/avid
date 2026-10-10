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
    expect(() => transport.load({ ...book, tracks: [{ id: 'one', url: 'https://books.test/one' }, { id: 'two', url: 'https://books.test/two' }] })).toThrow('Track durations');
    expect(() => transport.load({ ...book, tracks: [{ id: 'blob', url: 'blob:https://books.test/id' }] })).toThrow('blob URLs');
    expect(plugin.load).not.toHaveBeenCalled();
  });
  it('hands the complete queue to native and preserves boundary source identity, revision, seek and rate', async () => {
    const { transport, plugin, emit } = setup(); transports.push(transport);
    const queue = { ...book, manifestRevision: 'edition-2', tracks: [{ id: 'one', url: 'https://books.test/one', duration: 60 }, { id: 'two', url: 'https://books.test/two', duration: 60 }] };
    transport.load(queue, 58); await transport.play();
    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ tracks: queue.tracks, manifestRevision: 'edition-2', fileId: 'f', position: 58 }));
    emit({ position: 62, trackId: 'two', trackIndex: 1, trackTime: 2, manifestRevision: 'edition-2', updatedAt: new Date(5000).toISOString() });
    expect(transport.getSnapshot()).toMatchObject({ currentTime: 62, trackIndex: 1, chapterIndex: 1 });
    expect(JSON.parse(transport.checkpoint()!.locator)).toEqual({ version: 1, trackId: 'two', trackTime: 2, time: 62, manifestRevision: 'edition-2' });
    emit({ position: 90, manifestRevision: 'old-edition', updatedAt: new Date(6000).toISOString() });
    expect(transport.getSnapshot().currentTime).toBe(62);
    transport.seek(30); transport.setRate(1.7); transport.setSleepTimer({ endOfChapter: true }); await drain();
    expect(plugin.seek).toHaveBeenCalledWith({ position: 30 });
    expect(plugin.setRate).toHaveBeenCalledWith({ rate: 1.7 });
    expect(plugin.setSleepTimer).toHaveBeenCalledWith({ deadline: undefined, chapterEnd: 120 });
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
  it('adopts the live native owner without loading, seeking, playing or losing native sleep state', async () => {
    const { transport, plugin, emit } = setup(); transports.push(transport);
    emit({ position: 88, trackId: 't', trackIds: ['t'], trackTime: 88, playing: true, status: 'playing', rate: 1.6, sleepAtChapterEnd: 120, updatedAt: new Date(9000).toISOString() });
    expect(await transport.adoptNative(book)).toBe(true);
    expect(transport.getSnapshot()).toMatchObject({ currentTime: 88, rate: 1.6, status: 'playing', sleepAtChapterEnd: 120 });
    expect(plugin.load).not.toHaveBeenCalled(); expect(plugin.seek).not.toHaveBeenCalled(); expect(plugin.play).not.toHaveBeenCalled();
    expect(JSON.parse(transport.checkpoint()!.locator).trackTime).toBe(88);
    expect(transport.checkpoint()!.updatedAt).toBe(new Date(9000).toISOString());
  });
  it('refuses to adopt a different edition, reordered source queue or logged-out owner', async () => {
    const { transport, emit, account } = setup(); transports.push(transport);
    emit({ trackIds: ['t'], trackId: 't', manifestRevision: 'changed' });
    expect(await transport.adoptNative(book)).toBe(false);
    emit({ manifestRevision: undefined, trackIds: ['other'] });
    expect(await transport.adoptNative(book)).toBe(false);
    emit({ trackIds: ['t'] }); account('account-b');
    expect(await transport.adoptNative(book)).toBe(false);
    expect(transport.getBook()).toBeNull();
  });
  it('cannot adopt an owner after account scope changes during its snapshot request', async () => {
    const { transport, plugin, account } = setup(); transports.push(transport);
    let deliver!: (snapshot: NativePlaybackSnapshot) => void;
    vi.mocked(plugin.snapshot).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
    const adoption = transport.adoptNative(book);
    account('account-b');
    deliver({ accountScope: 'account-a', bookId: 'b', fileId: 'f', position: 40, duration: 120, rate: 1, playing: true, updatedAt: new Date().toISOString(), trackId: 't', trackIds: ['t'] });
    expect(await adoption).toBe(false);
    expect(transport.getBook()).toBeNull();
  });
});
