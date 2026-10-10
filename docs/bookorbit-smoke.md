# Disposable BookOrbit integration smoke

The Avid client passed **14 of 14 real write/read checks** against an isolated BookOrbit v3.3.0 server on 10 October 2026 UTC (9 October local time). The source was pinned to `e767358443419253eeed782518d6fc4f675d69fd`. This run used HTTP on `127.0.0.1:43120`, PostgreSQL 18.4 on `127.0.0.1:55439`, and a separate database named `avid_fixture`.

The user-supplied server was not used for these tests. The results do not certify production deployments, OIDC providers, native builds, physical devices, or all supported book variants.

## Evidence

The committed [request and check report](evidence/bookorbit-v3.3-smoke.json) records check outcomes and HTTP methods, paths, and statuses. It contains no passwords, access tokens, refresh tokens, cookies, annotation text, or private books.

| Check                                                                                 | Result |
| ------------------------------------------------------------------------------------- | ------ |
| Native password login, explicit refresh token, authenticated account identity         | Passed |
| Original EPUB/PDF upload, exact file IDs, two-page catalog pagination                 | Passed |
| EPUB CFI and percentage save/read                                                     | Passed |
| PDF page and percentage save/read                                                     | Passed |
| EPUB annotation creation, editing, retrieval, deletion                                | Passed |
| PDF annotation creation, editing, retrieval, deletion                                 | Passed |
| Collection creation, membership addition/removal, selected-book membership reads      | Passed |
| Exact `want_to_read` and `reading` statuses                                           | Passed |
| Durable reader-preference adapter, sparse field updates, unrelated-field preservation | Passed |
| Activity timestamps, duplicate session-ID idempotence, server statistics and timeline | Passed |
| Original MP3 upload, revisioned audio progress, audio note creation/edit/read/delete  | Passed |
| Read-only Avid client rejects mutations before making HTTP requests                   | Passed |
| Expired access token triggers native refresh-token rotation and account verification  | Passed |
| Server session logout                                                                 | Passed |

The EPUB and PDF came from `packages/readers/fixtures`. Audio was converted from the original Avid `audio1.wav` narration to MP3 using local ffmpeg. No third-party publication was downloaded. API setup and library creation use the pinned server DTOs; all subsequent library operations use the actual `BookOrbitClient` implementation.

## Repeat the run

The runner is [scripts/bookorbit-smoke.ts](../scripts/bookorbit-smoke.ts). It requires Node 24, a TypeScript loader, ffmpeg on `PATH`, and an already-running disposable BookOrbit server. It creates a fresh library for every run. Only the first run creates the fixture account; generated credentials are retained under `/tmp/avid-bookorbit-smoke-43120.json` with mode `0600`, outside the repository. Authentication tokens remain in memory.

```sh
AVID_DISPOSABLE_BOOKORBIT=1 \
AVID_BOOKORBIT_SMOKE_URL=http://127.0.0.1:43120 \
node --import /tmp/avid-bookorbit-contract/server/node_modules/tsx/dist/loader.mjs \
  scripts/bookorbit-smoke.ts
```

`AVID_BOOKORBIT_SMOKE_REPORT` can choose the output report path. The default is `/tmp/avid-bookorbit-smoke-report.json`.

The runner rejects non-loopback destinations before making a request and requires the explicit disposable-fixture opt-in. Its transport checks every outgoing origin and rejects redirects. A negative check with `https://example.invalid` exited at the destination assertion. This guard is additional protection; the target must still be a disposable database with no private library data.

## Server preparation used for this run

The pinned official repository was cloned to `/tmp/avid-bookorbit-contract`; its `AGENTS.md` was read. Dependencies were installed with pnpm 11.22 and install scripts disabled, and `@bookorbit/types` plus `@bookorbit/plugin-api` were built. The official database extensions and migrations were applied to the isolated PostgreSQL database.

The Nest SWC dev builder could not initialize its cache in this sandbox. No directory permissions were weakened. Running the installed TypeScript compiler from the official `server` directory succeeded:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.build.json
```

That emitted `server/dist/src/main.js`. The server was launched from the official `server` directory with these disposable fixture settings:

```sh
HOST=127.0.0.1 \
PORT=43120 \
APP_URL=http://127.0.0.1:43120 \
APP_VERSION=3.3.0 \
APP_DATA_PATH=/tmp/avid-bookorbit-data \
LIBRARY_BROWSE_ROOT=/tmp/avid-bookorbit-data \
DATABASE_URL=postgres://nightwatcher@127.0.0.1:55439/avid_fixture \
JWT_SECRET=avid-disposable-fixture-only-secret \
NODE_ENV=development \
COVER_SLOTS_BACKFILL_MODE=skip \
node dist/src/main.js
```

The version environment value labels the local build; the checked source commit identifies the tested version. Server logs are in `/tmp/avid-bookorbit-server.log`. The runner also passed a standalone strict TypeScript check. No server source or database schema patches were needed.
