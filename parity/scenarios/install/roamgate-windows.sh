#!/bin/sh
# The Windows release installer (scripts/install-roamgate.ps1) under Windows
# PowerShell, with only System32 on PATH (no Bun), against zip releases
# fake-models serves (from ./served/winrel): a fresh install, an install over
# a running roamgate.exe (renamed to roamgate.exe.previous), a pinned
# version while that previous one still runs (moved aside, then removed), and
# every refusal keeping the installation as it was. Run in the run's root by
# Git for Windows' bash; its Windows tools are the system's.
set -eu
system=$(cygpath -u "${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}")/System32
powershell=$system/WindowsPowerShell/v1.0/powershell.exe
tar=$system/tar.exe
win() { cygpath -w "$1"; }
fail() {
  printf 'roamgate-windows: %s\n' "$*" >&2
  exit 1
}

releases=$PWD/served/winrel
base=$FAKE_HTTP/files/winrel
dir=$PWD/install
mkdir -p "$releases" "$PWD/binaries"
arch=$("$powershell" -NoProfile -Command '[Runtime.InteropServices.RuntimeInformation]::OSArchitecture' | tr -d '\r')
case "$arch" in Arm64) platform=windows-arm64 ;; *) platform=windows-x64 ;; esac
package=roamgate-$platform
# A Bun executable per version: `--version`, and `wait` stays up.
for version in 1.0.0 2.0.0; do
  printf 'if (process.argv[2] === "--version") console.log("roamgate %s"); else if (process.argv[2] === "wait") setTimeout(() => {}, 600000); else process.exit(2);\n' "$version" >fixture.ts
  bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig fixture.ts \
    --outfile "$(win "$PWD/binaries/$version.exe")" >/dev/null
done
# release <archive name> <version> [VERSION line] [digest]: the zip as
# cargo xtask package makes it, and its .sha256.
release() {
  rm -rf stage && mkdir -p "stage/$package"
  cp "binaries/$2.exe" "stage/$package/roamgate.exe"
  cp "binaries/$2.exe" "stage/$package/roamgate-pi.exe"
  printf '%s\n' "${3:-roamgate $2 $platform}" >"stage/$package/VERSION"
  printf '#\n' >"stage/$package/THIRD_PARTY_LICENSES.md"
  rm -f "$releases/$1"
  "$tar" -a -C "$(win "$PWD/stage")" -cf "$(win "$releases/$1")" "$package"
  digest=$(sha256sum "$releases/$1" | cut -d' ' -f1)
  printf '%s  %s\n' "${4:-$digest}" "$1" >"$releases/$1.sha256"
}
# install [variables]: the installer under PowerShell, Windows' own modules.
install() {
  env -u PSModulePath "$@" PATH="$system:$system/WindowsPowerShell/v1.0" \
    ROAMGATE_INSTALL_DIR="$(win "$dir")" "$powershell" -NoProfile \
    -NonInteractive -ExecutionPolicy Bypass -File "$(win "$REPO/scripts/install-roamgate.ps1")" \
    >out.txt 2>err.txt
}
installed() { "$dir/$1" --version | tr -d '\r'; }
names() { ls -A "$dir" | sort | tr '\n' ' '; }

release "$package.zip" 1.0.0
install ROAMGATE_RELEASE_BASE_URL="$base" || fail "fresh: $(cat err.txt)"
[ "$(names)" = "roamgate-pi.exe roamgate.exe " ] || fail "fresh: $(names)"

"$dir/roamgate.exe" wait &
running=$!
release "$package.zip" 2.0.0
install ROAMGATE_RELEASE_BASE_URL="$base" || fail "over a running one: $(cat err.txt)"
[ "$(names)" = "roamgate-pi.exe roamgate-pi.exe.previous roamgate.exe roamgate.exe.previous " ] ||
  fail "over a running one: $(names)"
[ "$(installed roamgate.exe)" = "roamgate 2.0.0" ] || fail "over a running one: $(installed roamgate.exe)"
[ "$(installed roamgate.exe.previous)" = "roamgate 1.0.0" ] || fail "previous: $(installed roamgate.exe.previous)"

release "roamgate-v1.0.0-$platform.zip" 1.0.0
install ROAMGATE_RELEASE_BASE_URL="$base" ROAMGATE_VERSION=1.0.0 || fail "pinned: $(cat err.txt)"
[ "$(installed roamgate.exe)" = "roamgate 1.0.0" ] || fail "pinned: $(installed roamgate.exe)"
ls -A "$dir" | grep -q '\.stale-' || fail "pinned: the running previous was not moved aside: $(names)"
kill "$running" 2>/dev/null || true
wait "$running" 2>/dev/null || true
install ROAMGATE_RELEASE_BASE_URL="$base" ROAMGATE_VERSION=1.0.0 || fail "again: $(cat err.txt)"
if ls -A "$dir" | grep -q '\.stale-'; then fail "again: the stale previous stayed: $(names)"; fi

before=$(names)
refuse() {
  what=$1 message=$2
  shift 2
  if install "$@"; then fail "$what: the install succeeded"; fi
  grep -q "$message" err.txt || fail "$what: $(cat err.txt)"
  [ "$(names)" = "$before" ] || fail "$what: $(names)"
  [ "$(installed roamgate.exe)" = "roamgate 1.0.0" ] || fail "$what: replaced"
}
release "$package.zip" 2.0.0 "" "$(printf '0%.0s' $(seq 64))"
refuse checksum "package checksum mismatch" ROAMGATE_RELEASE_BASE_URL="$base"
release "$package.zip" 2.0.0 "roamgate 2.0.0 linux-x64"
refuse VERSION "package platform is linux-x64" ROAMGATE_RELEASE_BASE_URL="$base"
release "$package.zip" 2.0.0 "roamgate 3.0.0 $platform"
refuse binary "binary version does not match" ROAMGATE_RELEASE_BASE_URL="$base"
release "roamgate-v2.0.0-$platform.zip" 1.0.0
refuse pinned "package version is 1.0.0, expected 2.0.0" ROAMGATE_RELEASE_BASE_URL="$base" ROAMGATE_VERSION=2.0.0
refuse "insecure mirror" "must use HTTPS unless the mirror is loopback" ROAMGATE_RELEASE_BASE_URL=http://example.com/releases
refuse credentials "must not contain credentials" ROAMGATE_RELEASE_BASE_URL=https://u:p@example.com/releases
refuse "bad version" "invalid ROAMGATE_VERSION" ROAMGATE_RELEASE_BASE_URL="$base" "ROAMGATE_VERSION=1.0.0;rm"
echo ok
