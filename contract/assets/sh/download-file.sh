
set -euo pipefail
root={{root}}
request={{request}}
root_real="$(cd "$root" && pwd -P)"
case "$request" in
  /*) target="$request"; requested_absolute=1 ;;
  *) target="$root_real/$request"; requested_absolute=0 ;;
esac
target_real="$(realpath "$target")"
if [ "$requested_absolute" != "1" ]; then
  case "$target_real/" in "$root_real"/*) ;; *) exit 13 ;; esac
fi
if [ ! -f "$target_real" ] && [ ! -d "$target_real" ]; then
  echo "only regular files and directories can be downloaded" >&2
  exit 14
fi
if [ "$requested_absolute" = "1" ]; then
  rel="$target_real"
else
  rel="${target_real#"$root_real"/}"
fi
name="${target_real##*/}"
{{#checked}}[ -f "$target_real" ] || { echo "file changed during download" >&2; exit 16; }{{/checked}}
if [ -d "$target_real" ]; then
  parent="$(dirname "$target_real")"
  archive_name="$name.tar.gz"
  content_type="application/gzip"
  printf 'META\t%s\t%s\t%s\t%s\n' "0" "$(printf '%s' "$rel" | base64 | tr -d '\n')" "$(printf '%s' "$archive_name" | base64 | tr -d '\n')" "$(printf '%s' "$content_type" | base64 | tr -d '\n')"
  {{#metadata_only}}exit 0{{/metadata_only}}
  COPYFILE_DISABLE=1 tar -czf - -C "$parent" -- "$name" | base64 | tr -d '\n'
else
  size="$(stat -c %s "$target_real" 2>/dev/null || stat -f %z "$target_real")"
  {{#inline}}case "$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')" in
    {{audio_patterns}})
      [ "$size" -le {{audio_max_bytes}} ] || exit 15 ;;
  esac{{/inline}}
  {{#capped}}[ "$size" -le {{max_bytes}} ] || { printf '%s' "$size" >&2; exit 17; }{{/capped}}
  {{#slice}}[ "$size" -eq {{slice_size}} ] || { echo "file changed during download" >&2; exit 16; }{{/slice}}
  {{#stream}}[ "$size" -eq {{stream_size}} ] || { echo "file changed during download" >&2; exit 16; }
  exec cat -- "$target_real"{{/stream}}
  content_type="application/octet-stream"
  printf 'META\t%s\t%s\t%s\t%s\n' "$size" "$(printf '%s' "$rel" | base64 | tr -d '\n')" "$(printf '%s' "$name" | base64 | tr -d '\n')" "$(printf '%s' "$content_type" | base64 | tr -d '\n')"
  {{#metadata_only}}exit 0{{/metadata_only}}
  {{#slice}}dd if="$target_real" bs={{block_size}} skip={{skip_blocks}} count={{count_blocks}} 2>/dev/null | base64{{/slice}}{{^slice}}base64 < "$target_real"{{/slice}} | tr -d '\n'
fi
printf '\n'
