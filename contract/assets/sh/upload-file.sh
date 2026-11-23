
set -euo pipefail
root={{root}}
rel={{rel}}
name={{name}}
root_real="$(cd "$root" && pwd -P)"
target_dir="$root_real"
if [ -n "$rel" ]; then
  target_dir="$root_real/$rel"
fi
dir_real="$(cd "$target_dir" && pwd -P)"
case "$dir_real/" in "$root_real"/*|"$root_real/") ;; *) exit 13 ;; esac
if [ ! -d "$dir_real" ]; then
  echo "upload target is not a directory" >&2
  exit 14
fi
target="$dir_real/$name"
overwritten=0
if [ -d "$target" ] || [ -L "$target" ]; then
  echo "cannot overwrite a directory or symlink" >&2
  exit 15
fi
if [ -e "$target" ]; then overwritten=1; fi
base64 -d > "$target"
size="$(stat -c %s "$target" 2>/dev/null || stat -f %z "$target" 2>/dev/null || printf 0)"
rel_path="${target#"$root_real"/}"
printf 'META\t%s\t%s\t%s\n' "$(printf '%s' "$rel_path" | base64 | tr -d '\n')" "$size" "$overwritten"
