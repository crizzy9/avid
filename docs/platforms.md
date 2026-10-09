# Avid platform implementation and release evidence

Recorded October 9, 2026. A web implementation, a shell configuration, and native source are different levels of evidence. This repository does **not** yet establish the six-platform Phase 1 release gate. No signed mobile build, desktop installer, physical-device background run, or car entitlement approval has been produced in this environment.

## Implemented playback surface

`packages/playback` provides the browser audio owner, immutable transport snapshots, track/chapter timelines, 0.5–3× pitch-preserving playback, configurable skip commands, duration and chapter-end sleep, Media Session metadata and controls, exact track-relative checkpoints, installed-voice browser speech, actual speech boundary callbacks, and validated text/audio alignment lookup. Public integration examples are in `packages/playback/README.md`.

Browser controller tests cover cross-track seeking and restoration, track completion, rate retention, both sleep modes, old asynchronous play rejection, external interruption, incomplete total duration, and edition/timing guards. These tests inject a media-element test double; they prove controller behavior, not the browser's decoding or the operating system's lifecycle. Test commands:

```sh
pnpm exec vitest run --root . packages/playback/test
pnpm exec tsc --noEmit -p packages/playback/tsconfig.json
```

## Platform matrix

| Surface | Browser | iOS / Android | macOS / Windows / Linux |
| --- | --- | --- | --- |
| Shared reading/library UI | Shared React app | Capacitor configuration points to the same build | Tauri configuration points to the same build |
| Audio | HTML media controller implemented | AVPlayer / Media3 native owner source included; target integration and shared-UI routing remain | HTML media path while the app runs; OS media-key qualification remains |
| Lock-screen/system controls | Conditional Media Session | Native remote-command / session source included, not device qualified | Media Session where the embedded engine supplies it; native media-control adapters remain |
| Sleep timer | Browser-owned timer and chapter threshold | Native-owned timer source included; locked-screen proof remains | Browser controller while process runs; suspension qualification remains |
| Speech | Browser installed voices and actual callback ranges | Native speech adapter remains | Native OS speech adapter remains |
| Car surfaces | Not available | CarPlay and Android Auto browsing/entitlements remain | Not applicable |
| Widget / quick action / system intent | In-app equivalents only | Native extensions and intents remain | Tray/recent-book surfaces remain |
| Spotlight | In-app search | Apple native indexing remains | macOS indexing remains |
| Complete offline library | Phase 2 | Phase 2 | Phase 2 |

`getPlatformCapabilities()` deliberately reports native guarantees as unavailable in the current web build. Installed browser APIs are detected at runtime. An API existing is not treated as a device certification.

## Mobile shell and native audio source

`apps/mobile/capacitor.config.ts` names the app **Avid**, uses `app.avid.reader`, and bundles the root `dist` output. Capacitor 8 dependencies are recorded in the mobile package. Generate platform targets on an SDK-equipped machine:

```sh
pnpm install
pnpm build
pnpm --filter @avid/mobile add:ios
pnpm --filter @avid/mobile add:android
pnpm --filter @avid/mobile sync
```

The generation commands are one-time steps per missing target. For iOS use Xcode and the required signing team; for Android use the supported JDK/Android SDK. Those toolchains were not available on the implementation host. Follow the version-specific [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup).

### iOS integration

1. Add `apps/mobile/native/ios/*.swift` to the generated App target. Set its bridge view controller class in the generated storyboard to `AvidViewController` so the local `AvidPlayback` plugin registers.
2. Merge `Info.plist.fragment` into the generated app's Info.plist. Enable the Audio background mode and configure the real signing team.
3. Use `getNativePlayback()` from `apps/mobile/src/native-playback.ts`. It returns `null` unless the native plugin is actually installed. Route shared UI commands and authoritative state to this native owner before describing the mobile UI as background capable.
4. Supply the verified streaming URL for the current account. Auth-header renewal and native credential storage are not implemented. Clear the owner on account change; never send its checkpoint under another account.
5. Run the device scenarios below before enabling the native capability flag.

The Swift owner uses a process singleton, AVPlayer, an AVAudioSession playback category, remote play/pause/skip/seek handlers, interruption and route-change handling, native sleep state, Now Playing metadata, and account-hashed local checkpoints. It currently accepts **one audio file**. Native track queues, chapter metadata/artwork, persisted checkpoint retrieval, source-item error reporting, credential renewal, and repository replay integration still require implementation. UserDefaults checkpoints are recovery records, not the planned transactional SQLite outbox. The plugin is source, not a signed or compiled release.

Registration follows [Capacitor local iOS plugins](https://capacitorjs.com/docs/ios/custom-code). The [Apple audio-session documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession) describes the playback/background category requirement.

### Android integration

1. Copy `apps/mobile/native/android/src/main/java/app/avid/playback` into the generated app's Kotlin source set. Enable Kotlin and merge `dependencies.gradle.kts.fragment` into its Gradle dependencies.
2. Merge the manifest fragment: the app needs the media-playback foreground service permissions and service declaration. The supplied service is not exported. Android Auto browsing is intentionally unavailable until the catalog and controller permission contract is implemented.
3. Register `AvidPlaybackPlugin` in `MainActivity` before `super.onCreate(savedInstanceState)` using `registerPlugin(AvidPlaybackPlugin::class.java)` in Kotlin or `registerPlugin(AvidPlaybackPlugin.class)` in Java.
4. Route UI commands through the installed plugin and validate state/credential/journal handling as on iOS. The current plugin rejects commands until its service controller connects.
5. Run the device scenarios below and configure a release signing key before enabling the native capability flag.

The Media3 `MediaLibraryService` owns ExoPlayer, audio focus, noisy-route handling, native sleep checks, a MediaSession, and account-hashed recovery records independent of the activity. Media3 supplies the notification/transport foundation. The plugin's controller connects to the service and releases only the interface connection at destruction. It currently accepts one audio file. Library-browse callbacks, notification artwork, native track queues, credential renewal, persisted checkpoint retrieval, and transactional repository replay remain. SharedPreferences checkpoints are not a server-sync acknowledgement.

Service ownership and foreground permissions follow [Android background playback](https://developer.android.com/media/media3/session/background-playback). Local registration follows [Capacitor Android plugins](https://capacitorjs.com/docs/android/custom-code). The source pins [Media3 1.8.0](https://developer.android.com/jetpack/androidx/releases/media3#1.8.0); it needs a native compilation run before qualification.

## Desktop shell

`apps/desktop/src-tauri` contains a Tauri 2 Rust application, a restricted default capability, shared-client dev/build paths, and a content security policy. It does not grant filesystem, process execution, shell, or remote-page IPC privileges. Remote book content must continue to be isolated by the reader engine. Native API access must never be enabled for a book frame.

```sh
pnpm --filter @avid/desktop dev
pnpm --filter @avid/desktop build
```

Tauri invokes the root frontend build. Rust, OS WebView development libraries, and platform SDKs are required. This host has no Rust toolchain, so no desktop compile result is claimed. Installer bundling is disabled until icons, signing/notarization, installer metadata, and actual target builds are configured. The configuration alone does not meet the installable desktop gate. See [Tauri configuration](https://v2.tauri.app/reference/config/).

The desktop app currently uses the shared HTML audio backend. Dedicated macOS/Windows/Linux media controls, OS credentials, SQLite, tray actions, and installed-system speech adapters remain.

## Phase 1 feature evidence

| Requirement | Present evidence | Still required for the research acceptance gate |
| --- | --- | --- |
| F24 Audiobooks | Browser transport + codec preflight; native owner source | Real supported-format/range/auth fixtures; mobile integration and UI-suspension validation |
| F25 Chapters | Ordered timeline and exact track-relative restore tested in browser controller | Real server chapter fixture, native track queues, native chapter metadata |
| F26 Speed | Browser rate changes tested; native source clamps and applies rate | Persist account preference; physical native pitch/timing verification |
| F27 Sleep | Browser duration and chapter-end stops tested; native timer source | Locked-screen/native deadline tests; process lifecycle and interruptions |
| F28 CarPlay | Capability unavailable | Audio entitlement, native browse/transport templates, simulator and real-car run |
| F29 Lock Screen | Browser Media Session; native metadata/session source | Cover/chapter metadata completeness; suspended-interface physical-device control |
| F30 Remote skipping | Browser handlers; iOS/Android native skip source | Configurable native policy and Bluetooth/wired/car validation |
| F31 Read and Listen | Validated real-locator alignment model and duration sanity helper | Verified server overlay/bridge discovery and resource access; usable-file fixture |
| F32 Mode handoff | Exact text locator ↔ source timestamp lookup | Reader integration and bidirectional handoff on matched and mismatched editions |
| F33 Sentence highlight | Half-open interval lookup, gap handling, overlap/identity rejection tests | Native-timestamp reader rendering/auto-follow within timing budget on devices |
| F34 Speak | Installed browser voices; speech controller | Native iOS/Android/desktop speech adapters and selection start on tested engines |
| F35 Word highlight | True engine boundary offsets; no fabricated timing | Reader range mapping across every supported engine; capability evidence where missing |
| F36 Speech page turns | Speech `onEnd`/boundary integration hooks | Reader chaining and cross-chapter continuation without duplication on supported engines |
| F50 Spotlight | Capability unavailable | Account-safe native indexing, deep links, permission removal and logout cleanup |
| F51 Continue widget | Capability unavailable | WidgetKit/Android widgets and persisted shared snapshots |
| F52 Widget playback | Capability unavailable | Direct native-owner actions while the main interface is closed |
| F53 Quick actions | Capability unavailable | Recent-book/app-action routing with server/account identity |
| F54 System controls | Capability unavailable | iOS Control Center/Lock Screen controls and Action button intents |
| F55 Shortcuts | Capability unavailable | App Intents and closed-interface playback/resume tests |

This table describes playback/platform package evidence. A shared UI can consume these interfaces without satisfying every end-to-end acceptance row.

## Required qualification run

- Use real MP3/M4B and any other claimed codec fixture. Play, seek backward, cross tracks, restore exact file-relative positions, change rate, and expire each sleep mode.
- Run a 60-minute locked-screen session on physical iOS and Android devices. Interrupt with a call, unplug headphones, change network, expire credentials, and restart the interface without replacing the native owner.
- Confirm checkpoints are durable while the WebView is suspended; integrate source timestamps into the account-scoped transactional journal. Test logout and account switching during playback.
- Verify Now Playing artwork/chapter/position and headset, keyboard, wired, Bluetooth, car, and widget actions on their actual supported surfaces.
- Use aligned, unaligned, and wrong-edition fixtures. Record timing at different rates and ensure gaps never jump to a guessed percentage.
- Exercise speech with an engine that reports ranges and one that does not. Verify text range offsets, page/chapter continuation, cancellation, and reader focus.
- Compile and sign actual iOS/Android targets and build the three desktop platforms. Record SDK/OS versions, device models, codecs, test dates, observed outcomes, and known exceptions in the release record.

CarPlay entitlement approval, physical devices/car access, actual server credentials/contracts, Apple signing identity, Android signing credentials, and platform SDK runners are external inputs. No claim of complete Phase 1 parity should be made until all applicable feature rows and the release gates have evidence.
