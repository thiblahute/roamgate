
if [ -d /proc ]; then
  for link in /proc/[0-9]*/cwd; do
    cwd=$(readlink "$link" 2>/dev/null) || continue
    pid=${link#/proc/}
    pid=${pid%/cwd}
    printf 'p%s\nn%s\n' "$pid" "$cwd"
  done
elif command -v lsof >/dev/null 2>&1; then
  lsof -a -d cwd -Fp -Fn 2>/dev/null || true
else
  exit 127
fi
