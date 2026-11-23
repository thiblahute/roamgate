batch_marker='{{marker}}'
batch_err=$(mktemp "${TMPDIR:-/tmp}/roamgate-batch.XXXXXX") || exit 1
trap 'rm -f "$batch_err"' 0
trap 'exit 1' HUP INT TERM
{{blocks}}
printf '\n%s Z\n' "$batch_marker"
exit 0
