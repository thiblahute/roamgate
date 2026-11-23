set -eu
path={{path}}
known={{known}}
identity="$(stat -c '%d:%i' "$path" 2>/dev/null || stat -f '%d:%i' "$path")"
matches=false
if [ -n "$known" ] && [ "$identity" = "$known" ]; then
  sum=""
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(head -c {{known_bytes}} "$path" | sha256sum)"
  elif command -v shasum >/dev/null 2>&1; then
    sum="$(head -c {{known_bytes}} "$path" | shasum -a 256)"
  fi
  if [ "${sum%% *}" = {{known_sha256}} ]; then matches=true; fi
fi
if [ "$matches" = true ]; then
  printf '%s	tail
' "$identity"
  tail -c +{{tail_from}} "$path"
else
  printf '%s	full
' "$identity"
  cat "$path"
fi