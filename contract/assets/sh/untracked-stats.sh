
set -- {{paths}}
cd -- {{root}}
for p in "$@"; do
  f="./$p"
  [ -f "$f" ] || continue
  values="$( (stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f" 2>/dev/null) )"
  [ -n "$values" ] || continue
  printf '%s	%s	%s
' "$(printf '%s' "$p" | base64 | tr -d '
')" "${values%% *}" "${values##* }"
done
