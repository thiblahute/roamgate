
set -eu
{{git}} for-each-ref --format='%(refname)%09%(symref)%09%(objectname)%09%(creatordate:unix)%09%(upstream)' refs/heads/ refs/remotes/
{{git}} for-each-ref --sort=-creatordate --count={{tags_listed}} --format='%(refname)%09%09%(objectname)%09%(creatordate:unix)%09' refs/tags/
printf '\n--diff-base-config--\n'
{{git}} config --get init.defaultBranch || test "$?" = 1
printf '\n--compare-head--\n'
{{git}} symbolic-ref -q HEAD || true
printf '\n--compare-near--\n'
if {{git}} rev-parse -q --verify HEAD >/dev/null; then
  {{git}} log --first-parent -n {{near_history}} --format=%H HEAD
  printf '\n--compare-above--\n'
  {{git}} for-each-ref --contains HEAD --sort=creatordate --count={{near_listed}} --format='%(refname)' refs/heads/
fi
