
set -eu
tmp="$(mktemp -d "${TMPDIR:-/tmp}/roamgate-update.XXXXXX")"
target={{target}}
target_tmp=""
backup_tmp=""
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
tar -xJf "$archive" -C "$tmp"   {{version_file}}   {{binary_file}}
package_dir="$tmp/{{package_dir}}"
version_file="$package_dir/VERSION"
binary="$package_dir/roamgate"
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
target_tmp="$(mktemp "$target_dir/.$target_base.new.XXXXXX")"
install -m 0755 "$binary" "$target_tmp"
if [ -f "$target" ] && [ ! -L "$target" ]; then
  backup="$target.previous"
  backup_tmp="$(mktemp "$target_dir/.$target_base.previous.XXXXXX")"
  install -m 0755 "$target" "$backup_tmp"
  mv -f "$backup_tmp" "$backup"
  backup_tmp=""
fi
mv -f "$target_tmp" "$target"
target_tmp=""
