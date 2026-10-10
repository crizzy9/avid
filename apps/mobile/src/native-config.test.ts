import { describe, expect, it } from 'vitest';
import config from '../capacitor.config';

describe('native transport configuration', () => {
  it('uses native authenticated HTTP without weakening transport security', () => {
    expect(config.plugins?.CapacitorHttp?.enabled).toBe(true);
    expect(config.android?.allowMixedContent).toBe(false);
    expect(config.server?.cleartext).not.toBe(true);
    expect(config.server?.allowNavigation).toBeUndefined();
  });
});
