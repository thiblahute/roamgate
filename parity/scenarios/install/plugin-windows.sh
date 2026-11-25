#!/bin/sh
# The Windows plugin installer (scripts/install-plugin.ps1) under Windows
# PowerShell, with only System32 on PATH (no Bun): a plugin checkout of
# version 9.8.7 downloads its release from fake-models (served from
# ./served/winrel), checks it and replaces server\roamgate.exe, or fails
# and keeps the previous binary. Run in the run's root by Git for Windows'
# bash; its Windows tools are the system's (tar.exe, powershell.exe).
set -eu
system=$(cygpath -u "${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}")/System32
powershell=$system/WindowsPowerShell/v1.0/powershell.exe
tar=$system/tar.exe
win() { cygpath -w "$1"; }
fail() {
  printf 'plugin-windows: %s\n' "$*" >&2
  exit 1
}

root=$PWD/plugin
releases=$PWD/served/winrel
base=$FAKE_HTTP/files/winrel
mkdir -p "$root/scripts" "$root/server" "$PWD/assets" "$releases"
cp "$REPO/scripts/install-plugin.ps1" "$root/scripts/"
printf 'version = "9.8.7"\n' >"$root/herdr-plugin.toml"

arch=$("$powershell" -NoProfile -Command '[Runtime.InteropServices.RuntimeInformation]::OSArchitecture' | tr -d '\r')
case "$arch" in Arm64) platform=windows-arm64 ;; *) platform=windows-x64 ;; esac
package=roamgate-$platform
mkdir -p "$PWD/assets/$package"
# The packaged binary: its version, and `plugin version` unless rejected.
cat >fixture.ts <<'TS'
if (process.argv[2] === "--version" || (process.argv[2] === "plugin" && process.argv[3] === "version" && !process.env.PLUGIN_REJECT_NATIVE)) console.log("roamgate 9.8.7"); else process.exit(2);
TS
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig fixture.ts \
  --outfile "$(win "$PWD/assets/$package/roamgate.exe")" >/dev/null
archive_name=roamgate-v9.8.7-$platform.tar.xz
archive=$releases/$archive_name
# pack <VERSION's version> <file>: the package as the release ships it.
pack() {
  printf 'roamgate %s %s\n' "$1" "$platform" >"$PWD/assets/$package/VERSION"
  "$tar" --options xz:compression-level=0 -C "$(win "$PWD/assets")" -cJf "$(win "$2")" "$package"
}
pack 9.8.7 "$PWD/valid.tar.xz"
pack 9.8.6 "$PWD/invalid.tar.xz"
# checksum <digest> <name>
checksum() { printf '%s  %s\n' "$1" "$2" >"$archive.sha256"; }
digest_of() { sha256sum "$1" | cut -d' ' -f1; }

target=$root/server/roamgate.exe
# install [env options and variables]: the installer under PowerShell.
install() {
  env "$@" PATH="$system:$system/WindowsPowerShell/v1.0" "$powershell" -NoProfile \
    -NonInteractive -ExecutionPolicy Bypass -File "$(win "$root/scripts/install-plugin.ps1")"
}
for case in fresh none legacy-mirror checksum checksum-name metadata native-command download; do
  if [ "$case" = metadata ]; then cp invalid.tar.xz "$archive"; else cp valid.tar.xz "$archive"; fi
  digest=$(digest_of "$archive")
  case "$case" in
    checksum) checksum "$(printf '0%.0s' $(seq 64))" "$archive_name" ;;
    checksum-name) checksum "$digest" ../unrelated ;;
    *) checksum "$digest" "$archive_name" ;;
  esac
  [ "$case" = download ] && rm -f "$archive"
  [ "$case" = fresh ] || printf 'keep previous binary' >"$target"
  if [ "$case" = legacy-mirror ]; then
    set -- -u ROAMGATE_RELEASE_BASE_URL HERDR_GUI_RELEASE_BASE_URL="$base"
  else
    set -- ROAMGATE_RELEASE_BASE_URL="$base" HERDR_GUI_RELEASE_BASE_URL=http://legacy.invalid/releases
  fi
  [ "$case" = native-command ] && set -- "$@" PLUGIN_REJECT_NATIVE=1
  code=0
  install "$@" >out.txt 2>err.txt || code=$?
  case "$case" in
    fresh | none | legacy-mirror)
      [ "$code" = 0 ] || fail "$case: exit $code: $(cat err.txt)"
      version=$("$target" plugin version | tr -d '\r')
      [ "$version" = "roamgate 9.8.7" ] || fail "$case: installed binary says $version"
      ;;
    *)
      [ "$code" != 0 ] || fail "$case: the install succeeded"
      [ "$(cat "$target")" = "keep previous binary" ] || fail "$case: the previous binary was replaced"
      ;;
  esac
  [ "$(ls -A "$root/server")" = roamgate.exe ] || fail "$case: server holds $(ls -A "$root/server")"
done

# An empty ROAMGATE_RELEASE_BASE_URL means the official release, not the
# legacy variable's mirror.
code=0
env PATH="$system:$system/WindowsPowerShell/v1.0" ROAMGATE_RELEASE_BASE_URL= \
  HERDR_GUI_RELEASE_BASE_URL=http://legacy.invalid/releases "$powershell" -NoProfile \
  -NonInteractive -ExecutionPolicy Bypass -Command \
  "function Invoke-WebRequest { param(\$Uri) throw \"Selected release: \$Uri\" }; & '$(win "$root/scripts/install-plugin.ps1")'" \
  >out.txt 2>err.txt || code=$?
[ "$code" != 0 ] || fail "empty override: the install succeeded"
grep -q 'Selected release: https://github.com/powerfooI/roamgate/releases/download/v9.8.7/' err.txt ||
  fail "empty override: $(cat err.txt)"
[ "$(ls -A "$root/server")" = roamgate.exe ] || fail "empty override: server holds $(ls -A "$root/server")"

# A release with the Pi sidecar installs roamgate-pi.exe beside it.
cp "$PWD/assets/$package/roamgate.exe" "$PWD/assets/$package/roamgate-pi.exe"
pack 9.8.7 "$archive"
checksum "$(digest_of "$archive")" "$archive_name"
install ROAMGATE_RELEASE_BASE_URL="$base" >out.txt 2>err.txt || fail "pi sidecar: $(cat err.txt)"
[ "$(ls -A "$root/server" | sort | tr '\n' ' ')" = "roamgate-pi.exe roamgate.exe " ] ||
  fail "pi sidecar: server holds $(ls -A "$root/server")"
echo ok
