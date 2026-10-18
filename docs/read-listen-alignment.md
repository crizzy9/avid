# Read/listen preparation and exact handoff

Updated: 2026-10-18. Phase 2 now includes a bounded local preparation implementation for an **independent ebook and audiobook**, followed by retained offline read-along. This corrects the earlier baseline's incomplete understanding of the reference behavior. The [release comparison](apogee-release-delta-2026-10-18.md) documents the primary sources. Generated preparation and the older SMIL bridge have separate verification paths and evidence; neither establishes complete reference parity.

## Generated preparation implementation

`apps/web/src/preparation/prepareReadListen.ts` orchestrates explicit preparation. `generatedText.ts` extracts real EPUB paragraphs and CFIs; the worker recognizes audio using Transformers.js 4.3.1. Balanced uses quantized `Xenova/whisper-base.en` at revision `95bf40a508535962c6483ead40270b2e32267508`; Compact uses `Xenova/whisper-tiny.en` at revision `79fb389fc764e7c395bd330e9531d9d32ada7049`. Recognition is local and English-only. The first run downloads public model data. `audioWindows.ts` decodes overlapping windows of at most 30 seconds to mono 16 kHz and retains actual source offsets, avoiding a whole-audiobook PCM allocation. Full-book word lists and complete source Blobs are still retained; this does not establish bounded whole-job memory.

`packages/playback/src/generated-alignment.ts` matches the actual recognized words against publication paragraphs, run through a separate cancellable worker in the app. It accepts a regular EPUB without narration and does not consult chapter titles to establish a match. Selected word boundaries establish source-time intervals; no audio percentage becomes a CFI. The current `avid-word-match-v2` retains a 0.88 agreement floor, a token-agreement measure rather than a calibrated recognition probability. It adds bounded long-paragraph matching and contextual short/repeated passages between independent anchors; unresolved ambiguity, low agreement and unsupported timing cases remain unmapped. Earlier v1 packages remain readable.

`packages/core/src/preparedReadListen.ts` binds the original account, selected book/text/audio files, complete input SHA-256 values, ordered audio assets and durations, manifest revision, algorithm/model version and matched text/timing anchors. The EPUB and every needed audio blob are verified before the metadata/payload transaction publishes readiness. Cancellation, changed input, failed verification or insufficient storage rejects publication and preserves an earlier ready edition. Complete preparations can be reused without recognition; matching legacy package audio can be reused as input without deleting the old package.

On reopening, the store rechecks the artifact and actual source bytes. The reader's `restorePreparedAlignment` rehashes the current EPUB/audio, validates account/edition/timeline identity, and resolves the retained text against the loaded publication before issuing a fresh session-local map. Persisted JSON is never simply cast into the existing proof. Tokens, passwords and remote media URLs are excluded from prepared storage. `PreparedReadListenViewer` uses retained local blobs without a live client or recognition job. Its reading/audio positions are session-only: no annotations, durable checkpoints, reading activity or outbox writes. Old offline progress/notes databases are preserved and left unopened. Broader offline edits and server reconciliation remain deferred Phase 3 work.

Limits are 64 MiB per EPUB, 512 MiB per audio asset and 2 GiB total source bytes, with a 32 MiB metadata bound. Browser decoding, memory and available storage can impose lower practical limits. Recognition and prepared playback currently require Avid to remain open in the foreground. The current small human-audio benchmark linked 10/12 source excerpts and 19/21 reflowed passages with Balanced. The browser worker matched both paragraphs of the 15.86-second human fixture; rendered forward/backward highlighting, gap clearing and saved reopening with audio downloads blocked passed. That warm fixture does not certify cold production startup, full books or installed devices. See the [current preparation guide](phase-2-3-read-along.md), [benchmark](read-listen-benchmark.md) and planned [full-book validation](phase-2-full-book-validation.md). The historical tests below certify only the SMIL path.

## Existing SMIL and identical-narration bridge

Existing EPUB SMIL narration continues to work through Foliate. Its separate audiobook bridge is narrower than generated preparation: it links a standalone asset only when its **complete bytes match the narration resource in the exact open EPUB**, and the server playlist agrees with that EPUB's actual SMIL, spine and text fragments. Titles, durations, file sizes, ETags and book membership alone are not alignment proof. These constraints remain correct for this bridge and are not prerequisites for the new preparation flow.

## Verified BookOrbit contract

Inspected BookOrbit v3.3.0, commit `e767358443419253eeed782518d6fc4f675d69fd`:

- `GET /api/v1/epub/:bookId/media-overlay?fileId=:textFileId` returns SMIL items, clip begin/end seconds, section index, text href/fragment and audio resource href/size. Avid always supplies and validates the explicit file ID.
- `GET /api/v1/epub/:bookId/media-overlay/file/*?fileId=:textFileId` serves narration resources, including range responses. Resource paths are archive-relative and validated before URL construction.
- `GET /api/v1/audiobooks/:bookId/manifest` supplies revision, ordered assets, actual track durations and asset IDs; `GET /api/v1/audiobooks/:bookId/assets/:assetId/content` supplies the selected standalone audio.
- The server's internal `audiobook-ebook-progress-sync.service.ts` uses a duration-ratio conversion after a 5% / 300-second similarity check. This is an approximation, not a public exact alignment manifest. Avid does not reproduce that conversion or treat it as matching-edition evidence.

Primary source: [EPUB controller](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/modules/reader/epub/epub.controller.ts), [playlist types](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/packages/types/src/epub.ts), [server progress bridge](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/modules/book/audiobook-ebook-progress-sync.service.ts).

## Reader and player integration

`Reader.onAlignmentReady(handle)` supplies `ReaderAlignmentHandle` for a Blob-backed EPUB. A URL fetched later could be a changed edition, so URL-only sources do not advertise this capability. Reader close/account changes clear the handle. `Reader.modeControls` renders app-owned link/handoff controls inside the modal.

On explicit verification, the app chooses the EPUB-resource ↔ standalone-asset pairings, fetches authenticated complete assets with `getAudioAssetBlob(bookId,assetId,{signal,maxBytes})`, then calls:

```ts
const map = await handle.verifyAudiobook(playlist, manifest, audioFileId, [
  { audioHref, assetId, fileId, bytes },
]);
```

The reader checks the server playlist against the actual loaded archive, hashes that complete EPUB, extracts its actual narration resources and verifies full SHA-256 equality with the candidate audio bytes. Every linked passage needs a known clip end, exact text fragment, verified resource and known track duration. Ambiguous repeated fragments, overlapping audio intervals, mismatched resource sizes and unavailable timing reject. An explicit file pairing is not enough by itself.

The frozen map binds account scope, book, text file ID and SHA-256, selected audio file, manifest revision and ordered track durations. Proofs and maps are session-local objects, not reloadable JSON. The immutable map may outlive the reader but must be cleared on account/source changes. The app must recheck the current manifest revision after network verification and before activating a source. The existing resume flow also checks revision on opening playback.

The browser controller preserves declared manifest durations as canonical track boundaries. `loadedmetadata`/`durationchange` record separate `decodedDuration` observations; only originally unknown durations are discovered or refined. This SMIL bridge permits at most 2 milliseconds of decoder/manifest precision difference. Generated matching separately permits 0.5 seconds plus 2 milliseconds when a canonical duration is a whole second, reflecting verified BookOrbit rounding; fractional durations keep the stricter tolerance. Active-track bounds prevent a decoded tail from selecting the following track. No duration ratio stretches timestamps. MP3 priming/padding and physical decoder/edition qualification remain open; see the [benchmark clock notes](read-listen-benchmark.md).

For reading → audio, `handle.currentPassage(map,liveEdition)` resolves an explicit text selection first, then an explicitly opened navigation target, then the first mapped passage inside the actual visible DOM range. Retaining an explicit target until user navigation avoids jumping to the first paragraph when returning from a later paragraph on the same short page. Wholly unmapped text remains null; there is no nearest-off-page lookup or CFI derived from percentage. `alignedAudioAnchor(...)` returns the exact track ID, track seconds, complete-book source seconds and manifest revision for the existing playback flow. Call `handle.pauseNarration()` to stop embedded SMIL and speech before changing playback owner. `handoffToAudio(...)` additionally validates a supplied player source before pausing/loading it; it does not autoplay.

For audio → reading, `handoffToText(map,liveEdition,transport)` validates the active source and pauses to capture its final source time. It returns the exact EPUB href/fragment. The reader accepts that navigation target and emits its real native CFI after relocation. A caller may carry its last known text progress for temporary display; audio percentage must not be treated as text location. Unaligned gaps remain null. Intervals include their start and exclude their end; speed never scales source seconds.

## Bounds and evidence

Complete-resource verification is currently limited to 64 MiB per standalone asset and EPUB narration resource. The authenticated reader rejects partial, empty, truncated and oversized responses, checks Content-Length before reading, enforces a streaming byte limit even without Content-Length, and cancels the stream on account/source abort. Normal playback still streams; it does not download full audio for routine listening. Different encodings, edited audio or a large consolidated audiobook will not byte-match and therefore remain unlinked.

Offline tests cover 21 exact-map/transport cases, 10 contract/path cases, 9 bounded authenticated-read cases, and 7 real original EPUB/WAV fixture tests through Foliate, XML timing comparison, DOM passage resolution and both directions. Original fixture narration is synthetic eSpeak audio with authored timing. Previously recorded embedded-browser SMIL checks cover real WAV play/pause, source clock, speed, follow and passage highlights.

The app-owned `AlignmentControls` component has ten tests covering explicit selection, no fetch on mount, per-asset/total byte limits, cancellation/unmount/account guards, changed revision rejection and seven-language controls/errors without restarting requests. Metadata loads only after Link audiobook; complete standalone asset downloads begin only after Verify selected audio. Unknown backend/parser diagnostics retain their source text after a localized explanation.

`packages/readers/fixtures/reader.html?format=HANDOFF` supplies an actual Reader/AlignmentControls/PlaybackController browser harness using the original EPUB and identical WAV files served as standalone assets. Its client supplies local read-only metadata and actual local asset reads. It checks fresh EPUB bytes before returning to text and exposes exact locator logs. Browser results for this fixture are recorded separately; unit tests alone do not certify the button flow.

These tests do not claim a real server's separate audiobook edition was linked or that physical iOS/Android interruption and source transitions were qualified. Actual matching production assets, writable-server effects and native lifecycle qualification remain separate gates.

## Browser handoff evidence (2026-10-09)

The original `HANDOFF` fixture passed the actual Reader + AlignmentControls + PlaybackController flow in the embedded browser: explicit pairing of both WAV resources; successful full-byte verification; text p1 to playing standalone track 1; paused track 2 at 4.367s to `chapter.xhtml#p2` after re-hashing the fresh EPUB; and immediate return from p2 to track 2 at 4.167165532879818 source seconds (track time 0). Verification issued one playlist read, two manifest reads and two asset reads. The first runtime check exposed decoder-duration rounding changing canonical offsets; the fixed flow and a real-WAV regression now pass. This is controlled original-fixture evidence, not a linked private server edition or physical-device result.
