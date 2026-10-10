import { describe, expect, it, vi } from 'vitest';
import { BookOrbitClient, ProgressConflictError } from '../src/bookorbit';
const session = { profile: { id: 'server', url: 'https://books.test', name: 'Books' }, userId: '7', accessToken: 'offline-test' };
describe('pinned BookOrbit media-overlay routes', () => {
  it('requires an explicit EPUB file and sends only an authenticated read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ bookId: 12, fileId: 31, durationSeconds: null, items: [], sections: [], resources: [] }));
    const client = new BookOrbitClient(session, { fetch: fetcher, readOnly: true });
    expect((await client.getMediaOverlayPlaylist('12', '31')).fileId).toBe(31);
    expect(fetcher.mock.calls[0]![0]).toBe('https://books.test/api/v1/epub/12/media-overlay?fileId=31');
    expect(fetcher.mock.calls[0]![1]?.method ?? 'GET').toBe('GET');
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer offline-test');
    expect(client.mediaOverlayResourceUrl('12', '31', 'OPS/audio/Chapter one.mp3')).toBe('https://books.test/api/v1/epub/12/media-overlay/file/OPS/audio/Chapter%20one.mp3?fileId=31');
  });
  it('rejects another source file rather than applying primary-file fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ bookId: 12, fileId: 99, durationSeconds: null, items: [], sections: [], resources: [] }));
    await expect(new BookOrbitClient(session, { fetch: fetcher }).getMediaOverlayPlaylist('12', '31')).rejects.toBeInstanceOf(ProgressConflictError);
  });
  it.each(['../secret', '/absolute', 'https://elsewhere.test/file', 'audio?token=secret', 'audio#part', 'OPS/../audio', 'OPS\\audio', 'OPS/%2e%2e/audio'])('rejects unsafe resource path %s', href => {
    expect(() => new BookOrbitClient(session).mediaOverlayResourceUrl('12', '31', href)).toThrow();
  });
});
