import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../packages/core/src/types';
import { startNativeAuthentication } from './nativeAuthentication';

const session: Session = { profile: { id: 's', name: 'Library', url: 'https://books.example' }, userId: '1', accessToken: 'token' };
function setup() {
  let attempt: number | null = null;
  let generation = 0;
  let event = () => {};
  const remove = vi.fn(async () => {});
  const provider = {
    subscribe: vi.fn(async (callback: () => void) => { event = callback; return { remove }; }),
    pending: vi.fn(async (): Promise<any> => null),
    resume: vi.fn(async (): Promise<{session: Session; readOnly: boolean} | null> => null),
  };
  const options = {
    provider,
    canRestore: () => generation === 0,
    attempt: () => attempt,
    claimStartup: () => { attempt = 0; },
    active: (id: number) => attempt === id && generation === id,
    connect: vi.fn(async (_session: Session, _readOnly: boolean, _active: () => boolean) => {}),
    connected: vi.fn(() => { attempt = null; generation++; }),
    restore: vi.fn(async () => {}),
    error: vi.fn(),
  };
  return { options, provider, remove, event: () => event(), supersede: () => { generation++; attempt = null; } };
}
describe('native authentication startup ordering', () => {
  it('completes a durable callback before any vault restoration', async () => {
    const h = setup(); h.provider.resume.mockResolvedValue({ session, readOnly: true });
    const stop = startNativeAuthentication(h.options);
    await vi.waitFor(() => expect(h.options.connected).toHaveBeenCalledOnce());
    expect(h.options.connect).toHaveBeenCalledWith(session, true, expect.any(Function));
    expect(h.options.restore).not.toHaveBeenCalled(); stop();
  });
  it('keeps a pending system-browser attempt intact until its callback arrives', async () => {
    const h = setup(); h.provider.pending.mockResolvedValue({ state: 'pending' });
    const stop = startNativeAuthentication(h.options);
    await vi.waitFor(() => expect(h.provider.pending).toHaveBeenCalledOnce());
    expect(h.options.restore).not.toHaveBeenCalled();
    h.provider.resume.mockResolvedValue({ session, readOnly: true }); h.event(); h.event();
    await vi.waitFor(() => expect(h.options.connected).toHaveBeenCalledOnce());
    expect(h.options.connect).toHaveBeenCalledOnce(); stop();
  });
  it('restores the saved account only after proving there is no pending callback', async () => {
    const h = setup(); const stop = startNativeAuthentication(h.options);
    await vi.waitFor(() => expect(h.options.restore).toHaveBeenCalledOnce());
    expect(h.provider.pending.mock.invocationCallOrder[0]).toBeLessThan(h.options.restore.mock.invocationCallOrder[0]!); stop();
  });
  it.each(['manual', 'unmount'])('ignores a late exchange after %s supersedes it', async reason => {
    const h = setup();
    let resolve!: (value: {session: Session; readOnly: boolean}) => void;
    h.provider.resume.mockReturnValue(new Promise(done => { resolve = done; }));
    const stop = startNativeAuthentication(h.options);
    await vi.waitFor(() => expect(h.provider.resume).toHaveBeenCalledOnce());
    if (reason === 'manual') h.supersede(); else stop();
    resolve({ session, readOnly: false });
    await new Promise(done => setTimeout(done, 0));
    expect(h.options.connect).not.toHaveBeenCalled(); expect(h.options.restore).not.toHaveBeenCalled(); stop();
  });
});
