import { describe, expect, it, vi } from 'vitest';
import { BookOrbitClient } from '../src/bookorbit';
import { boundedBlob } from '../src/boundedBlob';
const session = { profile: { id: 'server', url: 'https://books.test', name: 'Books' }, userId: '7', accessToken: 'offline-test' };
describe('bounded authenticated alignment reads', () => {
  it('requires explicit preparation purpose above the old verification limit and caps preparations at 512 MiB', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('original audio'));
    const client = new BookOrbitClient(session, { fetch: fetcher, readOnly: true });
    await expect(client.getAudioAssetBlob('12', 'asset', { maxBytes: 512 * 1024 ** 2 })).rejects.toThrow('64 MiB');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await (await client.getAudioAssetBlob('12', 'asset', { maxBytes: 512 * 1024 ** 2, purpose: 'preparation' })).text()).toBe('original audio');
    await expect(client.getAudioAssetBlob('12', 'asset', { maxBytes: 512 * 1024 ** 2 + 1, purpose: 'preparation' })).rejects.toThrow('512 MiB');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('gets a complete asset with authentication and honors the supplied abort signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('audio bytes', { headers: { 'content-length': '11', 'content-type': 'audio/wav' } }));
    const abort = new AbortController();
    const result = await new BookOrbitClient(session, { fetch: fetcher, readOnly: true }).getAudioAssetBlob('12', 'track/one', { signal: abort.signal, maxBytes: 11 });
    expect(await result.text()).toBe('audio bytes'); expect(result.type).toBe('audio/wav');
    expect(fetcher.mock.calls[0]![0]).toBe('https://books.test/api/v1/audiobooks/12/assets/track%2Fone/content');
    expect(fetcher.mock.calls[0]![1]?.signal).toBe(abort.signal);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer offline-test');
  });
  it('cancels a declared oversized body before reading it', async () => {
    const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(boundedBlob(new Response(stream, { headers: { 'content-length': '100' } }), 10)).rejects.toThrow('complete audio');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('stops an unknown-length stream as soon as its bytes exceed the limit', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); }, cancel });
    await expect(boundedBlob(new Response(stream), 10)).rejects.toThrow('exceeds'); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['truncated', 'partial', 'range-header', 'empty'])('rejects a %s representation as full-byte proof', async kind => {
    const response = kind === 'truncated' ? new Response('abc', { headers: { 'content-length': '5' } })
      : kind === 'partial' ? new Response('abc', { status: 206 })
        : kind === 'range-header' ? new Response('abc', { headers: { 'content-range': 'bytes 0-2/50' } }) : new Response('');
    await expect(boundedBlob(response, 10)).rejects.toThrow();
  });
  it('rejects an already aborted action before making any request', async () => {
    const fetcher = vi.fn<typeof fetch>(); const abort = new AbortController(); abort.abort();
    await expect(new BookOrbitClient(session, { fetch: fetcher }).getAudioAssetBlob('12', 'asset', { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels a pending stream read on account/source cancellation', async () => {
    const cancel = vi.fn(); const abort = new AbortController();
    const promise = boundedBlob(new Response(new ReadableStream<Uint8Array>({ cancel })), 10, abort.signal);
    abort.abort(); await expect(promise).rejects.toMatchObject({ name: 'AbortError' }); expect(cancel).toHaveBeenCalledOnce();
  });
});
