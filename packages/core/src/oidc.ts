import { z } from 'zod';
import { BookOrbitClient, normalizeServerUrl, type ClientOptions } from './bookorbit';
import type { ServerProfile, Session } from './types';

const MAX_AGE_MS = 5 * 60 * 1000;
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const stateValue = z.string().min(1).max(512);
const transactionSchema = z.object({
  version: z.literal(1), state: stateValue, providerSlug: z.string().min(1),
  profileId: z.string().min(1), serverUrl: z.string().url(), redirectUri: z.string().min(1),
  clientKind: z.enum(['web', 'native']), transportBaseUrl: z.string().optional(),
  codeVerifier: secret, nonce: secret,
  createdAt: z.number().finite(), expiresAt: z.number().finite(),
});
/** Secret, short-lived transaction. Never put it in logs, URLs or synchronized app data. */
export type OidcTransaction = z.infer<typeof transactionSchema>;
type MaybePromise<T> = T | Promise<T>;
export interface OidcTransactionStorage {
  /** Must fail if the state already exists. Native implementations should use secure storage. */
  save(transaction: OidcTransaction): MaybePromise<void>;
  /** Atomically read and remove. Required across concurrent callbacks/processes. */
  take(state: string): MaybePromise<unknown | undefined>;
}
export type OidcFailure = 'configuration' | 'provider' | 'callback' | 'missing' | 'binding' | 'expired' | 'denied';
export class OidcLoginError extends Error {
  constructor(public readonly reason: OidcFailure, message: string) { super(message); this.name = 'OidcLoginError'; }
}
export interface OidcRedirectPolicy {
  /** Deployment APP_URL, supplied by its operator. It is not inferred from the API URL. */
  appUrl: string;
  /** Exact NATIVE_OIDC_REDIRECT_URI, only when configured on this server and provider. */
  nativeRedirectUri?: string;
}
export interface OidcLoginOptions {
  profile: ServerProfile;
  redirectUri: string;
  redirectPolicy: OidcRedirectPolicy;
  storage: OidcTransactionStorage;
  /** Native hosts must use their system authentication browser, not a book or login WebView. */
  launchAuthorization: (url: string) => MaybePromise<void>;
  clientOptions?: ClientOptions;
  crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  now?: () => number;
  /** May shorten the local lifetime, never lengthen the server's default five minutes. */
  lifetimeMs?: number;
}
export interface OidcLaunch { state: string; authorizationUrl: string; expiresAt: number }

function parseUrl(raw: string): URL {
  try { return new URL(raw); } catch { throw new OidcLoginError('configuration', 'The sign-in URL is invalid.'); }
}
function checkRedirect(redirectUri: string, policy: OidcRedirectPolicy): void {
  const candidate = parseUrl(redirectUri);
  const app = parseUrl(policy.appUrl);
  if (!['https:', 'http:'].includes(app.protocol) || app.username || app.password || app.search || app.hash
    || candidate.username || candidate.password || candidate.search || candidate.hash || redirectUri.length > 2048) {
    throw new OidcLoginError('configuration', 'Use an explicit callback without credentials, query parameters or fragments.');
  }
  const webCallback = new URL(`${policy.appUrl.replace(/\/$/, '')}/oauth2-callback`).href;
  const isWeb = ['https:', 'http:'].includes(candidate.protocol);
  const allowedWeb = isWeb && candidate.href === webCallback;
  const allowedNative = redirectUri === policy.nativeRedirectUri && !['javascript:', 'data:', 'file:', 'blob:', 'about:'].includes(candidate.protocol);
  if (!allowedWeb && !allowedNative) {
    throw new OidcLoginError('configuration', 'This callback is not configured for this BookOrbit deployment.');
  }
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function one(params: URLSearchParams, name: string, max: number, required = true): string | undefined {
  const values = params.getAll(name);
  if ((!values.length && required) || values.length > 1 || (values.length && (!values[0] || values[0].length > max))) {
    throw new OidcLoginError('callback', 'The sign-in callback is missing required data or contains ambiguous parameters.');
  }
  return values[0];
}
function callbackMatches(raw: string, expected: string): boolean {
  const received = parseUrl(raw);
  if (received.username || received.password || received.hash) return false;
  if (['http:', 'https:'].includes(received.protocol)) {
    received.search = '';
    return received.href === new URL(expected).href;
  }
  // Private-use schemes must never be compared by URL.origin (which is always "null").
  return raw.split('?')[0] === expected;
}

/** One profile/deployment binding; safe to reconstruct after a callback or process restart. */
export class OidcLoginFlow {
  private readonly profile: ServerProfile;
  private readonly client: ClientOptions;
  private readonly now: () => number;
  private readonly crypto: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  private readonly lifetime: number;
  private readonly redirectUri: string;
  constructor(private readonly options: OidcLoginOptions) {
    checkRedirect(options.redirectUri, options.redirectPolicy);
    this.profile = { ...options.profile, url: normalizeServerUrl(options.profile.url) };
    if (!this.profile.id) throw new OidcLoginError('configuration', 'A saved server profile is required for sign-in.');
    this.redirectUri = options.redirectUri;
    this.client = { ...options.clientOptions };
    this.now = options.now ?? Date.now;
    this.crypto = options.crypto ?? globalThis.crypto;
    if (!this.crypto?.getRandomValues || !this.crypto?.subtle) throw new OidcLoginError('configuration', 'Secure Web Crypto is required for provider sign-in.');
    this.lifetime = options.lifetimeMs ?? MAX_AGE_MS;
    if (!Number.isFinite(this.lifetime) || this.lifetime <= 0 || this.lifetime > MAX_AGE_MS) throw new OidcLoginError('configuration', 'The sign-in lifetime must be at most five minutes.');
  }
  async begin(providerSlug: string): Promise<OidcLaunch> {
    const login = await BookOrbitClient.loginOptions(this.profile.url, this.client);
    const providers = login.oidcProviders.filter(provider => provider.slug === providerSlug && provider.enabled);
    if (providers.length !== 1 || !providers[0]!.clientId.trim() || !providers[0]!.scopes.split(/\s+/).includes('openid')) {
      throw new OidcLoginError('provider', 'This server has not enabled a valid OpenID Connect provider with that name.');
    }
    const provider = providers[0]!;
    const codeVerifier = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    const nonce = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await this.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));
    const createdAt = this.now();
    if (!Number.isFinite(createdAt)) throw new OidcLoginError('configuration', 'The device clock is unavailable.');
    const response = await BookOrbitClient.createOidcState(this.profile.url, providerSlug, this.client);
    const endpoint = parseUrl(response.authorizationEndpoint);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new OidcLoginError('configuration', 'The provider authorization endpoint must be an HTTP or HTTPS URL without credentials or a fragment.');
    }
    const state = stateValue.parse(response.state);
    const expiresAt = createdAt + this.lifetime;
    if (this.now() >= expiresAt) throw new OidcLoginError('expired', 'Sign-in expired before the provider could open. Start again.');
    const params = { response_type: 'code', response_mode: 'query', client_id: provider.clientId, redirect_uri: this.redirectUri,
      scope: provider.scopes, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
    for (const [name, value] of Object.entries(params)) endpoint.searchParams.set(name, value);
    await this.options.storage.save({ version: 1, state, providerSlug, profileId: this.profile.id, serverUrl: this.profile.url,
      redirectUri: this.redirectUri, clientKind: this.client.clientKind ?? 'web', transportBaseUrl: this.client.transportBaseUrl,
      codeVerifier, nonce, createdAt, expiresAt });
    const authorizationUrl = endpoint.href;
    try { await this.options.launchAuthorization(authorizationUrl); }
    catch (error) { await this.options.storage.take(state); throw error; }
    return { state, authorizationUrl, expiresAt };
  }
  async complete(providerSlug: string, callbackUrl: string): Promise<Session> {
    const callback = parseUrl(callbackUrl);
    const state = one(callback.searchParams, 'state', 512)!;
    // Consume before binding checks or network requests. No retry can reuse a known transaction.
    const stored = await this.options.storage.take(state);
    if (stored === undefined || stored === null) throw new OidcLoginError('missing', 'This sign-in attempt is missing, expired or already used. Start again.');
    const parsed = transactionSchema.safeParse(stored);
    if (!parsed.success) throw new OidcLoginError('binding', 'The saved sign-in attempt is invalid. Start again.');
    const transaction = parsed.data;
    if (transaction.state !== state || transaction.profileId !== this.profile.id || transaction.serverUrl !== this.profile.url
      || transaction.providerSlug !== providerSlug || transaction.redirectUri !== this.redirectUri
      || transaction.clientKind !== (this.client.clientKind ?? 'web') || transaction.transportBaseUrl !== this.client.transportBaseUrl
      || !callbackMatches(callbackUrl, transaction.redirectUri)) {
      throw new OidcLoginError('binding', 'This callback does not belong to this server, provider or sign-in location. Start again.');
    }
    const now = this.now();
    if (!Number.isFinite(now) || now < transaction.createdAt || now >= transaction.expiresAt
      || transaction.expiresAt <= transaction.createdAt || transaction.expiresAt - transaction.createdAt > MAX_AGE_MS) {
      throw new OidcLoginError('expired', 'This sign-in attempt has expired. Start again.');
    }
    const error = one(callback.searchParams, 'error', 512, false);
    const code = one(callback.searchParams, 'code', 2048, !error);
    if (error) throw new OidcLoginError('denied', 'The provider did not complete sign-in. Start again when ready.');
    return BookOrbitClient.exchangeOidcCode(this.profile, { code: code!, state, codeVerifier: transaction.codeVerifier,
      nonce: transaction.nonce, redirectUri: transaction.redirectUri }, this.client);
  }
  /** Abandon a pending attempt after an explicit browser cancellation. */
  async cancel(state: string): Promise<void> { await this.options.storage.take(state); }
}

/** Tab-scoped web adapter. Native hosts must provide a durable, atomic secure-store adapter. */
export function createSessionOidcStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): OidcTransactionStorage {
  const key = (state: string) => `avid.oidc.v1.${encodeURIComponent(state)}`;
  return {
    save(transaction) {
      const name = key(transaction.state);
      if (storage.getItem(name) !== null) throw new OidcLoginError('binding', 'This sign-in state is already in use.');
      storage.setItem(name, JSON.stringify(transaction));
    },
    take(state) {
      const name = key(state), value = storage.getItem(name);
      storage.removeItem(name);
      if (value === null) return undefined;
      try { return JSON.parse(value); } catch { return null; }
    },
  };
}
