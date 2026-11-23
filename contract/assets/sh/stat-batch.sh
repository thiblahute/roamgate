for path in "$@"; do
  if [ ! -f "$path" ]; then echo -; continue; fi
  size="$(stat -c %s "$path" 2>/dev/null || stat -f %z "$path" 2>/dev/null)" &&
  mtime="$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null)" &&
  identity="$(stat -c '%d:%i' "$path" 2>/dev/null || stat -f '%d:%i' "$path" 2>/dev/null)" &&
  change="$(stat -c '%y:%z' "$path" 2>/dev/null || stat -f '%Fm:%Fc' "$path" 2>/dev/null)" &&
  path64="$(printf '%s' "$path" | base64 | tr -d '\n')" ||
  { echo '!'; continue; }
  printf '+%s\t%s\t%s\t%s\t%s\n' "$size" "$mtime" "$path64" "$identity" "$change"
done