
find "$(dirname "$f")" -maxdepth 1 -name '*.jsonl' -newer "$f" -exec grep -l -E -- '"sessionId"[[:space:]]*:[[:space:]]*"'"$id"'"' {} + 2>/dev/null | {
  best=""
  best_mtime=0
  while IFS= read -r g; do
    m="$(stat -c %Y "$g" 2>/dev/null || stat -f %m "$g")"
    if [ "$m" -gt "$best_mtime" ]; then
      best="$g"
      best_mtime="$m"
    fi
  done
  printf %s "$best"
}
