while :; do
  for f in "$@"; do
    s=$(stat -c '%s %Y %i' "$f" 2>/dev/null || stat -f '%z %m %i' "$f" 2>/dev/null || echo gone)
    printf '%s\t%s\n' "$f" "$s"
  done
  sleep 1
done