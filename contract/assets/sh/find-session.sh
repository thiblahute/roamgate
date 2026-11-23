
set -eu
id={{id}}
root="{{root}}"
[ -d "$root" ] || exit 44
latest=""
latest_mtime=0
while IFS= read -r -d '' candidate; do
  mtime="$(stat -c %Y "$candidate" 2>/dev/null || stat -f %m "$candidate")"
  if [ "$mtime" -ge "$latest_mtime" ]; then
    latest="$candidate"
    latest_mtime="$mtime"
  fi
done < <(find -L "$root" -type f \( {{names}} \) -print0)
[ -n "$latest" ] || exit 44
size="$(stat -c %s "$latest" 2>/dev/null || stat -f %z "$latest")"
path64="$(printf '%s' "$latest" | base64 | tr -d '\n')"
printf '%s\t%s\t%s\n' "$size" "$latest_mtime" "$path64"
