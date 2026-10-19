# Phase 2 — Avid as a complete audiobook application

Planning baseline: **2026-10-18**, Avid source `654db63`. This is the implementation plan requested before starting the next feature batch. Its unchecked requirements are planned work, not shipped behavior. The [roadmap](roadmap.md) retains the six-phase order; the [Phase 1 checklist](phase-1-status.md) retains its open acceptance gates.

## Product decision

Audiobooks are a primary Avid workflow. A listener must be able to discover a book, manage their listening queue, customize playback, listen with the screen locked, recover a position, and use bookmarks without ever opening the ebook reader. Read & Listen adds synchronized text to that complete listening experience.

Use the dated [Plappa, Absorb and Audiobookshelf inventory](audiobook-reference-inventory-2026-10-18.md) as the functional baseline. Match the useful listening workflows and depth of control; implement Avid's own interface and code. A reference feature being advertised does not establish that Avid has implemented or qualified it. Later reference releases enter this ledger explicitly rather than silently changing the completion target.

Keep React/TypeScript for shared screens and domain behavior. On mobile, the native playback owner must continue independently of React/WebView scheduling. Native audiobook behavior does not require rewriting every screen in SwiftUI or Kotlin. Desktop needs an explicit engine decision and lifecycle qualification; its current HTML audio plus native media controls cannot be described as an independent native audio engine.

BookOrbit limitations do not shrink this product specification. Client controls, queue behavior, matching and preferences proceed independently. Track unavailable server capabilities as integration gaps, develop against explicit adapter fixtures, and enable production actions only against verified contracts. Do not invent endpoints, present an unavailable operation as saved, or alter the supplied read-only server. This plan does not authorize a server rewrite or imply new Audiobookshelf/Jellyfin connectors are already implemented.

## Scope and phase boundary

| Included in Phase 2 | Kept for Phase 3 |
| --- | --- |
| Listening preferences, per-book overrides, persistent queue, seek history/undo, normal online playback recovery and existing account-scoped journals | A complete offline catalog/search experience and generalized offline progress reconciliation |
| Online audio bookmarks/notes and listening statistics, with truthful backend capability states | Full creation/editing of notes, highlights, collections and activity while offline, then conflict-safe synchronization |
| Complete-source Read & Listen preparation, resumable **processing** checkpoints, retained prepared media and cold reopening of that package | General resumable/batch media downloads, auto-download/delete, cellular download policy, cache quotas and eviction |
| Native background streaming, remote controls, car browsing, casting and wearable remote/streaming work | Phone-free wearable **downloaded** libraries and their transfer/storage management |
| Long-form installed/server speech playback, transcript tools, supported audio processing | Retained server-generated voice libraries and offline speech download management |

Settings and queue persistence are ordinary audiobook functionality; storing them locally does not turn this phase into the broader offline project. Conversely, prepared playback does not establish offline editing support. Its current viewer remains session-only until the Phase 3 progress design is delivered. Existing online recovery journals remain intact.

Podcast listening, episode queueing and episode-specific playback preferences belong in the shared audio design where a source supports them. Feed ingestion, automatic episode downloads and retention are tracked separately; download automation belongs to Phase 3. Server library administration, metadata scraping and transcoding infrastructure are not client playback requirements.

Phase 4 remains Pencil/reader enhancements, Phase 5 remains visual refinement, and Phase 6 remains comparison-reference cleanup/docs/launch. Necessary player navigation, accessible controls and audiobook library structure are Phase 2 work, not deferred cosmetic polish.

## What exists at the baseline

The implementation already has chapter-relative seeking, chapter durations, previous/next chapter, book time remaining, pitch-preserving speed, basic sleep timers, source-time audio notes, read/listen handoff, generated English matching, and mobile playback owners. It has seven-locale UI infrastructure and account/edition isolation.

The current control set is limited: fixed 0.5–3× choices, symmetric skip intervals, time/chapter remote modes, and fixed-minute/current-chapter sleep. There is no full audiobook settings hierarchy, cross-book listening queue, smart rewind, audio processing, casting or wearable product. The native “queue” contains tracks inside one book. The Home reading queue is a collection, not a playback queue. Car catalogs require previously registered sources.

Matching evidence is twelve short human excerpts and one short browser fixture. The recorded 1,027 tests, TypeScript check and build at `654db63` do not prove full-book matching, physical background playback or native feature parity. The [full-book validation plan](phase-2-full-book-validation.md) defines the next evidence.

## Feature ledger

Status **partial** means relevant source behavior exists but the listed requirement is incomplete or unqualified; **new** means substantial new behavior is needed. Each ID needs implementation, tests, capability reporting and applicable installed-device evidence before it closes.

| ID | Required experience | Baseline | Delivery |
| --- | --- | --- | --- |
| P2-01 | Dedicated Listen entry point; selectable listening-first start screen; Continue listening, Up next, recent and series shelves | Partial | D |
| P2-02 | Audiobook search/filter/sort by author, narrator, series order, duration, remaining time, progress and listening status; paged large libraries | Partial | D |
| P2-03 | Full/mini player, chapter/book timelines, precise chapter durations, book/chapter remaining and finish estimate at current speed | Partial | C |
| P2-04 | Independent skip directions, chapter navigation, jump to time, precise scrub, accessible seek and undo | Partial | C |
| P2-05 | Fine speed control, editable presets, pitch preservation and per-book/series preference overrides | Partial | C |
| P2-06 | Configurable smart rewind; distinguish pause, sleep, interruption, manual seek and deliberate backward movement | New | C |
| P2-07 | Sleep minutes, custom presets, chapter counts, end of book, schedule, fade, extension/reset and sleep-event recovery | Partial | C |
| P2-08 | Persistent cross-book/episode queue: play next/later, reorder, remove, clear, explicit next-book and next-in-series policy | New | D |
| P2-09 | Position/seek history with timestamp and reason; return/undo; completion, restart and reread controls without discarding history | Partial | D |
| P2-10 | Quick bookmark without required text, bookmark list/edit/delete/search/jump, timestamp notes and portable export | Partial | D |
| P2-11 | Listening sessions, per-book totals, day/week/year statistics, goals/streak display and separate audio/source/wall-time measures | Partial | D |
| P2-12 | Favorites, playlists/collections, series navigation and selectable metadata/remaining-time fields on listening cards | Partial | D |
| P2-13 | Accurate track order, embedded/fallback chapters, VBR seeks, original source clock and gapless transitions where the encoding permits | Partial | B |
| P2-14 | Calls, alarms, audio focus, headphone disconnect, route changes, credential renewal, transient stalls, app UI recreation and explicit process recovery | Partial | B/H |
| P2-15 | Global/account/library defaults, series/book overrides, reset/inherit, settings search and credential-free settings export/import | New | B/C |
| P2-16 | Silence skipping with adjustable behavior; retain source-time anchors and report saved listening time honestly | New | F |
| P2-17 | Voice boost, loudness normalization, volume boost/limiter, EQ presets/custom EQ and mono/channel controls where engines support them | New | F |
| P2-18 | Audio output picker, Bluetooth/AirPlay and Chromecast handoff/reconnect; receiver capability reporting | New/partial OS routing | G |
| P2-19 | Lock Screen/notification/Control Center controls, chapter or book progress, useful metadata, widgets, Live Activity where supported and shortcuts | Partial | G |
| P2-20 | CarPlay/Android Auto cold catalog browse/search/start, queue and chapter navigation; large-control in-app car mode | Partial | G |
| P2-21 | Apple Watch/Wear OS remote controls and eligible phone-free streaming; downloaded wearable playback handed to Phase 3 | New | G |
| P2-22 | Desktop media keys/tray, mini player, keyboard shortcuts and qualified long playback independent of window visibility | Partial | G |
| P2-23 | Independent ebook/audiobook pairing, clear edition/source choice, full-book matching and per-chapter coverage/uncertainty | Partial | A/E |
| P2-24 | Spotify-style transcript following, reader highlighting, transcript search/tap-to-seek and real sentence/word timing where supported | Partial paragraph following | E |
| P2-25 | Manual/latest-confirmed/separate read/listen positions; preview without moving the saved position; backward moves respected; undo and return-to-narration | Partial | C/E |
| P2-26 | Restartable preparation jobs: stages, pause/cancel/retry, source validation, resource policy, incremental checkpoints and atomic publication | Partial foreground job | E |
| P2-27 | Complete prepared-package playback from cold offline launch, no repeat ASR, corruption/edition/account guards and explicit gaps | Partial warm fixture | E/H |
| P2-28 | Transcript browse/search/export and chapter correction/import/export; versioned user corrections, inspect/reset without changing source identity | New/partial transcript panel | E |
| P2-29 | Long-form installed/server/self-hosted speech, explicit provider choice and real boundary highlighting; native scheduling and interruptions | Partial | G |
| P2-30 | Capability-aware BookOrbit integration, client-owned behavior despite server gaps, no fabricated synchronization or hidden writes | Partial | B/H |
| P2-31 | VoiceOver/TalkBack, large text, keyboard/switch input, reduced motion, localization and accessible time/slider announcements | Partial | Every milestone/H |
| P2-32 | Operational controls: keep screen awake while listening, screen lock/orientation, haptics and reduced-animation player behavior | Partial/new | C/G |
| P2-33 | Podcast episode playback/queue/order/completion and per-show intro/outro skip when supported, without importing Phase 3 download automation | New/adapter-dependent | D/G |
| P2-34 | Optional Storyteller/alignment provider, local/self-hosted voice and e-ink companion contracts retained from the earlier audio backlog | Partial integrations/new audio routes | G |
| P2-35 | Bookmark timestamp nudges, isolated preview, transcribe a selected window into a note, quote sharing and explicit trim/export of an audio clip | New | D/E |
| P2-36 | Foreground rolling transcripts while streaming without full download or ebook; optional streamed Read & Listen; find text from heard audio/find audio from selected text; bounded lookahead, waiting/slow-device state and ebook correction provenance | New | E |
| P2-37 | Configurable player shortcuts/order/visibility and native Now Playing lines; separate playback-seek lock from display preferences | New | C/G |
| P2-38 | Chapter tools: derive from tracks, shift selected/unlocked timestamps, preview/nudge, find spoken chapter starts and optional verified lookup provider | New | E |
| P2-39 | Explicit local/remote connection profiles, supported custom headers, streaming policy and redacted diagnostic export | Partial/new | B/G |
| P2-40 | Open standalone local audio without a server/ebook; review multi-file grouping/order and embedded metadata/chapters, then listen through the same player | Partial imported-byte transport | B/D |

Features marked platform-dependent remain in the ledger. An unavailable web API does not excuse a missing native implementation. A physical device or entitlement gate remains open with its owner/dependency documented; it does not become “done” because code compiles. Standalone watch downloads are the explicit Phase 3 exception, not a forgotten feature.

## Listening settings specification

Every setting has a type/range, default, scope, native bridge behavior, reset path and capability state. Supported options must work in full player, mini player and remote surfaces consistently. Do not expose a toggle that silently does nothing.

Proposed defaults below are Avid decisions, not claims about another app's defaults. Validate them during implementation. Use **temporary session override → book → series/show → library → account default** for applicable audio settings, and device/route preferences for hardware-specific behavior. Show where the effective value came from; removing an override restores inheritance. Do not infer a narrator-specific override when a book has multiple narrators; an explicit narrator preset may be added through the same model.

| Group | Options to support | Proposed initial behavior |
| --- | --- | --- |
| Speed | 0.5–5× target range, 0.05× steps, editable quick presets, pitch-preservation; report smaller engine/route limits | 1×; pitch preserved; per-book override available |
| Time display | Chapter/book scrubber; elapsed/remaining; raw duration/listening time; finish clock; percentage; configurable metadata fields | Chapter timeline with book remaining always visible; speed-adjusted listening estimate labeled |
| Seeking | Separate back/forward 1–300s; separate long-skip controls; chapter restart threshold/barrier with explicit repeated-press crossing; jump to chapter/time; fine scrub; independent in-app and system seek locks; optional confirmation; return/undo | Back 15s / forward 30s; preview scrub, commit on release; accessible direct control |
| Remote commands | Time skip vs chapter; independent intervals; previous-chapter restart behavior; headset/car mappings where OS exposes them | Time skip with the same 15/30 defaults; OS limitations explained |
| Smart rewind | Off/fixed/adaptive; editable pause-duration tiers and maximum; separate sleep/interruption rules; preserve explicit seek target | Off initially; user enables adaptive profile; never rewind a deliberate seek or read/listen handoff |
| Resume | Manual/allowed automatic resume after interruption; headset/Bluetooth reconnection; launch behavior; resume same book vs show queue | Resume only after explicit user/OS-permitted intent; route reconnection and app launch never surprise-autoplay |
| Sleep timer | Custom minutes/presets; current/next N or selected chapter start/end; episode/book end; scheduled time window; remembered duration; reset on pause/resume; fade duration; shake add/reset/sensitivity; tap/headphone extension; warning chime/volume and haptic feedback where supported | Off until selected; countdown uses wall time, chapter target uses source time; extension/chime optional |
| Sleep recovery | Record start/stop anchor; return to timer start; optional rewind on next play; explicit extension feedback | Preserve actual stop position; offer return rather than silently losing the night's progress |
| Queue | Continue manual queue/series/selected playlist or collection; stop after book; skip/remove finished items; duplicate handling; resume next vs start over; podcast direction and new-episode insertion | Stop after current book until autoplay is enabled; explicit queue order takes precedence over series |
| Completion | End-of-source detection, configurable near-end threshold, manual finished/unread, repeat chapter/book, A–B repeat for replay/study | Finish at actual end; repeat off; manual status never erases exact position/history without explicit reset |
| Bookmarks/history | Quick vs text bookmark, date/position sorting, timestamp nudges, isolated preview, optional pause/seek/sleep event markers, history retention, note/quote/clip export | Quick bookmark needs no typing; preview restores the actual session; event history separate from user notes; retention visible/configurable |
| DSP | Silence threshold/minimum pause/retained pause, voice boost strength, normalization, volume boost with limiter, EQ, mono/channel balance | Processing off; no hidden change to source timestamps; route/engine capability controls availability |
| Read & Listen | Follow text, auto-scroll/recenter, transcript font/line count/expanded view/color, paragraph/sentence/word mode, tap-to-seek confirmation, handoff destination/policy, quality/model/language, per-book pairing/repair, display latency offset per output route | Explicit pairing and preparation; manual handoff default; show only supported timing detail; browsing is a preview; display offset never alters source anchors |
| Preparation | Foreground/eligible background, power/thermal limits, model choice, pause/retry, job cleanup, diagnostic export | Local processing; no silent cloud upload; cancel preserves earlier complete preparation |
| Speech | Installed/online/self-hosted provider, voice, rate, real highlight availability, pronunciation overrides where supported | No implicit server voice selection or substitution; recorded-audiobook and TTS settings are distinct |
| Output/device | Route picker, focus/mixing/ducking policy where permitted, pause on disconnect, playback notification fields/buttons, player shortcut order/count/cover-tap action, car browse sort/autoplay preference, wake/orientation/haptics | Pause on route loss; do not resume to speaker unexpectedly; car autoplay off; OS policy takes precedence |
| Network | Wi-Fi-only streaming toggle, cellular warning, quality/direct/transcoded preference where a source supports it, retry behavior | Preserve explicit user choice; no invented conversion endpoint; download policy is Phase 3 |
| Settings portability | Search, reset section/all, export/import validated non-secret settings, per-device vs account labels | Export excludes tokens, passwords, private transcript and listening history; cross-device settings sync only on a verified contract |

A–B repeat, Live Activities and some processing options are explicit Avid product requirements beyond what this reference audit established; they are not attributed to all three reference apps. Optional spatial/surround processing stays in the engine-capability assessment rather than being promised on every output. Connection profiles/custom headers must retain authentication and account boundaries; a local-network profile does not authorize sending credentials to an arbitrary discovered host.

Chapter count, repeat range, completion, sleep and autoplay need an explicit precedence: **user stop/error or interruption → sleep boundary → active repeat range → track transition → book completion → optional next queued item/series**. Sleeping at a chapter/book boundary must never accidentally start the next book. Account switching invalidates pending autoplay and outstanding commands.

A chapter sleep target is a fixed source location captured when set. Seeking backward keeps that target unless the user explicitly resets it; seeking beyond it completes the timer and pauses at the chosen seek destination without snapping backward. Do not silently rebase onto the new chapter. Reject a newly selected target already behind the playhead. If a repeat range cannot reach the target, explain that conflict and offer a wall-time timer or removal of repeat; do not silently disable either. A near-end completion threshold changes library status only: it never truncates playback, removes a queued book or starts another book. Actual end or an explicit Next action is required to advance.

Local audio opening is a Phase 2 listening entry point, including grouping/reordering selected files and missing-chapter fallback. Persisting a generalized imported/offline catalog, its managed media and cross-device changes remains Phase 3. Streamed live transcription is also separate from a complete prepared package: it cannot be presented as ready for later offline playback until every required source and alignment is verified and retained.

## Implementation architecture and invariants

1. **Shared listening model.** Extend `packages/playback` with versioned settings, queue entries, command reasons, history events and capability descriptors. Keep book identity, exact file/manifest revision and source position on every command/event. Migrate the current unscoped remote-policy preference without leaking one account's overrides to another.
2. **Single playback owner.** iOS AVQueuePlayer/AVAudioSession and Android Media3 retain native playback ownership; React observes and commands them. Move timer/rewind/queue/DSP behavior that must run while locked into that owner. Android service ownership follows [Media3's background model](https://developer.android.com/media/media3/session/background-playback). iOS must honor [audio interruptions](https://developer.apple.com/documentation/AVFAudio/handling-audio-interruptions). Desktop engine selection is a measured spike before claiming equivalent independence.
3. **Source clock is authoritative.** Chapters, progress, annotations and alignment use original audio seconds. Playback speed changes wall time; silence skipping changes audible elapsed time. Store/report those separately. Gapless metadata, MP3 priming, native seek tolerances and rounded server durations require codec-specific evidence, not a blanket tolerance increase.
4. **Preferences and content are separate.** Device preferences/queue/recovery are not an offline library. User annotation storage and offline reconciliation retain their existing boundaries. Preparation scratch data is disposable/versioned processing state; a ready package is published atomically after source revalidation.
5. **Adapters expose capabilities.** Distinguish a missing server feature, missing engine feature, missing platform permission and untested behavior. Use provider contracts for media/catalog/online progress/bookmarks/stats. Build and test client features with fixtures when a server lacks the corresponding API, then label the integration gap honestly.
6. **No invented matching.** No proportional audio-to-ebook progress conversion, guessed word boundaries, chapter-title matching as proof, or forced nearest-passage jumps across uncertainty. Manual corrections are explicit, revisioned and reversible. Background scheduling and cloud processing must be stated separately; an iOS processing job cannot be assumed to run indefinitely overnight.
7. **One activity record per audible interval.** Do not count buffering, paused previews or skipped silence as listening. Native ownership, reconnects, source changes and duplicate events must not double-count activity. Distinguish elapsed listening, covered source duration and speed/silence time saved.

## Delivery order and acceptance

Work in reviewable commits and push each validated milestone to the existing repository. **A and B are now underway:** the frozen full-book corpus and runner are implemented, with complete-input baselines in progress; the [playback/settings foundation](phase-2-playback-foundation.md) is implemented with shared and Android compile/JVM checks. See [current run evidence](phase-2-full-book-runs.md). Neither milestone is fully accepted: complete-book reports, native source-clock/codec checks and the desktop runtime engine experiment remain open. C/D can proceed alongside E after the shared contracts exist. F/G must use those contracts rather than growing separate player logic.

| Milestone | Work | Evidence required to close |
| --- | --- | --- |
| **A — Lock the baseline and run full books** | Freeze reference/feature IDs; select full-book corpus before tuning; run current matching end to end; record failures, resource usage and gaps | Reproducible full-input reports with exact source/model/code hashes, failures retained, no excerpt result relabeled a full-book pass |
| **B — Playback and settings foundation** | Versioned preferences/capabilities, source/processed clock contract, native queue/history events, edition-safe command reasons; desktop engine spike | Migration/isolation tests; one state owner across UI/lock screen; native source-time/codec checks; explicit server integration-gap list |
| **C — Complete everyday controls** | Speed/presets, independent skips, smart rewind, rich sleep, display settings, precise seek/undo, resume policies | The same choices work from full/mini/native controls; sleep/rewind/seek precedence tests; accessible controls; no false progress from browsing |
| **D — Audiobook daily workflow** | Listen home, persistent book queue, next-in-series, history, bookmarks/notes, stats and collections; episode model where supported | Multi-book scenario survives UI/process restart; no account leakage; duplicate completion cannot skip a queued book; notes land on exact source time |
| **E — Full-book Read & Listen** | Fix A's measured failures; bounded/restartable jobs, transcript/search, edition diagnosis, matching review/corrections and prepared reopening | [Full-book gates](phase-2-full-book-validation.md), held-out material, actual rendered highlights, backward handoff, cold prepared-only playback and installed-device report |
| **F — Advanced audio processing** | Silence skip, normalization/boost, EQ/channel controls; qualify engine and route support | Long playback without drift, clipped speech or incorrect chapters/notes; resource/battery measurements; truthful remaining-time estimate and capability UI |
| **G — Native and extended audio surfaces** | Car cold catalogs, output/casting, widgets/Live Activities/shortcuts, desktop controls, wearable streaming/remote, long-form TTS and optional providers | Installed OS/receiver/car/watch cases with screen locked and UI closed; source/account validation and interruptions; track hardware/entitlement gates explicitly |
| **H — Phase 2 acceptance** | Cross-platform matrix, long sessions, accessibility/locales, real codec corpus, recovery regression, user guide | Every applicable ledger row has implementation and acceptance evidence; backend-only blockers recorded separately; no open client-side defect hidden by a parity claim |

No calendar promise is attached before A/B establish full-book processing cost and native engine work. The milestones are sequential checkpoints, with the stated parallel tracks, not a claim that all of this fits one small patch.

## Platform and release gates

| Surface | Minimum Phase 2 expectation | Evidence still needed |
| --- | --- | --- |
| iOS/iPadOS | Native audio owner, background/locked playback, all supported settings, system controls, AirPlay, CarPlay and prepared read/listen | Signed physical install; long session/call/Bluetooth/sleep/process recovery; CarPlay entitlement/device; memory/thermal measurements |
| Android | Media3 service, equivalent settings, notification/Bluetooth/Auto and supported casting | Physical device service/OS lifecycle, battery restrictions, notification permission, head unit, codecs and seek accuracy |
| macOS/Windows/Linux | Full listening workflow, system media controls, qualified background/window behavior and supported DSP | Engine decision and per-OS installed sessions; no browser-only proof substituted for desktop acceptance |
| Web/PWA | Shared controls and supported codec/matching workflow, honest background limitations, cold prepared-package reopening | Production build under service-worker control; browser storage/codec matrix; no blanket native-background promise |
| Watch/cast/car | The explicit supported remote/streaming routes from P2-18–22 | Each real receiver/OS/hardware contract; watch media download storage remains Phase 3 |

For ordinary audiobook playback require at least a continuous two-hour locked/background session on each mobile family, a long-book boundary/seek run, interruptions and token/network recovery, and no unexpected autoplay after force quit. OS termination may stop audio; restore an accurate position rather than promise playback survives every kill. Test at representative slow/normal/high speeds, each enabled DSP mode and output route. Capture app/OS/build, media hashes, actual duration, command log and measured results.

Phase 2 is complete only when its supported client experience passes these gates. Server-specific gaps may remain explicitly recorded as requested, but they must not be presented as working synchronization or used to excuse missing client-only features. The future claim of a **complete offline audiobook app** additionally requires Phase 3.
