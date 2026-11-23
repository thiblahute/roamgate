
set -eu
git -C {{root}} for-each-ref --format='%(refname)%09%(symref)%09%(objectname)' refs/heads/ refs/remotes/
printf '\n--diff-base-config--\n'
git -C {{root}} config --get init.defaultBranch || test "$?" = 1
