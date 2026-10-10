export interface DiscoveredReader { address: string; hostname: string }
export type DiscoverReaders = (signal?: AbortSignal) => Promise<DiscoveredReader[]>;
export interface ReaderDiscoveryBridge {
  discover(request: {id: string}): Promise<{readers: DiscoveredReader[]}>;
  close(request: {id: string}): Promise<unknown>;
}
/** Discovery is only a hint. A fresh status and directory inspection is still required. */
export function createReaderDiscovery(bridge: ReaderDiscoveryBridge): DiscoverReaders {
  return async signal => {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {rejectAbort = reject;});
    const cancel = () => { void bridge.close({id}).catch(() => {}); rejectAbort?.(signal?.reason ?? new DOMException('Discovery canceled.', 'AbortError')); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      const result = await Promise.race([bridge.discover({id}), aborted]);
      signal?.throwIfAborted();
      if (!Array.isArray(result.readers) || result.readers.length > 32) throw new Error('Invalid reader discovery response.');
      const seen = new Set<string>();
      return result.readers.filter(reader => {
        if (!reader || typeof reader.address !== 'string' || typeof reader.hostname !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(reader.hostname)) return false;
        const match = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(reader.address);
        if (!match) return false;
        const [a,b,c,d] = match.slice(1).map(Number);
        if ([a,b,c,d].some(value => value > 255) || !(a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254)) return false;
        if (seen.has(reader.address)) return false;
        seen.add(reader.address); return true;
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      await bridge.close({id}).catch(() => {});
    }
  };
}
