p={{path}}
printf '{{marker}} begin {{index}}\n'
if top=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null); then
  printf 'top %s\n' "$top"
  printf 'common %s\n' "$(git -C "$p" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  printf 'gitdir %s\n' "$(git -C "$p" rev-parse --path-format=absolute --git-dir 2>/dev/null)"
  b=$(git -C "$p" symbolic-ref --short -q HEAD 2>/dev/null)
  printf 'branch %s\n' "$b"
  r=""
  [ -n "$b" ] && r=$(git -C "$p" config --get "branch.$b.remote" 2>/dev/null)
  [ -z "$r" ] || [ "$r" = "." ] && r=origin
  u=$(git -C "$p" remote get-url "$r" 2>/dev/null || git -C "$p" remote get-url "$(git -C "$p" remote 2>/dev/null | head -n 1)" 2>/dev/null)
  printf 'remote %s\n' "$u"
fi
printf '{{marker}} end {{index}}\n'