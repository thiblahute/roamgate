
set -eu
root={{root}}
request={{request}}
text_limit={{text_limit}}
image_limit={{image_limit}}
root_real="$(cd "$root" && pwd -P)"
case "$request" in
  /*) target="$request"; requested_absolute=1 ;;
  *) target="$root_real/$request"; requested_absolute=0 ;;
esac
if [ ! -e "$target" ]; then exit {{missing_exit}}; fi
target_real="$(realpath "$target")"
if [ "$requested_absolute" != "1" ]; then
  case "$target_real/" in "$root_real"/*) ;; *) exit 13 ;; esac
fi
if [ "$requested_absolute" = "1" ]; then
  rel="$target_real"
else
  rel="${target_real#"$root_real"/}"
fi
if [ -d "$target_real" ]; then
  mtime="$(stat -c %Y "$target_real" 2>/dev/null || stat -f %m "$target_real" 2>/dev/null || printf 0)"
  printf 'META\t%s\t%s\t%s\t%s\t%s\n' "$(printf '%s' "$root_real" | base64 | tr -d '\n')" 0 "$mtime" "$(printf '%s' "$rel" | base64 | tr -d '\n')" directory
  exit 0
fi
if [ ! -f "$target_real" ]; then
  echo "only regular files can be previewed" >&2
  exit 14
fi
size="$(stat -c %s "$target_real" 2>/dev/null || stat -f %z "$target_real" 2>/dev/null || printf 0)"
mtime="$(stat -c %Y "$target_real" 2>/dev/null || stat -f %m "$target_real" 2>/dev/null || printf 0)"
limit="$text_limit"
case "$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')" in
  {{image_patterns}})
    if [ "$size" -le "$image_limit" ]; then limit="$image_limit"; fi
    ;;
esac
printf 'META\t%s\t%s\t%s\t%s\t%s\n' "$(printf '%s' "$root_real" | base64 | tr -d '\n')" "$size" "$mtime" "$(printf '%s' "$rel" | base64 | tr -d '\n')" file
head -c $((limit + 1)) "$target_real" | base64 | tr -d '\n'
printf '\n'
