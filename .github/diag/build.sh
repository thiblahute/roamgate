#!/bin/bash
# Temporary diagnostic: builds windows-arm64 variants with cargo-xwin.
set -euxo pipefail
T=aarch64-pc-windows-msvc
OUT=$PWD/out
mkdir -p "$OUT" /tmp/web
echo '<html></html>' > /tmp/web/index.html

# Minimal binaries built the same way.
mkdir -p /tmp/hello/src
cat > /tmp/hello/Cargo.toml <<'TOML'
[package]
name = "hello"
version = "0.1.0"
edition = "2021"
[dependencies]
mimalloc = { version = "0.1", default-features = false, optional = true }
[profile.release]
strip = false
debug = "line-tables-only"
TOML
cat > /tmp/hello/src/main.rs <<'RS'
#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
fn main() {
    let v: Vec<String> = std::env::args().collect();
    println!("hello {:?}", v);
    let t = std::thread::spawn(|| vec![0u8; 1 << 20].len());
    println!("thread {}", t.join().unwrap());
}
RS
(cd /tmp/hello && cargo xwin build --release --target $T && cp target/$T/release/hello.exe "$OUT/hello.exe" && cp target/$T/release/hello.pdb "$OUT/hello.pdb")
(cd /tmp/hello && cargo xwin build --release --target $T --features mimalloc && cp target/$T/release/hello.exe "$OUT/hello-mimalloc.exe" && cp target/$T/release/hello.pdb "$OUT/hello-mimalloc.pdb")

export CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_DEBUG=line-tables-only
cargo xtask build windows-arm64 --web /tmp/web --version 0.0.0-diag
cp target/$T/release/roamgate.exe "$OUT/roamgate-dbg.exe"
cp target/$T/release/roamgate.pdb "$OUT/roamgate-dbg.pdb"

sed -i '/#\[global_allocator\]/,+1d' crates/roamgate/src/main.rs
cargo xtask build windows-arm64 --web /tmp/web --version 0.0.0-diag
cp target/$T/release/roamgate.exe "$OUT/roamgate-nomi.exe"
cp target/$T/release/roamgate.pdb "$OUT/roamgate-nomi.pdb"
git checkout crates/roamgate/src/main.rs
ls -la "$OUT"
