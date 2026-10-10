fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/spotlight.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("avid_spotlight");
        println!("cargo:rustc-link-lib=framework=CoreSpotlight");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=native/spotlight.m");
    }
    tauri_build::build()
}
