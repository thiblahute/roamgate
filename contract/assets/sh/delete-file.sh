
set -euo pipefail
root={{root}}
rel={{rel}}
root_real="$(cd "$root" && pwd -P)"
target="$root_real/$rel"
parent="$(dirname "$target")"
parent_real="$(cd "$parent" && pwd -P)"
case "$parent_real/" in "$root_real"/*|"$root_real/") ;; *) exit 13 ;; esac
if [ ! -e "$target" ] && [ ! -L "$target" ]; then
  echo "file does not exist" >&2
  exit 14
fi
if [ -d "$target" ] && [ ! -L "$target" ]; then
  type=directory
elif [ -L "$target" ]; then
  type=symlink
else
  type=file
fi
rm -rf -- "$target"
printf 'META\t%s\t%s\n' "$(printf '%s' "$rel" | base64 | tr -d '\n')" "$type"
