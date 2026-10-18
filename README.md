# Avid

A personal reading and audiobook application built with React and TypeScript. Avid follows Apogee Reader's cover-first library, resume, reading, listening, and notebook workflows with original application code and artwork.

The interface follows the observed Apogee phone and tablet layouts: Home/Library/Browse/More navigation, a separate Search control, tinted resume view, compact media shelves, book sheets, and quiet reading chrome. The user's replica request supersedes the saved research's earlier redesign direction. [Reference coverage](docs/reference-layout.md) records what was compared and what still needs an installed-app audit.

**Status: working Phase 1 development preview, not a completed parity release.** The research calls for 66 Phase 1 requirements across web, iOS, Android, macOS, Windows, and Linux. Web and native implementations, tests and unsigned build packages are included. Signed builds, installed-device acceptance and live integration qualification remain open. See [the feature checklist](docs/phase-1-status.md).

The [current roadmap](docs/roadmap.md) is: **1 — core online product; 2 — complete audiobook experience; 3 — full offline support; 4 — Apple Pencil and reader enhancements; 5 — UI enhancements; 6 — comparison-reference cleanup, README/docs and launch.** The [Phase 1 validation guide](docs/phase-1-validation.md) gives build/install steps, required devices/accounts and the checks needed to finish pending items. Phase 6 includes removing all Apogee mentions from release content.

The [Phase 2 audiobook plan](docs/phase-2-audiobook-plan.md) makes listening a primary workflow, with a dedicated library/queue, comprehensive controls, native playback and full-book Read & Listen qualification. It includes a dated Plappa/Absorb/Audiobookshelf feature inventory, explicit settings and delivery gates. These are planned requirements, not a claim of current parity. The [full-book test plan](docs/phase-2-full-book-validation.md) is the next matching milestone; broader offline functionality remains Phase 3.

**Phase 2 includes a bounded Prepare Read & Listen implementation:** compare an independent EPUB and audiobook locally, generate paragraph alignment from recognized speech, and retain the complete sources for offline read-along. Use **More → Prepare Read & Listen**, select a loaded title with both formats, then explicitly start preparation in its reader. This implementation supports English narration and foreground use, with Balanced and Compact recognition options and visible word coverage. Real human-audio benchmarks and a browser fixture are available; installed-device and full-book acceptance remain open. The prepared viewer keeps positions only for its current session and does not save notes or highlights. Broader offline editing, durable progress/reconciliation and the full offline library are deferred to Phase 3. See the [read-along guide](docs/phase-2-3-read-along.md); neither phase is complete, and Phase 1 still has implementation and acceptance work.

The [October 18 reference update](docs/apogee-release-delta-2026-10-18.md) tracks Apogee 1.1.1 and corrects the original research's omission of preparation. Home now supports account-scoped collection/smart-scope pins with reordering and paginated opening. The reference checklist distinguishes implemented slices from unverified parity.

Recent release updates also add a selection card (notes, colors, lookup, translation and sharing), PDF fit/highlight corrections, optional publication formatting, [bounded AO3 work-skin restoration](docs/ao3-formatting.md), comic story-arc browsing, and a single top notification banner. **More → Book requests** supports ebook/audio/both where the server advertises support; a book's **More** tools can request its missing format. Reader settings list explicitly selected online voices with provider names. See [BookOrbit 3.4 contracts and limitations](docs/bookorbit-3.4.md). Offline server-voice downloads and batch downloads remain Phase 3.

## Run

The Nix development shell provides Node.js 24 and pnpm 10.34.5. With Nix's `nix-command` and `flakes` features enabled:

```sh
nix develop
pnpm install --frozen-lockfile
pnpm dev
```

Without Nix, install those Node/pnpm versions, skip `nix develop`, and run the pnpm commands directly. The [development environment guide](docs/dev-environment.md) covers optional direnv setup and the separate desktop/Android shells. Entering a shell does not install workspace dependencies or start a server.

Open `http://127.0.0.1:5173`. The initial library is an explicitly labeled local sample. Its original covers and reader content are included, so exploring it sends no third-party requests. Use **More → Open or upload a book** to try a real file, or connect a BookOrbit server.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

## BookOrbit

The adapter's reference contract is BookOrbit **v3.3.0**, pinned to commit `e767358443419253eeed782518d6fc4f675d69fd`. API routes, unsupported cases, and synchronization behavior are documented in [the contract notes](docs/bookorbit-contract.md).

The connection screen defaults to **read-only**: authentication and catalog queries are permitted, while progress, annotation, upload, membership, and other library mutations are rejected. Local checkpoints and notes remain scoped to the server/account. Browser sessions remain in memory. Native sign-in tokens use Keychain, Keystore, or desktop credential storage, with account verification on restore; passwords are not saved. Passwords and tokens are never written into the repository or book documents. Native positions and listening intervals are journaled in SQLite before replay into the account-scoped sync outbox; read-only provenance survives reconnects.

For a development server without CORS, copy `.env.example` to `.env.local`, set `VITE_BOOKORBIT_PROXY_ORIGIN` to its origin, and restart Vite. The proxy also defaults to read-only and blocks mutations before forwarding. Changing `AVID_PROXY_READ_ONLY` to `false` is an explicit development configuration choice; do not do this against a read-only test server. The Vite proxy is not a production server. Production deployments need a same-origin reverse proxy or explicit BookOrbit CORS configuration.

## Workspace

- `apps/web`: shared responsive library, details, notebook, activity, connection, reader, and player UI.
- `packages/core`: validated BookOrbit client, account-scoped IndexedDB/SQLite storage protocol and verified migration, synchronization outbox.
- `packages/readers`: isolated EPUB/MOBI engine, PDF.js viewer, archive comic reader, typography and annotations.
- `packages/playback`: audio transport, speech, alignment/codec utilities, platform capabilities.
- `apps/mobile`: Capacitor hosts with native playback, protected sessions, SQLite library storage and device integrations.
- `apps/desktop`: Tauri 2 host with protected sessions, SQLite, native media/speech, tray and macOS search.
- `docs`: research baseline, API evidence, platform setup, and release checklist.

## Boundaries

Prepared read-along playback belongs to Phase 2; full offline support remains deferred to Phase 3. Preparation currently permits **64 MiB per EPUB, 512 MiB per audio asset and 2 GiB total per prepared book**, subject to browser storage/memory and codec support. It downloads a pinned English speech model and the required recording, then processes the audio locally. A fixed twelve-excerpt human audiobook benchmark linked 10/12 source excerpts with the Balanced model, versus 5/12 with Compact. The improved matcher linked 19/21 controlled reflowed passages with Balanced, while leaving all twelve unrelated-book controls unmapped. These are small-sample results, not a general book-accuracy claim; see the [benchmark and reproduction guide](docs/read-listen-benchmark.md).

Completed preparation stores the complete source bytes and verified alignment. The foreground viewer can reopen those assets without another model run or server sign-in. Web cold starts also require the production build over HTTPS or localhost, loaded and reopened once so its service worker controls the app; development mode needs Vite running. Existing SMIL packages remain readable, and previously saved offline notes/progress databases are preserved, but the active prepared viewer neither reads nor updates those databases. Browser storage can be evicted or cleared. Resumable large-file downloads, native offline background playback and Phase 3 editing/reconciliation remain pending. See the [test and recovery instructions](docs/phase-2-3-read-along.md).

Browser audio and speech depend on browser lifecycle and available codecs/voices. Unsigned iOS app/widget/CarPlay, Android debug/Auto, and linked macOS/Windows/Linux hosts have compiled in CI at recorded checkpoints; those results do not certify the new preparation flow. Signing, installation, physical background playback, widgets, intents and car acceptance remain release gates. Existing SMIL linking verifies matching narration bytes and the exact EPUB/manifest edition. Generated preparation instead uses actual speech timestamps and EPUB passages, independent of chapter labels. It preserves uncertain passages as gaps and verifies the saved edition again when reopening.

CrossPoint delivery includes device inspection, a reviewed EPUB transfer and checksum verification, with isolated native transports and explicit discovery. Physical reader/firmware qualification remains open.

The optional AO3 companion runs locally with `node scripts/ao3-companion.mjs`, or through the included [HTTPS deployment](docs/ao3-deployment.md) for phones and hosted clients. Enable it explicitly in Integrations, pair it using the local or deployed companion’s code, and select followed-work editions to import. Imported editions remain on this device and preserve earlier files, notes and positions. See [connector setup](docs/integrations.md).

No analytics, advertising, purchase SDKs, or external font services are included. Diagnostic export is explicit and contains capability information only. Do not commit server credentials, private publications, or personal library fixtures.

## Upstream notices

Foliate.js is vendored at a pinned commit with its MIT license and an Avid modification notice. Other dependencies remain under their respective licenses. Apogee code and visual assets are not bundled. Sample cover illustrations and narration text were created for Avid; the original sample recording uses a local eSpeak voice. A separate development-only human-narration fixture uses an attributed [LibriSpeech excerpt under CC BY 4.0](packages/readers/fixtures/PREPARATION-LICENSE.md). The saved research is retained in `docs/research-baseline.md` for traceability.
