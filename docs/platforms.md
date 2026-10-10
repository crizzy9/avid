# Avid platform implementation and release evidence

Recorded October 9, 2026. Native source, a successful build, and device qualification are different evidence. Android produces a debug APK and Linux produces a linked Tauri development binary in this environment. GitHub CI run [38006307634](https://github.com/crizzy9/avid/actions/runs/38006307634) compiled the unsigned iOS app/widget on macOS and linked Linux/macOS desktop binaries at checkpoint `9797ffb`. Later car and queue changes require their own CI result. No signed release, physical-device background run, desktop installer, or car entitlement approval is claimed.

## Current host and transport matrix

| Surface | Browser | iOS / Android | macOS / Windows / Linux |
| --- | --- | --- | --- |
| Shared React reader/library | Implemented | Generated Capacitor 8.5.3 hosts bundle the same frontend | Tauri 2 host bundles the same frontend |
| Audio owner | HTMLAudioElement controller | Registered AVQueuePlayer / Media3 playlist owner selected by the shared transport factory | HTML media backend while process runs |
| System transport | Conditional Media Session | Now Playing / MPRemoteCommandCenter and Media3 session/notification source | Embedded-engine Media Session; target-specific qualification remains |
| Sleep | Browser duration/chapter threshold | Native wall-clock deadline and source-position threshold | Browser controller; suspension qualification remains |
| Speech | Installed browser voices and real callback boundaries | Shared browser speech; native speech engines remain | Shared browser speech; native OS voice adapters remain |
| Continue widget / actions | In-app surface | iOS WidgetKit, App Intents, quick actions, controls, Spotlight sources integrated into targets; Android widget remains | Native tray/recent-book actions remain |
| Car surfaces | Unavailable | Opt-in CarPlay browse/Now Playing source and Android Auto MediaLibraryService catalog; device approval/validation remains | Not applicable |
| Complete offline library | Phase 2 | Phase 2 | Phase 2 |

The mobile factory in `apps/mobile/src/native-transport.ts` returns the structural `PlaybackTransport` API consumed by the shared application. It creates exactly one backend. A lazy facade avoids allocating audio, native listeners or timers in abandoned React StrictMode render initializers. The native adapter serializes commands, uses owner snapshots/events for state and checkpoints, checks server/account/book/file identity, and ignores stale callbacks. Native load failure clears the source and cannot accidentally play the previously loaded book. Account changes clear native state.

Native playback rejects WebView `blob:` URLs, which require a native file/export route. Ordered queues require unique source IDs and known positive durations for every nonfinal track. Native owners advance tracks and map book-wide seeks/sleep thresholds to exact track offsets; checkpoints include canonical file identity, track ID/time and optional manifest revision. They do not silently fall back to a second WebView audio owner. Playback status distinguishes actual playback, buffering and failures; native source timing is authoritative. UI polling smooths foreground progress; it does not provide background execution.

## Playback verification

`packages/playback` implements chapter/track timelines, 0.5–3× playback, skip, both sleep modes, Media Session, exact track-relative checkpoints, browser speech boundaries, alignment validation, and durable activity chunks. Its README describes the public API and scope of the browser tests.

Mobile adapter tests verify serialized load/play, source-relative checkpoints, stale and wrong-account callbacks, native sleep arguments, unsupported sources, multi-track boundaries/revision identity, failed-load behavior, teardown, and lazy allocation. These are bridge doubles, not device tests.

```sh
pnpm exec vitest run --root . packages/playback/test apps/mobile/src
pnpm --filter @avid/mobile typecheck
pnpm --filter @avid/mobile verify:ios
```

## Mobile builds

Both host projects are checked in at `apps/mobile/android` and `apps/mobile/ios`; do not regenerate over their integrated native target configuration. After frontend changes:

```sh
pnpm install
pnpm build
pnpm --filter @avid/mobile sync
pnpm --filter @avid/mobile build:android
pnpm --filter @avid/mobile open:ios
```

The generated hosts identify as **Avid**, `app.avid.reader`. Launcher icons derive from Avid's existing SVG. Local-machine build output, copied frontend assets, credentials, Android signing keys and Apple provisioning files are ignored. The checked-in Gradle wrapper is a build tool, not a signing secret.

### Android evidence

A real `:app:assembleDebug` completed with Capacitor 8.5.3, Gradle 8.14.3, Android Gradle Plugin 8.13.0, Kotlin 2.2.20, JDK 21, compile/target SDK 36 and minimum SDK 24. The APK is generated at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` and is not committed. This is a debug-key artifact, not a store-ready release.

The Linux host's temporary SDK was installed from Google's command-line tools archive `commandlinetools-linux-15859902_latest.zip`; SHA-256 was checked against Google's published value `4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583`. NixOS requires an ELF interpreter adjustment for Google's AAPT2. The build used a temporary patched copy via `-Pandroid.aapt2FromMavenOverride=/tmp/aapt2`; this machine-specific path is not in the repository. On an ordinary SDK-equipped Linux/macOS host the standard Gradle command applies.

`MainActivity` registers the native plugin. The app source set includes the shared Kotlin source under `native/android`; the manifest installs the non-exported MediaLibraryService and media foreground/wake permissions. ExoPlayer owns audio focus, noisy-route handling, media session, sleep and checkpoints independently of the activity. Its interface releases only the MediaController connection on WebView destruction.

Native HTTP media requests resolve the WebView CookieManager's cookies for the exact requested URL through a Media3 ResolvingDataSource. Cookies do not enter media metadata or SharedPreferences. The media bridge currently supports cookie-authenticated streaming; Bearer-only media endpoints need a supported native resource loader and are not claimed. Authentication renewal and actual protected-server behavior still need device validation. Chapter/artwork notification metadata, secure cold-start session restoration and durable native-to-repository outbox replay remain.

References: [Android background playback](https://developer.android.com/media/media3/session/background-playback), [Media3 ResolvingDataSource](https://developer.android.com/reference/androidx/media3/datasource/ResolvingDataSource), [Capacitor local Android plugins](https://capacitorjs.com/docs/android/custom-code).

### iOS host and system surfaces

The generated app target includes `AvidViewController`, the native playback and system-surface plugins, the AVPlayer singleton and Keychain source store. SceneDelegate installs the correct bridge controller and handles cold/warm `avid://resume` links, Spotlight activities and quick actions. The Info.plist enables background audio, the custom scheme and the local-network usage description. HTTPS remains the supported default; broad ATS/mixed-content exceptions are not enabled.

The Xcode project embeds the **AvidWidgets** extension, with iOS 17 minimum for interactive widgets. Shared store and App Intent source belongs to both targets; playback/Keychain source belongs only to the application. iOS 18 gates the Control Center/Lock Screen control. Both targets declare `group.app.avid.reader`; a real signing team must enable this App Group on both identifiers. `verify:ios` parses the PBX project and verifies target references, source files, widget embedding, deep links, background mode and entitlement declarations. It does not itself typecheck Swift or validate signing. The base app and widget passed a real unsigned simulator compile in CI at `9797ffb`; a shared `App` scheme is checked in. On macOS, an unsigned simulator check is `xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO build`.

Implemented source flows:

- **Spotlight:** explicit indexing of title/author metadata into account-specific domains, checked deep-link lookup, and deletion on removal/logout. Batches are limited to 500 entries. No book content, cover credentials or streaming URLs enter the search index.
- **Continue Reading widget:** active-account recent metadata and progress from App Group storage; tapping restores a validated book/file. Widgets can directly invoke audiobook pause/resume intents.
- **Quick actions:** up to four current-account recent books, using the same validated navigation route.
- **App Intents and Shortcuts:** entity queries expose the current account's recent books; resume/pause intents use the app-process native audio owner; Continue Reading opens the application and queues navigation. A control uses the same resume intent on iOS 18.
- **Cold native resume:** audiobook source descriptors live in app Keychain with `AfterFirstUnlockThisDeviceOnly` access. Shared widget storage contains metadata only. Expired explicitly dated sources refuse resume. Native playback reads cookies from WKHTTPCookieStore into the supported AVURLAssetHTTPCookiesKey option; cookies are not duplicated in shared defaults. Logged-out or different-account actions reject lookup.

`getNativeSystemSurfaces()` returns a bridge only when the actual Capacitor plugin is registered. `capabilities()` reports whether the signed App Group is available, Spotlight indexing exists, the widget extension is actually embedded and OS intent/control versions apply. These runtime checks are prerequisites, not a device certification.

The AVQueuePlayer owner publishes Now Playing, handles remote play/pause/skip/seek and interruptions/headphone removal, maintains native sleep and writes scoped checkpoints. Browser login is currently memory-owned; complete secure account restoration, native credential renewal and native journal replay are outstanding. Keychain media-source storage alone is not complete secure session restoration.

References: [Capacitor local iOS plugins](https://capacitorjs.com/docs/ios/custom-code), [AVURLAsset cookie option](https://developer.apple.com/documentation/avfoundation/avurlassethttpcookieskey), [interactive widgets and app-process AudioPlaybackIntent](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities), [system controls](https://developer.apple.com/documentation/widgetkit/creating-controls-to-perform-actions-across-the-system), [Core Spotlight](https://developer.apple.com/documentation/corespotlight).

## Native HTTP and car surfaces

`CapacitorHttp.enabled` patches native fetch/XHR through Capacitor's official platform implementation; ordinary browser builds retain browser CORS. TLS verification and Android mixed-content restrictions remain enabled. The pinned Capacitor 8.5.3 implementation uses WebView CookieManager through Java CookieHandler on Android; on iOS native URLSession cookie storage synchronizes with WKHTTPCookieStore. Audio resolves cookies at the source URL, with iOS merging the URL-scoped Foundation cookie jar to avoid pending WebView synchronization after login. No bearer token is written to media metadata. Capacitor clears session cookies when the Android WebView plugin starts/destroys; this is not durable account-login restoration. Real protected-server, redirect and expiry behavior still requires device tests. Large book transfers through the HTTP bridge retain its documented memory limits. See [Capacitor HTTP](https://capacitorjs.com/docs/apis/http) and [cookie API](https://capacitorjs.com/docs/apis/cookies).

The shared account/catalog hook also feeds the Android system-surfaces plugin. Android stores prepared audio queues and resume positions in a no-backup AtomicFile encrypted with an Android Keystore AES-GCM key; iOS stores source descriptors in app-only Keychain. Widget/search metadata never contains source URLs. Car lists expose only current-account audiobooks whose source has been prepared through Avid's player; they do not pretend that metadata alone can resolve a playable server URL. Logout/account changes clear the catalog and stop its owner. Full authenticated server browsing from a cold car launch remains a session-restoration requirement.

**Android Auto:** `AvidLibraryCallback` implements root/recent/library browsing, bounded pagination, item lookup, title/author search, unambiguous voice search, native queue selection, resumption and change notifications. It resolves media IDs inside the service; external controllers cannot inject arbitrary URLs. Controllers require the app UID, Android's trusted-controller status, or a package/UID/signature match for production Android Auto. Signing hashes are pinned from [Google UAMP](https://github.com/android/uamp/blob/9498d991ab84b708e2130b6217483d4cccd4bbfd/common/src/main/res/xml/allowed_media_browser_callers.xml), not accepted from caller strings. Ordinary builds keep the service private. `pnpm --filter @avid/mobile build:android:auto` enables the car manifest and runs JVM tests. Both default and opt-in queue APKs compiled locally; all seven JVM pagination/controller-policy/timeline tests passed. The merged default manifest keeps the service non-exported, while the opt-in car manifest enables the legacy browse endpoint; no head-unit launch is claimed. See the [Media3 library contract](https://developer.android.com/media/media3/session/serve-content) and [Android Auto manifest requirements](https://developer.android.com/training/cars/media/auto).

**CarPlay:** `AvidCarPlaySceneDelegate` displays current-account recent/prepared audio with `CPListTemplate`; selecting a book resumes the same native owner and opens `CPNowPlayingTemplate`. Account changes refresh the list and queued actions recheck scope after cookie lookup. Standard app configurations request no CarPlay entitlement. `configure:ios` adds separate `DebugCarPlay`/`ReleaseCarPlay` configurations and an `App-CarPlay` scheme; only those use the CarPlay scene manifest and audio entitlement declaration. Apple must approve the entitlement and provisioning must match before a physical car build can work. An unsigned compiler check is:

```sh
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App-CarPlay -configuration DebugCarPlay -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO build
```

See [CarPlay content templates](https://developer.apple.com/documentation/carplay/displaying-content-in-carplay) and [entitlement approval](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements). Source/configuration support is not entitlement approval, driving suitability certification or physical car testing.

## Desktop evidence

The Tauri 2 application includes shared frontend paths, Avid icon assets, a committed Cargo.lock, CSP and a restricted main-window capability. No filesystem, shell/process or remote-page IPC permission is granted. Book frames must remain isolated from native APIs.

Linux `cargo check --locked` and `cargo build --locked` completed using Rust/Cargo 1.98.1 and GTK3/WebKitGTK 4.1 development libraries. The host's Nix packages required explicit pkg-config paths and the WebKit/sysprof development outputs. These compile dependencies were provided without writing host-specific paths into project configuration. The linked ELF binary is at `apps/desktop/src-tauri/target/debug/avid` (ignored build output). It has not been launched or packaged as an installer here.

```sh
pnpm --filter @avid/desktop dev
pnpm --filter @avid/desktop build
```

Tauri runs the root frontend build. Installer bundling remains disabled pending real target builds, signing/notarization and packaging validation. The macOS/Linux CI linked binaries at `9797ffb`; Windows CI was still running when this evidence entry was updated. Native desktop media control, credential/SQLite storage, tray actions and OS speech adapters remain. See [Tauri requirements](https://v2.tauri.app/start/prerequisites/) and [Tauri configuration](https://v2.tauri.app/reference/config/).

## Phase 1 platform acceptance gates

| IDs | Implemented evidence | Remaining release evidence |
| --- | --- | --- |
| F24–F27 | Browser transport tests, active native queue adapter, native chapters/speed/sleep source, Android debug build | authenticated real-codec/range fixtures; physical seek/rate/sleep and suspension tests |
| F28 | Opt-in CarPlay templates and Android Auto catalog, controller authentication and pagination; Android car configuration compiled | CarPlay approval/signing, car-config iOS compilation, physical car/voice/distraction tests |
| F29–F30 | Native remote commands/MediaSession and notification foundations | Full artwork/chapter metadata, configurable remote skip policy, Bluetooth/wired controls on devices |
| F31–F36 | Shared reader alignment/speech integration and playback timing primitives | Device timing budget, native speech adapters, background reader/speech continuity qualification |
| F50 | iOS account-scoped Spotlight indexing/deletion/navigation source integrated | Permission/account deletion scenarios; macOS index implementation |
| F51–F52 | Embedded iOS widget source and app-process playback intents with shared metadata | Signing, widget launch and locked-interface physical tests; Android widget |
| F53 | iOS dynamic recent-book quick actions and cold/warm routing source | Installed-device account isolation and launch verification |
| F54–F55 | iOS 18 control plus shared App Intents/Shortcuts source | Action button/Control Center/Shortcuts locked/cold scenarios |

Required qualification includes a 60-minute locked-screen audio run on physical iOS and Android devices; interruption, route/network change, expiry and account switch; exact checkpoint recovery and journal replay while JS is suspended; widget and headset transport; matched/wrong-edition alignment; speech with/without true ranges; and signed builds on all six targets. Native checkpoints are local recovery evidence, not server-sync acknowledgements. No complete Phase 1 parity claim follows from host generation or debug compilation alone.
