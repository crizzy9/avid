import { describe, expect, it, vi } from 'vitest';
import { SessionPersistence } from './sessionPersistence';
import type { NativeSessionRecord, NativeSessionVault } from '../../mobile/src/native-session';
import type { Session } from '../../../packages/core/src/types';
const session = (token: string): Session => ({ profile: { id: 's', name: 'Test', url: 'https://books.example' }, userId: '1', accessToken: token });
function fixture() {
  let state: NativeSessionRecord = { generation: 'initial' };
  const vault: NativeSessionVault = {
    read: vi.fn(async () => structuredClone(state)),
    write: vi.fn(async value => {
      if (value.expectedGeneration !== state.generation) throw new Error('stale');
      state = { generation: crypto.randomUUID(), session: value.session, readOnly: value.readOnly };
      return state;
    }),
    clear: vi.fn(async () => state = { generation: crypto.randomUUID() }),
  };
  return { vault, persistence: new SessionPersistence(vault), state: () => state };
}
describe('secure session persistence ordering', () => {
  it('keeps browser sessions out of persistent storage', async () => {
    const persistence = new SessionPersistence(null);
    expect(await persistence.read()).toBeNull();
    await persistence.persist(session('memory-only'), true, () => true);
    expect(await persistence.read()).toBeNull();
  });
  it('serializes rotating credentials with fresh native generations', async () => {
    const { persistence, state, vault } = fixture();
    await Promise.all([persistence.persist(session('old'), true, () => true), persistence.persist(session('new'), true, () => true)]);
    expect(state().session?.accessToken).toBe('new');
    expect(state().readOnly).toBe(true);
    expect(vault.read).toHaveBeenCalledTimes(1);
  });
  it('can persist a later sign-in after a transient locked-device read failure', async () => {
    const { persistence, vault, state } = fixture();
    vi.mocked(vault.read).mockRejectedValueOnce(new Error('Device locked'));
    await expect(persistence.read()).rejects.toThrow('Device locked');
    await persistence.persist(session('new-login'), true, () => true);
    expect(state().session?.accessToken).toBe('new-login');
    expect(vault.read).toHaveBeenCalledTimes(2);
  });
  it('cancels queued refreshes at logout and clears an in-flight write afterward', async () => {
    const { persistence, state, vault } = fixture();
    let finish!: () => void;
    const original = vault.write;
    vault.write = vi.fn(async value => { await new Promise<void>(resolve => { finish = resolve; }); return original(value); });
    const saving = persistence.persist(session('old'), false, () => true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const obsolete = persistence.persist(session('late'), false, () => true);
    const clearing = persistence.clear();
    finish();
    await Promise.all([saving, obsolete, clearing]);
    expect(state().session).toBeUndefined();
    expect(vault.write).toHaveBeenCalledTimes(1);
  });
  it('drops callbacks that belong to a disconnected account', async () => {
    const { persistence, vault } = fixture();
    let active = true;
    const saving = persistence.persist(session('late'), false, () => active);
    active = false;
    await saving;
    expect(vault.write).not.toHaveBeenCalled();
  });
  it('never retries a stale generation over a newer owner', async () => {
    const { persistence, vault, state } = fixture();
    await persistence.read();
    await vault.write({ expectedGeneration: 'initial', session: session('other-owner'), readOnly: true });
    await expect(persistence.persist(session('stale'), false, () => true)).rejects.toThrow('stale');
    expect(state().session?.accessToken).toBe('other-owner');
    expect(vault.write).toHaveBeenCalledTimes(2);
  });
});
