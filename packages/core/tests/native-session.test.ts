import { describe, expect, it, vi } from 'vitest';
import { BookOrbitClient } from '../src/bookorbit';
import type { Session } from '../src/types';

const session: Session = {
  profile: { id: 'server', name: 'Library', url: 'https://books.example', username: 'reader' },
  userId: '7', accessToken: 'expired', refreshToken: 'refresh-one', clientKind: 'native',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const user = { id: 7, username: 'reader', active: true };

describe('saved session authentication', () => {
  it('marks native password and OIDC sessions and omits pre-existing web cookies', async () => {
    const transport = vi.fn().mockImplementation(() => reply({ mode: 'login', accessToken: 'access', refreshToken: 'refresh', user }));
    const options = { fetch: transport, clientKind: 'native' as const };
    expect((await BookOrbitClient.login(session.profile, 'password', options)).clientKind).toBe('native');
    expect((await BookOrbitClient.exchangeOidcCode(session.profile, {
      code: 'code', state: 'state', codeVerifier: 'verifier', nonce: 'nonce', redirectUri: 'avid://callback',
    }, options)).clientKind).toBe('native');
    for (const [, init] of transport.mock.calls) expect(init.credentials).toBe('omit');
  });

  it('rotates one native credential across concurrent validation and preserves the session kind', async () => {
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) return reply({ accessToken: 'fresh', refreshToken: 'refresh-two' });
      return new Headers(init?.headers).get('Authorization') === 'Bearer expired' ? reply({}, 401) : reply(user);
    });
    const changed = vi.fn();
    const client = new BookOrbitClient(session, { fetch: transport, onSessionChange: changed });
    expect(await Promise.all([client.getCurrentUser(), client.getCurrentUser()])).toEqual([
      { ...user, id: '7' }, { ...user, id: '7' },
    ]);
    const refreshes = transport.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
    expect(JSON.parse(String(refreshes[0][1]?.body))).toEqual({ refreshToken: 'refresh-one' });
    expect(transport.mock.calls.every(([, init]) => init?.credentials === 'omit')).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ ...session, accessToken: 'fresh', refreshToken: 'refresh-two' });
  });

  it('restores web-kind sessions through the persistent cookie without a body credential', async () => {
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) return reply({ accessToken: 'fresh' });
      return new Headers(init?.headers).get('Authorization') === 'Bearer expired' ? reply({}, 401) : reply(user);
    });
    const client = new BookOrbitClient({ ...session, clientKind: 'web', refreshToken: undefined }, { fetch: transport });
    await client.getCurrentUser();
    const refresh = transport.mock.calls.find(([url]) => String(url).endsWith('/auth/refresh'))!;
    expect(JSON.parse(String(refresh[1]?.body))).toEqual({});
    expect(transport.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true);
  });

  it.each([{ ...user, id: 8 }, { ...user, active: false }])('rejects a mismatched or inactive server identity', async (returned) => {
    const transport = vi.fn().mockResolvedValue(reply(returned));
    await expect(new BookOrbitClient(session, { fetch: transport }).getCurrentUser()).rejects.toMatchObject({ status: 401 });
  });

  it('does not silently exchange native auth for a cookie session when its refresh token is missing', async () => {
    const transport = vi.fn().mockResolvedValue(reply({}, 401));
    const client = new BookOrbitClient({ ...session, refreshToken: undefined }, { fetch: transport });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ status: 401 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('revokes native sessions in read-only mode without refreshing a rejected logout', async () => {
    const transport = vi.fn().mockResolvedValue(reply({}, 401));
    const client = new BookOrbitClient(session, { fetch: transport, readOnly: true });
    await expect(client.logout()).rejects.toMatchObject({ status: 401 });
    expect(transport).toHaveBeenCalledExactlyOnceWith('https://books.example/api/v1/auth/logout', expect.objectContaining({
      method: 'POST', credentials: 'omit', body: JSON.stringify({ refreshToken: 'refresh-one' }),
    }));
  });
});
