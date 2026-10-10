# Development environment

The repository's `flake.nix` defines development shells; `flake.lock` pins Nixpkgs. These provide tools without changing your host's NixOS configuration, credentials or BookOrbit settings. Workspace dependencies still come from `pnpm-lock.yaml` and need an explicit install. Shell entry does not run that install, start Avid or connect to a server.

Nix must have the `nix-command` and `flakes` experimental features enabled. If they are not enabled in your existing configuration, add `--extra-experimental-features 'nix-command flakes'` to a Nix command. See the [Nix command manual](https://nix.dev/manual/nix/latest/command-ref/new-cli/nix).

## Web: default shell

```sh
nix develop
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173`. `nix develop .#web` selects the same shell explicitly. It supplies Node.js 24, pnpm 10.34.5, Git and nixfmt; the pnpm version matches `package.json` and CI. Without Nix, install the same Node/pnpm versions and run the pnpm commands directly.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

The web and desktop shells are defined for x86_64/aarch64 Linux and macOS. A definition or successful evaluation does not establish that every native host has been built or tested.

## Optional direnv

The checked-in `.envrc` contains `use flake` and selects the default web shell. If you already use direnv with flake support (optionally through nix-direnv), review `.envrc` and `flake.nix`, then run `direnv allow` yourself to trust this directory. Neither direnv nor this approval is required for `nix develop`. The generated `.direnv/` cache is ignored.

## Desktop

```sh
nix develop .#desktop
pnpm install --frozen-lockfile
pnpm --filter @avid/desktop dev
```

Tauri's configuration starts the root Vite server through `beforeDevCommand`. To compile the frontend and native app without creating installer bundles:

```sh
pnpm --filter @avid/desktop exec tauri build --no-bundle
```

The shell includes Rust/Cargo (at least 1.90), rustfmt and Clippy. On Linux it also supplies GTK3, WebKitGTK 4.1, AppIndicator, DBus, Speech Dispatcher, GStreamer audio decoders and the development dependencies needed by bindgen. Tray, GStreamer, GIO and GTK schema paths are configured on shell entry. Tauri's `info` command may warn that rustup is missing; this shell deliberately provides Rust directly through Nix. For the native Rust tests, first build the frontend assets:

```sh
pnpm build
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

A running Linux app still needs a graphical session. Native credentials and media controls need the session's DBus services; speech needs a working Speech Dispatcher service and installed voices. Installing libraries in a shell does not start those services. On macOS, install and select Apple's Xcode command-line tools separately. iOS needs full Xcode on macOS. Windows native builds use the Windows MSVC/WebView2 toolchain; a WSL shell can run the web workflow but does not replace that toolchain. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and the repository's [platform guide](platforms.md).

## Android: optional x86_64 Linux shell

Choosing `.#android` opts into Google's Android SDK packages and the SDK license acceptance configured in `flake.nix`. The default web and desktop shells do not include or accept the Android SDK. Review the [Android SDK terms](https://developer.android.com/studio/terms) before selecting it.

```sh
nix develop .#android
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @avid/mobile exec cap sync android
pnpm --filter @avid/mobile build:android
pnpm --filter @avid/mobile build:android:auto
```

The shell supplies JDK 21, Android platform 36 and build-tools 35.0.0, and configures `JAVA_HOME`/`ANDROID_HOME`. The committed Gradle wrapper supplies Gradle 8.14.3. The Auto command also runs JVM tests and enables the optional car manifest; it does not install or qualify an Android Auto host.

The SDK is managed in the immutable Nix store. The shell selects its patched AAPT2 through `GRADLE_OPTS`, avoiding the conventional Linux loader expected by Maven's binary. It includes no NDK, emulator or system images; Avid's mobile host uses Capacitor, not Tauri mobile. Other hosts can use an installed Android Studio SDK with the same Java/platform requirements. Do not regenerate the checked-in mobile host projects. See [Nixpkgs Android setup](https://nixos.org/manual/nixpkgs/stable/#android) and [mobile build instructions](platforms.md#mobile-builds).

## Checking the environment

`nix flake check` builds the current system's declared checks: Node/pnpm versions and, on Linux, desktop library/libclang discovery. It does not run Avid's JavaScript, Rust or Android test suites. `nix flake check --all-systems --no-build` checks evaluation without building those checks or proving cross-platform compilation. Use the explicit commands above for application validation; signing, installation and device acceptance remain separate steps.

Format the flake with `nix fmt flake.nix`. When updating `flake.lock`, keep `package.json` and the CI pnpm versions aligned; the flake checks this at evaluation time. The shell uses the patched pnpm 10 variant from Nixpkgs rather than enabling insecure package overrides.
