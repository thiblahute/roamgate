set -u
d={{dir}}
rel={{rel}}
home="${HOME:-}"; home="${home%/}"
n=0
while [ "$n" -lt {{max_levels}} ]; do
  d="${d%/*}"
  [ -n "$d" ] || exit 44
  if [ -n "$home" ]; then case "$home/" in "$d"/*) exit 44 ;; esac; fi
  if [ -e "$d/$rel" ]; then printf '%s\n' "$d"; exit 0; fi
  n=$((n+1))
done
exit 44
