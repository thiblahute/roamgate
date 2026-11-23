
set -euo pipefail
# Keep trailing newlines in directory names through command substitution.
root_real="$(cd -P -- {{root}} && printf '%s.' "$PWD")"
root_real="${root_real%.}"
directory_real="$(cd -P -- "$root_real"/{{directory}} && printf '%s.' "$PWD")"
directory_real="${directory_real%.}"
case "$directory_real/" in "${root_real%/}/"*) ;; *) echo "path escaped the workspace checkout" >&2; exit 13 ;; esac
{{^move}}mkdir -- "$directory_real"/{{name}}{{/move}}{{#move}}
source_parent="$(cd -P -- "$root_real"/{{source_directory}} && printf '%s.' "$PWD")"
source_parent="${source_parent%.}"
case "$source_parent/" in "${root_real%/}/"*) ;; *) echo "path escaped the workspace checkout" >&2; exit 13 ;; esac
source="$source_parent"/{{name}}
if [ ! -f "$source" ] && [ ! -L "$source" ]; then echo "Only files can be moved" >&2; exit 14; fi
command -v python3 >/dev/null || { echo "Moving files over SSH requires Python 3" >&2; exit 14; }
python3 -c {{rename}} "$source" "$directory_real"/{{name}}
{{/move}}
