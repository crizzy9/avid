import { expect, it, vi } from 'vitest';
import { createLazyPlaybackTransport } from './lazy-transport';
import type { PlaybackTransport } from './native-transport';

it('allocates no owner for discarded StrictMode render initializers', () => {
  const factory = vi.fn<() => PlaybackTransport>();
  const abandoned = createLazyPlaybackTransport(factory);
  expect(abandoned.getSnapshot()).toBe(abandoned.getSnapshot());
  expect(abandoned.getBook()).toBeNull();
  expect(abandoned.checkpoint()).toBeNull();
  abandoned.pause(); abandoned.destroy(); abandoned.destroy();
  expect(factory).not.toHaveBeenCalled();
});
it('creates one owner at committed subscription and delegates cleanup once', () => {
  const stop = vi.fn(); const destroy = vi.fn(); const subscribe = vi.fn(() => stop);
  const factory = vi.fn(() => ({ subscribe, destroy }) as unknown as PlaybackTransport);
  const transport = createLazyPlaybackTransport(factory);
  const unsubscribe = transport.subscribe(() => {}); unsubscribe();
  transport.subscribe(() => {});
  expect(factory).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
  transport.destroy(); transport.destroy(); expect(destroy).toHaveBeenCalledOnce();
});
