# BookOrbit contract implemented by Avid

Inspected on October 9, 2026 against the [BookOrbit v3.3.0 release source](https://github.com/bookorbit/bookorbit/tree/v3.3.0), commit `e767358443419253eeed782518d6fc4f675d69fd`. This is a source-verified adapter, not certification against a running BookOrbit installation. No server implementation has been copied into Avid. API requests and domain mappings are independently implemented.

All routes below are relative to the configured server's `/api/v1` prefix. Deployment subpaths are preserved. A same-origin transport can override the network base using `transportBaseUrl: '/bookorbit'` without changing account identity.

## Routes

| Behavior | Contract | Source at v3.3.0 |
| --- | --- | --- |
| Password authentication | `POST auth/login`, `{username,password,clientKind,deviceLabel}`; returns access token, expiry, user and session identity. Native clients additionally receive a refresh token. | `server/src/modules/auth/auth.controller.ts`, `dto/login.dto.ts`, `packages/types/src/auth.ts` |
| Login methods | `GET auth/login-options` returns password availability and OIDC providers. | `auth/auth.controller.ts` |
| Refresh | `POST auth/refresh` with refresh token for native transport, or refresh cookie for web. Concurrent 401s share one refresh. | `auth/dto/refresh.dto.ts` |
| Version/features | `GET app-info` | `app-info/app-info.controller.ts`, `packages/types/src/app-info.ts` |
| Libraries | `GET libraries` | `library/library.controller.ts` |
| Catalog/search | `POST books/query` or `POST libraries/:id/books`, with `sort`, `pagination:{page,size}`, `q`, `collapseSeries`. These POST routes perform reads. | `book/book.controller.ts`, `packages/types/src/query.ts` |
| Book details | `GET books/:id` | `book/book.controller.ts`, `packages/types/src/book.ts` |
| Files/covers | `GET books/files/:fileId/serve`; `GET books/:id/cover` | `book/book.controller.ts` |
| Collections/scopes | `GET collections`, `GET collections/:id/books`; `GET smart-scopes`, `GET smart-scopes/:id/books` | Corresponding module controllers |
| File progress | `GET/POST books/files/:fileId/progress`; write `{percentage,cfi}` for EPUB or `{percentage,pageNumber}` for PDF/comics | `book/dto/save-progress.dto.ts` |
| Legacy audio progress | `GET/PATCH books/:id/audio-progress`; write `{percentage,currentFileId,positionSeconds}` | `book/dto/upsert-audio-progress.dto.ts` |
| Reading status | `PATCH books/:id/status`; Avid finished maps to server `read`, queue to `want_to_read` | `user-book-status/dto/set-status.dto.ts` |
| Metadata | `PATCH books/:id/metadata`; fields are patched, not replaced | `book/dto/update-book-metadata.dto.ts` |
| Text/PDF notes | `GET/POST books/:bookId/annotations`, `PATCH/DELETE .../:annotationId` | `annotation/annotation.controller.ts`, its DTOs |
| Preferences | `GET/PATCH reader/preferences/:fileId`; patch `{set,unset}` | `reader-preferences/reader-preferences.controller.ts` |
| Activity | `POST books/files/:fileId/sessions`; source session ID, original start/end, active duration in seconds, read/listen/tts type | `reading-session/dto/save-reading-session.dto.ts` |
| Upload | `POST libraries/:id/upload`, multipart single `file` | `upload/upload.controller.ts` |
| Audiobook manifest | `GET audiobooks/:bookId/manifest`, schema `bookorbit.audiobook-manifest`, version 2 | `audiobook/audiobook.controller.ts`, `packages/types/src/audiobook.ts` |
| Audio stream | `GET audiobooks/:bookId/assets/:assetId/content`, range support | `audiobook/audiobook.controller.ts` |
| Guarded audio state | `GET/PUT audiobooks/:bookId/playback-state`; write asset, milliseconds, capturedAt, UUID operationId, baseRevision, manifestRevision | `audiobook/dto/put-audiobook-playback-state.dto.ts` |
| Timestamped audio notes | `GET/POST audiobooks/:bookId/bookmarks`, `PATCH/DELETE .../:bookmarkId`; create client UUID, milliseconds, title, note, optional chapter | `audiobook/dto/create-audiobook-bookmark.dto.ts` |

Catalog, session, annotation, audio and preference responses are validated before mapping. Server IDs are preserved as strings. Server progress units are 0–100; domain progress is 0–1. Audiobook manifest timings and bookmark positions are milliseconds; legacy audio progress locators are **track-relative seconds**. A display percentage is never used as an exact locator.

## Authentication and media

The server's JWT strategy supports Bearer headers and the `access_token` cookie. It explicitly does **not** accept query-string tokens. Avid never puts credentials into URLs. Web login uses `clientKind: 'web'` and `credentials: 'include'`; native login requests `clientKind: 'native'`. The caller owns credential lifecycle and secure persistence; the library database does not store sessions or tokens.

For browser media, use same-origin cookie-authenticated URLs or fetch bytes with `getFileBlob`/`coverBlob`. Blob loading is suitable for documents but buffers the file; use native authenticated streams or same-origin media URLs for large audiobooks. `streamHeaders()` supplies native transport headers. Cross-origin cookies, CORS, reverse proxies and seek/range behavior require deployment testing.

## Read-only connections

`new BookOrbitClient(session, {readOnly: true})` rejects **every implemented data mutation before network I/O**. Login and refresh remain available. The catalog query POST is allowed because its pinned server implementation is a read. `SyncCoordinator.flush()` returns immediately for read-only clients.

Pass `{readOnly: true}` to repository checkpoints, note writes and session recording to keep that activity exclusively on-device. Existing pending work is not sent by a read-only client. This is mandatory when exercising the user-provided read-only test server. No mutation tests target that server; all automated mutation tests use mocks.

## Persistence and synchronization

IndexedDB/Dexie schema version 1 uses normalized server URL plus authenticated user ID for every record and outbox entry. Profile names and rotating tokens do not affect scope. Each repository instance has one immutable scope. The sync coordinator refuses mismatched client and repository identities.

Checkpoint and mutation intent are committed together in one transaction. Pending progress for the same file/format is coalesced; original event time survives retries. Newer events can move backwards. Before sending progress, synchronization reads the remote locator and timestamp; a demonstrably newer remote event becomes an explicit conflict. Exact matches are acknowledged without a write. Annotation tombstones survive stale imports. Local annotation IDs are mapped to server IDs, including subsequent queued edits. An uncertain create is reconciled against remote content; absent or ambiguous matches require review instead of a duplicate-creating blind retry.

Reading activity retries preserve `sessionId`, start/end and duration. The pinned server repository deduplicates `(userId,sessionId)`. Audio playback has stronger guards: base revision, source timestamp, operation UUID and manifest revision; the adapter exposes this API without inventing idempotency support for other operations.

## Qualification gates and remaining limits

- Password/refresh, route construction, response conversion, read-only guards and synchronization are covered by mock contract tests. Real deployment certification, account permissions, token expiration during streaming and proxy behavior still need integration evidence.
- Text/PDF/comic progress writes have no client timestamp or compare-and-swap field. Avid avoids replaying observed stale events, but a concurrent update between its read and write remains possible. Missing remote timestamps cannot establish ordering. The source event time remains in the local journal.
- Annotation creates have no client idempotency key. The outbox preserves uncertain results for reconciliation; annotation deletion and external revision races are surfaced as conflicts. There is no assumed general change feed.
- PDF annotations require page geometry (`page`, bounding `rect`, per-line `rects`) and a file ID. Page-number-only notes cannot be uploaded as fake PDF highlights.
- Audiobook notes are supported natively by BookOrbit 3.3.0, so ordinary timestamped audio notes do not require a companion.
- Provider discovery exists, but the Avid OIDC browser/native callback and platform-specific allowed redirect registration remain separate implementation gates. Do not claim a working SSO flow from discovery alone.
- Library/collection results are paginated. `listCollections()` returns collection identities with empty `bookIds`; load pages through `getCollectionBooks()` to populate membership. Cover and file URLs are authenticated resources, not public URLs.
- This storage schema is the Phase 1 checkpoint and cache foundation. Durable offline media downloads, a complete offline search index and native SQLite implementations remain separate work.

Run the isolated checks from repository root with `pnpm exec vitest run --root . packages/core/tests`.
