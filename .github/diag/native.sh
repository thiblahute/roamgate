#!/bin/bash
# Temporary diagnostic: builds roamgate natively on windows-11-arm (MSVC).
set -uxo pipefail
OUT=$PWD/out
mkdir -p "$OUT"
echo native > "$OUT/native.txt"
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version || exit 0
rustc -vV
where clang || true
ls "/c/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Tools/Llvm" || true
export CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_DEBUG=line-tables-only
LLVM="/c/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Tools/Llvm/ARM64/bin"
[ -d "$LLVM" ] && export PATH="$LLVM:$PATH"
cargo build --release --locked -p roamgate 2>&1 | tail -40
cp target/release/roamgate.exe "$OUT/roamgate-native.exe" && cp target/release/roamgate.pdb "$OUT/roamgate-native.pdb"
exit 0
