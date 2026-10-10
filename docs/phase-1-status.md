# Phase 1 implementation and release evidence

Updated: 2026-10-09. This is the release checklist for the 66 Phase 1 rows in [the research baseline](research-baseline.md). **Phase 1 is not complete.** A working browser implementation and compiled Android, iOS app/widget/CarPlay, macOS, Windows and Linux development hosts are available; a six-platform parity claim would be premature.

`Browser implemented` means the source path works in the web runtime and has the stated evidence. It does not imply that all supported formats, mobile WebViews, assistive technologies, or recovery cases passed. `Partial` identifies missing behavior or evidence. `Pending` means an applicable release requirement is not implemented or qualified. No external entitlement or device result is inferred from the presence of code.

## Connection and library

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F01 | BookOrbit | Browser implemented. Real password login, catalog, covers, file reading, and pagination tested with a supplied server in read-only mode. API reference is pinned to v3.3.0. |
| F02 | Password login | Browser session and native Keychain/Keystore vault implemented. Native restore verifies the authenticated account before activation; serialized generation checks prevent stale token writes from undoing logout. Cookie refresh and native-token contracts have offline coverage. Foreground restoration is integrated; suspended native cookie renewal, secure-store device failures and expiry/device qualification remain. |
| F03 | Provider login | Configured web provider discovery, PKCE sign-in and callback restoration implemented; 29 offline transaction/routing tests pass; canceled password/provider attempts cannot activate after a later connection or closed dialog. Avid must own the exact server-allowlisted callback origin. Live provider deployment and native secure callback recovery remain. |
| F04 | Home / Library / Browse | Browser implemented with 48-item requests, cancellable server search, shelves, sorting, and virtualized grid/list. Synthetic 10,000-book tests keep fewer than 70 cards mounted, preserve keyboard focus, and prove zero eager cover fetches; viewport/focus-driven covers use four requests, 96 blobs and 32 MiB maximum. Metadata remains in memory. Hardware memory/FPS and native-device acceptance remain; see [performance evidence](library-performance.md). |
| F05 | Series | Server series discovery and separate paginated series-book lists preserve numeric series identity and contextual ordering. Contract tests pass. Large live series and edition identity qualification remain. |
| F06 | Collections | Collection reads, local sample collections, owned collection membership UI and guarded create/add/remove contracts. Read-only connections disable server mutations. Live writable fixture round-trip remains. |
| F07 | Manga filing | Device implementation: account-scoped, case-insensitive keyword rules across selected genre/title/series fields; conservative default matches the manga genre. Automatic/Manga RTL/Comic LTR overrides persist per title without leaking to other books/accounts. Five rule/render tests pass. Server preference round-trip remains. |

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
| F24 | Audiobooks | Browser transport and native AVQueuePlayer/Media3 queue bridge implemented with track-relative revisioned checkpoints. Android queue host compiles a debug APK; iOS app/widget, queue and CarPlay configurations compiled unsigned in CI at c4f269b. protected-stream/codec corpus and physical background qualification remain. |
| F25 | Chapters | Verified BookOrbit manifest normalization; track-relative source anchors. Chapter transition tests pass; real multi-track codec corpus required. |
| F26 | Speed | Browser pitch-preserving rate control and source-clock tests; native bridge delegates rate to AVPlayer/Media3 and reports owner state. Actual pitch/rate device qualification remains. |
| F27 | Sleep | Duration/chapter-end timers in browser and native owners; bridge tests verify native wall/source deadlines. Android compiles. Locked-screen/native interruption tests remain. |
| F28 | CarPlay | Opt-in CarPlay browse/Now Playing templates and Android Auto MediaLibraryService catalog implemented for native-prepared audio; Android car configuration compiles. CarPlay configuration compiled unsigned in CI; entitlement approval/signing and physical car/voice validation remain. |
| F29 | Lock Screen | Browser Media Session; active native owner metadata/remote-command route; Android session service compiles. Full chapter/artwork metadata and suspended-app physical acceptance remain. |
| F30 | Remote skipping | Browser transport handlers and native owner source. Bluetooth/headset/car testing remains. |
| F31 | Read and Listen | Existing EPUB SMIL fixture played real WAV narration in the embedded browser; source clock advanced to 0:01 and pause/speed controls worked. Exact standalone bridge helpers now verify open-EPUB SMIL/text plus matching full audio bytes, file identity and manifest revision; unsupported timing and different editions remain unlinked. The actual linking controls passed in the original EPUB/WAV browser fixture. Real-production corpus and native qualification remain; see read-listen-alignment.md. |
| F32 | Mode handoff | Embedded-overlay read/listen controls resumed actual audio and skipped between two distinct audio resources while paused, preserving highlighted passages. Standalone helper tests cover DOM fragment → exact track/source seconds and paused source time → EPUB fragment, including gaps and edition rejection; the original EPUB/WAV fixture passes both directions. The browser fixture verified explicit pairing, p1→standalone track1, paused track2 at4.367s→chapter.xhtml#p2 with a fresh EPUB hash, and p2→track2 at4.167s. Decoder duration rounding is kept separate from canonical offsets; material duration mismatches reject. Actual production editions and physical-device handoff remain. |
| F33 | Sentence highlighting | SMIL source-time unit tests and embedded-browser visible passage highlights passed; follow-text toggle and 0.75× speed verified. Proposed 250 ms timing at device/speed combinations and broader aligned corpus remain. |
| F34 | Speak | Installed browser voice selection and exact selection-start source mapping implemented; tests cover starting inside a paragraph and preserving inline words. Unavailable/failed speech produces a notice while the book remains open. Actual installed-voice and device validation remains. |
| F35 | Word highlighting | Actual boundary callbacks map UTF-16 offsets to exact ranges, including words spanning inline markup; deterministic tests pass. No synthetic precise timing is claimed when voices omit boundaries. Real-voice timing corpus remains. |
| F36 | Speech page turns | Reader follows boundaries, skips non-linear sections, and guards canceled utterance callbacks. Linear-section/end-of-book tests pass. Cross-section real voice and interruption corpus remains. |

## Progress, notes, and delivery

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F37 | Saved position | Transactional account-scoped IndexedDB checkpoints plus native SQLite WAL journals for exact EPUB/PDF/comic/audio positions. Native receipts and local outbox changes commit atomically before acknowledgement; tests cover retry deduplication, original event time, changed-account cancellation and persistent read-only provenance. Native storage-kill/restart and device qualification remain. |
| F38 | Progress sync | Outbox, original event time, stale-write conflicts and guarded audio revisions tested with mock contracts. Two real devices/writable fixture qualification remains; supplied server was never mutated. |
| F39 | KOReader sync | Core implemented: preserves native locators, uses server-provided CFI/page translations, validates exact account/file identity and canonical native timestamps, and supports bounded partial-MD5 snapshot checks. Twenty-five offline tests pass; changed editions and absent conversions remain explicit. Actual writable-server/physical KOReader round trip remains. |
| F40 | Reading log | Visible-reader accounting and playback activity accumulators with pause/buffer/seek tests. Native owners journal monotonic actual-playing intervals in immutable chunks up to15seconds, then replay by stable session IDs; JS listening accumulation is disabled for native owners. Server deduplication and scoped replay contracts pass. Suspended/terminated-device timing qualification remains. |
| F41 | Reading Stats | Activity UI reads server overview, summary and year calendar without blending local totals; it shows reading/listening filters, server timezone, year selection and current-week bars independent of the selected calendar year. Visible reading is journaled every 15 seconds and on hide/close with immutable session IDs; lifecycle, recovery and duplicate-retry tests pass. Local sample activity remains separate. Writable server totals comparison, platform-source filtering and timezone-boundary qualification remain. |
| F42 | Highlights | CFI/text/page-anchored selection and local persistence. Device selection and exact reflow corpus remain. |
| F43 | Notes | Create/edit/delete/jump for text and timestamp notes. Cross-device writable round trip remains. |
| F44 | Annotation search | Local notebook quote/text/book filtering and jump-to-source. Large synchronized corpus remains. |
| F45 | Annotation sync | Server IDs, tombstones, queued-edit remapping and uncertain-create reconciliation tests. Live multi-device acceptance remains. |
| F46 | Audio notes | Verified UUID-deduplicated BookOrbit bookmark APIs; whole-source-time anchors. No companion required by this contract. Device-to-device acceptance remains. |
| F47 | File upload | Native/web file selection and guarded server upload path. Local files open without upload; test-server uploads disabled. Writable upload/identifier fixture remains. |
| F48 | CrossPoint | Firmware contract implementation tracked in `docs/integrations.md`; physical transfer, discovery, and platform LAN permission qualification remain. |
| F49 | AO3 updates | Opt-in panel and fixed-origin loopback companion implement separate in-memory CSRF sessions, authenticated work subscriptions, bounded manual checks and observed EPUB downloads. Controlled fixtures cover chapter identity/content revisions, account isolation, rate limits, deduplication and canceled imports; editions retain old files/anchors. A real authorized followed-work chapter update and deployed/native connector qualification remain; see [connector contract](integrations.md#archive-of-our-own-f49). |

## Platform and release

| ID | Requirement | Current implementation / remaining gate |
| --- | --- | --- |
| F50 | Spotlight | iOS source indexes account-specific metadata domains, validates cold/warm deep links, and removes account/book entries; shared UI publishes catalog batches. Base iOS app compiled unsigned in CI; installed-device deletion/lifecycle tests remain. |
| F51 | Continue widget | Embedded iOS WidgetKit target reads account-safe App Group snapshots and opens exact book/file routes. Base app/widget compiled unsigned in CI; signing, widget device tests and Android widget remain. |
| F52 | Widget playback | iOS widget buttons invoke app-process audio intents; cold resume reads an account-checked Keychain source and authenticated cookie store. Unsigned Swift compilation passed in CI at `34f182f`; closed/locked-interface physical acceptance remains. |
| F53 | Quick actions | PWA shortcuts and iOS dynamic recent-book app-icon actions share account/file-checked navigation. iOS native source integrated; installed-device launch/account checks remain. |
| F54 | System controls | iOS 18 ControlWidget invokes native resume intent, gated by actual embedded extension and OS availability. Base widget compiled unsigned in CI; Control Center/Lock Screen/Action button device qualification remains. |
| F55 | Shortcuts | Shared AppEntity query and Resume/Pause/Continue App Intents/AppShortcuts source is wired to the native owner/navigation. Unsigned Swift compilation passed in CI at `34f182f`; secure cold session restoration and actual Shortcuts runs remain. |
| F56 | iPad layouts | Responsive library and reader layouts, desktop navigation, mobile bottom navigation. Actual iPad split-screen/keyboard qualification pending. |
| F57 | VoiceOver | Semantic labels, dialogs, focus management and keyboard actions. VoiceOver/TalkBack hands-on acceptance pending. |
| F58 | Dark interface | App-wide light/dark/system preference, independent reader theme. Native system-bar integration pending. |
| F59 | Color independence | Text/shape labels accompany connection, progress and state. Complete screen audit remains. |
| F60 | Contrast | Visible Home and Settings text measured above AA thresholds in light and dark themes after navigation, hero text and progress-badge corrections. Audit composites computed solid backgrounds; gradients/artwork and all remaining screens/components still require complete AA review. |
| F61 | Reduced motion | OS preference and app override implemented. Native and reader full coverage remains. |
| F62 | Localization | Explicit keyed catalogs for en, fi, fr, de, pl, zh-Hans and es cover primary navigation/library, connection, settings, details, collections/series, player, activity/notebook and reader controls/notices. Language changes persist and propagate across tabs; tests check seven-locale key/interpolation coverage, live changes and unchanged book content. Capability labels and details now use all seven catalogs; long guides and native surfaces remain incomplete; fluent-speaker review and seven-language layout/accessibility acceptance remain. |
| F63 | Guides | Setup, reading, formats, notes, audio, recovery and limitations documented in app and repository. Native-specific guides follow qualified builds. |
| F64 | No ads | No advertising SDK or advertising surfaces. |
| F65 | No purchases | No purchase/feature-gating dependency. |
| F66 | No tracking | No analytics or external font requests. Explicit capability-only diagnostic export. Full native/network audit remains. |

## External release gates

- Android SDK debug build and Linux Rust linked development build pass. CI at `34f182f` compiled the vault, playback adoption and SQLite journals in unsigned iOS app/widget/CarPlay and Android/Auto hosts, plus linked macOS/Linux/Windows desktop binaries. Signing, installable release packaging and physical mobile-device qualification remain. See [platform build evidence](platforms.md).
- CarPlay requires entitlement approval and actual simulator/car testing; code alone cannot satisfy it.
- The provided BookOrbit instance is strictly read-only. Synchronization/upload/membership mutation acceptance must use a separate disposable writable fixture, never that server.
- CrossPoint requires a physical device and pinned firmware. AO3's connector and controlled update fixture now exist; a real authorized account-based chapter update and deployed companion qualification remain.
- Full Phase 1 includes the missing implementation above as well as those external checks. It must not be described as complete merely because the web build and unit suite pass.

F67–F71 remain deliberately deferred to Phase 2.
