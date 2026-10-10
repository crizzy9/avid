# Exact read/listen handoff

Existing EPUB SMIL narration continues to work through Foliate. The separate audiobook bridge is deliberately narrower: it links a standalone asset only when its **complete bytes match the narration resource in the exact open EPUB**, and the server playlist agrees with that EPUB's actual SMIL, spine and text fragments. Titles, durations, file sizes, ETags and book membership alone are not alignment proof.

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

The browser controller preserves declared manifest durations as canonical track boundaries. `loadedmetadata`/`durationchange` record separate `decodedDuration` observations; only originally unknown durations are discovered or refined. Exact handoff permits at most 2 milliseconds of decoder/manifest precision difference, accommodating millisecond timestamp quantization without changing any source offset. A larger observed difference rejects handoff. Three regressions cover both original WAV tracks after rounded metadata, a material 250-millisecond mismatch, and discovery of unknown duration. Native transports retain their manifest offsets, but physical decoder/edition qualification is still required.

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
