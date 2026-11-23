
set -eu
root={{root}}
rel={{rel}}
show_hidden={{show_hidden}}
limit={{limit}}
root_real="$(cd "$root" && pwd -P)"
target="$root_real"
if [ -n "$rel" ]; then
  target="$root_real/$rel"
fi
target_real="$(cd "$target" && pwd -P)"
case "$target_real/" in "$root_real"/*|"$root_real/") ;; *) exit 13 ;; esac
printf 'ROOT\t%s\n' "$(printf '%s' "$root_real" | base64 | tr -d '\n')"
count=0
while IFS= read -r -d '' p; do
  name="$(basename "$p")"
  if [ "$show_hidden" != "1" ] && [ "${name#\.}" != "$name" ]; then
    continue
  fi
  count=$((count + 1))
  if [ "$count" -gt "$limit" ]; then
    printf 'TRUNCATED\n'
    break
  fi
  if [ -d "$p" ]; then type=directory; elif [ -L "$p" ]; then type=symlink; else type=file; fi
  size="$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p" 2>/dev/null || printf 0)"
  mtime="$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || printf 0)"
  name64="$(printf '%s' "$name" | base64 | tr -d '\n')"
  printf 'ENTRY\t%s\t%s\t%s\t%s\n' "$type" "$size" "$mtime" "$name64"
done < <(find "$target_real" -mindepth 1 -maxdepth 1 -print0)
