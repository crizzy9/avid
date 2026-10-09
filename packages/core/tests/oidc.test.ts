import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSessionOidcStorage, OidcLoginFlow, type OidcLoginOptions, type OidcTransaction } from '../src/oidc';

const profile = { id: 'server-one', name: 'Books', url: 'https://api.books.test' };
const redirectUri = 'https://books.test/oauth2-callback';
function fixture(overrides: Partial<OidcLoginOptions> = {}) {
  const values = new Map<string, string>();
  const storage = createSessionOidcStorage({ getItem: name => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value); }, removeItem: name => { values.delete(name); } });
  let now = 1_000_000, stateCount = 0;
  const exchangeBodies: Record<string, string>[] = [];
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/login-options')) return Response.json({ passwordLoginEnabled: true, allowRegistration: false,
      oidcProviders: [{ slug: 'reader-id', displayName: 'Readers', enabled: true, clientId: 'reader-app', scopes: 'openid profile email' }] });
    if (url.endsWith('/reader-id/state')) return Response.json({ state: `server-state-${++stateCount}`, authorizationEndpoint: 'https://identity.test/authorize?audience=books&state=old' });
    if (url.endsWith('/oidc/callback')) {
      exchangeBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ mode: 'login', accessToken: 'test-access', user: { id: 7, username: 'reader' } });
    }
    throw new Error('Unexpected test request');
  });
  const launch = vi.fn<(url: string) => void>();
  const options: OidcLoginOptions = { profile, redirectUri, redirectPolicy: { appUrl: 'https://books.test' }, storage,
    launchAuthorization: launch, clientOptions: { fetch: transport }, now: () => now, ...overrides };
  const flow = new OidcLoginFlow(options);
  const callback = (state: string, suffix = '') => `${options.redirectUri}?code=returned-code&state=${encodeURIComponent(state)}${suffix}`;
  const transaction = () => JSON.parse([...values.values()][0]!) as OidcTransaction;
  return { flow, options, values, launch, transport, exchangeBodies, callback, transaction, setNow: (value: number) => { now = value; } };
}

describe('BookOrbit OIDC transaction', () => {
  it('uses independent cryptographic PKCE/nonce values, preserves endpoint parameters and exchanges the exact binding once', async () => {
    const f = fixture();
    const started = await f.flow.begin('reader-id');
    const transaction = f.transaction();
    const url = new URL(started.authorizationUrl);
    expect(transaction.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction.nonce).not.toBe(transaction.codeVerifier);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(transaction.codeVerifier).digest('base64url'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.getAll('state')).toEqual([started.state]);
    expect(url.searchParams.get('audience')).toBe('books');
    expect(url.searchParams.has('code_verifier')).toBe(false);
    expect(f.launch).toHaveBeenCalledWith(started.authorizationUrl);
    const session = await f.flow.complete('reader-id', f.callback(started.state));
    expect(session.userId).toBe('7');
    expect(f.exchangeBodies).toEqual([{ code: 'returned-code', state: started.state, codeVerifier: transaction.codeVerifier,
      nonce: transaction.nonce, redirectUri, clientKind: 'web', deviceLabel: 'Avid' }]);
    expect(f.values.size).toBe(0);
    await expect(f.flow.complete('reader-id', f.callback(started.state))).rejects.toMatchObject({ reason: 'missing' });
    expect(f.exchangeBodies).toHaveLength(1);
  });
  it('restores a native transaction and opens only the injected system-browser launcher', async () => {
    const f = fixture({ redirectUri: 'avid://oauth2-callback', redirectPolicy: { appUrl: 'https://books.test', nativeRedirectUri: 'avid://oauth2-callback' } });
    f.options.clientOptions = { fetch: f.transport, clientKind: 'native' };
    const native = new OidcLoginFlow(f.options);
    const started = await native.begin('reader-id');
    await new OidcLoginFlow(f.options).complete('reader-id', f.callback(started.state));
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.exchangeBodies[0]?.clientKind).toBe('native');
    expect(f.exchangeBodies[0]?.redirectUri).toBe('avid://oauth2-callback');
  });
  it.each(['profile', 'server', 'provider', 'callback', 'client', 'transport'] as const)('rejects a %s binding mismatch before exchange and spends the transaction', async mismatch => {
    const f = fixture(); const started = await f.flow.begin('reader-id');
    const options = { ...f.options };
    let provider = 'reader-id', callback = f.callback(started.state);
    if (mismatch === 'profile') options.profile = { ...profile, id: 'different-account-profile' };
    if (mismatch === 'server') options.profile = { ...profile, url: 'https://other.books.test' };
    if (mismatch === 'provider') provider = 'different-provider';
    if (mismatch === 'callback') callback = callback.replace('/oauth2-callback', '/wrong-callback');
    if (mismatch === 'client') options.clientOptions = { ...options.clientOptions, clientKind: 'native' };
    if (mismatch === 'transport') options.clientOptions = { ...options.clientOptions, transportBaseUrl: '/different-proxy' };
    await expect(new OidcLoginFlow(options).complete(provider, callback)).rejects.toMatchObject({ reason: 'binding' });
    expect(f.exchangeBodies).toHaveLength(0);
    expect(f.values.size).toBe(0);
  });
  it.each([999_999, 1_300_000])('rejects callbacks outside the transaction time window (%s)', async time => {
    const f = fixture(); const started = await f.flow.begin('reader-id'); f.setNow(time);
    await expect(f.flow.complete('reader-id', f.callback(started.state))).rejects.toMatchObject({ reason: 'expired' });
    expect(f.exchangeBodies).toHaveLength(0);
  });
  it('allows only one concurrent completion, including across reconstructed flow instances', async () => {
    const f = fixture(); const started = await f.flow.begin('reader-id');
    const outcomes = await Promise.allSettled([f.flow.complete('reader-id', f.callback(started.state)), new OidcLoginFlow(f.options).complete('reader-id', f.callback(started.state))]);
    expect(outcomes.map(value => value.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(f.exchangeBodies).toHaveLength(1);
  });
  it('does not retry a code after an uncertain token-exchange network failure', async () => {
    const f = fixture(); const started = await f.flow.begin('reader-id');
    f.transport.mockRejectedValueOnce(new Error('Network ended without a response'));
    await expect(f.flow.complete('reader-id', f.callback(started.state))).rejects.toThrow('Network ended');
    await expect(f.flow.complete('reader-id', f.callback(started.state))).rejects.toMatchObject({ reason: 'missing' });
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it.each(['&code=duplicate', '#access_token=fragment', '&error=access_denied'] as const)('rejects malformed or denied responses (%s)', async suffix => {
    const f = fixture(); const started = await f.flow.begin('reader-id');
    await expect(f.flow.complete('reader-id', f.callback(started.state, suffix))).rejects.toBeInstanceOf(Error);
    expect(f.exchangeBodies).toHaveLength(0);
    expect(f.values.size).toBe(0);
  });
  it('rejects unknown state without consuming another outstanding attempt', async () => {
    const f = fixture(); await f.flow.begin('reader-id');
    await expect(f.flow.complete('reader-id', f.callback('unrelated-state'))).rejects.toMatchObject({ reason: 'missing' });
    expect(f.values.size).toBe(1);
    expect(f.exchangeBodies).toHaveLength(0);
  });
  it('rejects private-use scheme confusion despite both origins being null', async () => {
    const f = fixture({ redirectUri: 'avid://oauth2-callback', redirectPolicy: { appUrl: 'https://books.test', nativeRedirectUri: 'avid://oauth2-callback' } });
    const started = await f.flow.begin('reader-id');
    await expect(f.flow.complete('reader-id', f.callback(started.state).replace('avid:', 'evil:'))).rejects.toMatchObject({ reason: 'binding' });
    expect(f.exchangeBodies).toHaveLength(0);
  });
  it('clears the transaction when launch fails or the host cancels', async () => {
    const f = fixture(); f.launch.mockImplementationOnce(() => { throw new Error('Browser canceled'); });
    await expect(f.flow.begin('reader-id')).rejects.toThrow('Browser canceled');
    expect(f.values.size).toBe(0);
    const started = await f.flow.begin('reader-id'); await f.flow.cancel(started.state);
    expect(f.values.size).toBe(0);
  });
  it('does not contact the state endpoint for a missing or disabled provider', async () => {
    const f = fixture(); await expect(f.flow.begin('unknown-provider')).rejects.toMatchObject({ reason: 'provider' });
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.launch).not.toHaveBeenCalled();
  });
  it('never assumes that localhost or an arbitrary private scheme is allowlisted', () => {
    const f = fixture();
    expect(() => new OidcLoginFlow({ ...f.options, redirectUri: 'http://localhost:5173/oauth2-callback' })).toThrow('not configured');
    expect(() => new OidcLoginFlow({ ...f.options, redirectUri: 'avid://oauth2-callback' })).toThrow('not configured');
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('accepts an exact operator-configured HTTPS native callback as well as a private-use scheme', () => {
    const f = fixture();
    expect(() => new OidcLoginFlow({ ...f.options, redirectUri: 'https://avid.test/native-auth',
      redirectPolicy: { appUrl: 'https://books.test', nativeRedirectUri: 'https://avid.test/native-auth' } })).not.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('rejects corrupt stored data and removes it before any code exchange', async () => {
    const f = fixture(); const started = await f.flow.begin('reader-id');
    f.values.set([...f.values.keys()][0]!, '{malformed');
    await expect(f.flow.complete('reader-id', f.callback(started.state))).rejects.toMatchObject({ reason: 'missing' });
    expect(f.exchangeBodies).toHaveLength(0); expect(f.values.size).toBe(0);
  });
});
