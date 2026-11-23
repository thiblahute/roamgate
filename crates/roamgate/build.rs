//! Picks the web app the binary embeds: `ROAMGATE_WEB_DIST`, else the
//! repository's server/public (`bun run build:web`). Without one, an empty
//! directory is embedded so that checks and tests build without the web
//! toolchain; `cargo xtask package` refuses to package such a binary.

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=ROAMGATE_WEB_DIST");
    println!("cargo:rerun-if-env-changed=ROAMGATE_BUILD_VERSION");
    let manifest =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = std::env::var_os("ROAMGATE_WEB_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("../../server/public"));
    let dist = if dist.join("index.html").is_file() {
        println!("cargo:rerun-if-changed={}", dist.display());
        dist.canonicalize().expect("web dist path")
    } else {
        // Watch for the build appearing.
        if let Some(parent) = dist.parent() {
            println!("cargo:rerun-if-changed={}", parent.display());
        }
        let empty = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("no-web");
        std::fs::create_dir_all(&empty).expect("create the empty web directory");
        empty
    };
    println!("cargo:rustc-env=ROAMGATE_WEB_DIST={}", dist.display());
}
