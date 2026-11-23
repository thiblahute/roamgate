
set -eu
cd -- {{root}}
f={{file}}
if [ -d "$f" ] && [ ! -L "$f" ]; then
  echo "delete_untracked supports files only; recursive directory deletion is not supported" >&2
  exit 15
fi
git -c core.quotepath=false clean -f -- {{path}}
