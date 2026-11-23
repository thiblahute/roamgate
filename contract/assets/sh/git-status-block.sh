
p={{path}}
printf '{{marker}}BEGIN {{index}}\n'
git -C "$p" status --porcelain=v1 --branch 2>&1
code=$?
printf '{{marker}}END {{index}} %s\n' "$code"
