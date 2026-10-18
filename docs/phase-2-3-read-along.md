# Phase 2 preparation and the earlier read-along slice

Updated: 2026-10-18. **Phase 2 includes Prepare Read & Listen: compare an independent ebook and audiobook locally, retain the resulting preparation, and read/listen from it offline.** A bounded English implementation is now present. It is limited to foreground use and still needs full browser/device acceptance. Broader offline editing, notes/highlights, durable progress reconciliation and the full offline library are deferred to Phase 3. Neither phase is complete; Phase 1 also retains the implementation and acceptance gaps in its [checklist](phase-1-status.md) and [validation guide](phase-1-validation.md).

The earlier chapter-player, SMIL handoff and small offline-package behavior below was implemented and tested before this correction. Its original evidence remains useful, but does not prove that independent audio/text preparation works. Old experimental local notes and checkpoints are preserved in their databases; the active prepared viewer does not open or modify them. See the [roadmap](roadmap.md) and [October 18 reference correction](apogee-release-delta-2026-10-18.md).

## Prepare Read & Listen — current flow

1. Connect to BookOrbit and load a title containing both an **EPUB and an audiobook**. The More picker lists eligible books already loaded in the current catalog; load the book in Library first if it is absent. This flow does not pair arbitrary files from unrelated server books.
2. Choose **More → Prepare Read & Listen**, select that title, and wait for its EPUB to open. Open **Prepare Read & Listen** in the reader. Opening the explanation does not start model downloads or recognition.
3. Choose **Prepare on this device**. The app checks the exact EPUB/audio edition, downloads all required audio unless verified cached bytes can be reused, loads the speech model, compares spoken words with the actual EPUB paragraphs, then verifies and saves the result. Keep Avid open; charging is advisable for long jobs. **Cancel preparation** stops the active worker/job. Interrupted downloads/jobs do not resume from a saved partial stage.
4. Inspect the reported matched-passage count. A ready result can have gaps: silence, credits, repeated/short passages, omissions and poorly recognized text are not given invented timing. **Listen from this passage** works only where a verified match exists. A regular EPUB without embedded SMIL or narration is eligible, and chapter titles do not determine matching.
5. Choose **Open prepared books** or **Prepared Read & Listen** from the player. The saved list includes new generated preparations and readable earlier SMIL packages. Opening rechecks the saved bytes/metadata and establishes fresh reader alignment; no server sign-in, repeat recognition or remote source download is required for a complete saved package.
6. In the prepared viewer, switch between the book and player, follow the matched passage, seek or undo a deliberate position change. **Positions last only for this open session.** Closing and reopening does not restore its last position. The viewer has no note/highlight editing and does not write progress, activity or server-sync work. Old offline notes/progress databases remain untouched.

A complete preparation retains the EPUB, every required audio asset, versioned alignment and source fingerprints together. Atomic publication and revalidation reject missing, corrupt, changed-edition or stale-account inputs; cancellation or storage failure must not replace an earlier ready edition. The store strips credentials and remote media URLs. It can reuse an exact ready preparation without another model run, or reuse matching earlier SMIL audio bytes for a new comparison without deleting those older packages. Playback-only persistence is Phase 2 scope; offline editing/reconciliation is not part of this task.

### Runtime and limits

The browser worker uses **Transformers.js 4.3.1**, the quantized English model **`Xenova/whisper-tiny.en`**, pinned to revision **`79fb389fc764e7c395bd330e9531d9d32ada7049`**, and the shipped ONNX WebAssembly runtime. Model data is downloaded from the public model host on first use and may be cached by the browser. Recognition runs locally; the ebook and recording are not uploaded to a transcription service. Preparing a new title requires the model to be available, but reopening a complete prepared title does not need it.

Audio is decoded in overlapping windows of at most 30 seconds, mixed to mono 16 kHz, and recognized with actual word timestamps. A separate cancellable matching worker uses those source times to link EPUB paragraphs. Its agreement score is a text-matching threshold, **not a calibrated probability of correctness**. Ambiguous, short, repeated, oversized or low-agreement paragraphs remain unlinked. This first model is English-only; neither the seven interface languages nor the use of Unicode text matching establishes multilingual recognition support.

Current preparation bounds are **64 MiB per EPUB, 512 MiB per audio asset, 2 GiB total source bytes per book**, and 32 MiB for hashed preparation metadata. These are rejection limits, not a promise that every device can process that size. The app checks reported storage headroom and requests persistent browser storage, which may be denied. Compressed source/EPUB parsing, recognition state and browser overhead also consume memory. Preparation requires a browser decoder that supports the actual codec; declared MP3/M4A/M4B extensions alone are not sufficient. An unavailable decoder or inconsistent source duration produces an error.

Only complete packages are ready. This is not a resumable multi-gigabyte download scheduler, an overnight OS background task, or native locked-screen playback. Keep Avid open during preparation and prepared playback. Browser storage can be evicted or cleared; saved files are not a backup. The 64/64/256 MiB limits in the historical SMIL sections below apply to that earlier package format, not the new preparation store.

Apogee's differently named **Prepare for Listening** caches a server-generated voice for offline Speak. It is separate from matching a supplied audiobook to an ebook; the [reference update](apogee-release-delta-2026-10-18.md) records the distinction.

### Current evidence and checks

The real CPU-model smoke and a smoke using the **same web-runtime WebAssembly backend in a Node harness** used the repository's original synthetic EPUB/WAV fixture and recognized its audio instead of reading the authored SMIL timing. They matched **one of two paragraphs**. The first paragraph was misheard and correctly remained unlinked. This establishes one genuine recognition-to-text match, not human-narrated book accuracy, full-fixture coverage, or performance on long books. An alternative `base.en` experiment did not improve this fixture and is not the configured model.

Validation for this update: **880 tests passed across 111 files**, TypeScript passed, and the production build passed. Focused source suites cover generated timing/identity validation, actual EPUB passage extraction and fresh proof restoration, atomic prepared storage, cache reuse, cancellation and edition/account changes, a no-network prepared viewer, session-only positions and preservation of old notes/progress. Tests with supplied recognition intervals do not themselves exercise the real model. The WebAssembly CLI smoke is not browser-worker or UI acceptance. Full browser UI/cold-start QA is not recorded for this new generated flow because browser automation was unavailable; iOS and other installed-device preparation checks remain unperformed.

Run source checks and the optional real-model smoke separately:

```sh
pnpm exec vitest run --root . packages/playback/test/generated-alignment.test.ts packages/readers/src/generatedText.test.ts packages/core/tests/preparedReadListen.test.ts apps/web/src/preparation/prepareReadListen.test.ts apps/web/src/PrepareReadListen.test.tsx apps/web/src/OfflineDownloads.test.tsx apps/web/src/homePins.test.ts apps/web/src/PinnedHomeShelves.test.tsx
pnpm typecheck
pnpm test
pnpm build
# Opt-in: downloads the public pinned model; processes only original repository audio.
node --experimental-strip-types scripts/verify-read-listen.mjs
node --experimental-strip-types scripts/verify-read-listen.mjs --wasm
```

For a current manual check, use an authorized English EPUB/audiobook edition, run explicit preparation, record the coverage and review linked passages against the actual recording. Cancel and retry; replace an input edition and verify it cannot reuse an old map. After saving, reopen the production app once to activate its shell, disconnect the network and open the prepared title. Verify local audio, passage following, gaps, backward seeks and both handoff directions. Close/reopen and verify there is no durable position restoration or note/highlight editor. Inspect that no server request or model download occurs during reopening. Record exact build, browser/OS, codec, duration, model revision and observed failures; the permitted size limit is not a tested maximum.

## Chapter player and text

The player uses real source chapters for its current title, chapter number, chapter-relative seek control, elapsed/remaining chapter time and previous/next chapter buttons. Whole-book progress remains visible, with the remaining listening estimate adjusted for playback speed. Seeking, annotations and saved positions always use original source seconds. Unknown duration disables seeking; missing chapter metadata uses the whole-book clock. Silence or a gap between chapters does not acquire an invented chapter name. A drag crossing a chapter boundary retains the chapter clock captured at pointer-down.

In the existing SMIL path, an EPUB with real narration can play its embedded media. Linking a separate audiobook through that path additionally requires explicit pairing of its audio assets, complete matching audio bytes, the EPUB SHA-256 and the current audiobook manifest revision. Titles, equal duration or matching filenames do not prove alignment. This older linking operation does not transcribe audio or generate a timing map; the new preparation flow above is a separate capability.

After successful linking, **Show text** displays the verified publication passages. The active passage follows the source clock, including paused seeks; gaps clear the active passage. Selecting a passage seeks to its exact source start, and **Undo position change** restores the previous audio position for that explicit change. Following scrolls the text panel itself. The reader can show the corresponding passage highlight and optionally follow narration through the book. A paused player still has an exact location; highlighting is not limited to the playing state. Follow can be disabled while reading elsewhere.

## Reading and listening positions

The policy is stored by original server/account and book. Its default is **Switch only when I choose**. Each mode retains its own native reading or source-audio checkpoint.

| Choice or action | Behavior |
| --- | --- |
| Switch only when I choose | Opening the reader/player retains that mode's position. Use **Read from here** or **Listen from here** to move to the other mode's verified passage. |
| Follow latest confirmed position | A supported mode switch follows the newer confirmed reading/listening action by its original timestamp. A later backward move wins over an earlier forward position. |
| Keep separate positions | Ordinary mode changes preserve independent reading and listening positions. Explicit passage/handoff actions still mean an intentional seek. |
| Preview without saving position | Browsing updates the visible position without replacing the saved reading checkpoint. **Save this reading position** deliberately commits the displayed position. Leaving preview does not itself save it. |
| Follow narration | Automatic audio-driven reader navigation does not manufacture a newly confirmed reading checkpoint. |
| Undo position change | Restores the previous audio time for the displayed explicit jump. It is not a cross-device history or a general document undo stack. |

Only an actually aligned passage can bridge text and audio. Unspoken text and silence remain unmapped; the app does not estimate a position from reading percentage. A newly reopened EPUB must establish fresh alignment evidence before linked handoff is enabled.

## Historical SMIL package flow (October 10)

The following records the earlier implementation and its reproduction steps. The current app uses the prepared viewer described above: it can read these saved packages but no longer exposes the old offline notebook/progress workspace. These historical labels and durable-note behavior are not instructions for the current viewer. Do not delete the old databases when updating.

1. Open an EPUB with complete embedded SMIL narration. For a separate audiobook, link and verify the exact assets first. Ordinary EPUBs without complete narration, arbitrary audio-only downloads and other publication formats are outside this slice.
2. Choose **Download read-along** in the reader or its linked player. A paired download includes the EPUB and every asset in the current audiobook manifest, not just the current chapter. A self-contained EPUB can be saved with its embedded narration alone.
3. Wait for **Saved for offline reading and listening**. Source sizes, hashes, EPUB resources, timing metadata and account/file identities are checked before the metadata and blobs are published together. Cancellation, partial bytes, a changed manifest or quota failure does not replace an existing ready edition with an incomplete one.
4. Open **More → Offline read-along**, then **Open download**. Saved account labels identify the original workspace; no server sign-in or credentials are restored. Reopening verifies the package again. For a paired package, the reader checks the current EPUB/audio bytes and creates a fresh session-local alignment proof before enabling text/audio handoff. Stored timing metadata is not treated as a fresh proof.
5. Reading, text notes, audio notes and checkpoints in this workspace stay on this device. Saved audio notes appear under **Notebook** in the offline player; select a note to return to its source timestamp. Audio plays through the foreground browser transport using newly created blob URLs. Keep Avid open; native locked-screen/background offline playback is not established by this path.

The limits are **64 MiB for the EPUB, 64 MiB for each audio asset, and 256 MiB for the complete package**. Expanded EPUB resources also have a 256 MiB bound. Embedded audio already inside the EPUB and separate paired audio blobs both count toward package storage. Browser memory overhead can exceed the compressed package size during verification, so these limits do not guarantee success on every low-memory device. A rejected large publication needs the later resumable/native download implementation; the app does not silently save only part of it.

The offline progress database is keyed by the saved package ID and retains the original account partition. A changed EPUB/audio edition gets a different package even when its server book/file IDs are reused. Optional initial seeding imports only confirmed matching reading/audio checkpoints with their original timestamps; audio also requires the exact manifest revision. A newer or equally timed offline checkpoint wins. Online notes are not copied automatically. Offline mutations cannot create server outbox operations, including after signing into the original account again.

**Remove download** removes the saved publication bytes and package entry. Its device-local notes/checkpoints are retained separately; saving the exact same package again can recover them. This is not a backup/export feature or a secure erase of the entire account. Browser storage is local profile data, not a second offline login boundary: someone using that profile can open its saved downloads. No access/refresh tokens, passwords or remote signed media URLs are stored in a download.

## Production app shell

Saved publication bytes and a cached application shell are separate requirements. For a web cold start, serve `pnpm build` output at the site root over **HTTPS or localhost**, load Avid while online, and reopen/reload it so the installed service worker controls the page. Verify that the page is controlled by the service worker before disconnecting. The service worker caches public application build resources; it does not cache BookOrbit API/authentication responses or private book requests. Speech-model caching is separate and is not required to play a completed preparation.

`pnpm dev` does not install that production shell and needs its Vite server running. The default development and preview ports are different origins, so their IndexedDB downloads are different too. Use the same scheme, host and port when testing a saved package after switching to a production preview. Installed native shells already contain app resources, but the new IndexedDB/blob offline flow still needs physical-device qualification; packaging the app does not prove its background behavior or durable storage guarantees.

Browser/OS storage eviction, private mode, site-data clearing and quota limits still apply. A best-effort persistent-storage request may be denied. Clearing browser data can remove both downloads and local notes. Reopening a damaged package reports an error instead of using corrupt or partial data. A failed download can be retried, but interrupted byte-range downloads do not resume in this slice.

Damaged package metadata does not hide healthy entries. The current prepared list reports a bounded recovery notice and preserves damaged data; it does not expose unreadable account/book fields or delete entries automatically. Removing a healthy prepared entry is explicit and removes its publication bytes, not the older offline notes/checkpoints databases.

## Existing SMIL path: tests and evidence

Validation recorded on 2026-10-10 for this slice: **786 tests passed across 101 files**, TypeScript passed, and the production build passed. After the final offline-note navigation change, its 9 component tests, 9 reader chrome tests and 3 shell tests passed again. The package and isolated-progress suites cover 31 and 35 scenarios respectively: real EPUB/WAV bytes, SHA-256 round trips, original-account/edition separation, missing/corrupt assets, changed manifests, cancellation, rollback on quota/write failures, timestamp ordering and an empty offline sync outbox.

The Codex in-app browser exercised the original two-passage EPUB/WAV fixture. Actual rendered EPUB highlights moved forward and backward while paused, the exact terminal gap cleared both marks, and automatic following left the preview checkpoint count unchanged. This exposed and fixed detached-iframe cleanup and decoder-end rounding bugs that mocked playback alone did not show.

A production build with a temporary local fixture entry saved the package on a separate test origin. After loading/reopening the main app to activate its shell, the preview server was stopped (an HTTP probe could not connect). A cold main-app reload still opened the saved EPUB, re-verified the paired edition, rendered its highlight, played both saved audio resources, displayed timed text, sought backward into the ebook, and saved an audio note. The temporary fixture entry/configuration were removed; neither ships in the release build. The cold-start test exposed `Vary: Origin` cache misses for public module assets; a regression test now covers that fix. These checks require no BookOrbit server or account.

This evidence covers the recorded synthetic fixture and browser paths. It does not establish generated matching for independent publications, real-library alignment for arbitrary editions or installed-device behavior. Physical-device codec, accessibility, interruption, storage pressure and background acceptance remain pending. Earlier native CI results belong to their recorded commits and do not certify these UI paths or the new preparation pipeline.

Run the focused tests, then the repository checks:

```sh
pnpm exec vitest run --root . packages/core/tests/offlineReadAlong.test.ts packages/core/tests/offlineReadAlongProgress.test.ts apps/web/src/OfflineDownloads.test.tsx apps/web/src/offlineShell.test.ts apps/web/src/Player.test.tsx apps/web/src/playerTimeline.test.ts apps/web/src/ReadAlongPanel.test.tsx apps/web/src/readAlongState.test.ts packages/readers/src/alignedPassage.test.ts packages/readers/src/mediaOverlayHighlight.test.ts
pnpm typecheck
pnpm test
pnpm build
```

For a lawful, server-free manual check, follow the original **HANDOFF** fixture instructions in [Reader fixtures](../packages/readers/fixtures/README.md). The fixture is served only by Vite at `/@fs/<absolute-repository-path>/packages/readers/fixtures/reader.html?format=HANDOFF`; it is not shipped in the production app. Verify the two original WAV assets, exercise paused forward/backward passages, gaps, following, preview/explicit save, and use **Save verified fixture offline**. Then open the package in the main app on that same origin.

To test a cold web start with that saved fixture, stop the development server, build the production app, and serve the preview on the original origin, for example:

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 5173
```

Load `/` while that server is running, wait for service-worker activation and reopen/reload. Stop the server or enable the browser's offline mode, cold-open `/`, and open the saved package. Check text, playback, both handoff directions and zero BookOrbit requests. In the **current** prepared viewer, positions must remain session-only, no offline note/highlight editor should be exposed, and older progress/notes databases must remain unchanged. The October 10 notebook and close/reopen-position checks above are historical evidence, not current expected behavior. Test a second account and a changed edition with reused file IDs; their source bytes and alignment must remain isolated. Record exact commit, browser/OS, fixture, steps and results. Returning to development on the same origin may require unregistering the production service worker in browser developer tools; do not clear IndexedDB if retaining saved files and prior notes is intended.

Use only the original synthetic fixtures or authorized publications. Keep the supplied BookOrbit server read-only; this test needs no server mutation, external account or real credentials.

## Still pending

The bounded independent audio/text preparation and persisted viewer are implemented; real-book quality, actual browser worker/UI/cold-start and installed-device acceptance remain open as recorded above. Multilingual preparation, resumable jobs, advanced audio processing, broader queue/car browsing and installed-platform audio work remain on the roadmap. Full large-file downloads, range resume, download scheduling/network policies, pinning/eviction/storage management, all-format offline catalogs/search, offline editing/notes/highlights and cross-device progress reconciliation are deferred Phase 3 work. Native offline background playback still needs implementation/qualification appropriate to its platform; foreground playback cannot stand in for it. Physical-device codec, low-memory, low-space, interruption/kill/restart, background, assistive-technology and language checks are separate acceptance gates. Completing the earlier tests above closes only their recorded scenarios.
