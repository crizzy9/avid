import { BookOrbitClient, type ClientOptions } from '../../../packages/core/src/bookorbit';
import type { Session } from '../../../packages/core/src/types';
import type { SessionPersistence } from './sessionPersistence';

/** Validate identity and durably save rotated credentials before loading the catalog. */
export async function restoreNativeSession(
  persistence: SessionPersistence,
  options: (url: string) => ClientOptions,
  connect: (session: Session, readOnly: boolean, active: () => boolean) => Promise<void>,
  active: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  const saved = await persistence.read();
  if (!saved?.session || !active()) return;
  const readOnly = saved.readOnly !== false;
  const client = new BookOrbitClient(saved.session, {...options(saved.session.profile.url), readOnly});
  await client.getCurrentUser(signal);
  if (!active()) return;
  // A later catalog failure must not strand a rotated refresh token in memory.
  await persistence.persist(client.session, readOnly, active);
  if (active()) await connect(client.session, readOnly, active);
}
