# Avid

A personal BookOrbit reader built with React and TypeScript. Avid follows Apogee Reader's cover-first library, resume, reading, listening, and notebook workflows with original application code and artwork.

**Status: working Phase 1 development preview, not a completed parity release.** The research calls for 66 Phase 1 requirements across web, iOS, Android, macOS, Windows, and Linux. Native platform sources are included, but signed builds, physical-device qualification, several integrations, and release gates remain open. See [the feature checklist](docs/phase-1-status.md).

## Run

Requires Node.js 22.12+ and pnpm 10.

```sh
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. The initial library is an explicitly labeled local sample. Its original covers and reader content are included, so exploring it sends no third-party requests. Use **+ → Open a book from this device** to try a real file, or connect a BookOrbit server.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

## BookOrbit

The adapter's reference contract is BookOrbit **v3.3.0**, pinned to commit `e767358443419253eeed782518d6fc4f675d69fd`. API routes, unsupported cases, and synchronization behavior are documented in [the contract notes](docs/bookorbit-contract.md).

The connection screen defaults to **read-only**: authentication and catalog queries are permitted, while progress, annotation, upload, membership, and other library mutations are rejected. Local checkpoints and notes remain scoped to the server/account. Browser sessions remain in memory. Native sign-in tokens use Keychain or Keystore-protected storage, with account verification on restore; passwords are not saved. Passwords and tokens are never written into the repository or book documents. Native positions and listening intervals are journaled in SQLite before replay into the account-scoped sync outbox; read-only provenance survives reconnects.

For a development server without CORS, copy `.env.example` to `.env.local`, set `VITE_BOOKORBIT_PROXY_ORIGIN` to its origin, and restart Vite. The proxy also defaults to read-only and blocks mutations before forwarding. Changing `AVID_PROXY_READ_ONLY` to `false` is an explicit development configuration choice; do not do this against a read-only test server. The Vite proxy is not a production server. Production deployments need a same-origin reverse proxy or explicit BookOrbit CORS configuration.

## Workspace

- `apps/web`: shared responsive library, details, notebook, activity, connection, reader, and player UI.
- `packages/core`: validated BookOrbit client, account-scoped Dexie repositories, synchronization outbox.
- `packages/readers`: isolated EPUB/MOBI engine, PDF.js viewer, archive comic reader, typography and annotations.
- `packages/playback`: audio transport, speech, alignment/codec utilities, platform capabilities.
- `apps/mobile`: Capacitor configuration and native playback owner source.
- `apps/desktop`: Tauri 2 shell.
- `docs`: research baseline, API evidence, platform setup, and release checklist.

## Boundaries

Full offline downloads are Phase 2. Locally opening a file or caching a checkpoint does not make a book an offline download. Browser audio and speech depend on browser lifecycle and available codecs/voices. Unsigned iOS app/widget/CarPlay, Android debug/Auto, and linked macOS/Windows/Linux hosts compile in CI. Signing, installation, physical background playback, widgets, intents and car acceptance remain release gates. Read and Listen requires real EPUB media overlays or a verified alignment map. Explicit standalone linking verifies complete matching audio bytes and the exact EPUB/manifest edition; it does not generate alignment.

The optional AO3 companion runs locally with `node scripts/ao3-companion.mjs`. Enable it explicitly in Integrations, pair it using the printed code, and select followed-work editions to import. Imported editions remain on this device and preserve earlier files, notes and positions. See [connector setup](docs/integrations.md).

No analytics, advertising, purchase SDKs, or external font services are included. Diagnostic export is explicit and contains capability information only. Do not commit server credentials, private publications, or personal library fixtures.

## Upstream notices

Foliate.js is vendored at a pinned commit with its MIT license and an Avid modification notice. Other dependencies remain under their respective licenses. Apogee code and visual assets are not bundled. Sample cover illustrations and narration text were created for Avid; the sample recording uses a local eSpeak voice. The saved research is retained in `docs/research-baseline.md` for traceability.
