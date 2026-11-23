
cd {{root}} || exit 2
l={{local}}; r={{remote}}
flag() { if "$@" >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi; }
flag test "$(git symbolic-ref -q HEAD)" = "$l"
flag git merge-base --is-ancestor "$r" "$l"
flag git merge-base --is-ancestor "$l" "$r"
ml=$(git merge-base HEAD "$l" 2>/dev/null || true)
mr=$(git merge-base HEAD "$r" 2>/dev/null || true)
if [ -n "$ml" ]; then git log -1 --format=%ct "$ml"; else printf '0\n'; fi
if [ -n "$mr" ]; then git log -1 --format=%ct "$mr"; else printf '0\n'; fi
if [ -n "$ml" ] && [ -n "$mr" ]; then
  flag git merge-base --is-ancestor "$ml" "$mr"
  flag git merge-base --is-ancestor "$mr" "$ml"
else printf '0\n0\n'; fi
