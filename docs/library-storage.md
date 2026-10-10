# Local library storage

The shared repository now uses an explicit storage port. `DexieLibraryStorage` retains the existing IndexedDB database and its version 3 tables. `NativeLibraryStorage` speaks the typed desktop bridge in `packages/core/src/storageProtocol.ts`. The hook accepts `useLibrary({storage})`; the selected backend stays fixed for that mounted library. A failed native operation is surfaced to the caller rather than silently switching databases.

Every repository instance remains bound to the normalized server URL and authenticated user ID. Ordinary offline and demo storage does not depend on a live authentication token. Tokens, cookies and passwords do not belong in these tables. Rows retain the existing `key = JSON.stringify([scope, id])` identity; outbox `entityKey` is a secondary filter.

## Atomicity

Repository writes, conflict resolution, preference patches, and native journal replay use an explicit transaction-scoped repository object. There is no mutable global transaction owner. The IndexedDB adapter runs those operations in a native Dexie transaction; the native adapter records reads and buffered mutations, then asks SQLite to compare every observed table revision and commit all mutations atomically. A conflict replays only the local callback, with at most 16 attempts. Callbacks must never send network requests or perform other external effects.

Revisions belong to an account and table and survive account clearing, preventing old snapshots from becoming valid again. Empty commits validate read snapshots. Entity claims, exact checkpoint timestamps, immutable activity IDs, note ID remapping, deletion tombstones, native replay fingerprints and read-only provenance retain the same repository rules. Checkpoint reads request exact book IDs, rather than loading the entire catalog.

## Imported files

The bridge transfers file data in decoded chunks of at most 256 KiB. A staging upload has an account scope, exact size, MIME type and name; appends require the next offset. Completion yields an immutable scoped blob reference, which is published together with local edition metadata by the atomic commit. Native storage must validate the reference's ownership and metadata. Interrupted or unreferenced staging data is eligible for native cleanup.

Imported-book listing requests only file identities; it does not read file bodies. An explicit file open reads bounded chunks and verifies length and end-of-file before constructing the browser File. That browser representation can still require memory proportional to the opened file; the separate native audio receipt/player path is used for large native audio sources. The storage protocol does not imply that a WebView can render a 4 GiB ebook.

## Evidence and remaining qualification

Twelve parity and bridge-boundary tests exercise the same repository behavior with real fake-indexeddb transactions and an instrumented native CAS protocol fixture. They cover rollback, immutable scope after caller session mutation, account clearing, backward checkpoints, read-only edits, tombstones, canonical note IDs, concurrent activity and lease creation, idempotent native event receipts, forced CAS retry, exact multi-chunk bytes, metadata-only file listing, wrong-account responses, truncated file reads, and re-upload after temporary receipt expiry or account clearing. Existing synchronization/recovery/hook/native-journal tests pass through the port. All 14 disposable BookOrbit v3.3.0 smoke checks also pass after this refactor.

The protocol fixture is not SQLite, filesystem durability, or crash-injection evidence. The Rust backend, real native restart/kill acceptance and bounded cleanup require their own evidence. The copy-before-activation migration described below preserves the browser database and schema; no legacy account is deleted by migration.

## Copy before native activation

`migrateLibraryAccount({source, target, session, isActive?})` in `packages/core/src/storageMigration.ts` copies one account. It reads a consistent legacy snapshot, compares existing destination rows, and atomically adds only missing rows. A different row with the same identity stops the copy; unrelated destination rows remain intact. File fingerprints include name/type/size and SHA-256 hashes of 256 KiB chunks. Object fingerprints use deterministic key ordering, preserving array order and rejecting values that cannot be represented safely.

A second transaction verifies the persisted destination against that snapshot and creates a completion receipt only after successful read-back. Destination changes during verification invalidate the CAS and force another comparison. The source is checked again after copying; a detected change prevents completion. Bootstrap must keep the legacy account inactive while copying: this is not a distributed transaction across two independently writable databases. Source records, files, queues, and receipts are never deleted or changed by migration. A failure after the first copy is safe to retry; a conflict remains visible and requires a deliberate choice outside this helper.

For automatic readiness, construct `new MigratingLibraryStorage(source, target)` and pass that stable instance to `useLibrary({storage})`. Its `read` and `atomic` methods wait for one shared migration promise per canonical account scope. `.ready(scope)` exposes the same promise for bootstrap status. Failed attempts reject all waiters and release the failed cache entry so a later operation can retry. Successful readiness is cached; a validated completion receipt also makes later process starts idempotent. Native data is then authoritative: later edits in the preserved legacy database are intentionally not imported automatically, and legacy files are not rehashed on every activation.

Thirteen migration/readiness tests cover every table, exact file bytes, same-size corruption, conflicts, missing persisted rows, failure between copy and receipt, source changes, concurrent destination edits, cancellation, malformed receipts, account isolation, one readiness flight for concurrent reads/writes, visible failures and retries. Verification of native local files currently reconstructs one browser Blob at a time; transport and hashing use bounded chunks, but verification memory can still grow with that file's size. This is separate from the streaming native audio receipt path. Platform restart/kill and real SQLite evidence remain tracked independently.
