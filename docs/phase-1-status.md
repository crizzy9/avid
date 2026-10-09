# Phase 1 implementation and release evidence

Updated: 2026-10-09. This is the release checklist for the 66 Phase 1 rows in [the research baseline](research-baseline.md). **Phase 1 is not complete.** A working browser implementation, Android debug APK, Linux development binary and integrated iOS source targets are available; a six-platform parity claim would be premature.

`Browser implemented` means the source path works in the web runtime and has the stated evidence. It does not imply that all supported formats, mobile WebViews, assistive technologies, or recovery cases passed. `Partial` identifies missing behavior or evidence. `Pending` means an applicable release requirement is not implemented or qualified. No external entitlement or device result is inferred from the presence of code.

## Connection and library

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F01 | BookOrbit | Browser implemented. Real password login, catalog, covers, file reading, and pagination tested with a supplied server in read-only mode. API reference is pinned to v3.3.0. |
| F02 | Password login | Partial. Memory-only browser session, cookie refresh contract, concurrent refresh tests, and read-only guard. Native secure credential storage and expiry recovery on actual devices pending. |
| F03 | Provider login | Pending end-to-end provider flow and native callback proof. Provider discovery contract exists; no generic OAuth flow is falsely advertised. |
| F04 | Home / Library / Browse | Browser implemented with 48-item requests, cancellable server search, shelves, sorting, and virtualized grid/list. Synthetic 10,000-book tests keep fewer than 70 cards mounted, preserve keyboard focus, and prove zero eager cover fetches; viewport/focus-driven covers use four requests, 96 blobs and 32 MiB maximum. Metadata remains in memory. Hardware memory/FPS and native-device acceptance remain; see [performance evidence](library-performance.md). |
| F05 | Series | Partial. Loaded catalog books group and sort by server series name/index. Complete paginated series discovery and edition identity qualification remain. |
| F06 | Collections | Partial. Collection reads, local sample queue/collections, and guarded server mutation contracts. Permission-aware membership UI and live writable fixture round-trip remain. |
| F07 | Manga filing | Partial. Persisted right-to-left comic layout exists. Per-title classification policy and account/server preference round-trip remain. |

## Readers

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F08 | EPUB | Browser implemented using pinned Foliate. Original fixture and a real server publication open; contents, search, settings, and native CFI checkpoints tested. Fixed-layout/device corpus still required. |
| F09 | MOBI | Original DRM-free MOBI6/PalmDB fixture passes metadata, section and byte-offset TOC tests; embedded browser visibly rendered “The long way home” after chapter navigation and retained it after close/reopen. Protected-file flags fail explicitly. Representative MOBI/AZW corpus and device checks remain. |
| F10 | Fonts | Browser controls for family, size, and line spacing. Exact CFI round-trip tests; native accessibility/rotation checks remain. |
| F11 | Themes | Paper, warm, dark, and custom reader colors. Browser checked; complete contrast matrix remains. |
| F12 | Margins | Browser control; exact location contract retained. Device reflow/selection tests remain. |
| F13 | Page flow | Embedded-browser MOBI switched to continuous scroll and retained the logical chapter and selected flow after close/reopen. Paginated and continuous Foliate paths are implemented; broader cross-mode recovery corpus and device checks remain. |
| F14 | Font import | Account/device-scoped validated local font import. Restart and quota/error behavior need broader browser/device checks. |
| F15 | Turn animations | None, slide/fade/fast fade preferences, reduced-motion handling. Full animation/selection parity remains unqualified. |
| F16 | PDF | Separate PDF.js bounded canvas/text-layer viewer. Embedded-browser fixture visibly rendered page 2 text; close/reopen restored page 2. Large-document memory and native/device corpus checks remain. |
| F17 | PDF cropping | Embedded-browser auto-crop detected nonzero content bounds; manual four-edge sliders and reset retain original annotation coordinates. Broad PDF/crop corpus and native/device validation remain. |
| F18 | CBZ | Actual CBZ image extraction, natural sorting and limits tested; embedded browser visibly rendered page 2 of the original three-page fixture. Device and large-archive qualification remain. |
| F19 | CBR | Actual RAR4 fixture decoded by libarchive WASM in unit tests and visibly rendered/navigated in the embedded browser. Other RAR variants, encrypted handling corpus and native paths remain unqualified. |
| F20 | CB7 | Actual 7-Zip fixture decoded by libarchive WASM in unit tests and visibly rendered/navigated in the embedded browser. Large-archive memory, production packaging and device qualification remain. |
| F21 | Paged comics | Embedded-browser CBZ/CB7/CBR fixtures displayed page 2 of 3 after navigation; bounded prefetch and persisted direction implemented. Restart/direction corpus and actual-device checks remain. |
| F22 | Webtoon | Embedded-browser webtoon closed/reopened at the exact 1,073 px scroll position, including within-page offset. Bounded rendering is implemented; long-archive memory/variable-image and native-device corpus checks remain. |
| F23 | Two-page comics | Embedded-browser spread visibly displayed pages 2 and 3, with RTL preference applied; unit tests cover separate cover and odd final spread. Broad odd/even corpus and physical tablet qualification remain. |

## Audio and speech

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F24 | Audiobooks | Browser transport and active native factory/bridge implemented; Android Media3 host builds a debug APK. iOS AVPlayer owner is integrated into an uncompiled Xcode target. Native adapter tests pass. Multi-file native queues, protected-stream/codec corpus and physical background qualification remain. |
| F25 | Chapters | Verified BookOrbit manifest normalization; track-relative source anchors. Chapter transition tests pass; real multi-track codec corpus required. |
| F26 | Speed | Browser pitch-preserving rate control and source-clock tests; native bridge delegates rate to AVPlayer/Media3 and reports owner state. Actual pitch/rate device qualification remains. |
| F27 | Sleep | Duration/chapter-end timers in browser and native owners; bridge tests verify native wall/source deadlines. Android compiles. Locked-screen/native interruption tests remain. |
| F28 | CarPlay | Pending entitlement, native browsing templates, simulator and physical car validation. |
| F29 | Lock Screen | Browser Media Session; active native owner metadata/remote-command route; Android session service compiles. Full chapter/artwork metadata and suspended-app physical acceptance remain. |
| F30 | Remote skipping | Browser transport handlers and native owner source. Bluetooth/headset/car testing remains. |
| F31 | Read and Listen | Existing EPUB SMIL fixture played real WAV narration in the embedded browser; source clock advanced to 0:01 and pause/speed controls worked. Real-production aligned corpus, standalone-audio bridge and native qualification remain. |
| F32 | Mode handoff | Embedded-overlay read/listen controls resumed actual audio and skipped between two distinct audio resources while paused, preserving the corresponding highlighted passage. Full bidirectional standalone-audio handoff remains. |
| F33 | Sentence highlighting | SMIL source-time unit tests and embedded-browser visible passage highlights passed; follow-text toggle and 0.75× speed verified. Proposed 250 ms timing at device/speed combinations and broader aligned corpus remain. |
| F34 | Speak | Installed browser voice selection and exact selection-start source mapping implemented; tests cover starting inside a paragraph and preserving inline words. Unavailable/failed speech produces a notice while the book remains open. Actual installed-voice and device validation remains. |
| F35 | Word highlighting | Actual boundary callbacks map UTF-16 offsets to exact ranges, including words spanning inline markup; deterministic tests pass. No synthetic precise timing is claimed when voices omit boundaries. Real-voice timing corpus remains. |
| F36 | Speech page turns | Reader follows boundaries, skips non-linear sections, and guards canceled utterance callbacks. Linear-section/end-of-book tests pass. Cross-section real voice and interruption corpus remains. |

## Progress, notes, and delivery

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F37 | Saved position | Transactional account-scoped IndexedDB checkpoints; EPUB CFI/page/comic/audio anchors. Tests cover account isolation. Native SQLite owner integration remains. |
| F38 | Progress sync | Outbox, original event time, stale-write conflicts and guarded audio revisions tested with mock contracts. Two real devices/writable fixture qualification remains; supplied server was never mutated. |
| F39 | KOReader sync | Native EPUB locator/file identity retained. KOReader fingerprint translation and actual device round trip remain. |
| F40 | Reading log | Visible-reader accounting and playback activity accumulator with pause/buffer/seek tests. Server deduplication contract verified; native suspended-owner integration remains. |
| F41 | Reading Stats | Activity UI reads server overview, summary and year calendar without blending local totals; it shows reading/listening filters, server timezone, year selection and current-week bars independent of the selected calendar year. Visible reading is journaled every 15 seconds and on hide/close with immutable session IDs; lifecycle, recovery and duplicate-retry tests pass. Local sample activity remains separate. Writable server totals comparison, platform-source filtering and timezone-boundary qualification remain. |
| F42 | Highlights | CFI/text/page-anchored selection and local persistence. Device selection and exact reflow corpus remain. |
| F43 | Notes | Create/edit/delete/jump for text and timestamp notes. Cross-device writable round trip remains. |
| F44 | Annotation search | Local notebook quote/text/book filtering and jump-to-source. Large synchronized corpus remains. |
| F45 | Annotation sync | Server IDs, tombstones, queued-edit remapping and uncertain-create reconciliation tests. Live multi-device acceptance remains. |
| F46 | Audio notes | Verified UUID-deduplicated BookOrbit bookmark APIs; whole-source-time anchors. No companion required by this contract. Device-to-device acceptance remains. |
| F47 | File upload | Native/web file selection and guarded server upload path. Local files open without upload; test-server uploads disabled. Writable upload/identifier fixture remains. |
| F48 | CrossPoint | Firmware contract implementation tracked in `docs/integrations.md`; physical transfer, discovery, and platform LAN permission qualification remain. |
| F49 | AO3 updates | Pending opt-in account connector, refresh semantics, deduplication, and one real followed-work update. |

## Platform and release

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F50 | Spotlight | iOS source indexes account-specific metadata domains, validates cold/warm deep links, and removes account/book entries; shared UI publishes catalog batches. Xcode compilation and installed-device deletion/lifecycle tests remain. |
| F51 | Continue widget | Embedded iOS WidgetKit target reads account-safe App Group snapshots and opens exact book/file routes. Host graph validated; Xcode signing/compile, widget device tests and Android widget remain. |
| F52 | Widget playback | iOS widget buttons invoke app-process audio intents; cold resume reads an account-checked Keychain source and authenticated cookie store. Swift compile and closed/locked-interface physical acceptance remain. |
| F53 | Quick actions | PWA shortcuts and iOS dynamic recent-book app-icon actions share account/file-checked navigation. iOS native source integrated; installed-device launch/account checks remain. |
| F54 | System controls | iOS 18 ControlWidget invokes native resume intent, gated by actual embedded extension and OS availability. Xcode/Control Center/Lock Screen/Action button device qualification remains. |
| F55 | Shortcuts | Shared AppEntity query and Resume/Pause/Continue App Intents/AppShortcuts source is wired to the native owner/navigation. Swift compilation, secure cold session restoration and actual Shortcuts runs remain. |
| F56 | iPad layouts | Responsive library and reader layouts, desktop navigation, mobile bottom navigation. Actual iPad split-screen/keyboard qualification pending. |
| F57 | VoiceOver | Semantic labels, dialogs, focus management and keyboard actions. VoiceOver/TalkBack hands-on acceptance pending. |
| F58 | Dark interface | App-wide light/dark/system preference, independent reader theme. Native system-bar integration pending. |
| F59 | Color independence | Text/shape labels accompany connection, progress and state. Complete screen audit remains. |
| F60 | Contrast | Readable visual tokens implemented. Measured AA audit for all text/components/themes pending. |
| F61 | Reduced motion | OS preference and app override implemented. Native and reader full coverage remains. |
| F62 | Localization | Explicit keyed catalogs for en, fi, fr, de, pl, zh-Hans and es cover primary navigation/library, connection, settings, details, collections/series, player, activity/notebook and reader controls/notices. Language changes persist and propagate across tabs; tests check seven-locale key/interpolation coverage, live changes and unchanged book content. Technical capability prose, long guides and native surfaces remain incomplete; fluent-speaker review and seven-language layout/accessibility acceptance remain. |
| F63 | Guides | Setup, reading, formats, notes, audio, recovery and limitations documented in app and repository. Native-specific guides follow qualified builds. |
| F64 | No ads | No advertising SDK or advertising surfaces. |
| F65 | No purchases | No purchase/feature-gating dependency. |
| F66 | No tracking | No analytics or external font requests. Explicit capability-only diagnostic export. Full native/network audit remains. |

## External release gates

- Android SDK debug build and Linux Rust linked development build pass; iOS app/widget target structure passes static checks. macOS/Xcode compilation/signing, Windows/macOS desktop builds, installable release packaging and physical mobile devices remain. See [platform build evidence](platforms.md).
- CarPlay requires entitlement approval and actual simulator/car testing; code alone cannot satisfy it.
- The provided BookOrbit instance is strictly read-only. Synchronization/upload/membership mutation acceptance must use a separate disposable writable fixture, never that server.
- CrossPoint requires a physical device and pinned firmware. AO3 requires an explicit account/session connector and controlled update fixture.
- Full Phase 1 includes the missing implementation above as well as those external checks. It must not be described as complete merely because the web build and unit suite pass.

F67–F71 remain deliberately deferred to Phase 2.
