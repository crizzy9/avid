import type { Session } from '../../../packages/core/src/types';
import type { NativeSessionVault, NativeSessionRecord } from '../../mobile/src/native-session';

/** Serial, compare-and-set native storage. Browser sessions remain memory-only. */
export class SessionPersistence {
  private cursor?: Promise<NativeSessionRecord>;
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  constructor(private readonly vault: NativeSessionVault | null) {}
  read(): Promise<NativeSessionRecord | null> {
    if (!this.vault) return Promise.resolve(null);
    if (!this.cursor) {
      const pending = this.vault.read().catch(error => {
        if (this.cursor === pending) this.cursor = undefined;
        throw error;
      });
      this.cursor = pending;
    }
    return this.cursor;
  }
  persist(session: Session, readOnly: boolean, isActive: () => boolean): Promise<void> {
    if (!this.vault) return Promise.resolve();
    const epoch = this.epoch;
    const snapshot = structuredClone(session);
    const run = this.queue.catch(() => {}).then(async () => {
      if (epoch !== this.epoch || !isActive()) return;
      const cursor = await this.read();
      if (!cursor || epoch !== this.epoch || !isActive()) return;
      // Never retry a stale generation by overwriting another owner's credentials.
      const next = await this.vault!.write({ expectedGeneration: cursor.generation, session: snapshot, readOnly });
      this.cursor = Promise.resolve(next);
    });
    this.queue = run;
    return run;
  }
  clear(): Promise<void> {
    this.epoch++; // Invalidates queued refreshes immediately, before native I/O.
    if (!this.vault) return Promise.resolve();
    const run = this.queue.catch(() => {}).then(async () => {
      const next = await this.vault!.clear();
      this.cursor = Promise.resolve(next);
    });
    this.queue = run;
    return run;
  }
}
