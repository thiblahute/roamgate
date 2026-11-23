set -eu
cd {{root}}
p={{prefix}}
git update-ref {{before_ref}} {{baseline}}
git update-ref {{after_ref}} {{current}}
{{#skipped}}blob=$(printf '%s\n' {{skipped_paths}} | git hash-object -w --stdin)
git update-ref {{skipped_ref}} "$blob"{{/skipped}}
git for-each-ref --format='%(refname)' "$p/" | sed -n "s|^$p/\([^/]*\)/.*|\1|p" | sort -u -r | tail -n +{{keep_from}} | while IFS= read -r old; do
  case " {{kept}} " in *" $old "*) continue;; esac
  for end in before after skipped; do git update-ref -d "$p/$old/$end" 2>/dev/null || true; done
done
