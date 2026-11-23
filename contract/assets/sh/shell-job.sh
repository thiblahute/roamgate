set -m
cd -- "$1" || exit 126
login="${3:-${SHELL:-/bin/sh}}"
exec 3>&2 2>/dev/null
"$login" -l -c "$2" </dev/null 2>&3 3>&- &
job=$!
( cat >/dev/null; kill -TERM -"$job" || kill -TERM "$job" ) 2>/dev/null &
watch=$!
wait "$job"
code=$?
kill "$watch" 2>/dev/null
exit "$code"