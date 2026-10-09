export const CROSSPOINT_CONTRACT = {
  revision: 'd7fcc7cec414c1b2507d9e6da8550af089e4822b',
  documentation: 'https://github.com/crosspoint-reader/crosspoint-reader/blob/d7fcc7cec414c1b2507d9e6da8550af089e4822b/docs/webserver-endpoints.md',
  implementation: 'https://github.com/crosspoint-reader/crosspoint-reader/blob/d7fcc7cec414c1b2507d9e6da8550af089e4822b/src/network/CrossPointWebServer.cpp',
  qualifiedFirmwareVersions: [] as readonly string[],
} as const;

export interface CrossPointDevice {
  address: string;
  version: string;
  ip: string;
  mode: 'STA' | 'AP';
  device?: string;
  deviceId?: string;
}
export interface CrossPointFile { name: string; size: number; isDirectory: boolean; isEpub: boolean }
export interface CrossPointReadiness {
  device: CrossPointDevice;
  directory: string;
  files: CrossPointFile[];
  /** Successful, schema-checked GETs establish reachability; they do not prove a transfer. */
  status: 'protocol-observed';
  firmwareQualified: boolean;
  transport: 'browser-fetch' | 'injected-native-fetch';
  discovery: 'manual-address';
  contractRevision: string;
}
export interface CrossPointTransferPlan {
  id: string;
  device: CrossPointDevice;
  directory: string;
  originalName: string;
  destinationName: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export interface CrossPointVerification {
  state: 'verified' | 'missing' | 'different-content';
  plan: CrossPointTransferPlan;
  checkedAt: string;
  message: string;
}
export type CrossPointErrorCode = 'invalid-address' | 'invalid-path' | 'unsupported-file' | 'unreachable' |
  'unexpected-response' | 'file-exists' | 'device-changed' | 'upload-uncertain' | 'invalid-plan' | 'busy';
export class CrossPointError extends Error {
  constructor(readonly code: CrossPointErrorCode, message: string, readonly cause?: unknown) {
    super(message); this.name = 'CrossPointError';
  }
}
export interface CrossPointOptions {
  /** Native callers may inject a verified fetch-compatible LAN bridge. No native plugin is assumed. */
  fetch?: typeof fetch;
  transport?: 'browser-fetch' | 'injected-native-fetch';
  timeoutMs?: number;
  maxFileBytes?: number;
  makeId?: () => string;
  hash?: (bytes: ArrayBuffer) => Promise<string>;
}

/**
 * Original client implementation of the pinned CrossPoint HTTP contract.
 * All probing/reconciliation is read-only. send() is the only mutation and is
 * always one multipart POST. It never deletes, replaces, or automatically retries.
 */
export class CrossPointClient {
  private readonly request: typeof fetch;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private readonly makeId: () => string;
  private readonly hash: (bytes: ArrayBuffer) => Promise<string>;
  private readonly transport: CrossPointReadiness['transport'];
  private sources = new WeakMap<CrossPointTransferPlan, Blob>();
  private attempted = new Set<string>();
  private uploading = false;

  constructor(options: CrossPointOptions = {}) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = Math.max(1_000, options.timeoutMs ?? 30_000);
    this.maxBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.hash = options.hash ?? sha256;
    this.transport = options.transport ?? 'browser-fetch';
    if (this.transport === 'injected-native-fetch' && !options.fetch) throw new Error('A native transport must be explicitly injected.');
  }

  /** Try an explicit IP only when the requested host is unreachable. No LAN scan. */
  async inspect(address: string, options: { directory?: string; ipFallback?: string; signal?: AbortSignal } = {}): Promise<CrossPointReadiness> {
    const primary = normalizeDeviceAddress(address);
    const directory = normalizeDeviceDirectory(options.directory ?? '/');
    let device: CrossPointDevice;
    try { device = await this.status(primary, options.signal); }
    catch (error) {
      if (!(error instanceof CrossPointError) || error.code !== 'unreachable' || !options.ipFallback || options.signal?.aborted) throw error;
      const fallback = normalizeDeviceAddress(options.ipFallback);
      if (fallback === primary) throw error;
      device = await this.status(fallback, options.signal);
    }
    const files = await this.list(device.address, directory, options.signal);
    return { device, directory, files, status: 'protocol-observed',
      firmwareQualified: CROSSPOINT_CONTRACT.qualifiedFirmwareVersions.includes(device.version),
      transport: this.transport, discovery: 'manual-address', contractRevision: CROSSPOINT_CONTRACT.revision };
  }

  /** Read-only plan; the displayed destination gets an independent random suffix. */
  async prepare(readiness: CrossPointReadiness, file: Blob, originalName: string, signal?: AbortSignal): Promise<CrossPointTransferPlan> {
    if (!/\.epub$/i.test(originalName) || file.size === 0 || file.size > this.maxBytes) {
      throw new CrossPointError('unsupported-file', `Choose a non-empty EPUB no larger than ${Math.floor(this.maxBytes / 1024 / 1024)} MB.`);
    }
    signal?.throwIfAborted();
    const id = this.makeId();
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) throw new CrossPointError('invalid-plan', 'The transfer ID is invalid.');
    const destinationName = uniqueEpubName(originalName, id);
    if (readiness.files.some(file => sameFilename(file.name, destinationName))) {
      throw new CrossPointError('file-exists', 'This destination name already exists. Prepare a new transfer to choose a new unique name.');
    }
    const digest = await this.hash(await file.arrayBuffer());
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new CrossPointError('invalid-plan', 'The file hash adapter did not return a valid SHA-256 digest.');
    signal?.throwIfAborted();
    const plan: CrossPointTransferPlan = Object.freeze({ id, device: Object.freeze({ ...readiness.device }),
      directory: normalizeDeviceDirectory(readiness.directory), originalName, destinationName,
      size: file.size, sha256: digest.toLowerCase(), createdAt: new Date().toISOString() });
    this.sources.set(plan, file);
    return plan;
  }

  async send(plan: CrossPointTransferPlan, signal?: AbortSignal): Promise<CrossPointVerification> {
    const source = this.sources.get(plan);
    if (!source) throw new CrossPointError('invalid-plan', 'Prepare this transfer in the current session before sending it.');
    if (this.uploading) throw new CrossPointError('busy', 'An upload is already in progress.');
    if (this.attempted.has(plan.id)) throw new CrossPointError('upload-uncertain', 'This upload has already been attempted. Verify its result; do not resend the same plan.');
    this.uploading = true;
    try {
      const current = await this.inspect(plan.device.address, { directory: plan.directory, signal });
      assertSameDevice(plan.device, current.device);
      if (current.files.some(file => sameFilename(file.name, plan.destinationName))) {
        throw new CrossPointError('file-exists', 'A file already occupies this destination. Avid will not replace it. Prepare a new transfer.');
      }
      signal?.throwIfAborted();
      const form = new FormData();
      form.append('file', source, plan.destinationName);
      this.attempted.add(plan.id);
      try {
        await this.http(plan.device.address, '/upload', { path: plan.directory }, { method: 'POST', body: form, signal }, async response => {
          const body = new TextDecoder().decode(await readBounded(response, 64 * 1024)).trim();
          if (!response.ok || body !== `File uploaded successfully: ${plan.destinationName}`) {
            throw new CrossPointError('upload-uncertain', `The device did not confirm a complete upload (HTTP ${response.status}). Verify before taking another action.`);
          }
        });
      } catch (error) {
        if (error instanceof CrossPointError && error.code === 'upload-uncertain') throw error;
        throw new CrossPointError('upload-uncertain', 'The upload result is unknown. Avid will not retry automatically; verify the destination first.', error);
      }
      try { return await this.verify(plan, signal); }
      catch (error) {
        throw new CrossPointError('upload-uncertain', 'The device accepted the upload, but read-back verification did not finish. Use Verify again without resending.', error);
      }
    } finally { this.uploading = false; }
  }

  /** Read-only recovery for success, network failure, timeout, cancellation, or page reload. */
  async verify(plan: CrossPointTransferPlan, signal?: AbortSignal): Promise<CrossPointVerification> {
    validateCrossPointTransferPlan(plan);
    const current = await this.inspect(plan.device.address, { directory: plan.directory, signal });
    assertSameDevice(plan.device, current.device);
    const entry = current.files.find(file => sameFilename(file.name, plan.destinationName));
    const result = (state: CrossPointVerification['state'], message: string): CrossPointVerification => ({ state, plan, message, checkedAt: new Date().toISOString() });
    if (!entry) return result('missing', 'The destination file is not present. A new transfer may be prepared explicitly.');
    if (entry.isDirectory || entry.size !== plan.size) return result('different-content', 'The destination exists but its size differs. It has not been replaced or deleted.');
    const path = `${plan.directory === '/' ? '' : plan.directory}/${entry.name}`;
    const bytes = await this.http(current.device.address, '/download', { path }, { signal }, async response => {
      if (!response.ok) throw new CrossPointError('unexpected-response', `The device could not provide the uploaded file for verification (HTTP ${response.status}).`);
      return readBounded(response, plan.size);
    });
    if (bytes.byteLength !== plan.size || (await this.hash(bytes)).toLowerCase() !== plan.sha256.toLowerCase()) {
      return result('different-content', 'The downloaded bytes do not match the source EPUB. The file has not been replaced or deleted.');
    }
    return result('verified', 'The uploaded EPUB was downloaded again and its SHA-256 matches the source.');
  }

  private async status(address: string, signal?: AbortSignal): Promise<CrossPointDevice> {
    const value: unknown = await this.http(address, '/api/status', { plugin: 'avid' }, { signal }, async response => {
      if (!response.ok) throw new CrossPointError('unexpected-response', `This address did not provide CrossPoint status (HTTP ${response.status}). Open File Transfer on the device.`);
      try { return JSON.parse(new TextDecoder().decode(await readBounded(response, 64 * 1024))); } catch { return null; }
    });
    if (!isObject(value) || typeof value.version !== 'string' || !value.version || typeof value.ip !== 'string' ||
      (value.mode !== 'STA' && value.mode !== 'AP') || (value.deviceId != null && (typeof value.deviceId !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.deviceId)))) {
      throw new CrossPointError('unexpected-response', 'Device status does not match the pinned CrossPoint contract. No upload was attempted.');
    }
    return { address, version: value.version, ip: value.ip, mode: value.mode,
      device: typeof value.device === 'string' ? value.device : undefined,
      deviceId: typeof value.deviceId === 'string' ? value.deviceId.toLowerCase() : undefined };
  }

  private async list(address: string, directory: string, signal?: AbortSignal): Promise<CrossPointFile[]> {
    const value: unknown = await this.http(address, '/api/files', { path: directory }, { signal }, async response => {
      if (!response.ok) throw new CrossPointError('unexpected-response', `The destination directory could not be listed (HTTP ${response.status}). Select an existing folder.`);
      try { return JSON.parse(new TextDecoder().decode(await readBounded(response, 2 * 1024 * 1024))); } catch { return null; }
    });
    if (!Array.isArray(value) || !value.every(item => isObject(item) && typeof item.name === 'string' &&
      !/[\\/\u0000-\u001f]/.test(item.name) && typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0 &&
      typeof item.isDirectory === 'boolean' && typeof item.isEpub === 'boolean')) {
      throw new CrossPointError('unexpected-response', 'The device returned an unsupported file listing. No upload was attempted.');
    }
    return value as CrossPointFile[];
  }

  private async http<T>(address: string, path: string, query: Record<string, string>, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    const url = new URL(path, normalizeDeviceAddress(address));
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    const abort = new AbortController();
    const cancel = () => abort.abort(init.signal?.reason);
    if (init.signal?.aborted) cancel();
    else init.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => abort.abort(new Error('Device request timed out.')), this.timeout);
    try {
      const response = await this.request(url, { ...init, signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      return await consume(response);
    } catch (error) {
      if (error instanceof CrossPointError) throw error;
      throw new CrossPointError('unreachable', 'The reader could not be reached. Open File Transfer, check the device IP, and allow local-network access. Browser mixed-content/CORS rules may require a native transport.', error);
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', cancel);
    }
  }
}

export function normalizeDeviceAddress(value: string): string {
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`); }
  catch { throw new CrossPointError('invalid-address', 'Enter the CrossPoint hostname or the IP address shown on its screen.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
    (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new CrossPointError('invalid-address', 'Use only a device hostname/IP and optional port, without credentials, paths, or query parameters.');
  }
  return url.origin;
}

export function normalizeDeviceDirectory(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || /[\\\u0000-\u001f%]/.test(trimmed)) throw new CrossPointError('invalid-path', 'Choose an absolute device folder such as / or /Books.');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.some(part => part.startsWith('.') || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || ['system volume information', 'xtcache'].includes(part.toLowerCase()))) {
    throw new CrossPointError('invalid-path', 'Protected, hidden, or ambiguous destination folders are not supported.');
  }
  return `/${parts.join('/')}`;
}

function uniqueEpubName(originalName: string, id: string): string {
  let stem = Array.from(originalName.replace(/\.epub$/i, '').normalize('NFC').replace(/[^\p{L}\p{N} _-]/gu, '_').trim()).slice(0, 70).join('') || 'Book';
  while (new TextEncoder().encode(stem).length > 160) stem = Array.from(stem).slice(0, -1).join('');
  return `${stem} - avid-${id.replace(/-/g, '')}.epub`;
}
function sameFilename(a: string, b: string): boolean { return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase(); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function assertSameDevice(expected: CrossPointDevice, actual: CrossPointDevice): void {
  if (expected.version !== actual.version || (expected.deviceId ? expected.deviceId !== actual.deviceId : expected.ip !== actual.ip || expected.device !== actual.device)) {
    throw new CrossPointError('device-changed', 'Device identity or firmware changed after preparation. Inspect it again and prepare a new transfer.');
  }
}
export function validateCrossPointTransferPlan(value: unknown): asserts value is CrossPointTransferPlan {
  if (!isObject(value) || !isObject(value.device) || typeof value.device.address !== 'string' ||
    typeof value.device.version !== 'string' || !value.device.version || typeof value.device.ip !== 'string' ||
    !['AP', 'STA'].includes(String(value.device.mode)) || typeof value.id !== 'string' ||
    typeof value.originalName !== 'string' || typeof value.directory !== 'string' ||
    typeof value.destinationName !== 'string' || !/^[^/\\\u0000-\u001f]+\.epub$/i.test(value.destinationName) || value.destinationName.startsWith('.') ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256) ||
    typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0 ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new CrossPointError('invalid-plan', 'The saved transfer plan is invalid.');
  }
  normalizeDeviceAddress(value.device.address);
  normalizeDeviceDirectory(value.directory);
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new CrossPointError('unsupported-file', 'SHA-256 verification needs a secure browser context or an explicitly configured native hash adapter.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function readBounded(response: Response, limit: number): Promise<ArrayBuffer> {
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > limit) throw new CrossPointError('unexpected-response', 'The downloaded file exceeded the expected size.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new CrossPointError('unexpected-response', 'The downloaded file exceeded the expected size.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  return bytes.buffer;
}
