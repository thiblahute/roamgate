set -eu
umask 077
case "${TMPDIR:-/tmp}" in /*) temp_root="${TMPDIR:-/tmp}" ;; *) temp_root=/tmp ;; esac
# macOS's TMPDIR ends with a slash: keep the paths sent to agents clean.
while [ "${temp_root%/}" != "$temp_root" ]; do temp_root=${temp_root%/}; done
root="$temp_root/roamgate-uploads-$(id -u)"
[ ! -L "$root" ] || exit 1
mkdir -m 700 -p "$root"
[ -d "$root" ] && [ ! -L "$root" ] || exit 1
owner=$(stat -c %u "$root" 2>/dev/null || stat -f %u "$root")
mode=$(stat -c %a "$root" 2>/dev/null || stat -f %Lp "$root")
[ "$owner" = "$(id -u)" ] && [ "$mode" = 700 ] || exit 1
find "$root" -mindepth 1 -maxdepth 1 -type d -name 'upload-*' -mmin +{{retention_minutes}} -exec rm -rf -- {} +