# Avid reader package

`src/Reader.tsx` exports `Reader`, a full-screen native-modal React reader. Required props are the core `Book`, annotations, and close/anchor/annotation callbacks. Pass an explicit `BookFile` and `source: Blob` for authenticated downloads or imported files; ordinary file URLs are also accepted. `initialAnchor` restores native locators. `accountScope` scopes device preferences, imported fonts, and note drafts. `onActivity` reports reading, actual speech, or aligned-audio activity so the shell can avoid double-counting sessions.

## Engines

- EPUB/MOBI: vendored Foliate.js at commit `78914aef4466eb960965702401634c2cb348e9b1`, CFI restoration, book search, TOC, selection highlights, notes, paginated/scrolled layouts, typography, colors, imported fonts, and turn effects.
- PDF: separate PDF.js renderer with one active page canvas, selectable text, page/rectangle anchors, page search, automatic content-bound detection and manual crop.
- CBZ: fflate ZIP decoding with declared compressed/inflated limits and natural filename order.
- CBR/CB7: lazily loaded libarchive WASM worker with individual-page extraction. Includes one-page, separate-cover spreads, reading directions, and bounded webtoon rendering with page/offset anchors.
- Existing EPUB media overlays: actual SMIL text fragments and source clip times drive narration, highlights and optional follow-text. Controls include pause, resume, passage skips, and speed. Separate audiobook alignment requires explicit complete-byte verification described below.
- Speech: installed browser voices, real word-boundary callbacks where available, and continuation across sections. This is a foreground browser implementation; native background speech is a separate platform requirement.
- Speech source mapping preserves inline words, starts at the selected character, and skips non-linear sections. Voice, narration, font-import and search failures show a dismissible notice without removing the open publication.

Only `demo-*` books without a source can render the clearly labeled original Avid demonstration EPUB. Real books without available content show an explicit error.

## Language

Reader controls, settings, notes/search, speech/narration controls, PDF cropping, comic/page status and application recovery messages have explicit catalogs for English, Finnish, French, German, Polish, Simplified Chinese and Spanish. `useReaderI18n()` observes the shared app language without reopening the publication. Generated page labels and accessibility labels follow that language; publication text, its own contents titles, filenames and installed voice names remain source data. Unknown third-party decoder diagnostics remain available after a translated explanation.

Catalog tests require seven nonempty translations and identical interpolation placeholders per key. Rendered UI tests switch through all seven languages and check settings, notes, search and accessible names while confirming the ebook component stays mounted. Text wrapping handles expanded labels; actual device, screen-reader and native-speaker review remain release checks.

## Content boundary

Before any book document is navigated to, Avid removes executable/embed/form content and event handlers, injects a restrictive CSP, and renders it in an iframe without `allow-scripts`. Book resource URLs are limited to archive-local blob/data URLs by CSP; unexpected network requests, nested frames, scripts and forms are blocked. EPUB scripts never receive a native bridge. Pinned upstream changes and license are recorded in `vendor/foliate/AVID-NOTICE.md` and `LICENSE`.

## Evidence and limits

Comic direction now has a per-title Automatic/Manga (RTL)/Comic (LTR) choice. Automatic uses account/device keywords against selected genres, title or series, with a conservative default of `manga` in genres only. Keywords are literal, Unicode-normalized and case-insensitive; explicit title preferences survive rule changes without affecting another title or account. Rule configuration is available in comic reading settings. The old account-global direction no longer leaks into unrelated comics. Five rule/render tests cover this behavior; these preferences do not yet round-trip to BookOrbit.

`onAlignmentReady` exposes actual EPUB/SMIL verification and live DOM passage lookup to the app; `modeControls` places app-owned handoff controls inside the reader dialog. Separate audiobook linking requires complete matching audio bytes and current manifest revision, not titles or duration similarity. Seven tests use the original EPUB/WAV fixture through Foliate to verify timings, exact text fragments and both-direction targets. See `docs/read-listen-alignment.md` for the source-time bridge contract and explicit production/native qualification gates.

The handle is published after renderer initialization. `getTimedText(map,edition)` returns frozen `AlignedPassageText` lines containing only verified source fragment text, IDs, exact locators and source intervals. Each call verifies the current account/file and full EPUB hash. `passageAtLocator(map,edition,locator)` resolves a captured CFI or fragment against its parsed section independently of later viewport movement, so a saved anchor is never paired with whatever the user is viewing after an asynchronous save. Plaintext normalization is shared with offline package validation through `packages/core/src/readAlongText.ts`; hidden/executable content is omitted and block word boundaries are preserved. An unspoken heading or an empty fragment does not become a manufactured lyric.

`followAudio(map,edition,sourceSeconds,{follow})` highlights the current exact passage, including paused/backward seeks. With follow disabled it updates only loaded page DOM; with follow enabled it navigates the exact fragment once per passage and reanchors when following resumes. Half-open interval gaps clear the highlight. `clearAudioHighlight()` and reader close cancel queued work. The caller owns playback, source/revision guards and which audio owner is active; call `pauseNarration()` before starting standalone playback.

Set `persistProgress={false}` for deliberate preview/browse or external audio following. Locations continue updating the reader UI and `onPreviewAnchor`, while `onAnchor` stays silent. Returning to normal mode does not automatically commit the preview. External audio and embedded SMIL automatic navigation also suppress their own relocation checkpoints. Only an explicit app action should save the preview anchor. Reader tests cover this separation plus actual original EPUB/WAV text, silent gaps, hold/refollow, and stale asynchronous navigation. Existing SMIL tests also cover exact clip ends, paused backward positions, stale audio events and late loads after stop.

Reader unit tests cover native CFI restoration after typography changes, page/backward/offset anchors, source Blob normalization, isolation, EPUB packaging, CBZ extraction, actual RAR4/7-Zip image decoding, PDF crop bounds, and actual SMIL fragment/source-time transitions. The embedded-browser EPUB smoke test covered rendered content, TOC, search, notes and typography. Additional embedded-browser fixtures passed PDF rendering/cropping/restoration, CBZ/CB7/RAR4 image rendering, spreads/RTL, exact within-page webtoon restoration, and actual aligned WAV playback with a progressing source clock, pause, follow toggle, speed and highlighted passage skips. The parent app additionally tests real server files.

The original MOBI6/PalmDB fixture passes Foliate metadata, section and TOC byte-offset parsing tests; protected-file flags produce an explicit error. Speech range tests cover exact selection starts, words spanning inline markup, real callback-offset mapping, hidden content and linear-section transitions. Installed-voice playback and cross-chapter interruption still require runtime qualification.

Fixtures in `fixtures/` are original synthetic assets and are not included in the production application. Decoder unit tests do not certify every RAR variant, fixed-layout publication, speech voice, PDF, or mobile WebView. Production-build WASM packaging, accessibility on each OS, native lifecycle, and broad format corpora remain explicit qualification work.

The comic browser limit is 150 MB compressed, 40 MB per image, at most 2,500 images, and 350 MB total inflated bytes for CBZ. Encrypted archives are rejected. At most three fonts of at most 1 MB each are retained per account/device. Font validation uses `FontFace.load()` before persistence.
