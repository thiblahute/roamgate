cd -- "$1" || exit 126
login="${3:-${SHELL:-/bin/sh}}"
exec 3>&2 2>/dev/null
# The job runs in its own process group, so Stop ends all of it: through
# job control where the shell has it, else (dash and ash without a
# terminal, whose notice the stderr silenced above keeps out) setsid.
set -m
case $- in *m*) group= ;; *) group=$(command -v setsid) ;; esac
# The watcher reads the real stdin: without job control a background
# command's stdin would be /dev/null.
exec 4<&0
$group "$login" -l -c "$2" </dev/null 2>&3 3>&- 4<&- &
job=$!
( cat <&4 >/dev/null; kill -TERM -"$job" || kill -TERM "$job" ) 2>/dev/null 4<&4 &
watch=$!
exec 4<&-
wait "$job"
code=$?
kill "$watch" 2>/dev/null
exit "$code"