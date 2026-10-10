/** Read a complete representation with a hard decompressed-byte limit. No range fragments. */
export async function boundedBlob(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Blob> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('Audio verification accepts a byte limit up to 64 MiB.');
  signal?.throwIfAborted();
  const rawLength = response.headers.get('content-length');
  const declaredLength = rawLength === null ? null : Number(rawLength);
  const invalid = response.status !== 200 || response.headers.has('content-range') || (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes));
  if (invalid) { await response.body?.cancel(); throw new Error('A complete audio resource within the verification byte limit is required.'); }
  if (!response.body) throw new Error('The audio response has no readable body.');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: ArrayBuffer[] = []; let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('This audio resource exceeds the verification byte limit.'); }
      chunks.push(new Uint8Array(value).buffer);
    }
    if (!size || (!response.headers.has('content-encoding') && declaredLength !== null && size !== declaredLength)) throw new Error('The audio resource is empty or incomplete.');
    return new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
