import { describe, expect, it, vi } from 'vitest';
import { BookOrbitClient } from '../src/bookorbit';
import type { Session } from '../src/types';

const session: Session = {
  profile: { id: 'server', name: 'Books', url: 'https://books.example/base' },
  userId: '7', accessToken: 'fixture-access-token', clientKind: 'web',
};
function fixture(response: Response, activeSession = session) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { fetcher, client: new BookOrbitClient(activeSession, { fetch: fetcher, readOnly: true }) };
}
function streamed(chunks: number[][], headers?: HeadersInit) {
  const cancel = vi.fn(); let index = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(new Uint8Array(chunks[index++]));
    else controller.close();
  });
  // No automatic prefetch: a preflight rejection must not request even the first chunk.
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), pull, cancel };
}

describe('optional bounded BookOrbit file downloads', () => {
  it.each(['web', 'native'] as const)('preserves the file URL, authentication, signal and %s credential mode', async clientKind => {
    const controller = new AbortController();
    const { client, fetcher } = fixture(new Response('epub', {
      headers: { 'content-length': '4', 'content-type': 'application/epub+zip' },
    }), { ...session, clientKind });
    const blob = await client.getFileBlob('31', controller.signal, 4);
    expect(await blob.text()).toBe('epub'); expect(blob.type).toBe('application/epub+zip');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://books.example/base/api/v1/books/files/31/serve');
    expect(request?.signal).toBe(controller.signal);
    expect(request?.credentials).toBe(clientKind === 'native' ? 'omit' : 'include');
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer fixture-access-token');
    expect(new Headers(request?.headers).has('range')).toBe(false);
    expect(request?.method ?? 'GET').toBe('GET'); expect(request?.body).toBeUndefined();
  });

  it('retains a configured transport proxy without changing the file identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('epub'));
    const client = new BookOrbitClient(session, { fetch: fetcher, transportBaseUrl: '/bookorbit' });
    await client.getFileBlob('31', undefined, 4);
    expect(fetcher.mock.calls[0][0]).toBe('/bookorbit/api/v1/books/files/31/serve');
    expect(client.baseUrl).toBe('https://books.example/base');
  });

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte limit %s before requesting a file', async maximum => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new BookOrbitClient(session, { fetch: fetcher });
    await expect(client.getFileBlob('31', undefined, maximum)).rejects.toThrow(/file|byte limit/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts any positive safe-integer bound without allocating that capacity', async () => {
    const { client } = fixture(new Response('x'));
    expect((await client.getFileBlob('31', undefined, Number.MAX_SAFE_INTEGER)).size).toBe(1);
  });

  it('cancels an oversized declared response before pulling or delegating to blob()', async () => {
    const stream = streamed([[1]], { 'content-length': '9' });
    const blob = vi.spyOn(stream.response, 'blob');
    await expect(fixture(stream.response).client.getFileBlob('31', undefined, 8)).rejects.toThrow(/file|byte limit/i);
    expect(stream.pull).not.toHaveBeenCalled(); expect(blob).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it.each<{ kind: string; headers: HeadersInit }>([
    { kind: 'missing', headers: {} },
    { kind: 'understated', headers: { 'content-length': '2' } },
    { kind: 'compressed', headers: { 'content-length': '2', 'content-encoding': 'gzip' } },
  ])('counts actual decoded bytes with $kind Content-Length and cancels at overflow', async ({ headers }) => {
    const stream = streamed([[1, 2, 3], [4, 5, 6], [7]], headers);
    await expect(fixture(stream.response).client.getFileBlob('31', undefined, 5)).rejects.toThrow(/file|byte limit/i);
    expect(stream.pull).toHaveBeenCalledTimes(2);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts a complete decoded body at the exact bound when encoded length differs', async () => {
    const stream = streamed([[1, 2, 3], [4, 5, 6]], { 'content-length': '2', 'content-encoding': 'gzip' });
    const blob = await fixture(stream.response).client.getFileBlob('31', undefined, 6);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it('rejects overflow even when the transport never finishes canceling its body', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); }, cancel,
    }, { highWaterMark: 0 }));
    await expect(fixture(response).client.getFileBlob('31', undefined, 3)).rejects.toThrow(/file|byte limit/i);
    expect(cancel).toHaveBeenCalledTimes(1);
  }, 1000);

  it('rejects a pre-aborted request before calling the transport', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BookOrbitClient(session, { fetch: fetcher }).getFileBlob('31', controller.signal, 8)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a blocked read on abort even if native cancellation never settles', async () => {
    const controller = new AbortController(), cancel = vi.fn(() => new Promise<void>(() => {})), pull = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }));
    const pending = fixture(response).client.getFileBlob('31', controller.signal, 8);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1); expect(response.body!.locked).toBe(false);
  }, 1000);

  it('cancels a response arriving after abort without reading its bytes', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(yes => { resolve = yes; }));
    const controller = new AbortController();
    const pending = new BookOrbitClient(session, { fetch: fetcher }).getFileBlob('31', controller.signal, 8);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    const stream = streamed([[1, 2, 3]]); const blob = vi.spyOn(stream.response, 'blob');
    resolve(stream.response); await rejected;
    expect(stream.pull).not.toHaveBeenCalled(); expect(blob).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'empty', response: () => new Response('') },
    { kind: 'partial', response: () => new Response('abc', { status: 206 }) },
    { kind: 'range header', response: () => new Response('abc', { headers: { 'content-range': 'bytes 0-2/30' } }) },
    { kind: 'truncated', response: () => new Response('abc', { headers: { 'content-length': '5' } }) },
    { kind: 'missing body', response: () => new Response(null) },
  ])('rejects an $kind representation in the bounded full-resource path', async ({ response }) => {
    await expect(fixture(response()).client.getFileBlob('31', undefined, 8)).rejects.toThrow(/file|byte limit/i);
  });

  it.each([
    { kind: 'empty', response: () => new Response(''), expected: '' },
    { kind: 'partial', response: () => new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-2/30' } }), expected: 'abc' },
    { kind: 'ordinary', response: () => new Response('larger than a small optional bound'), expected: 'larger than a small optional bound' },
  ])('keeps existing unbounded $kind downloads delegated to Response.blob()', async ({ response, expected }) => {
    const reply = response(), blob = vi.spyOn(reply, 'blob');
    const value = await fixture(reply).client.getFileBlob('31');
    expect(await value.text()).toBe(expected); expect(blob).toHaveBeenCalledTimes(1);
  });

  it('does not carry an earlier caller’s small limit into a later unbounded read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('epub'));
    const client = new BookOrbitClient(session, { fetch: fetcher });
    await expect(client.getFileBlob('31', undefined, 3)).rejects.toThrow(/file|byte limit/i);
    expect(await (await client.getFileBlob('31')).text()).toBe('epub');
  });
});
