{{cleanup}}
directory=$(mktemp -d "$root/upload-XXXXXXXX")
trap 'rm -rf -- "$directory"' EXIT
path="$directory/"{{name}}
cat > "$path"
chmod 600 "$path"
printf '%s' "$path"
trap - EXIT