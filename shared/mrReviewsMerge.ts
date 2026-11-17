/**
 * Scheduled merges and merge bots (plan section 15, D26): labels that
 * schedule a merge after a delay ("Merge after: 2 days"), and bots or forge
 * queues that merge a request (Marge-bot, bors, Mergify, GitHub's merge
 * queue and auto-merge). Generic: every list is a setting, with defaults
 * for the common conventions, overridable per host, group or project.
 * Pure: the server computes a row's merge state with it, the settings
 * check patterns with it. Read only: nothing here ever acts on a forge.
 */

/** The four lists, in effect for one project. */
export type MrMergeRules = {
  /** Labels that schedule the merge after a delay (regexes, `delay` group). */
  afterLabels: string[];
  /** Merge bots' user names. */
  bots: string[];
  /** A bot's note saying an attempt failed (regexes, `reason` group). */
  botFailures: string[];
  /** Labels saying the request is queued for a bot (regexes). */
  queueLabels: string[];
};

export const MR_MERGE_RULE_KEYS = [
  "afterLabels",
  "bots",
  "botFailures",
  "queueLabels",
] as const;
export type MrMergeRuleKey = (typeof MR_MERGE_RULE_KEYS)[number];

/** settings.json's names of the lists. */
export const MR_MERGE_STORED_KEYS: Record<MrMergeRuleKey, string> = {
  afterLabels: "after_labels",
  bots: "bots",
  botFailures: "bot_failures",
  queueLabels: "queue_labels",
};

/**
 * `mr_reviews.merge`: lists set by the user (absent: the defaults), and
 * scopes ("host", "host/group/*", "host/project") whose lists replace the
 * inherited ones.
 */
export type MrMergeSettings = Partial<MrMergeRules> & {
  scopes: Record<string, Partial<MrMergeRules>>;
};

export const DEFAULT_MR_MERGE_RULES: MrMergeRules = {
  afterLabels: [
    "^merge[-_ ]?after\\b[\\s:=]*(?<delay>.+)$",
    "^merge[-_ ]?in\\b[\\s:=]*(?<delay>.+)$",
  ],
  bots: [
    "marge-bot",
    "marge",
    "bors",
    "bors-ng",
    "mergify",
    "kodiak",
    "kodiakhq",
    "mergebot",
    "merge-bot",
    "github-merge-queue",
  ],
  botFailures: [
    "^I couldn'?t merge this branch:?\\s*(?<reason>.*)",
    "^Sorry,? I can'?t (?<reason>.*)",
    "^(?<reason>I'm broken on the inside.*)",
    "(?<reason>refused to merge.*)",
    "^:?(broken_heart|x):?\\s*(?<reason>(build|tests?) failed.*)",
    "^(?<reason>merge conflict.*)",
    "(?<reason>removed from the (merge )?queue.*)",
  ],
  queueLabels: [
    "^(merge[-_ ]?queue|queued[-_ ]?(for|to)[-_ ]?merge|ready[-_ ]?to[-_ ]?merge[-_ ]?bot)$",
  ],
};

export const EMPTY_MR_MERGE_SETTINGS: MrMergeSettings = { scopes: {} };

export const MAX_MERGE_PATTERNS = 20;
export const MAX_MERGE_PATTERN = 200;
export const MAX_MERGE_SCOPES = 50;

/** A pattern as the settings keep it, or null when it does not compile. */
export function mrMergePattern(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > MAX_MERGE_PATTERN) return null;
  try {
    new RegExp(value, "iu");
    return value;
  } catch {
    return null;
  }
}

/** A bot name as compared: lower case, no `@`, no `[bot]` suffix. */
export function mrBotName(name: string): string {
  return name
    .trim()
    .replace(/^@/, "")
    .replace(/\[bot\]$/i, "")
    .toLowerCase();
}

/** A scope key: "host", "host/group/*" or "host/project", lower case. */
export function mrMergeScope(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const value = text
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!value || value.length > 300) return null;
  return /^[a-z0-9.-]+(:\d+)?(\/[\w.-]+)*(\/\*)?$/.test(value) ? value : null;
}

/** How specific a scope is for a project, or -1 when it does not apply. */
function scopeRank(scope: string, host: string, project: string): number {
  const full = `${host}/${project}`.toLowerCase();
  if (scope === full) return 10_000;
  if (scope.endsWith("/*")) {
    const prefix = scope.slice(0, -1);
    return full.startsWith(prefix) ? prefix.length : -1;
  }
  return scope === host.toLowerCase() ? 1 : -1;
}

/** The lists in effect for a project: defaults, the user's, then scopes. */
export function mrMergeRulesFor(
  settings: MrMergeSettings | undefined,
  ref: { host: string; project: string },
): MrMergeRules {
  const rules: MrMergeRules = { ...DEFAULT_MR_MERGE_RULES };
  if (!settings) return rules;
  for (const key of MR_MERGE_RULE_KEYS)
    if (settings[key]) rules[key] = settings[key]!;
  const scopes = Object.entries(settings.scopes ?? {})
    .map(([scope, lists]) => ({
      lists,
      rank: scopeRank(scope, ref.host, ref.project),
    }))
    .filter((each) => each.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  for (const { lists } of scopes)
    for (const key of MR_MERGE_RULE_KEYS)
      if (lists[key]) rules[key] = lists[key]!;
  return rules;
}

const regexCache = new Map<string, RegExp | null>();

function regex(pattern: string): RegExp | null {
  let found = regexCache.get(pattern);
  if (found === undefined) {
    try {
      found = new RegExp(pattern, "iu");
    } catch {
      found = null;
    }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(pattern, found);
  }
  return found;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function unit(text: string): number | null {
  const value = text.toLowerCase();
  if (/^(m|mins?|minutes?)$/.test(value)) return MINUTE;
  if (/^(h|hrs?|hours?)$/.test(value)) return HOUR;
  if (/^(d|days?)$/.test(value)) return DAY;
  if (/^(w|wks?|weeks?)$/.test(value)) return WEEK;
  return null;
}

/**
 * A delay as labels write it: "2 days", "1 week", "3d", "12h", "one
 * week", "1 week 2 days", "2d12h"; null when it is not one.
 */
export function parseMergeDelay(text: string): number | null {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/[()[\]"':]/g, " ");
  if (!value) return null;
  let total = 0;
  let rest = value;
  const part =
    /^\s*(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*([a-z]+)\s*(?:,|and)?/;
  let matched = 0;
  while (rest.trim()) {
    const match = part.exec(rest);
    if (!match) return null;
    const amount = /^\d/.test(match[1]!) ? Number(match[1]) : WORDS[match[1]!];
    const size = unit(match[2]!);
    if (amount === undefined || !Number.isFinite(amount) || size === null)
      return null;
    total += amount * size;
    matched++;
    rest = rest.slice(match[0].length);
  }
  return matched && total > 0 && total <= 365 * DAY ? Math.round(total) : null;
}

/** A delay as the row says it: "2 days", "1 week", "36 hours". */
export function formatMergeDelay(ms: number): string {
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  if (ms % WEEK === 0) return plural(ms / WEEK, "week");
  if (ms % DAY === 0) return plural(ms / DAY, "day");
  if (ms % HOUR === 0) return plural(ms / HOUR, "hour");
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    const hours = Math.round((ms % DAY) / HOUR);
    return `${plural(days, "day")} ${plural(hours, "hour")}`;
  }
  return plural(Math.max(1, Math.round(ms / MINUTE)), "minute");
}

/** The first label scheduling a merge, and its delay. */
export function mergeAfterLabel(
  labels: readonly string[] | undefined,
  patterns: readonly string[],
): { label: string; delayMs: number } | null {
  for (const label of labels ?? [])
    for (const pattern of patterns) {
      const match = regex(pattern)?.exec(label.trim());
      if (!match) continue;
      const text =
        match.groups?.delay ??
        match[1] ??
        label.trim().slice(match.index + match[0].length);
      const delayMs = text ? parseMergeDelay(text) : null;
      if (delayMs) return { label, delayMs };
    }
  return null;
}

/** Whether a label says the request is queued for a merge bot. */
export function queueLabel(
  labels: readonly string[] | undefined,
  patterns: readonly string[],
): string | null {
  for (const label of labels ?? [])
    if (patterns.some((pattern) => regex(pattern)?.test(label.trim())))
      return label;
  return null;
}

/** A bot's note read as a failed attempt: its reason, or null. */
export function botFailureReason(
  body: string,
  patterns: readonly string[],
): string | null {
  const text = body.replace(/\s+/g, " ").trim();
  for (const pattern of patterns) {
    const match = regex(pattern)?.exec(text);
    if (!match) continue;
    const reason = (match.groups?.reason ?? text).trim() || text;
    return reason.slice(0, 200);
  }
  return null;
}

/**
 * What happened on a request that tells about merging, as the details
 * read it (GitLab system notes, GitHub timeline events), oldest first.
 */
export type MrMergeEvent = {
  kind:
    | "labeled"
    | "assigned"
    | "unassigned"
    | "review_requested"
    | "review_removed"
    | "approved"
    | "queued"
    | "dequeued"
    | "auto_merge_on"
    | "auto_merge_off";
  at: string;
  /** Who did it. */
  actor?: string;
  /** Whom it is about (assigned / unassigned...), or the label. */
  who?: string[];
  label?: string;
  /** Why (a queue removal, an aborted automatic merge). */
  reason?: string;
};

/** What a request's details say about merging (state.json, derived). */
export type MrMergeFacts = {
  assignees: string[];
  reviewers: string[];
  /** Auto-merge (merge when the pipeline succeeds) is set: by whom. */
  autoMerge?: { by?: string; at?: string };
  /** In the forge's merge queue (GitHub): its position, when said. */
  queue?: { position?: number; at?: string };
  /** The latest approval's time, when the forge says. */
  approvedAt?: string;
  events: MrMergeEvent[];
  /** When each label was last added (by label, as written). */
  labelsAddedAt?: Record<string, string>;
};

/** The merge state of a row, as the board shows it. */
export type MrMergeInfo = {
  after?: {
    label: string;
    delayMs: number;
    /** "2 days". */
    delay: string;
    /** What the delay counts from. */
    from: "label" | "approval" | "update";
    since: string;
    /** When it becomes mergeable. */
    at: string;
    ready: boolean;
  };
  bot?: {
    /** The bot's name, or the forge's queue ("merge queue", "auto-merge"). */
    name: string;
    via: "assignee" | "reviewer" | "label" | "queue" | "auto_merge";
    queued: boolean;
    position?: number;
    /** Who set auto-merge. */
    by?: string;
    failed?: { reason: string; at: string };
  };
};

/** A note as the merge state reads it. */
export type MrMergeNote = { author: string; at: string; body: string };

function laterThan(a: string | undefined, b: string | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) > Date.parse(b);
}

/**
 * A request's merge state: the merge-after delay (from the label's add
 * time, else the last approval, else the last update) and the bot or queue
 * merging it, with its latest failed attempt. Undefined when neither
 * applies, and for requests no longer open.
 */
export function mrMergeInfo(input: {
  state: string;
  labels?: readonly string[];
  updatedAt: string;
  facts?: MrMergeFacts;
  notes?: readonly MrMergeNote[];
  rules: MrMergeRules;
  /** The user's name on that host (their own actions are no failures). */
  user?: string;
  now: number;
}): MrMergeInfo | undefined {
  if (input.state !== "open") return undefined;
  const info: MrMergeInfo = {};
  const facts = input.facts;
  const found = mergeAfterLabel(input.labels, input.rules.afterLabels);
  if (found) {
    const added = facts?.labelsAddedAt?.[found.label];
    const from: "label" | "approval" | "update" = added
      ? "label"
      : facts?.approvedAt
        ? "approval"
        : "update";
    const since =
      from === "label"
        ? added!
        : from === "approval"
          ? facts!.approvedAt!
          : input.updatedAt;
    const start = Date.parse(since);
    if (Number.isFinite(start)) {
      const at = start + found.delayMs;
      info.after = {
        label: found.label,
        delayMs: found.delayMs,
        delay: formatMergeDelay(found.delayMs),
        from,
        since,
        at: new Date(at).toISOString(),
        ready: input.now >= at,
      };
    }
  }
  const bot = mergeBot(input);
  if (bot) info.bot = bot;
  return info.after || info.bot ? info : undefined;
}

function mergeBot(input: Parameters<typeof mrMergeInfo>[0]) {
  const facts = input.facts;
  const bots = new Set(input.rules.bots.map(mrBotName));
  const isBot = (name: string | undefined) =>
    !!name && bots.has(mrBotName(name));
  const me = input.user ? mrBotName(input.user) : "";
  const events = facts?.events ?? [];
  const assignee = facts?.assignees.find(isBot);
  const reviewer = facts?.reviewers.find(isBot);
  const label = queueLabel(input.labels, input.rules.queueLabels);
  // How it is merging now, the most telling first.
  let current: NonNullable<MrMergeInfo["bot"]> | null = null;
  if (assignee) current = { name: assignee, via: "assignee", queued: true };
  else if (reviewer)
    current = { name: reviewer, via: "reviewer", queued: true };
  else if (facts?.queue)
    current = {
      name: "merge queue",
      via: "queue",
      queued: true,
      ...(facts.queue.position ? { position: facts.queue.position } : {}),
    };
  else if (facts?.autoMerge)
    current = {
      name: "auto-merge",
      via: "auto_merge",
      queued: true,
      ...(facts.autoMerge.by ? { by: facts.autoMerge.by } : {}),
    };
  else if (label) current = { name: label, via: "label", queued: true };

  // When it was last handed over (assigned, queued, auto-merge set).
  const handedAt = (name?: string) =>
    events
      .filter(
        (event) =>
          ((event.kind === "assigned" || event.kind === "review_requested") &&
            (event.who ?? []).some((who) =>
              name ? mrBotName(who) === mrBotName(name) : isBot(who),
            )) ||
          event.kind === "queued" ||
          event.kind === "auto_merge_on",
      )
      .map((event) => event.at)
      .sort()
      .pop();

  // The latest failure: a bot's note, the bot leaving, a queue removal,
  // an automatic merge aborted (not by the user).
  type Via = NonNullable<MrMergeInfo["bot"]>["via"];
  const failures: { reason: string; at: string; name: string; via: Via }[] = [];
  for (const note of input.notes ?? []) {
    if (!isBot(note.author)) continue;
    const reason = botFailureReason(note.body, input.rules.botFailures);
    if (reason)
      failures.push({
        reason,
        at: note.at,
        name: note.author,
        via: "assignee",
      });
  }
  for (const event of events) {
    if (
      (event.kind === "unassigned" || event.kind === "review_removed") &&
      isBot(event.actor) &&
      (event.who ?? []).some(
        (who) => mrBotName(who) === mrBotName(event.actor!),
      )
    ) {
      // The bot's own words near it say why.
      const said = (input.notes ?? [])
        .filter(
          (note) =>
            mrBotName(note.author) === mrBotName(event.actor!) &&
            Math.abs(Date.parse(note.at) - Date.parse(event.at)) < 60 * MINUTE,
        )
        .pop();
      failures.push({
        reason: said
          ? (botFailureReason(said.body, input.rules.botFailures) ??
            said.body.replace(/\s+/g, " ").trim().slice(0, 200))
          : `${event.actor} unassigned itself`,
        at: event.at,
        name: event.actor!,
        via: event.kind === "review_removed" ? "reviewer" : "assignee",
      });
    }
    if (
      (event.kind === "dequeued" || event.kind === "auto_merge_off") &&
      !(event.actor && me && mrBotName(event.actor) === me) &&
      (event.reason || event.kind === "dequeued")
    )
      failures.push({
        reason:
          event.kind === "dequeued"
            ? `removed from the merge queue${event.reason ? `: ${event.reason}` : ""}`
            : `auto-merge turned off: ${event.reason}`,
        at: event.at,
        name: event.kind === "dequeued" ? "merge queue" : "auto-merge",
        via: event.kind === "dequeued" ? "queue" : "auto_merge",
      });
  }
  failures.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const failure = failures[failures.length - 1];
  if (current) {
    // Still handed over, yet failed since (a bot that stays assigned, a
    // queue label left on). Handed over again after a failure (the
    // handing out of the details read) is a new attempt.
    const handed = handedAt(current.via === "label" ? undefined : current.name);
    if (
      failure &&
      (handed || current.via === "label") &&
      laterThan(failure.at, handed)
    )
      return {
        ...current,
        queued: false,
        failed: { reason: failure.reason, at: failure.at },
      };
    return current;
  }
  if (failure && laterThan(failure.at, handedAt())) {
    return {
      name: failure.name,
      via: failure.via,
      queued: false,
      failed: { reason: failure.reason, at: failure.at },
    };
  }
  return undefined;
}

/** "queued to merge by marge-bot", "#2 in the merge queue", "auto-merge set by alice". */
export function mrBotLabel(bot: NonNullable<MrMergeInfo["bot"]>): string {
  if (bot.via === "queue")
    return bot.position
      ? `#${bot.position} in the merge queue`
      : "in the merge queue";
  if (bot.via === "auto_merge")
    return `auto-merge set${bot.by ? ` by ${bot.by}` : ""}`;
  if (bot.via === "label") return `queued to merge (${bot.name})`;
  return `queued to merge by ${bot.name}`;
}

/** A failed attempt in a few words: "marge-bot could not merge", "left the merge queue". */
export function mrBotFailedLabel(bot: NonNullable<MrMergeInfo["bot"]>): string {
  if (bot.via === "queue") return "left the merge queue";
  if (bot.via === "auto_merge") return "auto-merge turned off";
  return `${bot.name} could not merge`;
}

/** What a failed attempt asks of the user: the bot's reason. */
export function mrBotFailedNext(bot: NonNullable<MrMergeInfo["bot"]>): string {
  const reason = bot.failed?.reason ?? "";
  if (bot.via === "queue" || bot.via === "auto_merge")
    return reason.charAt(0).toUpperCase() + reason.slice(1);
  return `${bot.name} could not merge: ${reason}`;
}

/** What a queued request's next step says. */
export function mrBotQueuedNext(bot: NonNullable<MrMergeInfo["bot"]>): string {
  if (bot.via === "queue")
    return bot.position
      ? `Merging from the merge queue (#${bot.position}): nothing to do`
      : "Merging from the merge queue: nothing to do";
  if (bot.via === "auto_merge")
    return "Merges itself once the pipeline succeeds";
  if (bot.via === "label") return `Waits for the merge bot (${bot.name})`;
  return `${bot.name} merges it: nothing to do unless it fails`;
}

/** When a scheduled merge becomes mergeable, as a row says it: "today 14:00", "Thu 14:00", "Nov 30 14:00". */
export function mrMergeTime(iso: string, now: number): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((time.getTime() - today.getTime()) / DAY);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days > 1 && days < 7)
    return `${time.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
  return `${time.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${clock}`;
}

/** What the merge state says to the inference's facts: "", or a word. */
export function mrMergeFact(info: MrMergeInfo | undefined): string {
  if (!info) return "";
  if (info.bot?.failed) return `failed:${info.bot.failed.at}`;
  if (info.bot?.queued) return "queued";
  if (info.after) return info.after.ready ? "ready" : "scheduled";
  return "";
}
