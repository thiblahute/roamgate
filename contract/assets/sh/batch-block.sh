printf '\n%s B {{index}}\n' "$batch_marker"
(
{{script}}
) 2>"$batch_err"
batch_code=$?
printf '\n%s E {{index}} %s\n' "$batch_marker" "$batch_code"
head -c 2000 "$batch_err"