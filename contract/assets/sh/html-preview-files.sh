
set -euo pipefail
root_real="$(cd {{root}} && pwd -P)"
request={{path}}
case "$request" in /*) target="$request" ;; *) target="$root_real/$request" ;; esac
target_real="$(realpath "$target")"
case "$target_real" in "$root_real"/*) ;; *) echo "HTML preview path is outside the workspace" >&2; exit 13 ;; esac
[ -f "$target_real" ] || { echo "HTML preview requires a regular file" >&2; exit 14; }
size="$(stat -c %s "$target_real" 2>/dev/null || stat -f %z "$target_real")"
[ "$size" -le {{limit}} ] || exit 15
rel="${target_real#"$root_real"/}"
printf '%s\n' "$(printf '%s' "$rel" | base64 | tr -d '\n')"
head -c {{limit_after}} "$target_real" | base64 | tr -d '\n'
