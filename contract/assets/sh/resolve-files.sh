
set -eu
root={{root}}
root_real="$(cd "$root" && pwd -P)"
root_prefix="${root_real%/}/"
requests=({{requests}})
for request in "${requests[@]}"; do
  case "$request" in
    /*) target="$request"; requested_absolute=1 ;;
    *) target="$root_real/$request"; requested_absolute=0 ;;
  esac
  target_real="$(realpath "$target" 2>/dev/null)" || continue
  if [ "$requested_absolute" != "1" ]; then
    case "$target_real/" in "$root_prefix"*) ;; *) continue ;; esac
  fi
  [ -f "$target_real" ] || [ -d "$target_real" ] || continue
  printf 'FILE\t%s\n' "$(printf '%s' "$request" | base64 | tr -d '\n')"
done
