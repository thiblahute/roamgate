
set -- {{paths}}
for p in "$@"; do
  git -C {{root}} -c core.quotepath=false diff --no-ext-diff --no-index --numstat -- /dev/null "$p"
done
# The loop's status is only its last file's; keep the batch's other counts.
exit 0
