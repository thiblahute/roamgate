cd -- "$1" || exit 126
login="${3:-${SHELL:-/bin/sh}}"
exec 3>&2 2>/dev/null
# Its own process group where the shell has job control (no tty: dash and
# ash say so on the stderr silenced above, and keep one group).
set -m
# The watcher reads the real stdin: without job control a background
# command's stdin would be /dev/null.
exec 4<&0
"$login" -l -c "$2" </dev/null 2>&3 3>&- 4<&- &
job=$!
( cat <&4 >/dev/null; kill -TERM -"$job" || kill -TERM "$job" ) 2>/dev/null 4<&4 &
watch=$!
exec 4<&-
wait "$job"
code=$?
kill "$watch" 2>/dev/null
exit "$code"