
path={{path}}
git_bin=$(command -v git 2>/dev/null || true)
if [ -z "$git_bin" ] && [ -x /usr/bin/git ]; then git_bin=/usr/bin/git; fi
if [ ! -e "$path" ]; then
  printf missing
elif [ -z "$git_bin" ]; then
  printf unknown
elif ! path_root=$(cd "$path" 2>/dev/null && pwd -P); then
  printf residual
elif ! git_root=$("$git_bin" -C "$path" rev-parse --show-toplevel 2>/dev/null); then
  printf residual
elif ! git_root=$(cd "$git_root" 2>/dev/null && pwd -P); then
  printf residual
elif [ "$path_root" != "$git_root" ]; then
  printf residual
else
  status_output=$("$git_bin" -C "$path" status --porcelain --untracked-files=all 2>/dev/null) || { printf unknown; exit 0; }
  if [ -n "$status_output" ]; then printf dirty; else printf clean; fi
fi
