# AO3 companion on another device

Avid can connect to an explicitly configured HTTPS companion from a phone, tablet, desktop, or hosted website. The local default remains `http://127.0.0.1:43119` on the same computer. `localhost` on a phone refers to the phone; use the HTTPS address below for a companion running elsewhere.

This companion has separate AO3 credentials and in-memory sessions. It can contact only `https://archiveofourown.org` using the verified login, work subscription, chapter, work and observed EPUB routes. It has no BookOrbit connection or arbitrary proxy endpoint. Restarting loses AO3 sessions; the user connects again. Imports remain one work per Avid/AO3 account with distinct edition files, preserving prior positions and notes.

## Explicit HTTPS proxy mode

The Node service always binds to `127.0.0.1`. Set both `AVID_AO3_PUBLIC_ORIGIN` (a canonical HTTPS origin with no path or trailing slash) and `AVID_AO3_TRUSTED_PROXY` (`127.0.0.1` or `::1`) to opt into proxy mode. It then requires all of these before reading credentials or making any upstream request:

- The actual TCP peer is the configured loopback proxy. Forwarded client IP headers never establish trust.
- `Host` and `X-Forwarded-Host` exactly match the configured external HTTPS host, including a nondefault port when applicable.
- `X-Forwarded-Proto` is exactly `https`; ambiguous `Forwarded` headers are rejected.
- `Origin` is in `AVID_AO3_ORIGINS`, and requests carry the random pairing bearer. CORS preflight verifies peer/host/origin but carries no credential.

Outside this mode, forwarding headers are rejected and Host must identify the actual local listener. HTTPS addresses entered in Avid cannot contain credentials, paths, dot segments, query parameters or fragments. A nondefault HTTPS port is supported; an explicit default `:443` is rejected in favor of its canonical origin. Plain HTTP is accepted only for explicit loopback addresses and ports.

Capacitor uses the original WebView fetch for this connector. The general native HTTP patch does not preserve the required POST redirect and cancellation rules. The HTTPS host therefore needs a trusted certificate and CORS for the actual Avid origin. No certificate verification is disabled. Avid applies a timeout to headers and complete body consumption, cancels stalled streams, limits HTML/JSON and EPUB sizes, refuses redirects, omits cookies, and sends no referrer. Pairing and companion session values remain request headers, never URL parameters.

## Docker Compose example

The example under `deploy/ao3` runs Node 24 and Caddy in a shared network namespace. Caddy reaches Node through their shared loopback; only TLS/HTTP challenge ports are published, and the Node port is never exposed. Caddy replaces the forwarding headers with fixed configured values. Credentials and AO3 sessions are not saved. Caddy request/error logs are disabled because its custom companion session header must not be logged. [Caddy reverse proxy configuration](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Compose service network mode and secrets](https://docs.docker.com/reference/compose-file/services/).

1. Point a hostname you control at the deployment machine and make ports 80 and 443 reachable for TLS issuance and HTTPS. This step is an administrator action; Avid does not deploy or change DNS automatically.
2. Copy `deploy/ao3/.env.example` to `deploy/ao3/.env`. Set `AVID_AO3_HOST` to the DNS hostname, without scheme/path/port. Set the explicit Avid origins you use. The configured native origins are `capacitor://localhost` on iOS, `https://localhost` on Android, `tauri://localhost` on macOS/Linux desktop, and `http://tauri.localhost` on Windows desktop with the current Tauri default. The companion connection remains HTTPS. Add the precise HTTPS origin of any hosted Avid web client. Do not use `*` or `null`.
3. Set `AVID_AO3_UID`/`AVID_AO3_GID` to the owner of the pairing secret on hosts where Compose mounts file-backed secrets. This lets the unprivileged Node process read a mode0600 file without making it world-readable.
4. Generate a pairing secret locally. The file and `.env` are ignored by Git:

```sh
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync("deploy/ao3/.pairing-token", randomBytes(24).toString("hex") + "\n", {mode: 0o600, flag: "wx"})'
docker compose --env-file deploy/ao3/.env -f deploy/ao3/compose.yaml config --quiet
docker compose --env-file deploy/ao3/.env -f deploy/ao3/compose.yaml up --build -d
```

5. Open Avid → Integrations → AO3. Enable the connector, enter `https://your-companion-host`, the secret's pairing value, and the separate AO3 login. On a phone, do not enter the deployment machine's `localhost` address. The pairing file is an access credential; share it only with the Avid clients allowed to use this companion.

The deployment script reads the secret through `AVID_AO3_PAIRING_FILE` and does not print it. If that variable is absent, local development generates and prints a new per-run pairing value. Rotate a deployed pairing value by replacing the secret and restarting the companion; AO3 sessions clear on restart. Configure any additional host firewall/reverse proxy independently, preserving the exact trusted-loopback boundary. Do not expose port43119 or broaden the trusted proxy to an arbitrary private network.

For an existing TLS reverse proxy on the same machine, the Node environment can be configured directly instead of using Compose. Preserve its loopback bind, set the two proxy variables and explicit origins, and overwrite `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto` at that local TLS proxy. Remove incoming `Forwarded`. Keep request bodies/authorization/custom session headers out of proxy logs.

## Evidence and qualification

Controlled tests generate a one-day self-signed certificate and key in a temporary directory, trust that specific certificate for a local HTTPS client, and route a verified TLS request through a real loopback reverse proxy into the production companion. They exercise native CORS preflight, allowed-origin pairing, rejection before any upstream call, exact proxy host/protocol/peer policy, and fixture-only AO3 login. The temporary certificate/key are deleted afterward. No global TLS bypass is used. Client tests verify original native WebView fetch selection, canonical origin rules, stalled-header/body cancellation and bounded responses.

The example passes Caddy2.11.4 configuration adaptation and Compose5.5.1 configuration validation. The Node24 entry point also starts directly from the TypeScript source without installing npm dependencies. Its Dockerfile-specific ignore file uses an explicit source allowlist; `.env`, pairing secrets, user files and the rest of the repository do not enter the build context.

This is a usable deployment path, not proof of an installed phone or public deployment. No live AO3 credentials or deployment were used. Actual certificate issuance, DNS/firewall configuration, container installation, physical iOS/Android WebView CORS, AO3 account challenges and a real followed-work update remain qualification gates. The container tags track Node24/Caddy2; an operator should pin the tested image digests for a release deployment.
