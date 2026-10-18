# Apogee reference update — 2026-10-18

This is a public-source comparison against the October 9 [research baseline](research-baseline.md). It records developer-reported features, not an installed-app audit, source-code equivalence or verified Avid parity. No private account, publication or server was accessed for this research. Historical research is retained; the [current roadmap](roadmap.md) controls implementation priorities.

## Current release and baseline correction

The current App Store release is **1.1.1**, dated **2026-10-15T18:10:38Z** by Apple's public lookup. The prior 1.1.0 release was October 7. [App Store version history](https://apps.apple.com/us/app/apogee-reader/id6779567734), [Apple lookup](https://itunes.apple.com/lookup?id=6779567734&country=us).

Prepare Read & Listen was not introduced after our baseline. The maintainer announced it in **build 323 on September 11**: open it from More, prepare matching in advance, inspect status by book, and optionally let the work run overnight while charging. The baseline missed that behavior and treated authored media overlays as the principal path. [Build 323 announcement](https://github.com/briarrrn/apogee-issues/discussions/132).

The initial **build 271 on August 18** joined a title's ebook and audiobook and followed narration in the reader. Its announcement requested feedback about edition mismatches and initially required downloaded audio. [Build 271 announcement](https://github.com/briarrrn/apogee-issues/discussions/76).

**Build 377 on September 28** added matching while streaming, fetching the audio needed for the current location instead of requiring the complete audiobook first. It also described word highlighting. Consequently, the launch-era download prerequisite cannot be applied to all later live matching. [Build 377 announcement](https://github.com/briarrrn/apogee-issues/discussions/163).

## What public sources establish about preparation

The product site describes on-device matching between a title held as an ebook and an audiobook, with narrated text in the player and following in the reader. Combined with the build announcements, this supports a preparation job that examines independent text/audio content; it does not support an embedded-SMIL-only interpretation. [Product description](https://apogeereader.app/).

The public sources do not identify the recognition engine/model, matching algorithm, language coverage, confidence thresholds, processing limits, exact persisted format or all offline readiness conditions. The privacy statement says the app talks to the user's server and optional integrations rather than an Apogee-operated data backend; it does not identify a particular speech framework. These details must remain unknown rather than being attributed to Apogee. [Privacy statement](https://apogeereader.app/privacy/).

The public roadmap was marked updated October 8 when inspected. Its forthcoming preparation improvements include clearer stages, incremental saving and reduced heat. That is planned behavior, not evidence those improvements shipped in 1.1.1. [Official roadmap](https://apogeereader.app/roadmap/).

The audiobook guide also describes a separate chapter-level offer to jump to where the user has read, using a downloaded ebook's contents. That convenience should not be confused with verified sentence-level alignment. [Audiobook guide](https://apogeereader.app/guides/audiobooks/).

## 1.1.1 additions to track

The following concise checklist comes from the published 1.1.1 notes. Checked means a scoped Avid source implementation with focused tests, not installed-app or visual parity. Unchecked items need further implementation/comparison and recorded acceptance; they do not assert that Avid lacks every part of the feature. [Release notes](https://apps.apple.com/us/app/apogee-reader/id6779567734).

- [x] Richer EPUB/PDF selection actions: colors, inline note, copy, explicit lookup/translation links, native share or attributed-copy fallback. New strings cover seven locales.
- [x] Home pins for smart scopes and collections — scoped implementation below.
- [ ] Offline server-generated speech preparation — explicitly deferred to Phase 3.
- [x] Named server voices and bounded one-chunk lookahead. Real caption times drive highlights; buffering is excluded from speech activity. Native/background qualification remains open.
- [ ] Series-wide batch downloads — explicitly deferred to Phase 3.
- [x] Comic grouping by story arc: bounded, explicit metadata indexing with coverage and load-more controls. The server has no verified arc-index route.
- [x] Bounded AO3 work-skin recovery during explicit import/update: existing authenticated source CSS and classes are restored into a new edition only after exact chapter matching. Earlier editions remain intact. The per-file “Use publication formatting” setting displays it. Advanced skins and live Calibre/native qualification remain limited; see [AO3 formatting recovery](ao3-formatting.md).
- [x] Chapter-title-independent content matching, now with contextual dialogue/repetition handling and a stronger recognition option. Small human-audio evidence is recorded; whole-book/edition and installed-device acceptance remain open.
- [x] PDF width/page fitting, crop-aware geometry and PDF.js 5 text-layer positioning. Browser selection/highlight checks passed on the two-page fixture.
- [x] One queued top notification banner, including modal dialogs, account resets, persistent errors and paused expiry while focused/hovered/hidden.
- [x] BookOrbit 3.4 missing-format and atomic ebook/audiobook-pair requests, explicitly capability-gated, with status paging and read-only mutation guards.
- [ ] Translation refinements: all newly added features have seven-locale labels and explicit translation actions; a full reference-copy/native locale audit remains open.

The October 9 **build 385** announcement adds useful implementation context for Home pin ordering, preparation progress/stop/retry, voice-storage management and overnight/low-light controls. It was a TestFlight announcement; details absent from the App Store notes are not independently established as 1.1.1 release behavior. [Build 385 announcement](https://github.com/briarrrn/apogee-issues/discussions/172).

## Two different preparation features

| Name | Input and purpose | Avid scope |
| --- | --- | --- |
| Prepare Read & Listen | Compare an ebook with an existing audiobook so their locations can follow one another. | Current Phase 2 priority: local matching, persisted preparation and offline playback. |
| Prepare for Listening | Retain a server-generated voice for a downloaded ebook so Speak can use it offline. | Online server speech is implemented against a verified contract; retaining generated speech offline is Phase 3. |

The second feature is explicitly described in the build 385 announcement. A TTS download does not create alignment between an independently supplied audiobook and ebook. [Build 385 announcement](https://github.com/briarrrn/apogee-issues/discussions/172).

## Feasible implementation and acceptance boundaries

Avid now implements explicit local recognition and text matching, with exact edition identities, source-time anchors, unmatched gaps, cancellation, atomic storage and a prepared viewer. It accepts an ordinary EPUB plus the same BookOrbit title's independent audiobook; it does not require SMIL or matching chapter names. The default English model is `Xenova/whisper-base.en`, pinned at `95bf40a508535962c6483ead40270b2e32267508`, through Transformers.js 4.3.1; the smaller pinned tiny.en model remains selectable. [Human-narration evidence](read-listen-benchmark.md) covers twelve fixed excerpts and controlled reflow, not arbitrary editions or full novels. No BookOrbit mutation is necessary to process authorized inputs; the existing read-only test-server restriction remains in force.

Home now includes a local per-account pin manager for collections and smart scopes, ordered pins, header-open browsing, 12-book shelves and 40-book pages. Its maximum is 12 pinned shelves. Thirteen focused tests cover saved ordering/account isolation, failure/retry, corrupt preferences, late responses and bounded large-catalog paging. The feature uses existing read-only server queries and local preferences; it does not synchronize Home layout to another device. Installed-app visual comparison remains open.

Prepared playback belongs to Phase 2, including retained assets. Its current limits are 64 MiB per EPUB, 512 MiB per audio asset and 2 GiB total, with foreground operation and English recognition only. The prepared viewer does not save positions, notes, highlights or activity. Broader offline library/editing, durable progress reconciliation and multi-device conflict handling are fully deferred to Phase 3. Earlier SMIL packages remain readable and their old notes/progress databases are preserved without being opened by the new viewer.

The 1.1.1 checklist is wider than this bounded implementation. Series-wide downloads depend on deferred download management. Server voice and request features use the separately verified [BookOrbit 3.4 contracts](bookorbit-3.4.md), while the original adapter baseline remains documented as v3.3.0. Reader selection, story arcs, AO3 styling and PDF behavior still require installed-device comparisons. Public release-note coverage and source implementations cannot justify an all-features or visual 1:1 claim.

Earlier preparation baseline validation: **880 tests across 111 files**, TypeScript and the production build passed. CPU and web-runtime WebAssembly smokes in a Node harness matched **one of two paragraphs** of the original synthetic fixture; the misheard paragraph remained unlinked. That historical result does not certify the expanded implementation. Current human-audio, browser-worker and source-suite evidence appears below and in the [read-along guide](phase-2-3-read-along.md).

## Additional Avid validation in this update

The broader implementation and server contracts are recorded in [BookOrbit 3.4 requests and voices](bookorbit-3.4.md) and the [matching benchmark](read-listen-benchmark.md). The full suite passed 1,027 tests in 131 files, TypeScript and production build passed, and the real browser-worker preparation fixture matched both human-narrated paragraphs. Forward/backward rendered highlights, terminal-gap clearing, session-only navigation and saved playback with fixture downloads blocked passed in the browser. These are bounded fixture results; full-book, cold production start and iOS qualification remain open. All server mutation tests use controlled fixtures; the supplied test server remains untouched. The new offline work is limited to retained Read & Listen preparation. Full offline catalogs, resumable/batch downloads, offline server speech, editing and reconciliation remain Phase 3.
