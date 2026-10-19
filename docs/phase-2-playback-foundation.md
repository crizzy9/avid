# Phase 2 B — playback foundation

Implementation checkpoint: **2026-10-19**. This is the foundation for the [audiobook plan](phase-2-audiobook-plan.md), not a claim that all playback features or installed devices are qualified. Full-book matching is measured separately by Milestone A.

## Ownership and source time

The application still chooses exactly one playback transport. On the web and desktop, `PlaybackController` owns an HTML media element. On iOS, `AvidPlaybackOwner` owns AVQueuePlayer/AVAudioSession independently of the WebView. Android uses the Media3 ExoPlayer inside `AvidPlaybackService`. The JavaScript native adapter observes and commands these owners; its one-second UI polling is not responsible for playback or track transitions.

`playbackClock(snapshot)` is the explicit version 1 clock contract:

- `sourceSeconds` is the original complete-book timeline. Chapters, seek targets, notes, alignment and checkpoints use it without dividing by speed.
- `estimatedRemainingWallSeconds` is a labeled estimate: remaining source duration divided by rate. Unknown duration yields `null`.
- `processedOutputSeconds` is `null`, and `processing` is `none`. Current engines do not supply a measured DSP output clock. Neither speed adjustment nor seek history is reported as silence savings or actual listening activity.

Declared track durations continue to define canonical offsets. Decoder observations do not silently move subsequent chapters. The existing generated-alignment rounding guard and decoded-tail exclusion remain intact. This work does not change the matcher or relax its thresholds.

`playbackEngineCapabilities(engine)` separates implementation facts from qualification. Every current adapter applies 0.5–3×; settings may preserve a higher desired rate for future engines. Browser and desktop report no independent background owner. Native owners report independence, while `physicalDeviceQualified` remains false and gapless playback remains unqualified. No DSP capability is advertised.

## Settings and controls

The versioned preferences layer resolves account/library/series/book/session inheritance and projects desired settings onto current engine limits. The player exposes account and book editing, with per-field Apply/reset and visible inheritance. Series overrides are resolved when an ID is available; library inheritance is schema-supported but not applied without a verified library ID. An adopted native session keeps its unsaved speed as a visible temporary session choice; an explicit saved rate or reset replaces it. Storage events and queued legacy migration are account-checked. Its persistence is ordinary listening configuration, not the Phase 3 offline media/catalog project. See `packages/playback/src/preferences.ts` and the settings tests for validation, migration and export/import rules.

Remote policy now supports independent backward and forward intervals of **1–300 source seconds**. The settings default is 15 seconds backward and 30 seconds forward. Existing `{mode, seconds}` records remain symmetric, so an existing deliberate choice is preserved. `backwardSeconds`/`forwardSeconds` extend that contract without removing `seconds` from old consumers.

The same normalized policy reaches browser Media Session handlers, desktop next/previous actions, iOS preferred skip intervals and Android Media3 remote seek increments. Chapter mode keeps the existing three-second previous-chapter restart rule and source-time fallback at the final chapter. This is the control foundation; advanced chapter barriers, smart rewind, fine scrub and seek locks remain Milestone C.

## Commands, events and the later queue

The transport exposes `getPlaybackSession()`, `dispatch(command)`, `onPlaybackEvent(listener)` and `getPlaybackHistory()`.

A version 1 session token contains a fresh load/adoption ID, stable account scope, book/file identity and exact manifest revision. Dispatch refuses a token from another account, edition, transport or earlier load—even when the same book is loaded again. Native dispatch also reads the authoritative owner and sends the expected source to the bridge. Swift checks that source on its main actor before changing AVQueuePlayer; Android checks current MediaController metadata before forwarding the command. JavaScript command queues retain generation checks before and after asynchronous resolution/refresh. These checks do not claim an atomic transaction across an arbitrary external controller racing a Media3 service command.

Commands distinguish user seeking, read/listen handoff, recovery, remote commands, rate changes, sleep, interruptions and track transitions. A backward seek remains a backward seek; no furthest-position policy or smart rewind changes it. Existing simple methods remain available and accept optional play/pause/seek/rate reason tags. `dispatch` reports whether a command was accepted; playback state remains authoritative for actual success or buffering/failure.

Each transport keeps at most **256 current-session events**. Native owners retain a **64-event process-owned tail**, including source identity, an owner ID, monotonically increasing sequence, original source positions, time, rate and observed status. The adapter validates account/edition and finite values, then imports unseen events on return from background or native adoption. Duplicate polls do not duplicate that native tail. Explicit command observations and native owner observations have distinct `origin` values; they are not deduplicated into a listening-time ledger. Unknown native command intent is labeled `native-observation`, never guessed to be a particular UI action.

The tail contains no media URLs, credentials, book text or display metadata. It is bounded and process-scoped; iOS excludes it from the existing durable recovery snapshot. Existing progress/recovery journals remain unchanged. It is not a complete seek-history product, does not survive arbitrary process death, and makes no server-sync promise. The future history/undo UI and persistent cross-book queue belong to Milestone D. Version 1 queue-entry/state types already require account and edition identity and exclude reusable media URLs; no queue autoplay is enabled by this checkpoint.

## Desktop engine architecture spike

**Decision for this checkpoint:** keep the existing desktop WebView transport as an explicit capability-limited backend. Do not claim it provides native-engine independence. A native desktop playback backend remains an open implementation gate before desktop audiobook parity; this source audit does not select an untested decoder dependency.

The inspected paths are `apps/mobile/src/native-transport.ts`, `apps/desktop/src/bridge.ts`, and `apps/desktop/src-tauri/src/{main,surfaces}.rs`. The Tauri host uses `souvlaki` for media controls/metadata. Its media callback emits `avid:desktop-action` to the main WebView; it does not decode or own recorded audio. While a media session is playing, closing the window hides that same WebView. Retaining the window is not evidence that playback survives WebView recreation, suspension, a crash or host process death. Desktop speech is a different subsystem and does not establish a recorded-audiobook engine.

This was an **executed source architecture audit**, not a desktop latency, memory, decoder or background-duration measurement. The available host is Linux/NixOS; no packaged Tauri playback session or Apple SDK was exercised here. The capability contract records the actual limitation rather than marking the spike as runtime qualification.

The next backend experiment must run the same signed/local source fixtures through a process-owned decoder and measure all of these before selection:

1. Multi-hour MP3 VBR, AAC/M4B, FLAC/Opus/WAV playback, track/source seek accuracy and encoded gapless behavior.
2. Header/credential isolation, token renewal, range recovery and source-edition replacement without losing the intended position.
3. Pause/seek/rate/remote behavior with the main UI hidden and then destroyed/recreated; one owner must remain authoritative.
4. CPU/RSS, interruption/route loss, source timestamp drift at all supported rates, and a future DSP output/source mapping.
5. Linux/macOS/Windows packaging and availability. An engine result on one host is not a qualification of every desktop platform.

## Server integration gaps and phase boundary

Client preferences, source clocks, intervals and session histories do not require a new BookOrbit endpoint. No server calls or writes are added by this foundation. The following remain separate integration gates:

| Requirement | Current boundary |
| --- | --- |
| Cross-device settings or listening queue sync | No verified settings/queue contract; local settings do not claim cloud synchronization. |
| Exact audiobook edition identity | Preserve the supplied manifest revision and file/track identities; reject stale identity rather than fabricate one. Native callback revisions must match exactly, including absent revision. |
| Bookmark/note/activity product expansion | Use the already verified adapter routes/capabilities only; remaining history/statistics/queue features need Milestone D fixtures and capability states. |
| Stream conversion/quality or DSP | No invented transcoding endpoint. Existing direct media access remains the provider boundary. DSP is Milestone F. |
| Credentials/recovery | Existing account-scoped native refresh and recovery continue. This checkpoint does not prove every expiry, process-death or route scenario on devices. |
| Broader offline editing, catalog and downloads | Phase 3: durable offline progress, notes/highlights, reconciliation, managed downloads and search. Prepared Read & Listen retains its existing explicit exception. |

## Evidence and open acceptance gates

Focused shared checks passed **173 tests in 16 files**, covering the playback package, settings tests present at this checkpoint, native TypeScript adapter and lazy transport. TypeScript passed. Coverage includes account/edition/load-token rejection, deliberate backward commands, no fabricated processed clock, bounded history, native-tail validation/deduplication, independent skip directions and legacy policy behavior. The final combined project suite passed **1,108 tests in 138 files**; TypeScript and the production web build passed. The build retains its existing large-chunk warning.

Android `compileDebugKotlin` passed against the real application sources. Focused JVM tests passed **5 tests**: `RemotePlaybackPolicyTest` (3) and `PlaybackEventTailTest` (2). The latter uses Robolectric and verifies bounded source history, credential exclusion, independent returned snapshots and edition resets. Toolchain: cached Gradle 8.14.3, JDK 21.0.12, Android SDK 36; the NixOS run used a compatible AAPT2 override. These are compile/JVM checks, not physical audio playback or Bluetooth/headset tests.

Swift source was updated but not compiled on this Linux host; macOS/Xcode CI and physical iOS verification remain open. Native original-MP3/M4B seek/tail behavior, codecs, background interruptions, credential renewal, long listening sessions and device memory/battery are still acceptance gates. Milestone B's source and settings foundation is implemented, while installed-device codec/recovery evidence and the desktop native backend remain explicitly incomplete.
