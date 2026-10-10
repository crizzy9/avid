import { beforeEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ native: false, available: false, vault: { read: vi.fn(), write: vi.fn(), clear: vi.fn() } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => runtime.native, isPluginAvailable: () => runtime.available }, registerPlugin: () => runtime.vault }));
import { nativeSessionStore } from './native-session';

describe('secure native session capability', () => {
  beforeEach(() => { runtime.native = false; runtime.available = false; });
  it('has no browser or missing-plugin credential-storage fallback', () => {
    expect(nativeSessionStore()).toBeNull();
    runtime.native = true; expect(nativeSessionStore()).toBeNull();
  });
  it('returns the registered platform vault only', () => {
    runtime.native = true; runtime.available = true;
    expect(nativeSessionStore()).toBe(runtime.vault);
  });
});
