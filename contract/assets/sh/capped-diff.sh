
patch_file=$(mktemp "${TMPDIR:-/tmp}/roamgate-diff.XXXXXX") || exit 1
trap 'rm -f "$patch_file"' 0
trap 'exit 1' HUP INT TERM
git -C {{root}} -c core.quotepath=false {{command}} >"$patch_file"
git_code=$?
case "$git_code" in 0|1) ;; *) exit "$git_code" ;; esac
patch_size=$(wc -c <"$patch_file")
printf '%s
' "$patch_size"
if [ {{automatic}} -eq 0 ] || [ "$patch_size" -lt {{large_patch_bytes}} ]; then
  head -c {{head_bytes}} "$patch_file"
fi
exit "$git_code"
