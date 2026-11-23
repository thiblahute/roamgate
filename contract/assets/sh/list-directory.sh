
set -eu
path={{path}}
case "$path" in '~'|'~/'*) path="$HOME${path#\~}" ;; esac
error_text=''
if [ -d "$path" ]; then
  if [ -x "$path" ]; then path="$(cd -- "$path" && pwd -P)"; else error_text='Directory is not accessible.'; fi
elif [ -e "$path" ]; then error_text='Path is not a directory.'
else error_text='Directory does not exist.'; fi
emit() { printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | base64 | tr -d '\n')"; }
emit PATH "$path"
emit ERROR "$error_text"
if [ {{suggestions}} = 1 ]; then
  directory="$path"
  prefix=''
  if [ -n "$error_text" ]; then directory="$(dirname -- "$path")"; prefix="$(basename -- "$path")"; fi
  count=0
  for child in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    [ -d "$child" ] || continue
    name="${child##*/}"
    case "$name" in "$prefix"*) ;; *) continue ;; esac
    case "$name" in .*) case "$prefix" in .*) ;; *) continue ;; esac ;; esac
    [[ "$name" =~ [[:cntrl:]] ]] && continue
    emit DIRECTORY "$child"
    count=$((count + 1))
    [ "$count" -lt {{limit}} ] || break
  done
fi
