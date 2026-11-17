import { forgeRefLabel } from "./forge";
import type { MrInboxEntry, MrLane } from "./mrReviews";
import { mrWhoseLabel } from "./mrReviews";

/**
 * The Reviews search, as GitLab's: `key:value` tokens (any negated with a
 * leading `-`; several values of one key: any of them) and free words (each
 * in the request's words). Shared by the panel, its saved views and the
 * board's tools, so a view means the same everywhere.
 */

export const MR_FILTER_KEYS = [
  "project",
  "label",
  "waiting",
  "lane",
  "state",
  "stale",
  "draft",
  "author",
  "pipeline",
  "effort",
  "merge-after",
  "bot",
  "is",
] as const;
export type MrFilterKey = (typeof MR_FILTER_KEYS)[number];

export type MrFilterToken = { key: MrFilterKey; value: string; not: boolean };

export type MrFilter = {
  tokens: MrFilterToken[];
  /** Free words; a negated word (`-word`) is one the request must not hold. */
  words: { text: string; not: boolean }[];
};

const LANE_NAMES: Record<string, MrLane> = {
  "your-move": "your_move",
  your_move: "your_move",
  mine: "your_move",
  waiting: "waiting",
  blocked: "blocked",
  "not-sent": "not_sent",
  not_sent: "not_sent",
  unsent: "not_sent",
  stale: "stale",
  merging: "merging",
  done: "done",
};

/** Splits on blanks, keeping a quoted value whole (`label:"needs work"`). */
function split(text: string): string[] {
  const out: string[] = [];
  const pattern = /(-?[\w]+:"[^"]*"?)|(-?"[^"]*"?)|(\S+)/g;
  for (const match of text.matchAll(pattern)) out.push(match[0]);
  return out;
}

function unquote(value: string): string {
  return value.replace(/^"/, "").replace(/"$/, "");
}

/** The search text read as tokens and words; unknown keys stay words. */
export function parseMrFilter(text: string): MrFilter {
  const filter: MrFilter = { tokens: [], words: [] };
  for (const part of split(text.trim())) {
    const not = part.startsWith("-") && part.length > 1;
    const body = not ? part.slice(1) : part;
    const colon = body.indexOf(":");
    const key = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
    if (colon > 0 && (MR_FILTER_KEYS as readonly string[]).includes(key)) {
      const value = unquote(body.slice(colon + 1)).trim();
      if (value) filter.tokens.push({ key: key as MrFilterKey, value, not });
      continue;
    }
    const word = unquote(body).toLowerCase();
    if (word) filter.words.push({ text: word, not });
  }
  return filter;
}

/** The words a request is found by: title, project, author, number, branches. */
export function mrSearchText(entry: MrInboxEntry): string {
  return [
    entry.title,
    entry.project,
    entry.host,
    entry.author,
    forgeRefLabel(entry),
    forgeRefLabel(entry, true),
    entry.sourceBranch,
    entry.targetBranch,
    entry.state,
    entry.draft ? "draft" : "",
    entry.reason ?? "",
    entry.next?.text ?? "",
    ...(entry.labels ?? []),
    ...(entry.override?.labels ?? []),
    ...entry.reasons.map((reason) => reason.replace(/_/g, " ")),
  ]
    .join("\n")
    .toLowerCase();
}

/**
 * `group/*` (or `group/`) and `*` match as globs; anything else as a whole
 * value.
 */
function like(pattern: string, value: string): boolean {
  // "group/" is all of the group, as it is typed.
  const p = pattern.toLowerCase().replace(/\/$/, "/*");
  const v = value.toLowerCase();
  if (!p.includes("*")) return v === p;
  const regex = new RegExp(
    `^${p
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
      .join(".*")}$`,
  );
  return regex.test(v);
}

/** The request's state as `state:` reads it. */
function stateOf(entry: MrInboxEntry): string {
  if (entry.key.startsWith("branch:"))
    return entry.unsent ? "unsent" : "branch";
  return entry.state;
}

/** Whether one token holds for a request (before its negation). */
function holds(entry: MrInboxEntry, token: MrFilterToken): boolean {
  const value = token.value.toLowerCase();
  switch (token.key) {
    case "project":
      return like(token.value, entry.project);
    case "label":
      return [...(entry.labels ?? []), ...(entry.override?.labels ?? [])].some(
        (label) => like(token.value, label),
      );
    case "waiting": {
      const whose = entry.override?.whose;
      if (whose && !entry.overrideOutdated)
        return like(token.value, mrWhoseLabel(whose));
      if (value === "me") return entry.lane === "your_move";
      if (value === "time")
        return (
          entry.lane === "waiting" &&
          !!entry.merge?.after &&
          !entry.merge.after.ready
        );
      if (value === "reviewer")
        return (
          entry.lane === "waiting" &&
          !(entry.merge?.after && !entry.merge.after.ready)
        );
      // A bot (or the forge's queue) merging it.
      const bot = entry.merge?.bot;
      return (
        entry.lane === "merging" &&
        !!bot &&
        (value === "bot" || like(token.value, bot.name))
      );
    }
    case "lane":
      return !!entry.lane && LANE_NAMES[value] === entry.lane;
    case "state":
      if (value === "merging")
        return entry.lane === "merging" || !!entry.merge?.bot?.queued;
      return value === "draft"
        ? entry.draft && entry.state === "open"
        : stateOf(entry) === value;
    case "merge-after": {
      const after = entry.merge?.after;
      if (value === "no" || value === "none") return !after;
      if (!after) return false;
      if (value === "ready" || value === "now") return after.ready;
      if (value === "waiting" || value === "later") return !after.ready;
      return (
        value === "yes" || value === "any" || like(token.value, after.delay)
      );
    }
    case "bot": {
      const bot = entry.merge?.bot;
      if (!bot) return value === "none";
      if (value === "any" || value === "yes") return true;
      if (value === "failed") return !!bot.failed;
      if (value === "queued") return bot.queued;
      return like(token.value, bot.name);
    }
    case "stale":
      return (entry.lane === "stale") === (value === "yes" || value === "true");
    case "draft":
      return entry.draft === (value === "yes" || value === "true");
    case "author":
      return like(token.value, entry.author);
    case "pipeline":
      return (entry.pipeline ?? "none") === value;
    case "effort":
      return !!entry.effort && like(token.value, entry.effort);
    case "is":
      if (value === "mine" || value === "own")
        return entry.reasons.includes("authored");
      if (value === "review")
        return (
          entry.section !== "suggested" && !entry.reasons.includes("authored")
        );
      if (value === "pinned") return entry.section === "pinned";
      if (value === "suggested") return entry.section === "suggested";
      if (value === "unread") return entry.isNew || !!entry.unread?.changed;
      return false;
  }
}

/**
 * Whether a request matches: every key holds (several values of one key:
 * any of them; a negated one: none of them), and every word is among its
 * words (a negated word: not).
 */
export function mrFilterMatches(
  entry: MrInboxEntry,
  filter: MrFilter | string,
): boolean {
  const parsed = typeof filter === "string" ? parseMrFilter(filter) : filter;
  const byKey = new Map<MrFilterKey, MrFilterToken[]>();
  for (const token of parsed.tokens)
    if (!token.not)
      byKey.set(token.key, [...(byKey.get(token.key) ?? []), token]);
  for (const tokens of byKey.values())
    if (!tokens.some((token) => holds(entry, token))) return false;
  for (const token of parsed.tokens)
    if (token.not && holds(entry, token)) return false;
  if (!parsed.words.length) return true;
  const text = mrSearchText(entry);
  return parsed.words.every((word) => text.includes(word.text) !== word.not);
}

/** Whether a filter keeps only one's own work (lanes then apply). */
export function mrFilterIsOwn(filter: MrFilter | string): boolean {
  const parsed = typeof filter === "string" ? parseMrFilter(filter) : filter;
  return parsed.tokens.some(
    (token) =>
      !token.not &&
      ((token.key === "is" &&
        (token.value === "mine" || token.value === "own")) ||
        token.key === "lane" ||
        token.key === "waiting" ||
        token.key === "effort" ||
        token.key === "merge-after" ||
        token.key === "bot" ||
        (token.key === "state" && token.value === "merging")),
  );
}

const VALUES: Partial<Record<MrFilterKey, string[]>> = {
  waiting: ["me", "reviewer", "external", "time", "bot"],
  lane: [
    "your-move",
    "waiting",
    "merging",
    "blocked",
    "not-sent",
    "stale",
    "done",
  ],
  state: ["open", "draft", "merging", "merged", "closed", "branch", "unsent"],
  "merge-after": ["yes", "no", "waiting", "ready"],
  bot: ["any", "queued", "failed", "none"],
  stale: ["yes", "no"],
  draft: ["yes", "no"],
  pipeline: ["failed", "running", "pending", "success", "manual", "none"],
  is: ["mine", "review", "pinned", "suggested", "unread"],
};

/**
 * What completes the search's last word: keys first, then once a key is
 * typed its values, from the requests shown (projects, labels, people,
 * efforts) and the fixed ones.
 */
export function mrFilterCompletions(
  text: string,
  entries: MrInboxEntry[],
): { label: string; insert: string }[] {
  const at = text.search(/\S*$/);
  const word = text.slice(at);
  const not = word.startsWith("-") ? "-" : "";
  const body = word.slice(not.length);
  const colon = body.indexOf(":");
  if (colon < 0) {
    const lower = body.toLowerCase();
    return MR_FILTER_KEYS.filter((key) => key.startsWith(lower)).map((key) => ({
      label: `${not}${key}:`,
      insert: `${text.slice(0, at)}${not}${key}:`,
    }));
  }
  const key = body.slice(0, colon).toLowerCase() as MrFilterKey;
  if (!(MR_FILTER_KEYS as readonly string[]).includes(key)) return [];
  const typed = unquote(body.slice(colon + 1)).toLowerCase();
  const found = new Set<string>(VALUES[key] ?? []);
  for (const entry of entries) {
    if (key === "project") {
      found.add(entry.project);
      const group = entry.project.split("/").slice(0, -1).join("/");
      if (group) found.add(`${group}/*`);
    } else if (key === "label")
      for (const label of [
        ...(entry.labels ?? []),
        ...(entry.override?.labels ?? []),
      ])
        found.add(label);
    else if (key === "author") found.add(entry.author);
    else if (key === "waiting" && entry.override?.whose)
      found.add(mrWhoseLabel(entry.override.whose));
    else if (key === "effort" && entry.effort) found.add(entry.effort);
    else if ((key === "bot" || key === "waiting") && entry.merge?.bot)
      found.add(entry.merge.bot.name);
  }
  return [...found]
    .filter((value) => value && value.toLowerCase().startsWith(typed))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 30)
    .map((value) => {
      const quoted = /\s/.test(value) ? `"${value}"` : value;
      return {
        label: `${not}${key}:${quoted}`,
        insert: `${text.slice(0, at)}${not}${key}:${quoted} `,
      };
    });
}
