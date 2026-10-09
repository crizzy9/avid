import { describe, expect, it, vi } from 'vitest';
import { CrossPointClient, CROSSPOINT_CONTRACT, normalizeDeviceAddress, normalizeDeviceDirectory, validateCrossPointTransferPlan, type CrossPointFile } from '../src/crosspoint';

const transferId = '00000000-0000-4000-8000-000000000001';
const status = { version: 'fixture-firmware', ip: '192.168.1.42', mode: 'STA', device: 'X4', deviceId: 'a'.repeat(64) };
function fixture() {
  const files = new Map<string, Uint8Array>();
  let uploadCount = 0;
  let failAfterWrite = false;
  let deviceVersion = status.version;
  let downloadedOverride: Uint8Array | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(String(input));
    if (url.pathname === '/api/status') return Response.json({ ...status, version: deviceVersion });
    if (url.pathname === '/api/files') return Response.json([...files].map(([name, bytes]): CrossPointFile => ({ name, size: bytes.byteLength, isDirectory: false, isEpub: true })));
    if (url.pathname === '/upload') {
      uploadCount++;
      const file = (init?.body as FormData).get('file') as File;
      if (files.has(file.name)) return new Response('File already exists', { status: 400 });
      files.set(file.name, new Uint8Array(await file.arrayBuffer()));
      if (failAfterWrite) throw new TypeError('Response was lost');
      return new Response(`File uploaded successfully: ${file.name}`);
    }
    if (url.pathname === '/download') {
      const name = url.searchParams.get('path')!.split('/').at(-1)!;
      const bytes = downloadedOverride ?? files.get(name);
      return bytes ? new Response(bytes as BodyInit) : new Response('Missing', { status: 404 });
    }
    return new Response('Unexpected route', { status: 404 });
  });
  const client = new CrossPointClient({ fetch: fetchMock as typeof fetch, makeId: () => transferId });
  return { client, files, fetchMock, uploaded: () => uploadCount,
    loseUploadResponse: () => { failAfterWrite = true; },
    changeFirmware: () => { deviceVersion = 'different'; },
    corruptDownload: (bytes: Uint8Array) => { downloadedOverride = bytes; } };
}
const epub = () => new Blob(['PK\u0003\u0004fixture EPUB content'], { type: 'application/epub+zip' });

describe('CrossPoint contract and readiness', () => {
  it('uses explicit device addresses and rejects credentials or traversal', () => {
    expect(normalizeDeviceAddress('192.168.1.42')).toBe('http://192.168.1.42');
    expect(normalizeDeviceAddress('http://crosspoint.local:8080/')).toBe('http://crosspoint.local:8080');
    expect(normalizeDeviceDirectory('/Books/')).toBe('/Books');
    for (const address of ['https://user:password@reader.local', 'http://reader.local/path', 'file:///etc/passwd', 'http://reader.local?x=1']) expect(() => normalizeDeviceAddress(address)).toThrow();
    for (const path of ['/../Books', '/.crosspoint', '/Books%2fsecret', '/Books\\other']) expect(() => normalizeDeviceDirectory(path)).toThrow();
  });
  it('reports observed protocol separately from unqualified firmware', async () => {
    const { client, fetchMock } = fixture();
    const ready = await client.inspect('crosspoint.local', { directory: '/Books' });
    expect(ready).toMatchObject({ status: 'protocol-observed', firmwareQualified: false, discovery: 'manual-address', contractRevision: CROSSPOINT_CONTRACT.revision });
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/status?plugin=avid');
  });
  it('uses only the explicitly supplied IP fallback when mDNS is unreachable', async () => {
    const local = fixture();
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === 'crosspoint.local') throw new TypeError('DNS failed');
      return local.fetchMock(input, init);
    });
    const client = new CrossPointClient({ fetch: request as typeof fetch });
    expect((await client.inspect('crosspoint.local', { ipFallback: '192.168.1.42' })).device.address).toBe('http://192.168.1.42');
    expect(request.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['crosspoint.local', '192.168.1.42', '192.168.1.42']);
  });
  it('rejects a wrong service response without guessing or trying an upload', async () => {
    const request = vi.fn(async () => Response.json({ name: 'Unrelated NAS' }));
    const client = new CrossPointClient({ fetch: request as typeof fetch });
    await expect(client.inspect('192.168.1.42', { ipFallback: '192.168.1.43' })).rejects.toMatchObject({ code: 'unexpected-response' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('CrossPoint delivery', () => {
  it('prepares read-only, sends one multipart file, and verifies its exact bytes', async () => {
    const { client, fetchMock, uploaded } = fixture();
    const ready = await client.inspect('192.168.1.42', { directory: '/Books' });
    const plan = await client.prepare(ready, epub(), 'My book.epub');
    expect(uploaded()).toBe(0);
    expect(plan.destinationName).toBe('My book - avid-00000000000040008000000000000001.epub');
    expect(plan.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await client.send(plan)).toMatchObject({ state: 'verified' });
    expect(uploaded()).toBe(1);
    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(mutation[0])).toBe('http://192.168.1.42/upload?path=%2FBooks');
    expect(mutation[1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(mutation[1]?.headers).toBeUndefined(); // Browser owns multipart boundary; no BookOrbit token.
    await expect(client.send(plan)).rejects.toMatchObject({ code: 'upload-uncertain' });
    expect(uploaded()).toBe(1);
  });
  it('refuses a destination created since preparation, including case differences', async () => {
    const { client, files, uploaded } = fixture();
    const plan = await client.prepare(await client.inspect('192.168.1.42'), epub(), 'Book.epub');
    files.set(plan.destinationName.toUpperCase(), new Uint8Array([1]));
    await expect(client.send(plan)).rejects.toMatchObject({ code: 'file-exists' });
    expect(uploaded()).toBe(0);
    expect(files.size).toBe(1);
  });
  it('never retries an ambiguous write and reconciles it through read-only verification', async () => {
    const { client, uploaded, loseUploadResponse, fetchMock } = fixture();
    const plan = await client.prepare(await client.inspect('192.168.1.42'), epub(), 'Book.epub');
    loseUploadResponse();
    await expect(client.send(plan)).rejects.toMatchObject({ code: 'upload-uncertain' });
    expect(uploaded()).toBe(1);
    await expect(client.send(plan)).rejects.toMatchObject({ code: 'upload-uncertain' });
    const before = fetchMock.mock.calls.length;
    expect(await client.verify(JSON.parse(JSON.stringify(plan)))).toMatchObject({ state: 'verified' });
    expect(uploaded()).toBe(1);
    expect(fetchMock.mock.calls.slice(before).every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it('detects same-size corrupted content and leaves it untouched', async () => {
    const { client, corruptDownload, uploaded } = fixture();
    const plan = await client.prepare(await client.inspect('192.168.1.42'), epub(), 'Book.epub');
    corruptDownload(new Uint8Array(plan.size));
    expect(await client.send(plan)).toMatchObject({ state: 'different-content' });
    expect(uploaded()).toBe(1);
  });
  it('reports missing files through read-only recovery', async () => {
    const { client, uploaded } = fixture();
    const plan = await client.prepare(await client.inspect('192.168.1.42'), epub(), 'Book.epub');
    expect(await client.verify(plan)).toMatchObject({ state: 'missing' });
    expect(uploaded()).toBe(0);
  });
  it('rechecks firmware before the only mutating request', async () => {
    const { client, changeFirmware, uploaded } = fixture();
    const plan = await client.prepare(await client.inspect('192.168.1.42'), epub(), 'Book.epub');
    changeFirmware();
    await expect(client.send(plan)).rejects.toMatchObject({ code: 'device-changed' });
    expect(uploaded()).toBe(0);
  });
  it('rejects unsupported files and malformed saved receipts before network mutation', async () => {
    const { client, uploaded } = fixture();
    const ready = await client.inspect('192.168.1.42');
    await expect(client.prepare(ready, epub(), 'Book.pdf')).rejects.toMatchObject({ code: 'unsupported-file' });
    await expect(client.prepare(ready, new Blob(), 'empty.epub')).rejects.toMatchObject({ code: 'unsupported-file' });
    expect(() => validateCrossPointTransferPlan({ device: null })).toThrow();
    expect(uploaded()).toBe(0);
  });
});
