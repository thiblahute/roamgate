import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_MR_MERGE_RULES,
  MR_MERGE_RULE_KEYS,
  type MrMergeRuleKey,
  type MrMergeRules,
  type MrMergeSettings,
  mrMergeScope,
} from "../../../shared/mrReviewsMerge";

const LISTS: Record<MrMergeRuleKey, { title: string; hint: string }> = {
  afterLabels: {
    title: "Labels that schedule a merge",
    hint: 'Regular expressions on a label; the delay is the "delay" group ("Merge after: 2 days", "merge-after: 1 week", "merge after 3d").',
  },
  bots: {
    title: "Merge bots",
    hint: "User names; a request assigned to one, or with one as a reviewer, is queued to merge.",
  },
  botFailures: {
    title: "A bot's note saying it failed",
    hint: 'Regular expressions on the bot\'s latest note; the reason shown is the "reason" group.',
  },
  queueLabels: {
    title: "Labels saying it is queued for a bot",
    hint: "Regular expressions on a label.",
  },
};

/** The lists a scope inherits: the defaults, the user's, then wider scopes. */
function inherited(merge: MrMergeSettings, scope: string | null): MrMergeRules {
  const rules: MrMergeRules = { ...DEFAULT_MR_MERGE_RULES };
  for (const key of MR_MERGE_RULE_KEYS)
    if (scope !== null && merge[key]) rules[key] = merge[key]!;
  if (!scope) return rules;
  // A project inherits its host's scope and any group scope above it.
  const wider = Object.keys(merge.scopes)
    .filter((other) => {
      if (other === scope) return false;
      if (!other.includes("/")) return scope.startsWith(`${other}/`);
      return other.endsWith("/*") && scope.startsWith(other.slice(0, -1));
    })
    .sort((a, b) => a.length - b.length);
  for (const other of wider)
    for (const key of MR_MERGE_RULE_KEYS)
      if (merge.scopes[other]?.[key]) rules[key] = merge.scopes[other]![key]!;
  return rules;
}

/**
 * Scheduled merges and merge bots (section 15): the four lists for every
 * host, and scopes (a host, `host/group/*`, `host/project`) replacing them.
 * A list left empty inherits; "Off here" turns that detection off.
 */
export function MrMergeSettingsSection({
  merge,
  busy,
  onSave,
}: {
  merge: MrMergeSettings;
  busy: boolean;
  onSave: (merge: MrMergeSettings) => void;
}) {
  const [scope, setScope] = useState<string | null>(null);
  const [newScope, setNewScope] = useState("");
  // Added, nothing set in them yet: shown, not saved until a list is set.
  const [added, setAdded] = useState<string[]>([]);
  const scopes = [...new Set([...Object.keys(merge.scopes), ...added])].sort();
  const current: Partial<MrMergeRules> =
    scope === null ? merge : (merge.scopes[scope] ?? {});
  const parent = inherited(merge, scope);

  const setList = (key: MrMergeRuleKey, list: string[] | undefined) => {
    const lists = { ...current } as Partial<MrMergeRules>;
    if (list === undefined) delete lists[key];
    else lists[key] = list;
    if (scope === null) {
      const next: MrMergeSettings = { scopes: merge.scopes };
      for (const each of MR_MERGE_RULE_KEYS)
        if (lists[each]) next[each] = lists[each];
      onSave(next);
    } else
      onSave({
        ...merge,
        scopes: { ...merge.scopes, [scope]: pick(lists) },
      });
  };

  const addScope = () => {
    const key = mrMergeScope(newScope);
    if (!key) return;
    // Kept once a list is set in it; until then it inherits everything.
    setAdded((list) => (list.includes(key) ? list : [...list, key]));
    setScope(key);
    setNewScope("");
  };

  return (
    <section className="assistant-task-overview mr-merge-settings">
      <h3 className="mr-reviews-section-title">
        Scheduled merges and merge bots
      </h3>
      <p className="assistant-hint">
        Mine shows when a request becomes mergeable after a merge-after label,
        and which bot is merging it (lane Merging), or why its attempt failed.
        Read only: nothing is ever assigned or posted.
      </p>
      <div className="mr-merge-scopes" role="tablist" aria-label="Scope">
        <button
          type="button"
          role="tab"
          aria-selected={scope === null}
          className={scope === null ? "is-active" : "ghost"}
          onClick={() => setScope(null)}
        >
          Every host
        </button>
        {scopes.map((each) => (
          <span key={each} className="mr-merge-scope">
            <button
              type="button"
              role="tab"
              aria-selected={scope === each}
              className={scope === each ? "is-active" : "ghost"}
              onClick={() => setScope(each)}
            >
              {each}
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={`Remove the scope ${each}`}
              disabled={busy}
              onClick={() => {
                setAdded((list) => list.filter((other) => other !== each));
                if (merge.scopes[each]) {
                  const rest = { ...merge.scopes };
                  delete rest[each];
                  onSave({ ...merge, scopes: rest });
                }
                if (scope === each) setScope(null);
              }}
            >
              <Trash2 size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="mr-reviews-settings-add">
        <input
          aria-label="Host, group or project"
          placeholder="gitlab.example.org/group/*"
          value={newScope}
          onChange={(event) => setNewScope(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addScope();
          }}
        />
        <button
          type="button"
          className="ghost"
          disabled={busy || !mrMergeScope(newScope)}
          onClick={addScope}
        >
          <Plus size={13} /> Add a scope
        </button>
      </div>
      {MR_MERGE_RULE_KEYS.map((key) => {
        const own = current[key];
        const state =
          own === undefined
            ? "inherited"
            : own.length
              ? "set here"
              : "off here";
        return (
          <label
            key={`${scope ?? ""}\n${key}\n${JSON.stringify(own ?? null)}`}
            className="form-field"
          >
            <span>
              {LISTS[key].title} <small>({state})</small>
            </span>
            <textarea
              rows={Math.min(6, Math.max(2, (own ?? parent[key]).length))}
              defaultValue={own?.join("\n") ?? ""}
              placeholder={parent[key].join("\n")}
              disabled={busy}
              spellCheck={false}
              aria-label={LISTS[key].title}
              onBlur={(event) => {
                const lines = event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean);
                const next = lines.length ? lines : undefined;
                if (JSON.stringify(next) !== JSON.stringify(own))
                  setList(key, next);
              }}
            />
            <small className="assistant-hint">
              {LISTS[key].hint}{" "}
              {own === undefined || own.length ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setList(key, [])}
                >
                  Off here
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setList(key, undefined)}
                >
                  Inherit
                </button>
              )}
            </small>
          </label>
        );
      })}
    </section>
  );
}

function pick(lists: Partial<MrMergeRules>): Partial<MrMergeRules> {
  const out: Partial<MrMergeRules> = {};
  for (const key of MR_MERGE_RULE_KEYS) if (lists[key]) out[key] = lists[key];
  return out;
}
