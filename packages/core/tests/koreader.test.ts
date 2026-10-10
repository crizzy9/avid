import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BookOrbitClient, ProgressConflictError, ReadOnlyError } from '../src/bookorbit';
import { assertKoreaderBinding, bookOrbitTextProgress, computeKoreaderFingerprint, koreaderRestoreAnchor, parseKoreaderCheckpoint, type KoreaderBinding } from '../src/koreader';
import fixtures from './fixtures/koreader-progress.json';
const binding: KoreaderBinding = { serverUrl: 'https://books.test', userId: '7', bookId: '12', fileId: '31', kind: 'epub' };
const session = { profile: { id: 'server', url: binding.serverUrl, name: 'Books' }, userId: binding.userId, accessToken: 'offline-test' };
const digest = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
describe('KOReader partial-file identity', () => {
  it.each([['', 'd41d8cd98f00b204e9800998ecf8427e'], ['abc', '900150983cd24fb0d6963f7d28e17f72'], ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0']])('matches RFC1321 for a small file (%s)', async (text, expected) => {
    const fingerprint = await computeKoreaderFingerprint(new Blob([text]));
    expect(fingerprint).toEqual({ algorithm: 'koreader-partial-md5', value: expected, sizeBytes: text.length });
  });
  it('matches the pinned server block fixture and does not use full-file MD5', async () => {
    const bytes = Buffer.alloc(8192, 'A'); bytes.fill('B', 1024, 2048); bytes.fill('C', 4096, 5120);
    const expected = digest(Buffer.concat([Buffer.alloc(1024, 'A'), Buffer.alloc(1024, 'B'), Buffer.alloc(1024, 'C')]));
    expect((await computeKoreaderFingerprint(new Blob([bytes]))).value).toBe(expected);
    expect(expected).not.toBe(digest(bytes));
    const renamed = new File([bytes], 'different filename.epub');
    expect((await computeKoreaderFingerprint(renamed)).value).toBe(expected);
  });
  it('reads at most twelve blocks for a file larger than 1 GiB, including the partial final block', async () => {
    const reads: [number, number][] = [];
    const size = 1073741824 + 13;
    const source = { size, slice(start = 0, end = size) { reads.push([start, end]); return new Blob([new Uint8Array(end - start).fill((start / 1024) % 251)]); } };
    const fingerprint = await computeKoreaderFingerprint(source);
    const positions = [0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456, 1073741824];
    expect(reads.map(([start]) => start)).toEqual(positions);
    expect(reads.reduce((sum, [start, end]) => sum + end - start, 0)).toBe(11 * 1024 + 13);
    expect(fingerprint.value).toBe(digest(Buffer.concat(reads.map(([start, end]) => Buffer.alloc(end - start, (start / 1024) % 251)))));
  });
  it('documents why a partial fingerprint cannot certify unchanged unsampled bytes', async () => {
    const bytes = new Uint8Array(8192);
    const original = await computeKoreaderFingerprint(new Blob([bytes]));
    bytes[3000] = 255;
    expect((await computeKoreaderFingerprint(new Blob([bytes]))).value).toBe(original.value);
    bytes[100] = 255;
    expect((await computeKoreaderFingerprint(new Blob([bytes]))).value).not.toBe(original.value);
  });
});
describe('KOReader native locator and server translation boundary', () => {
  it('preserves the exact server/native pair and dates it from canonical device metadata', () => {
    const checkpoint = parseKoreaderCheckpoint(binding, fixtures.epub.file, fixtures.epub.sync)!;
    const anchor = koreaderRestoreAnchor(checkpoint, binding)!;
    expect(anchor.locator).toBe(fixtures.epub.file.cfi);
    expect(anchor.updatedAt).toBe(fixtures.epub.sync.canonicalUpdatedAt);
    expect(anchor.koreader?.nativeLocator).toBe(fixtures.epub.file.koreaderProgress);
    expect(checkpoint.precision).toBe('unspecified');
    expect(checkpoint.translation).toBe('server-cfi');
    expect(JSON.parse(JSON.stringify(anchor)).koreader.nativeLocator).toBe(fixtures.epub.file.koreaderProgress);
    const write = bookOrbitTextProgress(anchor, binding);
    expect(write.percentage).toBeCloseTo(55);
    expect(write).toMatchObject({ cfi: fixtures.epub.file.cfi, koreaderProgress: fixtures.epub.file.koreaderProgress });
  });
  it('does not treat old web timestamps as the time of a newer native position', () => {
    const checkpoint = parseKoreaderCheckpoint(binding, fixtures.epub.file)!;
    expect(checkpoint.readerAnchor?.updatedAt).toBe('');
    expect(checkpoint.eventTimeSource).toBe('unknown');
    expect(checkpoint.reviewReason).toBe('native-time-unavailable');
  });
  it('never creates a CFI from a percentage or an unconverted native XPointer', () => {
    const checkpoint = parseKoreaderCheckpoint(binding, { ...fixtures.epub.file, cfi: null }, fixtures.epub.sync)!;
    expect(checkpoint.nativeLocator).toBe(fixtures.epub.file.koreaderProgress);
    expect(checkpoint.readerAnchor).toBeNull();
    expect(checkpoint.translation).toBe('unavailable');
    expect(koreaderRestoreAnchor(checkpoint, binding)).toBeNull();
  });
  it('cannot use another edition or an inconsistent canonical percentage to date this point', () => {
    const otherFile = parseKoreaderCheckpoint(binding, fixtures.epub.file, { ...fixtures.epub.sync, bookFileId: 32 })!;
    const changedPoint = parseKoreaderCheckpoint(binding, fixtures.epub.file, { ...fixtures.epub.sync, canonicalPercentage: 20 })!;
    expect(otherFile.readerAnchor?.updatedAt).toBe(''); expect(changedPoint.readerAnchor?.updatedAt).toBe('');
  });
  it.each(['currentFileId', 'bookFileId', 'userId'] as const)('rejects contradictory %s values before restoring', field => {
    expect(() => parseKoreaderCheckpoint(binding, { ...fixtures.epub.file, [field]: 999 })).toThrow('different source file or account');
  });
  it.each(['serverUrl', 'userId', 'bookId', 'fileId', 'kind'] as const)('rejects a checkpoint bound to another %s', field => {
    expect(() => assertKoreaderBinding({ ...binding, [field]: field === 'kind' ? 'pdf' : 'other' }, binding)).toThrow('different account, book or file');
  });
  it('preserves fingerprints and rejects changed sampled content or file size', async () => {
    const fingerprint = await computeKoreaderFingerprint(new Blob(['Original book bytes']));
    const exact = { ...binding, fingerprint };
    const checkpoint = parseKoreaderCheckpoint(exact, fixtures.epub.file, fixtures.epub.sync)!;
    expect(checkpoint.binding.fingerprint).toEqual(fingerprint);
    expect(() => koreaderRestoreAnchor(checkpoint, { ...exact, fingerprint: { ...fingerprint, sizeBytes: fingerprint.sizeBytes + 1 } })).toThrow('fingerprint changed');
    expect(() => koreaderRestoreAnchor(checkpoint, { ...exact, fingerprint: { ...fingerprint, value: 'a'.repeat(32) } })).toThrow('fingerprint changed');
  });
  it('keeps raw evidence but refuses restore after the server reports a changed device file', () => {
    const checkpoint = parseKoreaderCheckpoint(binding, fixtures.epub.file, { ...fixtures.epub.sync, fileModifiedSinceLastSync: true })!;
    expect(checkpoint.nativeLocator).toBe(fixtures.epub.file.koreaderProgress);
    expect(() => koreaderRestoreAnchor(checkpoint, binding)).toThrow('source file changed');
  });
  it('preserves fixed-page semantics and serializes a webtoon anchor without inventing an offset conversion', () => {
    const comic = { ...binding, fileId: '32', kind: 'comic' as const };
    const checkpoint = parseKoreaderCheckpoint(comic, fixtures.comic.file, fixtures.comic.sync)!;
    const anchor = koreaderRestoreAnchor(checkpoint, comic)!;
    expect(anchor.locator).toBe('117'); expect(checkpoint.precision).toBe('page');
    expect(bookOrbitTextProgress({ ...anchor, locator: '{"page":117,"offset":0.4}' }, comic)).toEqual({ percentage: 40, pageNumber: 117, koreaderProgress: '117' });
    expect(() => bookOrbitTextProgress({ ...anchor, locator: '{"page":0}' }, comic)).toThrow('positive integers');
  });
  it('does not echo the previous native point when Avid moves to a new CFI', () => {
    const checkpoint = parseKoreaderCheckpoint(binding, fixtures.epub.file, fixtures.epub.sync)!;
    const anchor = koreaderRestoreAnchor(checkpoint, binding)!;
    const next = { ...anchor, locator: 'epubcfi(/6/2!/4/2/1:20)', progress: 0.6 };
    expect(bookOrbitTextProgress(next, binding)).toEqual({ percentage: 60, cfi: next.locator });
    expect(() => bookOrbitTextProgress({ ...next, locator: fixtures.epub.file.koreaderProgress }, binding)).toThrow('native EPUB CFI');
  });
});
describe('authenticated BookOrbit integration', () => {
  it('uses read-only JWT routes and preserves the latest device timestamp', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixtures.epub.file)).mockResolvedValueOnce(Response.json(fixtures.epub.sync));
    const client = new BookOrbitClient(session, { fetch: fetcher, readOnly: true });
    const anchor = await client.getProgress(binding);
    expect(anchor?.updatedAt).toBe(fixtures.epub.sync.canonicalUpdatedAt);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://books.test/api/v1/books/files/31/progress', 'https://books.test/api/v1/koreader/books/12/progress']);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has('x-auth-key')).toBe(false);
    await expect(client.saveProgress(anchor!)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps native event time unknown when KOReader metadata permission is unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixtures.epub.file)).mockResolvedValueOnce(Response.json({ message: 'Not permitted' }, { status: 403 }));
    const checkpoint = await new BookOrbitClient(session, { fetch: fetcher }).getKoreaderCheckpoint(binding);
    expect(checkpoint?.nativeLocator).toBe(fixtures.epub.file.koreaderProgress);
    expect(checkpoint?.readerAnchor?.updatedAt).toBe('');
  });
  it('retains source identity conflict protection and sends valid fixed-page writes', async () => {
    const mismatch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...fixtures.epub.file, currentFileId: 999 }));
    await expect(new BookOrbitClient(session, { fetch: mismatch }).getProgress(binding)).rejects.toBeInstanceOf(ProgressConflictError);
    const write = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await new BookOrbitClient(session, { fetch: write }).saveProgress({ bookId: '12', fileId: '32', kind: 'pdf', locator: '{"page":7,"offset":0}', progress: 0.4, updatedAt: fixtures.epub.sync.canonicalUpdatedAt });
    expect(JSON.parse(String(write.mock.calls[0]![1]?.body))).toEqual({ percentage: 40, pageNumber: 7, koreaderProgress: '7' });
  });
});
