
cd {{root}} 2>/dev/null || { echo "cannot enter the checkout" >&2; exit 2; }
f={{path}}
patch_file=$(mktemp "${TMPDIR:-/tmp}/roamgate-diff.XXXXXX") || exit 1
trap 'rm -f "$patch_file"' 0
trap 'exit 1' HUP INT TERM
base=$(git rev-parse --verify --quiet HEAD) || base=$(git hash-object -t tree /dev/null)
# A path through a link out of the checkout, or a FIFO or device, is not
# read: git would follow the one and block on the other.
top=$(pwd -P)
if real=$(cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd -P); then
  case "$real/" in "$top"/*) ;; *) echo "the file is outside the checkout" >&2; exit 4;; esac
fi
if [ -e "$f" ] && [ ! -f "$f" ] && [ ! -L "$f" ] && [ ! -d "$f" ]; then
  echo "not a regular file of the checkout" >&2; exit 4
fi
untracked=0
u=$({{git}} ls-files --others --exclude-standard -z -- "$f" | tr -d '\000')
if [ "$u" = "$f" ]; then
  { [ -f "$f" ] || [ -L "$f" ]; } || { echo "not a regular file of the checkout" >&2; exit 4; }
  untracked=1
  {{git}} diff {{diff_options}} --no-index -- /dev/null "$f" >"$patch_file"
else
  {{git}} diff {{diff_options}} --find-renames "$base" -- {{pathspec}} >"$patch_file"
fi
git_code=$?
case "$git_code" in 0|1) ;; *) exit "$git_code" ;; esac
unmerged=0
[ -n "$(git ls-files -u -- {{pathspec}} 2>/dev/null | head -n 1)" ] && unmerged=1
# macOS wc pads its count with spaces: the number alone.
patch_size=$(( $(wc -c <"$patch_file") ))
printf '%s %s %s\n' "$patch_size" "$untracked" "$unmerged"
if [ {{automatic}} -eq 0 ] || [ "$patch_size" -lt {{large_patch_bytes}} ]; then
  head -c {{cap}} "$patch_file"
  if [ "$patch_size" -le {{max_bytes}} ] && [ "$untracked" = 0 ] && [ "$unmerged" = 0 ]; then
    printf '\n{{marker}}\n'
    {{git}} diff {{diff_options}} --cached --find-renames -- {{pathspec}} | head -c {{cap}}
    printf '\n{{marker}}\n'
    {{git}} diff {{diff_options}} -- "$f" | head -c {{cap}}
  fi
fi
exit 0
