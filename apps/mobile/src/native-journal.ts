import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ReadingAnchor, ReadingSession } from '../../../packages/core/src/types';

interface NativeJournalEnvelope {
  id: string;
  accountScope: string;
  bookId: string;
  fileId: string;
  createdAt: string;
  /** Captured when recorded. Later connections cannot make a read-only event writable. */
  readOnly: boolean;
}
export type NativeJournalEvent = NativeJournalEnvelope & (
  | { type: 'progress'; payload: ReadingAnchor }
  | { type: 'activity'; payload: ReadingSession & { kind: 'listening'; endedAt: string } }
);
export interface NativeJournalPlugin {
  /** Persist first. Acknowledge this ID only after the same event is committed to the scoped JS repository. */
  recordProgress(options: { accountScope: string; anchor: ReadingAnchor; readOnly?: boolean }): Promise<{ id: string; readOnly: boolean }>;
  drain(options: { accountScope: string; limit?: number }): Promise<{ events: NativeJournalEvent[] }>;
  ack(options: { accountScope: string; ids: string[] }): Promise<void>;
}
const plugin = registerPlugin<NativeJournalPlugin>('AvidJournal');
export function getNativeJournal(): NativeJournalPlugin | null {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AvidJournal') ? plugin : null;
}
