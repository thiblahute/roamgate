
set -eu
tmp="$(mktemp -d "${TMPDIR:-/tmp}/roamgate-update.XXXXXX")"
target={{target}}
target_tmp=""
backup_tmp=""
pi_tmp=""
pi_backup_tmp=""
if [ ! -f "$target" ] || [ -L "$target" ]; then
  echo "running executable is not a regular file" >&2
  exit 1
fi
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
archive="$tmp/{{archive_name}}"
expected_sha256={{sha256}}
curl {{curl_transport}} -fsSL {{archive_url}} -o "$archive"
if command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "$archive" | awk 'NR == 1 { print $1 }')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$archive" | awk 'NR == 1 { print $1 }')"
else
  echo "shasum or sha256sum is required to verify updates" >&2
  exit 1
fi
if [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "downloaded archive checksum does not match update manifest" >&2
  exit 1
fi
# The Pi sidecar roamgate-pi ships beside roamgate since the Rust build;
# an older archive has none.
has_pi=""
if tar -tJf "$archive" | grep -Fqx "{{package_dir}}/roamgate-pi"; then
  has_pi=1
  tar -xJf "$archive" -C "$tmp"   {{version_file}}   {{binary_file}}   "{{package_dir}}/roamgate-pi"
else
  tar -xJf "$archive" -C "$tmp"   {{version_file}}   {{binary_file}}
fi
package_dir="$tmp/{{package_dir}}"
version_file="$package_dir/VERSION"
binary="$package_dir/roamgate"
pi="$package_dir/roamgate-pi"
if [ -n "$has_pi" ] && { [ ! -f "$pi" ] || [ -L "$pi" ] || [ ! -x "$pi" ]; }; then
  echo "downloaded archive does not contain regular package files" >&2
  exit 1
fi
if [ ! -d "$package_dir" ] || [ -L "$package_dir" ] ||    [ ! -f "$version_file" ] || [ -L "$version_file" ] ||    [ ! -f "$binary" ] || [ -L "$binary" ] || [ ! -x "$binary" ]; then
  echo "downloaded archive does not contain regular package files" >&2
  exit 1
fi
expected_version={{version}}
package_name=""
actual_version=""
actual_platform=""
extra_version_field=""
read -r package_name actual_version actual_platform extra_version_field < "$version_file"
if [ "$package_name" != "roamgate" ] ||    [ "$actual_version" != "$expected_version" ] ||    [ "$actual_platform" != {{platform}} ] ||    [ -n "$extra_version_field" ]; then
  echo "downloaded VERSION metadata does not match update manifest" >&2
  exit 1
fi
binary_version="$("$binary" --version)"
if [ "$binary_version" != "roamgate $expected_version" ]; then
  echo "downloaded binary version does not match update manifest" >&2
  exit 1
fi
if [ ! -f "$target" ] || [ -L "$target" ]; then
  echo "running executable changed during update" >&2
  exit 1
fi
target_dir="$(dirname "$target")"
target_base="$(basename "$target")"
pi_target="$target_dir/roamgate-pi"
if { [ -e "$pi_target" ] || [ -L "$pi_target" ]; } &&
  { [ ! -f "$pi_target" ] || [ -L "$pi_target" ]; }; then
  echo "roamgate-pi beside the executable is not a regular file" >&2
  exit 1
fi
# The executable already at this version (a release whose update left
# roamgate-pi out): it and roamgate.previous stay, only roamgate-pi is
# installed.
keep_binary=""
if [ "$("$target" --version 2>/dev/null || true)" = "roamgate $expected_version" ]; then
  keep_binary=1
fi
if [ -n "$has_pi" ]; then
  pi_tmp="$(mktemp "$target_dir/.roamgate-pi.new.XXXXXX")"
  install -m 0755 "$pi" "$pi_tmp"
fi
if [ -z "$keep_binary" ]; then
  target_tmp="$(mktemp "$target_dir/.$target_base.new.XXXXXX")"
  install -m 0755 "$binary" "$target_tmp"
  if [ -f "$target" ] && [ ! -L "$target" ]; then
    backup="$target.previous"
    backup_tmp="$(mktemp "$target_dir/.$target_base.previous.XXXXXX")"
    install -m 0755 "$target" "$backup_tmp"
    mv -f "$backup_tmp" "$backup"
    backup_tmp=""
  fi
  # roamgate-pi.previous goes with roamgate.previous: none when the replaced
  # release had no roamgate-pi.
  if [ -f "$pi_target" ] && [ ! -L "$pi_target" ]; then
    pi_backup_tmp="$(mktemp "$target_dir/.roamgate-pi.previous.XXXXXX")"
    install -m 0755 "$pi_target" "$pi_backup_tmp"
    mv -f "$pi_backup_tmp" "$pi_target.previous"
    pi_backup_tmp=""
  else
    rm -f "$pi_target.previous"
  fi
  if [ -z "$has_pi" ]; then
    rm -f "$pi_target"
  fi
fi
if [ -n "$has_pi" ]; then
  mv -f "$pi_tmp" "$pi_target"
  pi_tmp=""
fi
if [ -z "$keep_binary" ]; then
  mv -f "$target_tmp" "$target"
  target_tmp=""
fi
