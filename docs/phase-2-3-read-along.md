# Phase 2/3 read-along slice

Updated: 2026-10-10. This document covers the implemented chapter-player and bounded offline read-along work. **Neither Phase 2 nor Phase 3 is complete.** The [roadmap](roadmap.md) retains the wider audiobook and offline requirements; Phase 1 still has the implementation and acceptance gaps in its [checklist](phase-1-status.md) and [validation guide](phase-1-validation.md). Existing platform, format and reader-fixture testing instructions continue to apply.

## Chapter player and text

The player uses real source chapters for its current title, chapter number, chapter-relative seek control, elapsed/remaining chapter time and previous/next chapter buttons. Whole-book progress remains visible, with the remaining listening estimate adjusted for playback speed. Seeking, annotations and saved positions always use original source seconds. Unknown duration disables seeking; missing chapter metadata uses the whole-book clock. Silence or a gap between chapters does not acquire an invented chapter name. A drag crossing a chapter boundary retains the chapter clock captured at pointer-down.

An EPUB with real SMIL narration can play its embedded media. Linking a separate audiobook additionally requires explicit pairing of its audio assets, complete matching audio bytes, the EPUB SHA-256 and the current audiobook manifest revision. Titles, equal duration or matching filenames do not prove alignment. This slice does not transcribe audio or generate a timing map.

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

## Download and reopen

1. Open an EPUB with complete embedded SMIL narration. For a separate audiobook, link and verify the exact assets first. Ordinary EPUBs without complete narration, arbitrary audio-only downloads and other publication formats are outside this slice.
2. Choose **Download read-along** in the reader or its linked player. A paired download includes the EPUB and every asset in the current audiobook manifest, not just the current chapter. A self-contained EPUB can be saved with its embedded narration alone.
3. Wait for **Saved for offline reading and listening**. Source sizes, hashes, EPUB resources, timing metadata and account/file identities are checked before the metadata and blobs are published together. Cancellation, partial bytes, a changed manifest or quota failure does not replace an existing ready edition with an incomplete one.
4. Open **More → Offline read-along**, then **Open download**. Saved account labels identify the original workspace; no server sign-in or credentials are restored. Reopening verifies the package again. For a paired package, the reader checks the current EPUB/audio bytes and creates a fresh session-local alignment proof before enabling text/audio handoff. Stored timing metadata is not treated as a fresh proof.
5. Reading, text notes, audio notes and checkpoints in this workspace stay on this device. Saved audio notes appear under **Notebook** in the offline player; select a note to return to its source timestamp. Audio plays through the foreground browser transport using newly created blob URLs. Keep Avid open; native locked-screen/background offline playback is not established by this path.

The limits are **64 MiB for the EPUB, 64 MiB for each audio asset, and 256 MiB for the complete package**. Expanded EPUB resources also have a 256 MiB bound. Embedded audio already inside the EPUB and separate paired audio blobs both count toward package storage. Browser memory overhead can exceed the compressed package size during verification, so these limits do not guarantee success on every low-memory device. A rejected large publication needs the later resumable/native download implementation; the app does not silently save only part of it.

The offline progress database is keyed by the saved package ID and retains the original account partition. A changed EPUB/audio edition gets a different package even when its server book/file IDs are reused. Optional initial seeding imports only confirmed matching reading/audio checkpoints with their original timestamps; audio also requires the exact manifest revision. A newer or equally timed offline checkpoint wins. Online notes are not copied automatically. Offline mutations cannot create server outbox operations, including after signing into the original account again.

**Remove download** removes the saved publication bytes and package entry. Its device-local notes/checkpoints are retained separately; saving the exact same package again can recover them. This is not a backup/export feature or a secure erase of the entire account. Browser storage is local profile data, not a second offline login boundary: someone using that profile can open its saved downloads. No access/refresh tokens, passwords or remote signed media URLs are stored in a download.

## Production app shell

Saved publication bytes and a cached application shell are separate requirements. For a web cold start, serve `pnpm build` output at the site root over **HTTPS or localhost**, load Avid while online, and reopen/reload it so the installed service worker controls the page. The downloads screen reports when the shell is not yet active. The service worker caches public application build resources; it does not cache BookOrbit API/authentication responses or private book requests.

`pnpm dev` does not install that production shell and needs its Vite server running. The default development and preview ports are different origins, so their IndexedDB downloads are different too. Use the same scheme, host and port when testing a saved package after switching to a production preview. Installed native shells already contain app resources, but the new IndexedDB/blob offline flow still needs physical-device qualification; packaging the app does not prove its background behavior or durable storage guarantees.

Browser/OS storage eviction, private mode, site-data clearing and quota limits still apply. A best-effort persistent-storage request may be denied. Clearing browser data can remove both downloads and local notes. Reopening a damaged package reports an error instead of using corrupt or partial data. A failed download can be retried, but interrupted byte-range downloads do not resume in this slice.

Damaged package metadata does not hide healthy downloads. The downloads screen shows a generic **Damaged download** entry without displaying unreadable account or book fields. **Remove damaged download** explicitly removes its package entry and bytes, preserving local notes and checkpoints; nothing is deleted automatically. A stale recovery action cannot delete a package that has since been repaired by downloading it again.

## Tests and evidence

Validation recorded on 2026-10-10 for this slice: **786 tests passed across 101 files**, TypeScript passed, and the production build passed. After the final offline-note navigation change, its 9 component tests, 9 reader chrome tests and 3 shell tests passed again. The package and isolated-progress suites cover 31 and 35 scenarios respectively: real EPUB/WAV bytes, SHA-256 round trips, original-account/edition separation, missing/corrupt assets, changed manifests, cancellation, rollback on quota/write failures, timestamp ordering and an empty offline sync outbox.

The Codex in-app browser exercised the original two-passage EPUB/WAV fixture. Actual rendered EPUB highlights moved forward and backward while paused, the exact terminal gap cleared both marks, and automatic following left the preview checkpoint count unchanged. This exposed and fixed detached-iframe cleanup and decoder-end rounding bugs that mocked playback alone did not show.

A production build with a temporary local fixture entry saved the package on a separate test origin. After loading/reopening the main app to activate its shell, the preview server was stopped (an HTTP probe could not connect). A cold main-app reload still opened the saved EPUB, re-verified the paired edition, rendered its highlight, played both saved audio resources, displayed timed text, sought backward into the ebook, and saved an audio note. The temporary fixture entry/configuration were removed; neither ships in the release build. The cold-start test exposed `Vary: Origin` cache misses for public module assets; a regression test now covers that fix. These checks require no BookOrbit server or account.

This evidence covers the recorded synthetic fixture and browser paths. It does not establish real-library alignment for arbitrary editions or installed-device behavior. Physical-device codec, accessibility, interruption, storage pressure and background acceptance remain pending. Earlier native CI results belong to their recorded commits and do not certify these new UI paths.

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

Load `/` while that server is running, wait for service-worker activation and reopen/reload. Stop the server or enable the browser's offline mode, cold-open `/`, and open the saved package. Check text, playback, both handoff directions, preview without saved-position movement, explicit saves, local notes, close/reopen restoration and zero BookOrbit requests. Test a second account and a changed edition with reused file IDs; their notes and positions must remain isolated. Record exact commit, browser/OS, fixture, steps and results. Returning to development on the same origin may require unregistering the production service worker in browser developer tools; do not clear IndexedDB if retaining downloads and notes is intended.

Use only the original synthetic fixtures or authorized publications. Keep the supplied BookOrbit server read-only; this test needs no server mutation, external account or real credentials.

## Still pending

Full multi-gigabyte downloads, range resume, download scheduling/network policies, pinning/eviction/storage management, all-format offline catalogs and search, cross-device offline reconciliation, and native offline background playback remain implementation work. Advanced Phase 2 audio processing/transcription/generated alignment and broader queue/car browsing work remain on the roadmap. Physical-device codec, low-memory, low-space, interruption/kill/restart, background, assistive-technology and language checks are separate acceptance gates. Completing the tests above closes only this bounded slice's recorded scenarios.
