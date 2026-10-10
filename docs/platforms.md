# Avid platform implementation and release evidence

Recorded October 9, 2026. Native source, a successful build, and device qualification are different evidence. Android produces a debug APK and Linux produces a linked Tauri development binary in this environment. GitHub CI run [38009233133](https://github.com/crizzy9/avid/actions/runs/38009233133) passed all five jobs at checkpoint `2920e79`: unsigned iOS app/widget and opt-in CarPlay configuration, Android default/Auto builds, and linked Linux/macOS/Windows desktop binaries. That checkpoint includes secure vault, native adoption and journal recovery. The later `b257b14` checkpoint passed Android and all three desktop jobs; its iOS appearance-plugin type error is fixed in source, awaiting another CI run together with the native authentication changes. No signed release, physical-device background run, desktop installer, or car entitlement approval is claimed.

## Current host and transport matrix

| Surface | Browser | iOS / Android | macOS / Windows / Linux |
| --- | --- | --- | --- |
| Shared React reader/library | Implemented | Generated Capacitor 8.5.3 hosts bundle the same frontend | Tauri 2 host bundles the same frontend |
| Audio owner | HTMLAudioElement controller | Registered AVQueuePlayer / Media3 playlist owner selected by the shared transport factory | HTML media backend while process runs |
| System transport | Conditional Media Session | Now Playing / MPRemoteCommandCenter and Media3 session/notification source | Embedded-engine Media Session; target-specific qualification remains |
| Sleep | Browser duration/chapter threshold | Native wall-clock deadline and source-position threshold | Browser controller; suspension qualification remains |
| Speech | Installed browser voices and real callback boundaries | Shared browser speech; native speech engines remain | Shared browser speech; native OS voice adapters remain |
| Continue widget / actions | In-app surface | iOS WidgetKit, App Intents, quick actions, controls and Spotlight; Android Continue Reading widget with account-checked navigation | Native tray/recent-book actions remain |
| Car surfaces | Unavailable | Opt-in CarPlay browse/Now Playing source and Android Auto MediaLibraryService catalog; device approval/validation remains | Not applicable |
| Complete offline library | Phase 2 | Phase 2 | Phase 2 |

The mobile factory in `apps/mobile/src/native-transport.ts` returns the structural `PlaybackTransport` API consumed by the shared application. It creates exactly one backend. A lazy facade avoids allocating audio, native listeners or timers in abandoned React StrictMode render initializers. The native adapter serializes commands, uses owner snapshots/events for state and checkpoints, checks server/account/book/file identity, and ignores stale callbacks. Native load failure clears the source and cannot accidentally play the previously loaded book. Account changes clear native state. `readOwnerSnapshot()` exposes live source identity without URLs; `adoptNative(book)` rereads and verifies account, canonical file, edition and ordered track IDs before attaching to the existing owner without load, seek or play. Its newest native position, rate and sleep policy remain authoritative.

Native playback rejects WebView `blob:` URLs, which require a native file/export route. Ordered queues require unique source IDs and known positive durations for every nonfinal track. Native owners advance tracks and map book-wide seeks/sleep thresholds to exact track offsets; checkpoints include canonical file identity, track ID/time and optional manifest revision. They do not silently fall back to a second WebView audio owner. Playback status distinguishes actual playback, buffering and failures; native source timing is authoritative. UI polling smooths foreground progress; it does not provide background execution.

## Playback verification

`packages/playback` implements chapter/track timelines, 0.5–3× playback, skip, both sleep modes, Media Session, exact track-relative checkpoints, browser speech boundaries, alignment validation, and durable activity chunks. Its README describes the public API and scope of the browser tests.

Mobile adapter tests verify serialized load/play, source-relative checkpoints, stale and wrong-account callbacks, native sleep arguments, unsupported sources, multi-track boundaries/revision identity, failed-load behavior, teardown, lazy allocation, and storage warnings that do not falsely mark playing audio as failed. These are bridge doubles, not device tests.

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

Native HTTP media requests resolve the WebView CookieManager's cookies for the exact requested URL through a Media3 ResolvingDataSource. Cookies do not enter media metadata or SharedPreferences. The Media3 resolver renews the matching vault session before protected server API requests and supplies credentials only to that server. Its isolated OkHttp transport refuses redirects; external redirected media is unsupported instead of forwarding credentials. Actual protected-server, refresh and recovery behavior still needs device validation. Chapter/artwork notification metadata, physical cold-start session restoration and native-to-repository outbox replay qualification remain.

References: [Android background playback](https://developer.android.com/media/media3/session/background-playback), [Media3 ResolvingDataSource](https://developer.android.com/reference/androidx/media3/datasource/ResolvingDataSource), [Capacitor local Android plugins](https://capacitorjs.com/docs/android/custom-code).

### iOS host and system surfaces

The generated app target includes `AvidViewController`, the native playback and system-surface plugins, the AVPlayer singleton and Keychain source store. SceneDelegate installs the correct bridge controller and handles cold/warm `avid://resume` links, Spotlight activities and quick actions. The Info.plist enables background audio, the custom scheme and the local-network usage description. HTTPS remains the supported default; broad ATS/mixed-content exceptions are not enabled.

The Xcode project embeds the **AvidWidgets** extension, with iOS 17 minimum for interactive widgets. Shared store and App Intent source belongs to both targets; playback/Keychain source belongs only to the application. iOS 18 gates the Control Center/Lock Screen control. Both targets declare `group.app.avid.reader`; a real signing team must enable this App Group on both identifiers. `verify:ios` parses the PBX project and verifies target references, source files, widget embedding, deep links, background mode and entitlement declarations. It does not itself typecheck Swift or validate signing. The app/widget and opt-in CarPlay scheme passed real unsigned simulator compiles in CI at `2920e79`; a shared `App` scheme is checked in. On macOS, an unsigned simulator check is `xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO build`.

Implemented source flows:

- **Spotlight:** explicit indexing of title/author metadata into account-specific domains, checked deep-link lookup, and deletion on removal/logout. Batches are limited to 500 entries. No book content, cover credentials or streaming URLs enter the search index.
- **Continue Reading widget:** active-account recent metadata and progress from App Group storage; tapping restores a validated book/file. Widgets can directly invoke audiobook pause/resume intents.
- **Quick actions:** up to four current-account recent books, using the same validated navigation route.
- **App Intents and Shortcuts:** entity queries expose the current account's recent books; resume/pause intents use the app-process native audio owner; Continue Reading opens the application and queues navigation. A control uses the same resume intent on iOS 18.
- **Cold native resume:** audiobook source descriptors live in app Keychain with `AfterFirstUnlockThisDeviceOnly` access. Shared widget storage contains metadata only. Expired explicitly dated sources refuse resume. Native playback reads cookies from WKHTTPCookieStore into the supported AVURLAssetHTTPCookiesKey option; cookies are not duplicated in shared defaults. Logged-out or different-account actions reject lookup.

`getNativeSystemSurfaces()` returns a bridge only when the actual Capacitor plugin is registered. `capabilities()` reports whether the signed App Group is available, Spotlight indexing exists, the widget extension is actually embedded and OS intent/control versions apply. These runtime checks are prerequisites, not a device certification.

The playback bridge separately reports installed background-audio and system-control support. Android waits for a real media controller connection and checks the installed service, foreground permissions/type, and optional exported car metadata. iOS checks the installed audio background mode; CarPlay is reported available only while an actual system-created CarPlay scene exists. The report does not infer entitlement approval from a build flag or invoke private entitlement APIs.

The AVQueuePlayer owner publishes Now Playing, handles remote play/pause/skip/seek and interruptions/headphone removal, maintains native sleep and writes scoped checkpoints. A dedicated session vault now stores the core Session in iOS Keychain (`AfterFirstUnlockThisDeviceOnly`) or Android Keystore AES-GCM storage under the no-backup directory. Reads/writes/clears use durable generation identifiers; stale compare-and-set writes fail after logout/account changes. There is no web storage fallback. Root bootstrap validates the saved user through `/auth/me` before activating the library and persists any rotated session only after validation. The native authentication coordinator now owns credential renewal independently of JavaScript; its new source needs the next compiler checkpoint, and physical kill/expiry validation remains required.

References: [Capacitor local iOS plugins](https://capacitorjs.com/docs/ios/custom-code), [AVURLAsset cookie option](https://developer.apple.com/documentation/avfoundation/avurlassethttpcookieskey), [interactive widgets and app-process AudioPlaybackIntent](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities), [system controls](https://developer.apple.com/documentation/widgetkit/creating-controls-to-perform-actions-across-the-system), [Core Spotlight](https://developer.apple.com/documentation/corespotlight).

## Native durability and replay

The mobile hosts register a native SQLite playback journal (`AvidJournal`). Owner sampling uses native monotonic time and source-position advance at the current rate; it excludes pauses, buffering, seek discontinuities and stalled sampling gaps. Listening activity is split into immutable chunks of at most 15 seconds, flushed at transport boundaries. Exact audio checkpoints append at the existing five-second cadence and on pause/seek/stop. SQLite uses WAL and full synchronous commits; the database is excluded from device backup and contains positions/activity metadata, never media URLs or credentials.

A failed insertion sets a sticky recovery warning in owner snapshots while leaving actual playback status intact. Failed activity chunks and checkpoint fingerprints remain retryable; only a successful durable insertion clears the warning. No-op sampling does not hide a storage failure. Sudden process termination can lose the currently unflushed listening fraction, normally less than 15 seconds; physical disk-full and locked-storage qualification remains.

`drain({accountScope,limit})` returns up to 200 ordered immutable events. JS commits the matching repository transaction/outbox before `ack({accountScope,ids})` deletes those native events. IDs and original event timestamps survive retries. Scope checks prohibit acknowledging another account's event. Activity event IDs equal their session IDs. Root replay receipts deduplicate committed deliveries. Each event retains read-only provenance captured from its source and restricted by current vault policy, so reconnecting with write access cannot change past local-only events into uploads.

For EPUB/PDF/comic position changes, `recordProgress({accountScope,anchor,readOnly})` validates the active vault account and appends an exact anchor; native read-only mode and the caller's read-only flag are combined conservatively. The JS reader then commits its local transaction and acknowledges the native receipt. Browser builds have no native-storage fallback claim. Foreground JS listening accumulation is disabled when the native journal owns those intervals, preventing duplicate activity totals.

The session vault and native journal/adoption sources compiled in native CI at `2920e79`; physical suspend/kill/expiry/disk-error qualification remains required. Native SQLite persistence and IndexedDB/outbox replay are different from a server acknowledgment; journal acknowledgment only follows the local transaction.

## Native sign-in and credential renewal

`AvidOidc` uses ASWebAuthenticationSession on iOS and Android Custom Tabs. A single short-lived PKCE/nonce transaction and callback inbox live in Keychain or Keystore storage, bound to the current vault generation. The exact `avid://oauth2-callback` route, state, redirect, challenge and expiration are checked before returning a one-use transaction. System browser launch resolves immediately; a secret-free event prompts the coordinator to read the durable inbox. Logout/new attempts invalidate prior generations. Provider routing is explicitly configured and requires the BookOrbit/provider callback allowlist; a browser fallback or an arbitrary provider URL is not treated as native sign-in support. See [ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession) and [Android Custom Tabs](https://developer.android.com/develop/ui/views/layout/webapps/overview-of-android-custom-tabs).

The `AvidAuth` bridge shares one refresh coordinator between foreground requests and native audio owners. Password login and OIDC token exchanges use isolated HTTP sessions with no shared cookie jar and no redirects. Successful responses can apply staged cookies only while their captured vault generation is still current. Logout waits for any accepted cookie commit, clears credentials/cookies and stops the old owner before resolving; a late HTTP result cannot restore the previous account. Network waits do not hold the commit barrier. This also prevents a superseded sign-in response from changing the live WebView account behind the UI's generation checks.

Refresh requests are deduplicated per account/generation. Every returned access token is verified through `/auth/me` against the saved active user before the coordinator commits the vault and then the matching platform cookies. Fresh-session readers wait for cookie commit completion. The notification to JavaScript contains only account scope and generation; token values stay in the secure session record. The foreground session cursor adopts the latest native generation so its next persistence operation does not overwrite a background rotation. Native sources retain the established BookOrbit web-cookie protocol; the iOS player does not advertise a bearer-only media resource loader.

The native owners schedule renewal near token expiry while playing. Android's resolving data source also preflights every protected range/track open; a single HTTP-401 recovery prepares the existing ExoPlayer playlist at its current state. iOS uses AVPlayer error-log HTTP status for bounded 401 recovery and rebuilds queued AVURLAssets after a committed credential rotation. Both preserve the user's latest position, pause state, speed and sleep policy while a refresh is in flight. A failed renewal surfaces a reconnect warning and never activates a different account. These new authentication/renewal sources require the next native CI result and real server/device expiry, process-kill, offline and supersession qualification.

Android's Continue Reading widget uses an encrypted metadata-only recent store and opaque, account-checked navigation IDs for books of all supported reader kinds. Logout removes its entries and updates the launcher. `AvidAppearance` applies the current light/dark/system setting to iOS interface/status style and Android system bars, including transparent edge-to-edge bars on recent Android versions. Source/compile evidence does not establish physical launcher or system-bar rendering quality.

## Native HTTP and car surfaces

`CapacitorHttp.enabled` patches native fetch/XHR through Capacitor's official platform implementation; ordinary browser builds retain browser CORS. TLS verification and Android mixed-content restrictions remain enabled. The pinned Capacitor 8.5.3 implementation uses WebView CookieManager through Java CookieHandler on Android; on iOS native URLSession cookie storage synchronizes with WKHTTPCookieStore. Audio resolves cookies at the source URL, with iOS merging the URL-scoped Foundation cookie jar to avoid pending WebView synchronization after login. No bearer token is written to media metadata. Capacitor clears session cookies when the Android WebView plugin starts/destroys; this is not durable account-login restoration. The app retains the server web-cookie protocol: access and refresh cookies are persistent platform cookies, and the saved session may have no refresh token. A lost/expired refresh cookie requires sign-in again. Native-token mode remains optional core support; iOS Bearer-only media transport is not advertised. Real protected-server, redirect and expiry behavior still requires device tests. The server access cookie normally expires after 15 minutes. The shared native authentication coordinator below renews credentials and rebuilds queued iOS assets after a committed rotation; physical background expiry recovery is not yet qualified. Large book transfers through the HTTP bridge retain its documented memory limits. See [Capacitor HTTP](https://capacitorjs.com/docs/apis/http) and [cookie API](https://capacitorjs.com/docs/apis/cookies).

The shared account/catalog hook also feeds the Android system-surfaces plugin. Android stores prepared audio queues and resume positions in a no-backup AtomicFile encrypted with an Android Keystore AES-GCM key; iOS stores source descriptors in app-only Keychain. Widget/search metadata never contains source URLs. Car lists expose only current-account audiobooks whose source has been prepared through Avid's player; they do not pretend that metadata alone can resolve a playable server URL. Logout/account changes clear the catalog and stop its owner. Foreground bootstrap restores and validates the saved session. Cold car playback uses the same native authentication coordinator to renew expired media access before preparing protected audio; missing cookies or rejected identity stop playback with a reconnect message.

**Android Auto:** `AvidLibraryCallback` implements root/recent/library browsing, bounded pagination, item lookup, title/author search, unambiguous voice search, native queue selection, resumption and change notifications. It resolves media IDs inside the service; external controllers cannot inject arbitrary URLs. Controllers require the app UID, Android's trusted-controller status, or a package/UID/signature match for production Android Auto. Signing hashes are pinned from [Google UAMP](https://github.com/android/uamp/blob/9498d991ab84b708e2130b6217483d4cccd4bbfd/common/src/main/res/xml/allowed_media_browser_callers.xml), not accepted from caller strings. Ordinary builds keep the service private. `pnpm --filter @avid/mobile build:android:auto` enables the car manifest and runs JVM tests. Both default and opt-in queue APKs compiled locally; JVM pagination, controller-policy, timeline, journal-timing, OIDC and widget binding tests passed. The merged default manifest keeps the service non-exported, while the opt-in car manifest enables the legacy browse endpoint; no head-unit launch is claimed. See the [Media3 library contract](https://developer.android.com/media/media3/session/serve-content) and [Android Auto manifest requirements](https://developer.android.com/training/cars/media/auto).

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

Tauri runs the root frontend build. Installer bundling remains disabled pending real target builds, signing/notarization and packaging validation. The macOS/Linux/Windows CI linked binaries at `b257b14`. Native desktop media control, credential/SQLite storage, tray actions and OS speech adapters remain. See [Tauri requirements](https://v2.tauri.app/start/prerequisites/) and [Tauri configuration](https://v2.tauri.app/reference/config/).

## Phase 1 platform acceptance gates

| IDs | Implemented evidence | Remaining release evidence |
| --- | --- | --- |
| F24–F27 | Browser transport tests, active native queue adapter, native chapters/speed/sleep source, Android debug build | authenticated real-codec/range fixtures; physical seek/rate/sleep and suspension tests |
| F28 | Opt-in CarPlay templates and Android Auto catalog, controller authentication and pagination; Android car configuration compiled | CarPlay approval/signing and physical car/voice/distraction tests |
| F29–F30 | Native remote commands/MediaSession and notification foundations | Full artwork/chapter metadata, configurable remote skip policy, Bluetooth/wired controls on devices |
| F31–F36 | Shared reader alignment/speech integration and playback timing primitives | Device timing budget, native speech adapters, background reader/speech continuity qualification |
| F50 | iOS account-scoped Spotlight indexing/deletion/navigation source integrated | Permission/account deletion scenarios; macOS index implementation |
| F51–F52 | Embedded iOS widget/App Intents and compiled Android Continue Reading widget, encrypted account-bound recents and cold/warm navigation | Signing, widget launch and locked-interface physical tests |
| F03 | Native provider browser, encrypted expiring PKCE transaction, exact callback routing and generation-bound exchange source; Android compile and TS coordinator tests | Server/provider callback allowlist, iOS compiler checkpoint and physical browser/cold callback tests |
| F58 | Native theme bridge updates iOS interface/status style and Android edge-to-edge system bars | iOS compiler checkpoint and real light/dark/system switch qualification |
| F53 | iOS dynamic recent-book quick actions and cold/warm routing source | Installed-device account isolation and launch verification |
| F54–F55 | iOS 18 control plus shared App Intents/Shortcuts source | Action button/Control Center/Shortcuts locked/cold scenarios |

Required qualification includes a 60-minute locked-screen audio run on physical iOS and Android devices; interruption, route/network change, expiry and account switch; exact checkpoint recovery while JS is suspended and native journal replay on JS return; widget and headset transport; matched/wrong-edition alignment; speech with/without true ranges; and signed builds on all six targets. Native checkpoints are local recovery evidence, not server-sync acknowledgements. No complete Phase 1 parity claim follows from host generation or debug compilation alone.
