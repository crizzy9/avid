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

- [ ] Richer EPUB/PDF selection actions, including lookup, translation and sharing.
- [x] Home pins for smart scopes and collections — scoped implementation below.
- [ ] Offline server-generated speech preparation.
- [ ] Named server voices and smoother speech.
- [ ] Series-wide batch downloads.
- [ ] Comic grouping by story arc.
- [ ] Preserved/restorable AO3 publication styling.
- [ ] Ebook/audiobook matching despite different chapter titles — bounded generated matching implemented; broader accuracy/edition acceptance remains open.
- [ ] PDF width fitting and selection-highlight positioning.
- [ ] A single top notification banner.
- [ ] BookOrbit 3.4+ missing-format and combined ebook/audiobook requests.
- [ ] Translation refinements.

The October 9 **build 385** announcement adds useful implementation context for Home pin ordering, preparation progress/stop/retry, voice-storage management and overnight/low-light controls. It was a TestFlight announcement; details absent from the App Store notes are not independently established as 1.1.1 release behavior. [Build 385 announcement](https://github.com/briarrrn/apogee-issues/discussions/172).

## Two different preparation features

| Name | Input and purpose | Avid scope |
| --- | --- | --- |
| Prepare Read & Listen | Compare an ebook with an existing audiobook so their locations can follow one another. | Current Phase 2 priority: local matching, persisted preparation and offline playback. |
| Prepare for Listening | Retain a server-generated voice for a downloaded ebook so Speak can use it offline. | Separate speech/cache feature; verify the actual server contract before implementation. |

The second feature is explicitly described in the build 385 announcement. A TTS download does not create alignment between an independently supplied audiobook and ebook. [Build 385 announcement](https://github.com/briarrrn/apogee-issues/discussions/172).

## Feasible implementation and acceptance boundaries

Avid now implements explicit local recognition and text matching, with exact edition identities, source-time anchors, unmatched gaps, cancellation, atomic storage and a prepared viewer. It accepts an ordinary EPUB plus the same BookOrbit title's independent audiobook; it does not require SMIL or matching chapter names. The configured English model is `Xenova/whisper-tiny.en`, pinned at `79fb389fc764e7c395bd330e9531d9d32ada7049`, through Transformers.js 4.3.1. The generated paragraph matching is a bounded implementation of this behavior, not evidence of arbitrary-edition or human-narration accuracy. No BookOrbit mutation is necessary to process authorized inputs; the existing read-only test-server restriction remains in force.

Home now includes a local per-account pin manager for collections and smart scopes, ordered pins, header-open browsing, 12-book shelves and 40-book pages. Its maximum is 12 pinned shelves. Thirteen focused tests cover saved ordering/account isolation, failure/retry, corrupt preferences, late responses and bounded large-catalog paging. The feature uses existing read-only server queries and local preferences; it does not synchronize Home layout to another device. Installed-app visual comparison remains open.

Prepared playback belongs to Phase 2, including retained assets. Its current limits are 64 MiB per EPUB, 512 MiB per audio asset and 2 GiB total, with foreground operation and English recognition only. The prepared viewer does not save positions, notes, highlights or activity. Broader offline library/editing, durable progress reconciliation and multi-device conflict handling are fully deferred to Phase 3. Earlier SMIL packages remain readable and their old notes/progress databases are preserved without being opened by the new viewer.

The 1.1.1 checklist is wider than this bounded implementation. Series-wide downloads depend on deferred download management. Server voice and request features require their own verified contracts; Avid's currently documented server adapter baseline is v3.3.0, so 3.4 routes must not be guessed. UI selection, story arcs, AO3 styling and PDF behavior require individual comparisons. Public release-note coverage and the implemented Home pin slice cannot justify an all-features or visual 1:1 claim.

Validation: **880 tests passed across 111 files**, TypeScript passed, and the production build passed. Real CPU and web-runtime WebAssembly smokes in a Node harness recognized the original synthetic fixture and matched **one of two paragraphs**; the misheard paragraph remained unlinked. This is limited positive evidence for a real recognizer, not a book-level quality benchmark or browser-worker acceptance. New browser/device acceptance remains open. Historical SMIL/browser results in the [read-along guide](phase-2-3-read-along.md) do not certify the generated path. Record the exact build, model/runtime, browser/device, mismatch cases and cold offline result before expanding the claim.
