# Finishing Phase 1

Updated: 2026-10-10. Use this guide with the [feature checklist](phase-1-status.md) and [current roadmap](roadmap.md). Phase 1 is a working development preview, not a fully qualified release.

## What is available now

The browser has implemented library browsing/search, reading for supported EPUB/MOBI/PDF/comic files, streaming audio, chapters, speed/sleep controls, notes, collections, progress/activity, recovery, appearance settings and seven-language catalogs. Read and Listen requires real media overlays or a verified alignment map. Format and accessibility coverage is still bounded by the recorded fixtures and checks.

At source checkpoint `430b8b6`, 657 shared tests, TypeScript, the production web build and all five native CI jobs passed. Fourteen real write/read smoke checks also passed against a separate disposable BookOrbit v3.3.0 instance. The supplied server was used only for read-only integration checks.

Native playback, secure sessions, SQLite, widgets, shortcuts, desktop media controls, car hosts and connectors have source implementations and compilation evidence. These are not all accessible in a browser tab, and unsigned compilation does not prove installed behavior. The car catalog currently contains audio prepared by the native host, not every untouched server audiobook. Native speech still depends on JavaScript for subsequent chunks/chapters; desktop speech does not expose precise word boundaries. AO3 replacement editions retain old files/positions but do not migrate an exact old location into changed text. Native OIDC uses `avid://oauth2-callback`; HTTPS Universal/App Links are not implemented.

Full downloaded-media/offline operation is **Phase 3**, not available yet. Advanced audio and generated alignment are **Phase 2**. Apple Pencil work is **Phase 4**. A complete installed reference-app comparison and native accessibility audit remain open.

## Recommended order

1. Install ordinary Android and iOS development builds on physical devices, then the desktop packages on their target systems.
2. Run the core reading and 60-minute locked-screen playback/recovery checks below. Fix failures before extending the native feature claims.
3. Use a separate writable, disposable BookOrbit deployment and two clients to qualify synchronization and conflicts.
4. Qualify widgets, car hosts, provider login and connectors with the necessary accounts/devices.
5. Finish the format corpus, accessibility, language, reference-layout and native-guide checks. Record evidence against the relevant F01–F66 rows.

Phase 2 implementation can proceed alongside external device/account gates. It does not turn unresolved Phase 1 rows into passes.

## Install Android

The successful [native CI run](https://github.com/crizzy9/avid/actions/runs/38019033815) produced `avid-android-debug` and `avid-android-auto-debug` artifacts. Download and unzip the appropriate artifact, then install its APK on a test phone. CI retains artifacts for 14 days; rerun the workflow if they have expired. These are development packages, not store releases.

To build locally, use Node.js 24, pnpm 10, JDK 21 and a configured Android SDK:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @avid/mobile exec cap sync android
pnpm --filter @avid/mobile build:android
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

For the opt-in Android Auto host, run `pnpm --filter @avid/mobile build:android:auto` and install the resulting APK. Test browsing, voice/search and playback with Google's [Desktop Head Unit](https://developer.android.com/training/cars/testing/dhu), followed by a physical head unit. The default app keeps its car service private. Public distribution/signing is separate Phase 6 work.

## Install iOS/iPadOS

Use a Mac with Xcode, an Apple development signing team and an actual iPhone/iPad. The unsigned CI build proves compilation; it is not a provisioned device IPA.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @avid/mobile exec cap sync ios
pnpm --filter @avid/mobile verify:ios
pnpm --filter @avid/mobile open:ios
```

Select the signing team for both the main `App` and `AvidWidgets` targets, configure provisioning and the shared App Group, select the `App` scheme and run on the connected device. The checked-in app identifier is `app.avid.reader`; the group is `group.app.avid.reader`. If these identifiers are unavailable to the team, change them consistently across the app, widget, entitlements, configuration and native group references. Keep the integrated hosts; do not regenerate them. See [Capacitor's Xcode capability setup](https://capacitorjs.com/docs/ios/configuration), [Apple's App Group setup](https://developer.apple.com/help/account/identifiers/register-an-app-group/) and [Avid platform notes](platforms.md).

CarPlay additionally requires Apple's approved audio entitlement and matching provisioning. Use the opt-in `App-CarPlay` scheme/configuration and qualify simulator plus real car behavior. [Apple's CarPlay developer page](https://developer.apple.com/carplay/) provides the entitlement request and simulator information. Ordinary iOS reading/playback qualification can start while that approval is pending.

## Install desktop builds

The same CI run produced unsigned `avid-desktop-macOS-unsigned-debug`, `avid-desktop-Windows-unsigned-debug` and `avid-desktop-Linux-unsigned-debug` artifacts: a macOS app, Windows NSIS installer and Linux Debian package. Install each on its matching OS and verify the credential store, codecs, files, callback handling, media keys/tray, speech and account/recovery behavior. Test macOS Spotlight from an installed app.

For local development/builds, use `pnpm --filter @avid/desktop dev` or `pnpm --filter @avid/desktop build` with the platform prerequisites in [platforms.md](platforms.md). Release signing and notarization belong to Phase 6; development installation and behavior qualification are needed now. `pnpm dev` alone starts the browser app and cannot establish native background, widget or car behavior.

## Remaining checks and required inputs

| Item | How to proceed | Evidence to record |
| --- | --- | --- |
| Background audio and speech | Use physical iOS/Android devices with representative audio and speech. Run at least 60 minutes locked; cross chapters, change speed, exercise sleep timers, Bluetooth/headset controls, calls, network changes and session expiry. Separately terminate/reopen the app and test recovery. Continuous background speech still needs implementation work. | Device/OS, exact codec/fixture, expected versus actual source position and listening activity, interruptions and failures. Do not expect playback to continue after an explicit force-stop. |
| Native storage and controls | Test cold starts, widget/shortcut/media commands, account switching/logout, unavailable credential storage, low disk space and interrupted storage writes on installed builds. | Correct account and publication opened; no old-account data or actions; checkpoint/recovery behavior and sanitized logs. |
| Two-client synchronization | On a separate writable disposable server, use two clients to change positions in both directions, create/edit/delete notes, change memberships and accumulate activity. Review conflicts and reconnect in both orders. | Original IDs/event times retained, no duplicate activity or annotations, explicit conflict resolution and correct server read-back. See [sync smoke evidence](bookorbit-smoke.md). |
| Provider login | Configure the actual provider/server and exact web/native callback allowlists using [.env.example](../.env.example) and [OIDC setup](oidc.md). Test installed cold/warm callbacks, cancellation, expiry and account changes. Password login does not qualify OIDC. | Provider/server versions, callback configuration without secrets, successful identity restoration and failure/cancellation behavior. |
| CarPlay / Android Auto | Install the enabled host, obtain required CarPlay approval/provisioning and test both development simulators and physical vehicle/head-unit behavior. Finish full-catalog browsing during Phase 2. | Browse/search/play, locked/cold session recovery, controls and account cleanup. Prepared-audio-only browsing is a current limitation. |
| KOReader | Use a physical device and the exact same publication on a writable disposable server, with the documented `koreader_sync` access. Follow [KOReader qualification](koreader.md). | Avid → KOReader → Avid position round-trip, changed-file rejection and missing-conversion behavior. |
| CrossPoint | Use an owned reader on the same LAN, record firmware, and transfer a disposable EPUB to a reviewed destination: Check reader → Review transfer → Send EPUB → read-back hash verification. Manual IP entry is available. | Firmware/device, permission behavior, matching file hash and successful reading on the device. No physical firmware version is currently qualified. See [integrations](integrations.md). |
| AO3 | Start `node scripts/ao3-companion.mjs`, explicitly pair using its temporary code, and use an authorized account and followed-work update. Phones need reachable HTTPS hosting and exact allowed Avid origins; see [deployment](ao3-deployment.md). | Authenticated import/update, no duplicate import, preservation of prior edition/notes, and explicit changed-edition location behavior. Live account/deployment behavior remains unqualified. |
| Format/codec coverage | Use lawful representative EPUB, MOBI, PDF, CBZ/CBR/CB7 and audio fixtures, including fixed layouts and large publications. Exercise rotation, chapter navigation and memory limits on each supported host. | Fixture identity, platform/codec support, rendering/navigation results and explicit unsupported cases. |
| Accessibility and languages | Test VoiceOver, TalkBack and desktop assistive technology; keyboard/focus, larger fonts, contrast and reduced motion; fluent-speaker review across all seven locales. | Actual device/assistive-technology versions, component/state failures and corrected retests. Automated contrast/catalog checks alone are insufficient. |
| Reference and guides | Compare the remaining installed reference-app states with lawful fixtures, including settings, player, error and login/recovery states. Update native instructions after real installs. | Screen/state coverage and discrepancies in [reference-layout.md](reference-layout.md), then the corresponding feature rows. |

Keep the supplied BookOrbit instance **read-only**. Do not enable writes there to complete this checklist. Credentials, tokens, private publications and account screenshots must stay out of commits and test reports.

For each check record the feature ID, exact commit, device/OS, fixture, steps, expected/actual result, pass/fail and sanitized evidence in the relevant linked document. A failing result is useful: fix it and rerun that scenario. There is no need to wait for the entire matrix before addressing a failure. Signing identities, external provider configuration and physical hardware enable these tests; supplying them alone does not complete the engineering acceptance work.
