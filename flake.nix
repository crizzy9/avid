{
  description = "Avid development shells for the web, Tauri desktop and Android hosts";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      environments = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          inherit (pkgs) lib;
          node = pkgs.nodejs_24;
          pnpmVersion = lib.removePrefix "pnpm@" manifest.packageManager;
          # The lockfile pins the patched pnpm 10 variant. Keep packageManager
          # and CI in sync when updating nixpkgs instead of allowing version drift.
          pnpm =
            assert lib.assertMsg (
              pkgs.pnpm_10_latest.version == pnpmVersion
            ) "Update package.json and CI to match the pnpm version in flake.lock";
            pkgs.pnpm_10_latest.override { nodejs-slim = node; };
          web = pkgs.mkShellNoCC {
            name = "avid-web";
            packages = [
              node
              pnpm
              pkgs.git
              pkgs.nixfmt
            ];
            shellHook = ''
              if [[ $- == *i* ]]; then
                echo "Avid web: pnpm install --frozen-lockfile; pnpm dev"
              fi
            '';
          };
          desktopLibraries = lib.optionals pkgs.stdenv.hostPlatform.isLinux (
            with pkgs;
            [
              gtk3
              webkitgtk_4_1
              libayatana-appindicator
              librsvg
              dbus
              speechd
              openssl
              sysprof
              glib-networking
              gsettings-desktop-schemas
              gst_all_1.gstreamer
              gst_all_1.gst-plugins-base
              gst_all_1.gst-plugins-good
              gst_all_1.gst-plugins-bad
              gst_all_1.gst-libav
            ]
          );
          desktop =
            assert lib.versionAtLeast pkgs.rustc.version "1.90";
            pkgs.mkShell {
              name = "avid-desktop";
              inputsFrom = [ web ];
              packages =
                with pkgs;
                [
                  cargo
                  rustc
                  rustfmt
                  clippy
                  pkg-config
                ]
                ++ lib.optionals stdenv.hostPlatform.isLinux [ patchelf ];
              nativeBuildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [
                pkgs.rustPlatform.bindgenHook
              ];
              buildInputs = desktopLibraries;
              shellHook =
                lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
                  # The tray library is loaded with dlopen rather than linked.
                  export LD_LIBRARY_PATH="${
                    lib.makeLibraryPath [ pkgs.libayatana-appindicator ]
                  }''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
                  export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
                  export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
                ''
                + ''
                  if [[ $- == *i* ]]; then
                    echo "Avid desktop: pnpm install --frozen-lockfile; pnpm --filter @avid/desktop dev"
                  fi
                '';
            };
          # Only #android opts into Google's SDK and its license; the web and
          # desktop shells contain no Android SDK. This SDK shell is provided for
          # x86_64 Linux; other hosts can use their installed Android Studio SDK.
          androidPkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };
          androidSdk =
            (androidPkgs.androidenv.composeAndroidPackages {
              platformVersions = [ "36" ];
              buildToolsVersions = [ "35.0.0" ];
              includeNDK = false;
              includeCmake = false;
              includeEmulator = false;
              includeSystemImages = false;
            }).androidsdk;
          android = pkgs.mkShell {
            name = "avid-android";
            inputsFrom = [ web ];
            packages = [
              pkgs.jdk21
              androidSdk
            ];
            JAVA_HOME = "${pkgs.jdk21}";
            ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
            ANDROID_SDK_ROOT = "${androidSdk}/libexec/android-sdk";
            shellHook = ''
              # Google's Maven aapt2 executable expects a conventional Linux
              # loader. Use the Nix-patched SDK binary with the Gradle wrapper.
              export GRADLE_OPTS="''${GRADLE_OPTS:+$GRADLE_OPTS }-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2"
              if [[ $- == *i* ]]; then
                echo "Avid Android: pnpm build; pnpm --filter @avid/mobile exec cap sync android; pnpm --filter @avid/mobile build:android"
              fi
            '';
          };
        in
        {
          devShells = {
            default = web;
            inherit web desktop;
          }
          // lib.optionalAttrs (system == "x86_64-linux") { inherit android; };
          formatter = pkgs.nixfmt;
          checks = {
            toolchain =
              pkgs.runCommand "avid-web-toolchain"
                {
                  nativeBuildInputs = [
                    node
                    pnpm
                  ];
                }
                ''
                  node -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1)'
                  test "$(pnpm --version)" = "${pnpmVersion}"
                  touch "$out"
                '';
          }
          // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            desktop-dependencies =
              pkgs.runCommand "avid-desktop-dependencies"
                {
                  nativeBuildInputs = [
                    pkgs.pkg-config
                    pkgs.rustPlatform.bindgenHook
                  ];
                  buildInputs = desktopLibraries;
                }
                ''
                  pkg-config --exists gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 librsvg-2.0 dbus-1 speech-dispatcher
                  test -f "$LIBCLANG_PATH/libclang.so"
                  gst-inspect-1.0 playbin >/dev/null
                  gst-inspect-1.0 wavparse >/dev/null
                  gst-inspect-1.0 avdec_aac >/dev/null
                  touch "$out"
                '';
          };
        }
      );
    in
    {
      devShells = nixpkgs.lib.mapAttrs (_: value: value.devShells) environments;
      checks = nixpkgs.lib.mapAttrs (_: value: value.checks) environments;
      formatter = nixpkgs.lib.mapAttrs (_: value: value.formatter) environments;
    };
}
