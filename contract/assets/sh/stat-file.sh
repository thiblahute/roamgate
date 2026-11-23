
set -eu
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
type=file
if [ -d "$target_real" ]; then type=directory; fi
size="$(stat -c %s "$target_real" 2>/dev/null || stat -f %z "$target_real" 2>/dev/null || printf 0)"
mtime="$(stat -c %Y "$target_real" 2>/dev/null || stat -f %m "$target_real" 2>/dev/null || printf 0)"
printf 'STAT\t%s\t%s\t%s\n' "$size" "$mtime" "$type"
