#!/bin/sh
set -eu

github_repository="powerfooI/roamgate"
# New names take precedence even when explicitly empty (VERSION= means latest).
custom_release_base="${ROAMGATE_RELEASE_BASE_URL-${HERDR_GUI_RELEASE_BASE_URL:-}}"
install_dir="${ROAMGATE_INSTALL_DIR-${HERDR_GUI_INSTALL_DIR:-$HOME/.local/bin}}"
requested_version="${ROAMGATE_VERSION-${HERDR_GUI_VERSION:-}}"

fail() {
  printf 'Roamgate installer: %s\n' "$*" >&2
  exit 1
}

[ -n "$install_dir" ] || fail "install directory must not be empty"

for command in curl tar install uname awk cat mktemp grep; do
  command -v "$command" >/dev/null 2>&1 ||
    fail "required command not found: $command"
done
if command -v shasum >/dev/null 2>&1; then
  checksum_tool="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  checksum_tool="sha256sum"
else
  fail "required command not found: shasum or sha256sum"
fi

case "$(uname -s):$(uname -m)" in
Darwin:arm64 | Darwin:aarch64)
  platform="darwin-arm64"
  ;;
Darwin:x86_64 | Darwin:amd64)
  platform="darwin-x64"
  ;;
Linux:x86_64 | Linux:amd64)
  platform="linux-x64"
  ;;
Linux:arm64 | Linux:aarch64)
  platform="linux-arm64"
  ;;
*)
  fail "unsupported platform: $(uname -s) $(uname -m)"
  ;;
esac

if [ -n "$requested_version" ]; then
  case "$requested_version" in
  *[!0-9A-Za-z._-]*)
    fail "invalid ROAMGATE_VERSION: $requested_version"
    ;;
  esac
  archive_name="roamgate-v${requested_version}-${platform}.tar.xz"
else
  archive_name="roamgate-${platform}.tar.xz"
fi

# GitHub uses a different asset directory for latest and versioned releases.
# Custom mirrors keep the existing flat-directory contract.
if [ -n "$custom_release_base" ]; then
  release_base="$custom_release_base"
elif [ -n "$requested_version" ]; then
  release_base="https://github.com/$github_repository/releases/download/v${requested_version}"
else
  release_base="https://github.com/$github_repository/releases/latest/download"
fi
while [ "${release_base%/}" != "$release_base" ]; do
  release_base="${release_base%/}"
done
case "$release_base" in
*\?* | *\#*)
  fail "release base URL must not contain a query or fragment"
  ;;
esac
release_authority="${release_base#*://}"
release_authority="${release_authority%%/*}"
[ -n "$release_authority" ] || fail "invalid release base URL"
case "$release_authority" in
*@*) fail "release base URL must not contain credentials" ;;
esac
case "$release_base" in
https://*)
  curl_protocol="=https"
  ;;
http://*)
  case "$release_authority" in
  localhost | localhost:* | 127.0.0.1 | 127.0.0.1:* | "[::1]" | "[::1]":*) ;;
  *) fail "release base URL must use HTTPS unless the mirror is loopback" ;;
  esac
  curl_protocol="=http"
  ;;
*) fail "release base URL must be an HTTP(S) URL" ;;
esac
package_dir="roamgate-${platform}"
mkdir -p "$install_dir"
target="$install_dir/roamgate"
# The Pi sidecar Ranger runs for models other than Claude Code, beside
# roamgate; releases before the Rust build have none.
pi_target="$install_dir/roamgate-pi"
for path in "$target" "$pi_target"; do
  if { [ -e "$path" ] || [ -L "$path" ]; } &&
    { [ ! -f "$path" ] || [ -L "$path" ]; }; then
    fail "install target exists but is not a regular file"
  fi
done
tmp="$(mktemp -d "${TMPDIR:-/tmp}/roamgate-install.XXXXXX")"
target_tmp=""
backup_tmp=""
pi_tmp=""
pi_backup_tmp=""

cleanup() {
  rm -rf "$tmp"
  if [ -n "${target_tmp:-}" ]; then
    rm -f "$target_tmp"
  fi
  if [ -n "${backup_tmp:-}" ]; then
    rm -f "$backup_tmp"
  fi
  if [ -n "${pi_tmp:-}" ]; then
    rm -f "$pi_tmp"
  fi
  if [ -n "${pi_backup_tmp:-}" ]; then
    rm -f "$pi_backup_tmp"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

archive="$tmp/$archive_name"
checksum="$archive.sha256"
printf 'Downloading roamgate for %s...\n' "$platform"
curl --proto "$curl_protocol" --proto-redir "$curl_protocol" \
  -fsSL "$release_base/$archive_name" -o "$archive"
curl --proto "$curl_protocol" --proto-redir "$curl_protocol" \
  --max-filesize 4096 -fsSL \
  "$release_base/$archive_name.sha256" -o "$checksum"
checksum_line="$(cat "$checksum")" || fail "unable to read package checksum"
set -f
set -- $checksum_line
set +f
[ "$#" -eq 2 ] || fail "invalid package checksum file"
expected_checksum="$1"
checksum_name="$2"
[ "${#expected_checksum}" -eq 64 ] || fail "invalid package checksum file"
case "$expected_checksum" in
*[!0-9A-Fa-f]*) fail "invalid package checksum file" ;;
esac
expected_checksum="$(printf '%s\n' "$expected_checksum" | awk '{ print tolower($0) }')"
[ "$checksum_name" = "$archive_name" ] || fail "invalid package checksum file"
if [ "$checksum_tool" = "shasum" ]; then
  actual_checksum="$(shasum -a 256 "$archive" | awk 'NR == 1 { print $1 }')"
else
  actual_checksum="$(sha256sum "$archive" | awk 'NR == 1 { print $1 }')"
fi
[ "$actual_checksum" = "$expected_checksum" ] || fail "package checksum mismatch"

has_pi=""
if tar -tJf "$archive" | grep -Fqx "$package_dir/roamgate-pi"; then
  has_pi=1
  tar -xJf "$archive" -C "$tmp" \
    "$package_dir/VERSION" \
    "$package_dir/roamgate" \
    "$package_dir/roamgate-pi"
else
  tar -xJf "$archive" -C "$tmp" \
    "$package_dir/VERSION" \
    "$package_dir/roamgate"
fi

extracted_package_dir="$tmp/$package_dir"
version_file="$extracted_package_dir/VERSION"
binary="$extracted_package_dir/roamgate"
pi="$extracted_package_dir/roamgate-pi"
[ -d "$extracted_package_dir" ] && [ ! -L "$extracted_package_dir" ] ||
  fail "package directory is invalid"
[ -f "$version_file" ] && [ ! -L "$version_file" ] ||
  fail "package VERSION file is missing or invalid"
[ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] ||
  fail "package binary is missing, invalid, or not executable"
[ -z "$has_pi" ] || { [ -f "$pi" ] && [ ! -L "$pi" ] && [ -x "$pi" ]; } ||
  fail "package roamgate-pi is invalid or not executable"

package_name=""
package_version=""
package_platform=""
extra_version_field=""
read -r package_name package_version package_platform extra_version_field \
  <"$version_file" || fail "invalid package VERSION file"
[ "$package_name" = "roamgate" ] || fail "invalid package VERSION file"
[ -z "$extra_version_field" ] || fail "invalid package VERSION file"
[ -n "$package_version" ] || fail "package version is missing"
[ "$package_platform" = "$platform" ] ||
  fail "package platform is $package_platform, expected $platform"
[ -z "$requested_version" ] || [ "$package_version" = "$requested_version" ] ||
  fail "package version is $package_version, expected $requested_version"

binary_version="$("$binary" --version)"
[ "$binary_version" = "roamgate $package_version" ] ||
  fail "binary version does not match package VERSION"

for path in "$target" "$pi_target"; do
  if { [ -e "$path" ] || [ -L "$path" ]; } &&
    { [ ! -f "$path" ] || [ -L "$path" ]; }; then
    fail "install target changed during installation"
  fi
done
target_tmp="$(mktemp "$install_dir/.roamgate.new.XXXXXX")"
install -m 0755 "$binary" "$target_tmp"
if [ -n "$has_pi" ]; then
  pi_tmp="$(mktemp "$install_dir/.roamgate-pi.new.XXXXXX")"
  install -m 0755 "$pi" "$pi_tmp"
fi
backup=""
if [ -f "$target" ] && [ ! -L "$target" ]; then
  backup="$target.previous"
  backup_tmp="$(mktemp "$install_dir/.roamgate.previous.XXXXXX")"
  install -m 0755 "$target" "$backup_tmp"
  mv -f "$backup_tmp" "$backup"
  backup_tmp=""
  # roamgate-pi.previous goes with roamgate.previous: none when the
  # replaced release had no roamgate-pi.
  if [ -f "$pi_target" ] && [ ! -L "$pi_target" ]; then
    pi_backup_tmp="$(mktemp "$install_dir/.roamgate-pi.previous.XXXXXX")"
    install -m 0755 "$pi_target" "$pi_backup_tmp"
    mv -f "$pi_backup_tmp" "$pi_target.previous"
    pi_backup_tmp=""
  else
    rm -f "$pi_target.previous"
  fi
  [ -n "$has_pi" ] || rm -f "$pi_target"
fi
if [ -n "$has_pi" ]; then
  mv -f "$pi_tmp" "$pi_target"
  pi_tmp=""
fi
mv -f "$target_tmp" "$target"
target_tmp=""

printf 'Installed roamgate %s to %s\n' "$package_version" "$target"
if [ -n "$has_pi" ]; then
  printf 'Installed its Pi sidecar to %s\n' "$pi_target"
fi
if [ -n "$backup" ]; then
  printf 'Previous binary saved to %s\n' "$backup"
fi
case ":${PATH:-}:" in
*":$install_dir:"*) ;;
*)
  printf 'Add %s to PATH to run roamgate directly.\n' "$install_dir"
  ;;
esac
