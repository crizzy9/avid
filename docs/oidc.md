# BookOrbit provider sign-in

`packages/core/src/oidc.ts` implements a login transaction around the verified BookOrbit v3.3.0 APIs. It does not enable provider login in the interface or prove a deployment's external identity-provider configuration. It makes no provider requests in tests.

The contract is pinned to commit `e767358443419253eeed782518d6fc4f675d69fd`. Relevant upstream sources are the [redirect allowlist](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/modules/auth/oidc/redirect-uri.ts), [provider/state/token exchange service](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/modules/auth/oidc/oidc.service.ts), [one-use state store](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/modules/auth/oidc/oidc-state.service.ts), and [BookOrbit web client's PKCE flow](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/client/src/features/auth/composables/useOidc.ts).

## Deployment requirement

BookOrbit accepts its configured `APP_URL` plus `/oauth2-callback`, or the **exact** configured `NATIVE_OIDC_REDIRECT_URI`. The provider must also register the selected callback. The API URL does not establish `APP_URL`, and neither a local Vite callback nor an arbitrary Avid deep link is automatically supported. A same-origin API proxy does not change this server allowlist.

The caller must supply confirmed `redirectPolicy` values for the selected server. Avid cannot discover those deployment values from `login-options`. The helper checks its explicit policy; it cannot verify an operator's settings remotely. Use HTTPS deployment and provider endpoints. The helper accepts HTTP for explicitly configured development deployments, which still require a secure context providing Web Crypto.

For a web deployment, Avid must actually own the allowlisted callback route and restore its initiating tab's transaction. Redirecting to an existing BookOrbit front end will not transfer its authentication into an unrelated Avid origin. For native deployment, register the exact callback with the OS and provider, then route the full returned URL into the transaction owner. An HTTPS native callback additionally requires qualified Universal Links/App Links configuration.

## Integration API

```ts
import { OidcLoginFlow, createSessionOidcStorage } from '../packages/core/src/oidc';

const flow = new OidcLoginFlow({
  profile: selectedServerProfile,
  redirectUri: 'https://books.example/oauth2-callback',
  redirectPolicy: { appUrl: 'https://books.example' }, // Confirmed deployment APP_URL.
  storage: createSessionOidcStorage(window.sessionStorage),
  launchAuthorization: url => window.location.assign(url),
  clientOptions: { clientKind: 'web' },
});

await flow.begin(selectedProviderSlug);
// At the callback route, reconstruct with the same profile/policy and initiating tab storage.
const session = await flow.complete(selectedProviderSlug, window.location.href);
// Install this session using the app's ordinary authenticated-session path.
```

Persist only the non-secret selected profile/provider routing information needed to reconstruct the owner. Do not choose those bindings from callback-supplied query parameters. Process the full URL once, then remove the callback's code/state from browser history. A provider error or failed exchange requires a fresh `begin()`; `cancel(state)` abandons an explicit browser cancellation.

Native hosts supply `clientOptions.clientKind: 'native'`, their exact configured `redirectUri`, an injected `launchAuthorization` that uses the system authentication browser, and an `OidcTransactionStorage` backed by platform secure storage. `save` must reject an existing state. `take` must atomically read and delete across concurrent callbacks/processes, including after restart. Native storage should evict records at `expiresAt`. The web adapter uses tab-scoped `sessionStorage`; it is not a substitute for native secure storage or a cross-tab shared transaction database.

## Transaction rules and evidence

Each attempt uses independent 32-byte cryptographic PKCE verifier and nonce values. The authorization URL receives an S256 challenge, response type `code`, query response mode, provider client ID/scopes, and the server-generated state. The verifier never enters that URL. The transaction binds the exact profile ID and normalized server URL, provider slug, redirect URI, client kind, optional proxy transport, and creation/expiration times. Its local lifetime is at most five minutes; a server configured with a shorter TTL remains authoritative.

A callback containing a known state atomically consumes the transaction **before** binding checks and code exchange. Mismatches, denial, expired state, corrupt storage, duplicate response parameters and uncertain network failures do not permit replay. Private-use callbacks are compared by exact scheme/route, never by their `null` URL origin. The exchange always receives the stored verifier, nonce and redirect URI; BookOrbit validates provider state and ID-token claims. No identity token is decoded and trusted by the UI.

Offline tests cover S256 against an independent SHA-256 implementation, independent nonce/verifier generation, web/native completion, reconstructed and concurrent one-use behavior, profile/server/provider/callback/client/transport mismatch, expiry and backward time, private-scheme confusion, malformed/denied responses, unavailable providers, cancellation, launch failure, corrupt storage and uncertain exchange failure. Actual provider login, callback routing, native process restart, secure storage, and OS browser dismissal still require a configured disposable deployment and device qualification. The supplied read-only server is not used for provider experiments.
