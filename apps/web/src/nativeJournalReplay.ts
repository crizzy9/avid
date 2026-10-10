import { z } from 'zod';
import type { LibraryRepository } from '../../../packages/core/src/repository';
import type { ReadingAnchor, ReadingSession } from '../../../packages/core/src/types';

const time = z.string().refine(value => Number.isFinite(Date.parse(value)), 'A native event timestamp is required.');
const identity = z.string().min(1).max(4096);
const envelope = z.object({ id: identity, accountScope: identity, bookId: identity, fileId: identity,
  createdAt: time, readOnly: z.boolean().default(true) });
const schema = z.discriminatedUnion('type', [
  envelope.extend({ type: z.literal('progress'), payload: z.object({ bookId: identity, fileId: identity,
    kind: z.enum(['epub','pdf','comic','audio']), locator: z.string().min(1).max(65536),
    progress: z.number().finite().min(0).max(1), updatedAt: time }) }),
  envelope.extend({ type: z.literal('activity'), payload: z.object({ id: identity, bookId: identity,
    kind: z.literal('listening'), startedAt: time, duration: z.number().finite().nonnegative().max(86400), endedAt: time }) }),
]);
export interface JournalAdapter {
  drain(options: {accountScope:string;limit:number}): Promise<{events: unknown[]}>;
  ack(options: {accountScope:string;ids:string[]}): Promise<void>;
}
async function fingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** All local effects and their receipts commit together, before acknowledging native storage. */
export async function commitNativeEvents(repo: LibraryRepository, raw: readonly unknown[], readOnly: boolean): Promise<string[]> {
  if (raw.length > 200) throw new Error('The native journal returned too many events.');
  const events = raw.map(value => schema.parse(value));
  const seen = new Set<string>();
  for (const event of events) {
    if (event.accountScope !== repo.scope || event.bookId !== event.payload.bookId || seen.has(event.id))
      throw new Error('The native journal contains a different account or duplicate event identity.');
    seen.add(event.id);
    if (event.type === 'progress' && event.fileId !== event.payload.fileId) throw new Error('The native checkpoint file changed.');
    if (event.type === 'activity' && (event.id !== event.payload.id || Date.parse(event.payload.endedAt) < Date.parse(event.payload.startedAt) ||
      event.payload.duration * 1000 > Date.parse(event.payload.endedAt) - Date.parse(event.payload.startedAt) + 1000))
      throw new Error('The native listening interval is invalid.');
  }
  const receipts = await Promise.all(events.map(async event => ({ event, fingerprint: await fingerprint(event) })));
  const db = repo.db;
  await db.transaction('rw', [db.anchors, db.books, db.sessions, db.outbox, db.nativeReceipts], async () => {
    for (const { event, fingerprint } of receipts) {
      const key = JSON.stringify([repo.scope, event.id]);
      const existing = await db.nativeReceipts.get(key);
      if (existing) {
        if (existing.value.fingerprint !== fingerprint) throw new Error('A native event ID was reused for different content.');
        continue;
      }
      // Read-only events retain that protection even after a later writable reconnect.
      const localOnly = readOnly || event.readOnly || !/^\d+$/.test(event.bookId) || !/^\d+$/.test(event.fileId);
      if (event.type === 'progress') await repo.checkpoint(event.payload as ReadingAnchor, {readOnly: localOnly});
      else {
        const { endedAt, ...session } = event.payload;
        await repo.recordSession(session as ReadingSession, event.fileId, {readOnly: localOnly, endedAt});
      }
      await db.nativeReceipts.put({key, scope: repo.scope, id: event.id, value: {fingerprint}});
    }
  });
  return events.map(event => event.id);
}

/** One bounded batch per call; a failed ack may replay safely after reload. */
export async function replayNativeJournal(journal: JournalAdapter, repo: LibraryRepository, readOnly: boolean, isActive: () => boolean): Promise<number> {
  if (!isActive()) return 0;
  const { events } = await journal.drain({accountScope: repo.scope, limit: 200});
  if (!isActive() || !events.length) return 0;
  const ids = await commitNativeEvents(repo, events, readOnly);
  if (!isActive()) return 0;
  await journal.ack({accountScope: repo.scope, ids});
  return ids.length;
}
