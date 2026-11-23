import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MR_DISPOSITIONS,
  type MrDisposition,
  type MrEffort,
  type MrEffortChanges,
  type MrEffortSummary,
  type MrMatchProposal,
  type MrOverlap,
  type MrPlan,
} from "../../../shared/mrReviews";
import {
  type DataFileAppender,
  type DataFileWriter,
  dataFileAppender,
  dataFileWriter,
} from "../config/data-paths";
import { type MrConnection, shQuote } from "./clones";
import {
  parseUpstreamCandidates,
  proposeMatches,
  type UpstreamCandidate,
  upstreamCandidatesScript,
} from "./fuzzy";

/**
 * Upstreaming efforts: every commit of `target..source` with one
 * disposition. Derived ones (upstream by patch id against the target,
 * in review by patch id against the user's requests, in a part) are
 * recomputed from git and kept in `derived.json`; authored ones (not for
 * upstream, superseded, planned, matches decided by hand) are the user's
 * and the leader session's, kept in `ledger.json` with a journal for
 * Undo, and each commit's versions are appended to `history.jsonl`, never
 * capped (D24). One script per refresh, run only when a head moved.
 */

export const LEDGER_JOURNAL = 100;
export const LEDGER_BULK_MAX = 500;
export const LEDGER_PAGE = 200;
/** The target is asked of its remote (ls-remote) at most this often. */
export const TARGET_CHECK_MS = 15 * 60_000;

export const AUTHORED_DISPOSITIONS = [
  "not_for_upstream",
  "superseded",
  "planned",
  "upstream",
  "in_review",
] as const;
export type AuthoredDisposition = (typeof AUTHORED_DISPOSITIONS)[number];

export type AuthoredEntry = {
  disposition: AuthoredDisposition;
  reason?: string;
  /** The commit, request or effort it points to (superseded by, upstream as). */
  pointer?: string;
  /** The secondary key, to carry it across rewording and rebases (D12). */
  subject: string;
  authorDate: number;
  sha: string;
  at: string;
  by: "user" | "agent";
};

/** A person's decisions on a commit's fuzzy matches (D14). */
export type MatchDecision = {
  /** The upstream commit confirmed as this one. */
  accepted?: string;
  /** Upstream commits said not to be this one: never proposed again. */
  rejected: string[];
  at: string;
  by: "user" | "agent";
};

export type LedgerFile = {
  version: number;
  /** By ledger key (the patch id the commit was first seen with). */
  entries: Record<string, AuthoredEntry>;
  /** A later patch id of a commit, to its ledger key. */
  aliases: Record<string, string>;
  /** Fuzzy match decisions by ledger key. */
  matches: Record<string, MatchDecision>;
  /** Planned requests (D25). */
  plans: MrPlan[];
  /** The last bulk changes, newest last, for Undo. */
  journal: {
    id: number;
    at: string;
    by: "user" | "agent";
    summary: string;
    before: Record<string, AuthoredEntry | null>;
    /** Match decisions before, when the change made some. */
    matches?: Record<string, MatchDecision | null>;
    /** Every plan before, when the change touched plans. */
    plans?: MrPlan[];
  }[];
};

export type DerivedCommit = {
  key: string;
  sha: string;
  patchId: string;
  subject: string;
  author: string;
  authorDate: number;
  files: string[];
  /** Lines changed per file, aligned with files. */
  sizes?: number[];
  dir: string;
  disposition: MrDisposition;
  /** Why: the request it is in, the reason, what supersedes it. */
  note?: string;
  /** Authored not for upstream, yet upstream (What changed says so). */
  upstreamAnyway?: boolean;
};

export type DerivedFile = {
  /** The heads it was derived from. */
  heads: string;
  at: string;
  commits: DerivedCommit[];
  feeders: { ref: string; sha: string; notReady: number; drift: number }[];
  /** One entry per day: the counts that day. */
  daily: { date: string; counts: Partial<Record<MrDisposition, number>> }[];
  /** Ledger keys whose current sha / patch id were recorded in history. */
  seen: Record<string, string>;
  /** Upstream commits since the merge base, read for fuzzy matching. */
  upstream?: { key: string; commits: UpstreamCandidate[] };
  /** Fuzzy match proposals of unsorted commits, by ledger key. */
  proposals?: Record<string, MrMatchProposal[]>;
  error?: string;
};

export const emptyLedger = (): LedgerFile => ({
  version: 0,
  entries: {},
  aliases: {},
  matches: {},
  plans: [],
  journal: [],
});

/** A ledger as read: fields older files lack filled in. */
function normalLedger(value: Partial<LedgerFile>): LedgerFile {
  return {
    ...emptyLedger(),
    ...value,
    matches: value.matches ?? {},
    plans: value.plans ?? [],
  };
}

/** Heads of an effort: `S`, `T` (local copy of the target), `F ref sha`. */
export function effortHeadsScript(effort: MrEffort, checkTarget: boolean) {
  const local = upstreamRef(effort);
  return [
    `d=${shQuote(effort.clone.path)}`,
    'export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"',
    '[ -d "$d" ] || { echo "E\tno such clone"; exit 0; }',
    ...(checkTarget
      ? [
          // The target moved upstream: fetched into Roamgate's own ref
          // only (D13), never the user's remote-tracking refs.
          `r=$(git -C "$d" ls-remote ${shQuote(effort.target.remote)} ${shQuote(`refs/heads/${effort.target.branch}`)} 2>/dev/null | cut -f1)`,
          `l=$(git -C "$d" rev-parse -q --verify ${shQuote(local)} 2>/dev/null)`,
          // By URL: a fetch from the remote's name would also move its
          // remote-tracking ref.
          `u=$(git -C "$d" config --get ${shQuote(`remote.${effort.target.remote}.url`)})`,
          `if [ -n "$r" ] && [ "$r" != "$l" ]; then git -C "$d" fetch -q --no-tags "$u" ${shQuote(`+refs/heads/${effort.target.branch}:${local}`)} >/dev/null 2>&1; fi`,
        ]
      : []),
    `printf "U\\t%s\\n" "$(git -C "$d" config --get ${shQuote(`remote.${effort.target.remote}.url`)} 2>/dev/null)"`,
    `s=$(git -C "$d" rev-parse -q --verify ${shQuote(effort.source)} 2>/dev/null)`,
    'printf "S\\t%s\\n" "$s"',
    `t=$(git -C "$d" rev-parse -q --verify ${shQuote(local)} 2>/dev/null) || t=$(git -C "$d" rev-parse -q --verify ${shQuote(`refs/remotes/${effort.target.remote}/${effort.target.branch}`)} 2>/dev/null)`,
    'printf "T\\t%s\\n" "$t"',
    'if [ -n "$s" ] && [ -n "$t" ]; then printf "M\\t%s\\n" "$(git -C "$d" merge-base "$s" "$t" 2>/dev/null)"; fi',
    ...effort.feeders.map(
      (ref) =>
        `printf "F\\t%s\\t%s\\n" ${shQuote(ref)} "$(git -C "$d" rev-parse -q --verify ${shQuote(ref)} 2>/dev/null)"`,
    ),
    "exit 0",
  ].join("\n");
}

/** Where an effort's target is kept in its clone (D13). */
export function upstreamRef(effort: MrEffort): string {
  return `refs/roamgate/upstream/${effort.target.remote}/${effort.target.branch}`;
}

export function parseHeads(stdout: string) {
  let source = "";
  let target = "";
  let error = "";
  let url = "";
  let mergeBase = "";
  const feeders: { ref: string; sha: string }[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, a = "", b = ""] = line.split("\t");
    if (kind === "S") source = a;
    else if (kind === "T") target = a;
    else if (kind === "F") feeders.push({ ref: a, sha: b });
    else if (kind === "E") error = a;
    else if (kind === "U") url = a;
    else if (kind === "M") mergeBase = a;
  }
  return { source, target, feeders, error, url, mergeBase };
}

/**
 * Every commit of target..source (oldest first) with author, files and
 * patch id, which are upstream already (`git cherry`), and each feeder's
 * commits not on the source and its drift.
 */
export function effortCommitsScript(
  dir: string,
  source: string,
  target: string,
  feeders: string[],
): string {
  const range = `${target}..${source}`;
  return [
    `d=${shQuote(dir)}; s=${shQuote(source)}; t=${shQuote(target)}`,
    `git -C "$d" log --no-merges --reverse --format='C%x09%H%x09%at%x09%an%x09%s' ${shQuote(range)}`,
    `git -C "$d" log --no-merges --format='N%x09%H' --numstat ${shQuote(range)}`,
    `git -C "$d" log --no-merges -p --format='commit %H' ${shQuote(range)} | git -C "$d" patch-id --stable | awk '{ print "I\\t" $1 "\\t" $2 }'`,
    `git -C "$d" cherry "$t" "$s" | awk '{ print "Y\\t" $1 "\\t" $2 }'`,
    ...feeders.map(
      (ref) =>
        `printf "F\\t%s\\t%s\\t%s\\n" ${shQuote(ref)} "$(git -C "$d" cherry "$s" ${shQuote(ref)} 2>/dev/null | grep -c '^+')" "$(git -C "$d" rev-list --count ${shQuote(ref)}..${shQuote(source)} 2>/dev/null)"`,
    ),
    "exit 0",
  ].join("\n");
}

export type ReadCommit = {
  sha: string;
  at: number;
  author: string;
  subject: string;
  files: string[];
  /** Lines changed per file, aligned with files. */
  sizes: number[];
  patchId: string;
  upstream: boolean;
};

export function parseEffortCommits(stdout: string): {
  commits: ReadCommit[];
  feeders: { ref: string; notReady: number; drift: number }[];
} {
  const commits: ReadCommit[] = [];
  const bySha = new Map<string, ReadCommit>();
  const feeders: { ref: string; notReady: number; drift: number }[] = [];
  let files: ReadCommit | null = null;
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    const kind = parts[0];
    if (kind === "C" && parts.length >= 5) {
      const commit: ReadCommit = {
        sha: parts[1]!,
        at: Number(parts[2]) || 0,
        author: parts[3]!,
        subject: parts.slice(4).join("\t"),
        files: [],
        sizes: [],
        patchId: "",
        upstream: false,
      };
      commits.push(commit);
      bySha.set(commit.sha, commit);
      files = null;
    } else if (kind === "N" && parts.length === 2) {
      files = bySha.get(parts[1]!) ?? null;
    } else if (kind === "I" && parts.length === 3) {
      const commit = bySha.get(parts[2]!);
      if (commit) commit.patchId = parts[1]!;
      files = null;
    } else if (kind === "Y" && parts.length === 3) {
      const commit = bySha.get(parts[2]!);
      if (commit && parts[1] === "-") commit.upstream = true;
      files = null;
    } else if (kind === "F" && parts.length === 4) {
      feeders.push({
        ref: parts[1]!,
        notReady: Number(parts[2]) || 0,
        drift: Number(parts[3]) || 0,
      });
      files = null;
    } else if (files && parts.length === 3 && /^(\d+|-)$/.test(kind!)) {
      // --numstat: added, deleted, path.
      files.files.push(parts[2]!);
      files.sizes.push((Number(parts[0]) || 0) + (Number(parts[1]) || 0));
    } else if (line && files && !line.includes("\t")) {
      files.files.push(line);
      files.sizes.push(0);
    }
  }
  // A commit with an empty diff has no patch id: its sha stands in.
  for (const commit of commits) commit.patchId ||= `sha:${commit.sha}`;
  return { commits, feeders };
}

/** A path's top directory ("src/a/b.c" -> "src/a"), for the breakdown. */
export function topDir(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split("/");
    const dir =
      parts.length > 2
        ? parts.slice(0, 2).join("/")
        : parts.length === 2
          ? parts[0]!
          : ".";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ".";
}

/**
 * The ledger key of each commit: its patch id, or the key it had before
 * a reword or rebase changed it, found by an alias or by the secondary key
 * (author date and subject) among keys no commit holds now (D12).
 */
export function assignKeys(
  commits: ReadCommit[],
  ledger: LedgerFile,
  previous: DerivedCommit[],
): { keys: string[]; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};
  const used = new Set<string>();
  const known = new Set([
    ...Object.keys(ledger.entries),
    ...previous.map((commit) => commit.key),
  ]);
  const secondary = new Map<string, string>();
  for (const commit of previous)
    secondary.set(`${commit.authorDate}\0${commit.subject}`, commit.key);
  for (const [key, entry] of Object.entries(ledger.entries))
    secondary.set(`${entry.authorDate}\0${entry.subject}`, key);
  const keys = commits.map((commit) => {
    const direct = ledger.aliases[commit.patchId] ?? commit.patchId;
    if (known.has(direct) && !used.has(direct)) {
      used.add(direct);
      return direct;
    }
    const before = secondary.get(`${commit.at}\0${commit.subject}`);
    if (before && !used.has(before) && before !== commit.patchId) {
      used.add(before);
      aliases[commit.patchId] = before;
      return before;
    }
    used.add(commit.patchId);
    return commit.patchId;
  });
  return { keys, aliases };
}

/** One derived commit: its disposition from git, the requests and the ledger. */
export function disposition(
  commit: ReadCommit,
  authored: AuthoredEntry | undefined,
  inReview: string | undefined,
  inPart: string | undefined,
  planned?: string,
): Pick<DerivedCommit, "disposition" | "note" | "upstreamAnyway"> {
  if (authored?.disposition === "not_for_upstream")
    return {
      disposition: "not_for_upstream",
      ...(authored.reason ? { note: authored.reason } : {}),
      ...(commit.upstream ? { upstreamAnyway: true } : {}),
    };
  if (authored?.disposition === "superseded")
    return {
      disposition: "superseded",
      ...(authored.pointer ? { note: `by ${authored.pointer}` } : {}),
    };
  if (commit.upstream) return { disposition: "upstream" };
  if (inReview) return { disposition: "in_review", note: inReview };
  if (inPart) return { disposition: "in_part", note: inPart };
  if (planned) return { disposition: "planned", note: planned };
  if (authored)
    return {
      disposition: authored.disposition,
      ...(authored.pointer || authored.reason
        ? { note: authored.pointer ?? authored.reason }
        : {}),
    };
  return { disposition: "unsorted" };
}

export function countsOf(commits: DerivedCommit[]) {
  const counts: Partial<Record<MrDisposition, number>> = {};
  for (const commit of commits)
    counts[commit.disposition] = (counts[commit.disposition] ?? 0) + 1;
  return counts;
}

/**
 * Commits two sets share, and what to do about it (D23): the same set is
 * one effort (the other a feeder or a copy); one holding all of the other
 * stacks it; a partial overlap keeps both, the shared commits in one part.
 */
export function overlapOf(
  mine: ReadonlySet<string>,
  theirs: ReadonlySet<string>,
  other: { with: string; kind: "effort" | "branch" },
): MrOverlap | null {
  let shared = 0;
  for (const id of mine) if (theirs.has(id)) shared++;
  if (!shared) return null;
  const relation: MrOverlap["relation"] =
    shared === mine.size && shared === theirs.size
      ? "same"
      : shared === theirs.size
        ? "contains"
        : shared === mine.size
          ? "contained"
          : "partial";
  const proposal =
    relation === "same"
      ? `Same commits as ${other.with}: keep one effort, the other as a feeder (or drop it as a copy)`
      : relation === "contains"
        ? `All of ${other.with} is here: stack it under this effort, or make it a feeder`
        : relation === "contained"
          ? `All of this is in ${other.with}: stack this effort under it`
          : `${shared} commits shared with ${other.with}: put them in one part only`;
  return { ...other, shared, relation, proposal };
}

/**
 * An effort's files: ledger, derived, history; written one at a time,
 * behind the changes and off the event loop (dataFileWriter): a sync of a
 * derived file on a busy disk stalled every call for 5 s (2026-11-23). What
 * is not yet written is read from memory meanwhile.
 */
export function createLedgerStore(root: string) {
  const queues = new Map<string, Promise<unknown>>();
  const made = new Set<string>();
  const writers = new Map<string, DataFileWriter>();
  const appenders = new Map<string, DataFileAppender>();
  /** Each file's contents not yet known to be written. */
  const unwritten = new Map<string, string>();
  const dirOf = (id: string) => {
    const dir = join(root, id);
    if (!made.has(dir)) {
      mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    return dir;
  };
  const read = <T>(file: string, empty: () => T): T => {
    try {
      const text =
        unwritten.get(file) ??
        (existsSync(file) ? readFileSync(file, "utf8") : null);
      return text === null ? empty() : (JSON.parse(text) as T);
    } catch {
      return empty();
    }
  };
  const write = (file: string, value: unknown) => {
    const text = `${JSON.stringify(value)}\n`;
    unwritten.set(file, text);
    let writer = writers.get(file);
    if (!writer) {
      writer = dataFileWriter(file);
      writers.set(file, writer);
    }
    writer.write(() => text);
    void writer.flush().then(() => {
      if (unwritten.get(file) === text) unwritten.delete(file);
    });
  };
  const appender = (file: string) => {
    let found = appenders.get(file);
    if (!found) {
      found = dataFileAppender(file);
      appenders.set(file, found);
    }
    return found;
  };
  return {
    ledger: (id: string) =>
      normalLedger(read(join(dirOf(id), "ledger.json"), emptyLedger)),
    /** What the user saw last (What changed); runtime only, never exported. */
    seen: (id: string): SeenSnapshot | null =>
      read<SeenSnapshot | null>(join(dirOf(id), "seen.json"), () => null),
    writeSeen(id: string, seen: SeenSnapshot) {
      write(join(dirOf(id), "seen.json"), seen);
    },
    derived: (id: string): DerivedFile | null =>
      read<DerivedFile | null>(join(dirOf(id), "derived.json"), () => null),
    writeLedger(id: string, ledger: LedgerFile) {
      write(join(dirOf(id), "ledger.json"), ledger);
    },
    writeDerived(id: string, derived: DerivedFile) {
      write(join(dirOf(id), "derived.json"), derived);
    },
    /** Appends versions of commits (D24): one line each, never rewritten. */
    appendHistory(id: string, lines: Record<string, unknown>[]) {
      if (!lines.length) return;
      appender(join(dirOf(id), "history.jsonl")).append(
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
    },
    history(id: string, key?: string): Record<string, any>[] {
      const file = join(dirOf(id), "history.jsonl");
      const pending = appenders.get(file)?.pending() ?? "";
      if (!existsSync(file) && !pending) return [];
      const text =
        (existsSync(file) ? readFileSync(file, "utf8") : "") + pending;
      return text.split("\n").flatMap((line) => {
        if (!line) return [];
        try {
          const value = JSON.parse(line);
          return !key || value.key === key ? [value] : [];
        } catch {
          return [];
        }
      });
    },
    /** Resolves once every file holds what was written (tests, cleanup). */
    async flush() {
      await Promise.all(
        [...writers.values(), ...appenders.values()].map((each) =>
          each.flush(),
        ),
      );
    },
    /** One change of an effort's files at a time. */
    queue<T>(id: string, change: () => Promise<T> | T): Promise<T> {
      const before = queues.get(id) ?? Promise.resolve();
      const next = before.then(change, change);
      queues.set(
        id,
        next.catch(() => {}),
      );
      return next;
    },
  };
}

export type LedgerStore = ReturnType<typeof createLedgerStore>;

/** The effort's card from its declaration and derived file. */
export function effortSummary(
  effort: MrEffort,
  derived: DerivedFile | null,
  overlaps: MrOverlap[],
  head?: MrEffortSummary["head"],
  more?: { ledger: LedgerFile; seen: SeenSnapshot | null },
): MrEffortSummary {
  const commits = derived?.commits ?? [];
  const changes = more ? changesOf(derived, more.ledger, more.seen) : null;
  return {
    id: effort.id,
    name: effort.name,
    group: effort.group,
    source: effort.source.replace(/^refs\/(heads|remotes)\//, ""),
    target: `${effort.target.remote}/${effort.target.branch}`,
    total: commits.length,
    counts: countsOf(commits),
    notReady: (derived?.feeders ?? []).reduce(
      (sum, feeder) => sum + feeder.notReady,
      0,
    ),
    ...(derived?.at ? { at: derived.at } : {}),
    ...(derived?.error ? { error: derived.error } : {}),
    overlaps,
    ...(head ? { head } : {}),
    ...(changes
      ? {
          proposals: changes.proposals.length,
          changed: changeCount(changes),
        }
      : {}),
    ...(more?.ledger.plans.length
      ? {
          plans: {
            proposed: more.ledger.plans.filter((p) => p.state === "proposed")
              .length,
            accepted: more.ledger.plans.filter((p) => p.state === "accepted")
              .length,
          },
        }
      : {}),
  };
}

/** Commits of a ledger matching a filter, as `ledger_list` and the table read it. */
export function filterLedger(
  commits: DerivedCommit[],
  filter: { disposition?: string; text?: string },
): DerivedCommit[] {
  const words = (filter.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return commits.filter((commit) => {
    if (filter.disposition && commit.disposition !== filter.disposition)
      return false;
    return words.every((word) => {
      const [key, value] = word.includes(":")
        ? [word.slice(0, word.indexOf(":")), word.slice(word.indexOf(":") + 1)]
        : ["", word];
      if (key === "disposition")
        return commit.disposition === value.replace(/-/g, "_");
      if (key === "dir") return commit.dir.toLowerCase().startsWith(value);
      if (key === "file")
        return commit.files.some((file) => file.toLowerCase().includes(value));
      if (key === "author") return commit.author.toLowerCase().includes(value);
      return (
        commit.subject.toLowerCase().includes(value) ||
        commit.sha.startsWith(value)
      );
    });
  });
}

/**
 * A first grouping of unsorted commits for the leader session (D15):
 * fixup!/squash! chains with their commit, then by top directory and
 * subject prefix ("pool: ...").
 */
export function clusterLedger(commits: DerivedCommit[]) {
  const clusters = new Map<string, DerivedCommit[]>();
  const bySubject = new Map(commits.map((commit) => [commit.subject, commit]));
  for (const commit of commits) {
    const fix = /^(?:fixup|squash|amend)! (.*)$/.exec(commit.subject);
    const base = fix ? bySubject.get(fix[1]!) : undefined;
    const prefix = /^([\w./-]{2,40}):\s/.exec(base?.subject ?? commit.subject);
    const label = `${base?.dir ?? commit.dir}${prefix ? ` ${prefix[1]}:` : ""}`;
    clusters.set(label, [...(clusters.get(label) ?? []), commit]);
  }
  return [...clusters]
    .map(([label, list]) => ({
      label,
      size: list.length,
      files: [...new Set(list.flatMap((commit) => commit.files))].length,
      commits: list.map((commit) => commit.sha.slice(0, 12)),
    }))
    .sort((a, b) => a.size - b.size || a.files - b.files);
}

export { MR_DISPOSITIONS };

/**
 * Derives an effort: heads first (one cheap round trip, the target
 * fetched when its remote moved, at most every TARGET_CHECK_MS), then,
 * only when a head moved, every commit; then the dispositions.
 */
export async function deriveEffort(input: {
  effort: MrEffort;
  connection: MrConnection;
  store: LedgerStore;
  checkTarget: boolean;
  /**
   * Patch ids of the user's requests on the target project (its remote's
   * URL given), read in the clone.
   */
  requests: (
    url: string,
    targetSha: string,
  ) => Promise<{ key: string; label: string; ids: ReadonlySet<string> }[]>;
  /** Patch ids in each part (label -> ids). */
  parts?: { label: string; ids: ReadonlySet<string> }[];
  /** Patch ids in a plan or part of another effort (D4): its name. */
  elsewhere?: ReadonlyMap<string, string>;
  now?: () => number;
  force?: boolean;
}): Promise<{ derived: DerivedFile; ran: boolean }> {
  const { effort, connection, store } = input;
  const now = input.now ?? (() => Date.now());
  const previous = store.derived(effort.id);
  const heads = parseHeads(
    (
      await connection.run(
        effortHeadsScript(effort, input.checkTarget),
        120_000,
      )
    ).stdout,
  );
  const ledger = store.ledger(effort.id);
  const requests =
    heads.source && heads.target
      ? await input.requests(heads.url, heads.target).catch(() => [])
      : [];
  const requestsKey = requests
    .map((each) => `${each.key}:${each.ids.size}`)
    .join(",");
  const partsKey = [
    ...(input.parts ?? []).map((each) => `${each.label}:${each.ids.size}`),
    ...[...(input.elsewhere ?? [])].map(([id, name]) => `${id}>${name}`),
  ].join(",");
  const key = [
    heads.source,
    heads.target,
    ...heads.feeders.map((each) => each.sha),
    requestsKey,
    partsKey,
    ledger.version,
  ].join("|");
  if (heads.error || !heads.source || !heads.target) {
    const derived: DerivedFile = {
      ...(previous ?? {
        heads: "",
        at: "",
        commits: [],
        feeders: [],
        daily: [],
        seen: {},
      }),
      error:
        heads.error ||
        (!heads.source
          ? `${effort.source} is not in ${effort.clone.path}`
          : `${effort.target.remote}/${effort.target.branch} could not be read`),
    };
    return { derived, ran: false };
  }
  if (!input.force && previous && previous.heads === key && !previous.error)
    return { derived: previous, ran: false };
  // The commits only when the source, the target or a feeder moved; the
  // dispositions again when the requests, parts or ledger did.
  const sameCommits =
    previous &&
    previous.heads
      .split("|")
      .slice(0, 2 + heads.feeders.length)
      .join("|") ===
      key
        .split("|")
        .slice(0, 2 + heads.feeders.length)
        .join("|");
  let read: ReturnType<typeof parseEffortCommits>;
  if (sameCommits && !input.force) {
    read = {
      commits: previous.commits.map((commit) => ({
        sha: commit.sha,
        at: commit.authorDate,
        author: commit.author,
        subject: commit.subject,
        files: commit.files,
        sizes: commit.sizes ?? commit.files.map(() => 0),
        patchId: commit.patchId,
        upstream: commit.disposition === "upstream" || !!commit.upstreamAnyway,
      })),
      feeders: previous.feeders,
    };
  } else
    read = parseEffortCommits(
      (
        await connection.run(
          effortCommitsScript(
            effort.clone.path,
            heads.source,
            heads.target,
            effort.feeders,
          ),
          300_000,
        )
      ).stdout,
    );
  // Upstream commits since the merge base, for fuzzy matching (D14): read
  // again only when the source, the target or the merge base moved, and
  // only while some commit is matched neither exactly nor by hand.
  const upstreamKey = `${heads.source}|${heads.target}|${heads.mergeBase}`;
  let upstream =
    previous?.upstream?.key === upstreamKey ? previous.upstream : undefined;
  if (
    !upstream &&
    heads.mergeBase &&
    read.commits.some((commit) => !commit.upstream)
  ) {
    const found = parseUpstreamCandidates(
      (
        await connection.run(
          upstreamCandidatesScript(
            effort.clone.path,
            heads.source,
            heads.target,
            heads.mergeBase,
            3000,
            shQuote,
          ),
          300_000,
        )
      ).stdout,
    );
    upstream = { key: upstreamKey, commits: found.commits };
  }
  return store.queue(effort.id, () => {
    const current = store.ledger(effort.id);
    const { keys, aliases } = assignKeys(
      read.commits,
      current,
      previous?.commits ?? [],
    );
    if (Object.keys(aliases).length) {
      current.aliases = { ...current.aliases, ...aliases };
      store.writeLedger(effort.id, current);
    }
    const review = new Map<string, string>();
    for (const request of requests)
      for (const id of request.ids)
        if (!review.has(id)) review.set(id, request.label);
    const part = new Map<string, string>();
    for (const each of input.parts ?? [])
      for (const id of each.ids) if (!part.has(id)) part.set(id, each.label);
    for (const [id, name] of input.elsewhere ?? [])
      if (!part.has(id)) part.set(id, `in a part of ${name}`);
    const planOf = new Map<string, string>();
    for (const plan of current.plans)
      for (const key of plan.commits) planOf.set(key, plan.name);
    const commits: DerivedCommit[] = read.commits.map((commit, index) => {
      const ledgerKey = keys[index]!;
      return {
        key: ledgerKey,
        sha: commit.sha,
        patchId: commit.patchId,
        subject: commit.subject,
        author: commit.author,
        authorDate: commit.at,
        files: commit.files.slice(0, 40),
        sizes: commit.sizes.slice(0, 40),
        dir: topDir(commit.files),
        ...disposition(
          commit,
          current.entries[ledgerKey],
          review.get(commit.patchId),
          part.get(commit.patchId),
          planOf.get(ledgerKey),
        ),
      };
    });
    const proposals = proposeMatches(
      commits.filter((commit) => commit.disposition === "unsorted"),
      upstream?.commits ?? [],
      (key) => current.matches[key]?.rejected ?? [],
    );
    // Every new version of a commit goes to its history (D24).
    const seen: Record<string, string> = { ...(previous?.seen ?? {}) };
    const at = new Date(now()).toISOString();
    const lines: Record<string, unknown>[] = [];
    for (const commit of commits) {
      const version = `${commit.sha}:${commit.patchId}`;
      if (seen[commit.key] === version) continue;
      seen[commit.key] = version;
      lines.push({
        key: commit.key,
        sha: commit.sha,
        patchId: commit.patchId,
        subject: commit.subject,
        authorDate: commit.authorDate,
        seenAt: at,
        where: "source",
      });
    }
    store.appendHistory(effort.id, lines);
    const date = at.slice(0, 10);
    const daily = [
      ...(previous?.daily ?? []).filter((each) => each.date !== date),
      { date, counts: countsOf(commits) },
    ].slice(-365);
    const feederShas = new Map(
      heads.feeders.map((each) => [each.ref, each.sha]),
    );
    const derived: DerivedFile = {
      heads: key,
      at,
      commits,
      feeders: read.feeders.map((each) => ({
        ...each,
        sha: feederShas.get(each.ref) ?? "",
      })),
      daily,
      seen,
      ...(upstream ? { upstream } : {}),
      proposals,
    };
    store.writeDerived(effort.id, derived);
    // The first reading is what the user has seen (What changed starts here).
    if (!store.seen(effort.id))
      store.writeSeen(effort.id, snapshotOf(derived, current));
    return { derived, ran: true };
  });
}

/**
 * Sets authored dispositions on commits (all or nothing, at most
 * LEDGER_BULK_MAX), journaled for Undo; `unsorted` clears them.
 */
export function setDispositions(
  store: LedgerStore,
  effort: MrEffort,
  input: {
    commits: string[];
    disposition: AuthoredDisposition | "unsorted";
    reason?: string;
    pointer?: string;
    by: "user" | "agent";
    summary: string;
    now?: () => number;
  },
): Promise<{ changed: number; unknown: string[]; journal: number }> {
  return store.queue(effort.id, () => {
    if (input.commits.length > LEDGER_BULK_MAX)
      throw new Error(`At most ${LEDGER_BULK_MAX} commits a call.`);
    const derived = store.derived(effort.id);
    const commits = derived?.commits ?? [];
    const ledger = store.ledger(effort.id);
    const { found, unknown } = resolveCommits(commits, input.commits);
    if (unknown.length)
      return { changed: 0, unknown, journal: ledger.journal.at(-1)?.id ?? 0 };
    const at = new Date((input.now ?? Date.now)()).toISOString();
    const before: Record<string, AuthoredEntry | null> = {};
    for (const commit of found) {
      before[commit.key] = ledger.entries[commit.key] ?? null;
      if (input.disposition === "unsorted") delete ledger.entries[commit.key];
      else
        ledger.entries[commit.key] = {
          disposition: input.disposition,
          ...(input.reason ? { reason: input.reason.slice(0, 300) } : {}),
          ...(input.pointer ? { pointer: input.pointer.slice(0, 300) } : {}),
          subject: commit.subject,
          authorDate: commit.authorDate,
          sha: commit.sha,
          at,
          by: input.by,
        };
    }
    const id = (ledger.journal.at(-1)?.id ?? 0) + 1;
    ledger.journal = [
      ...ledger.journal,
      { id, at, by: input.by, summary: input.summary.slice(0, 200), before },
    ].slice(-LEDGER_JOURNAL);
    ledger.version++;
    store.writeLedger(effort.id, ledger);
    return { changed: found.length, unknown: [], journal: id };
  });
}

/** Takes back a bulk change (the last one when no id is given). */
export function undoLedger(
  store: LedgerStore,
  effortId: string,
  journalId?: number,
): Promise<{ undone: string | null }> {
  return store.queue(effortId, () => {
    const ledger = store.ledger(effortId);
    const at =
      journalId === undefined
        ? ledger.journal.length - 1
        : ledger.journal.findIndex((each) => each.id === journalId);
    const entry = ledger.journal[at];
    if (!entry) return { undone: null };
    for (const [key, value] of Object.entries(entry.before)) {
      if (value) ledger.entries[key] = value;
      else delete ledger.entries[key];
    }
    for (const [key, value] of Object.entries(entry.matches ?? {})) {
      if (value) ledger.matches[key] = value;
      else delete ledger.matches[key];
    }
    if (entry.plans) ledger.plans = entry.plans;
    ledger.journal.splice(at, 1);
    ledger.version++;
    store.writeLedger(effortId, ledger);
    return { undone: entry.summary };
  });
}

export function isAuthoredDisposition(
  value: unknown,
): value is AuthoredDisposition | "unsorted" {
  return (
    value === "unsorted" ||
    (AUTHORED_DISPOSITIONS as readonly unknown[]).includes(value)
  );
}

/** Commits named by key, patch id or a sha of 7 characters at least. */
export function resolveCommits(
  commits: DerivedCommit[],
  names: string[],
): { found: DerivedCommit[]; unknown: string[] } {
  const unknown: string[] = [];
  const found: DerivedCommit[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const matches = commits.filter(
      (commit) =>
        commit.key === name ||
        commit.patchId === name ||
        (lower.length >= 7 && commit.sha.startsWith(lower)),
    );
    if (matches.length === 1) found.push(matches[0]!);
    else unknown.push(name);
  }
  return { found, unknown };
}

function journalOf(
  ledger: LedgerFile,
  input: { by: "user" | "agent"; summary: string; now?: () => number },
  before: LedgerFile["journal"][number]["before"],
  extra: Pick<LedgerFile["journal"][number], "matches" | "plans">,
): number {
  const id = (ledger.journal.at(-1)?.id ?? 0) + 1;
  ledger.journal = [
    ...ledger.journal,
    {
      id,
      at: new Date((input.now ?? Date.now)()).toISOString(),
      by: input.by,
      summary: input.summary.slice(0, 200),
      before,
      ...extra,
    },
  ].slice(-LEDGER_JOURNAL);
  ledger.version++;
  return id;
}

/**
 * Confirms or rejects fuzzy matches (D14), all or nothing: a confirmed one
 * makes the commit upstream by hand with the upstream commit as pointer
 * and adds that commit to its history (D24); a rejected one is never
 * proposed again for it.
 */
export function decideMatches(
  store: LedgerStore,
  effort: MrEffort,
  input: {
    decisions: { commit: string; match: string; accept: boolean }[];
    by: "user" | "agent";
    summary: string;
    now?: () => number;
  },
): Promise<{ accepted: number; rejected: number; journal: number }> {
  return store.queue(effort.id, () => {
    if (input.decisions.length > LEDGER_BULK_MAX)
      throw new Error(`At most ${LEDGER_BULK_MAX} decisions a call.`);
    const derived = store.derived(effort.id);
    const commits = derived?.commits ?? [];
    const candidates = derived?.upstream?.commits ?? [];
    const ledger = store.ledger(effort.id);
    const problems: string[] = [];
    const resolved = input.decisions.map((decision) => {
      const { found } = resolveCommits(commits, [decision.commit]);
      const commit = found[0];
      const lower = decision.match.toLowerCase();
      const proposed = commit ? (derived?.proposals?.[commit.key] ?? []) : [];
      const pool = [
        ...proposed.map((each) => ({
          sha: each.sha,
          subject: each.subject,
          at: 0,
        })),
        ...candidates,
      ];
      const shas = [
        ...new Set(
          pool
            .filter((each) => lower.length >= 7 && each.sha.startsWith(lower))
            .map((each) => each.sha),
        ),
      ];
      if (!commit) problems.push(`${decision.commit}: not in the ledger`);
      else if (shas.length !== 1)
        problems.push(
          `${decision.match}: ${shas.length ? "ambiguous" : "not an upstream commit since the merge base"}`,
        );
      const match = pool.find((each) => each.sha === shas[0]);
      return { decision, commit, match };
    });
    if (problems.length)
      throw new Error(`${problems.slice(0, 20).join("; ")}; nothing changed`);
    const at = new Date((input.now ?? Date.now)()).toISOString();
    const before: Record<string, AuthoredEntry | null> = {};
    const matchesBefore: Record<string, MatchDecision | null> = {};
    const lines: Record<string, unknown>[] = [];
    let accepted = 0;
    let rejected = 0;
    for (const { decision, commit, match } of resolved) {
      const key = commit!.key;
      if (!(key in matchesBefore))
        matchesBefore[key] = ledger.matches[key] ?? null;
      const current = ledger.matches[key] ?? { rejected: [], at, by: input.by };
      if (decision.accept) {
        accepted++;
        if (!(key in before)) before[key] = ledger.entries[key] ?? null;
        ledger.entries[key] = {
          disposition: "upstream",
          pointer: match!.sha,
          reason: "matched by hand",
          subject: commit!.subject,
          authorDate: commit!.authorDate,
          sha: commit!.sha,
          at,
          by: input.by,
        };
        ledger.matches[key] = {
          ...current,
          accepted: match!.sha,
          rejected: current.rejected.filter((sha) => sha !== match!.sha),
          at,
          by: input.by,
        };
        lines.push({
          key,
          sha: match!.sha,
          patchId: "",
          subject: match!.subject,
          authorDate: match!.at,
          seenAt: at,
          where: "upstream",
        });
      } else {
        rejected++;
        const next: MatchDecision = {
          ...current,
          rejected: [...new Set([...current.rejected, match!.sha])].slice(-50),
          at,
          by: input.by,
        };
        if (current.accepted === match!.sha) delete next.accepted;
        ledger.matches[key] = next;
        if (current.accepted === match!.sha) {
          if (!(key in before)) before[key] = ledger.entries[key] ?? null;
          delete ledger.entries[key];
        }
      }
    }
    const journal = journalOf(ledger, input, before, {
      matches: matchesBefore,
    });
    store.writeLedger(effort.id, ledger);
    store.appendHistory(effort.id, lines);
    return { accepted, rejected, journal };
  });
}

export const PLAN_MAX = 200;

export type PlanAction =
  | {
      action: "propose";
      name: string;
      commits: string[];
      dependsOn?: string[];
      /** Made by the user: accepted at once. */
      accepted?: boolean;
    }
  | { action: "accept"; plan: string }
  | {
      action: "edit";
      plan: string;
      name?: string;
      commits?: string[];
      /** Commits added to it (the ledger's :plan NAME on an existing one). */
      add?: string[];
      remove?: string[];
      dependsOn?: string[];
    }
  | { action: "split"; plan: string; commits: string[]; name: string }
  | { action: "drop"; plan: string }
  | {
      action: "part";
      plan: string;
      part: NonNullable<MrPlan["part"]>;
    };

/** A plan by id or name (case-insensitive). */
export function findPlan(plans: MrPlan[], name: string): MrPlan | null {
  const lower = name.trim().toLowerCase();
  return (
    plans.find((plan) => plan.id === name) ??
    plans.find((plan) => plan.name.toLowerCase() === lower) ??
    null
  );
}

/**
 * Proposes, accepts, edits, splits or drops planned requests (D25), all or
 * nothing, journaled for Undo. A commit is in at most one plan, here and
 * across efforts (D4): `taken` names the other efforts' planned commits by
 * patch id.
 */
export function changePlans(
  store: LedgerStore,
  effort: MrEffort,
  change: PlanAction,
  input: {
    by: "user" | "agent";
    summary: string;
    taken?: ReadonlyMap<string, string>;
    now?: () => number;
  },
): Promise<{ plan: MrPlan | null; journal: number }> {
  return store.queue(effort.id, () => {
    const commits = store.derived(effort.id)?.commits ?? [];
    const ledger = store.ledger(effort.id);
    const before = structuredClone(ledger.plans);
    const at = new Date((input.now ?? Date.now)()).toISOString();
    const keysOf = (names: string[], plan?: MrPlan) => {
      const { found, unknown } = resolveCommits(commits, names);
      if (unknown.length)
        throw new Error(
          `not in the ledger (or ambiguous): ${unknown.slice(0, 20).join(", ")}; nothing changed`,
        );
      const problems: string[] = [];
      for (const commit of found) {
        const other = ledger.plans.find(
          (each) => each !== plan && each.commits.includes(commit.key),
        );
        if (other)
          problems.push(`${commit.sha.slice(0, 10)} is in ${other.name}`);
        const elsewhere = input.taken?.get(commit.patchId);
        if (elsewhere)
          problems.push(
            `${commit.sha.slice(0, 10)} is in a part of ${elsewhere}`,
          );
        if (commit.disposition === "upstream")
          problems.push(`${commit.sha.slice(0, 10)} is upstream`);
      }
      if (problems.length)
        throw new Error(
          `a commit is in one planned request only: ${problems.slice(0, 10).join("; ")}; nothing changed`,
        );
      // In source order, whatever order they were given in.
      const order = new Map(
        commits.map((commit, index) => [commit.key, index]),
      );
      return [...new Set(found.map((commit) => commit.key))].sort(
        (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
      );
    };
    const named = (name: string) => {
      const plan = findPlan(ledger.plans, name);
      if (!plan) throw new Error(`no planned request "${name}"`);
      return plan;
    };
    const depends = (names: string[] | undefined, self?: MrPlan) =>
      (names ?? []).map((name) => {
        const plan = named(name);
        if (plan === self) throw new Error("a plan cannot come after itself");
        return plan.id;
      });
    const fresh = (name: string): string => {
      const clean = name.trim().slice(0, 120);
      if (!clean) throw new Error("a planned request needs a name");
      if (findPlan(ledger.plans, clean))
        throw new Error(`there is already a planned request "${clean}"`);
      return clean;
    };
    let plan: MrPlan | null = null;
    switch (change.action) {
      case "propose": {
        if (ledger.plans.length >= PLAN_MAX)
          throw new Error(`At most ${PLAN_MAX} planned requests an effort.`);
        plan = {
          id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: fresh(change.name),
          commits: keysOf(change.commits),
          dependsOn: depends(change.dependsOn),
          state:
            change.accepted && input.by === "user" ? "accepted" : "proposed",
          at,
          by: input.by,
        };
        if (!plan.commits.length) throw new Error("no commit given");
        ledger.plans = [...ledger.plans, plan];
        break;
      }
      case "accept":
        plan = named(change.plan);
        plan.state = "accepted";
        plan.at = at;
        break;
      case "edit": {
        plan = named(change.plan);
        if (change.name && change.name.trim() !== plan.name)
          plan.name = fresh(change.name);
        let keys = change.commits ? keysOf(change.commits, plan) : plan.commits;
        if (change.add?.length)
          keys = [...new Set([...keys, ...keysOf(change.add, plan)])];
        if (change.remove?.length) {
          const { found } = resolveCommits(commits, change.remove);
          const drop = new Set(found.map((commit) => commit.key));
          keys = keys.filter((key) => !drop.has(key));
        }
        const order = new Map(
          commits.map((commit, index) => [commit.key, index]),
        );
        plan.commits = keys.sort(
          (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
        );
        if (change.dependsOn) plan.dependsOn = depends(change.dependsOn, plan);
        plan.at = at;
        break;
      }
      case "split": {
        const from = named(change.plan);
        const { found, unknown } = resolveCommits(commits, change.commits);
        if (unknown.length)
          throw new Error(
            `not in the ledger: ${unknown.slice(0, 20).join(", ")}`,
          );
        const moved = new Set(found.map((commit) => commit.key));
        if ([...moved].some((key) => !from.commits.includes(key)))
          throw new Error(`a commit to split off is not in ${from.name}`);
        if (moved.size === from.commits.length)
          throw new Error("a split leaves some commits in the plan");
        from.commits = from.commits.filter((key) => !moved.has(key));
        plan = {
          id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: fresh(change.name),
          commits: [...moved],
          dependsOn: [...from.dependsOn],
          state: from.state,
          at,
          by: input.by,
        };
        const order = new Map(
          commits.map((commit, index) => [commit.key, index]),
        );
        plan.commits.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
        ledger.plans = [...ledger.plans, plan];
        break;
      }
      case "drop": {
        const gone = named(change.plan);
        ledger.plans = ledger.plans
          .filter((each) => each !== gone)
          .map((each) => ({
            ...each,
            dependsOn: each.dependsOn.filter((id) => id !== gone.id),
          }));
        plan = gone;
        break;
      }
      case "part":
        plan = named(change.plan);
        plan.part = change.part;
        break;
    }
    const journal = journalOf(ledger, input, {}, { plans: before });
    store.writeLedger(effort.id, ledger);
    return { plan, journal };
  });
}

/** What the user saw of an effort, to tell what changed since. */
export type SeenSnapshot = {
  at: string;
  dispositions: Record<string, MrDisposition>;
  notReady: Record<string, number>;
  upstreamAnyway: string[];
  merged: string[];
};

/** Plans whose every commit is upstream now. */
function mergedPlans(derived: DerivedFile, ledger: LedgerFile): string[] {
  const state = new Map(
    derived.commits.map((commit) => [commit.key, commit.disposition]),
  );
  return ledger.plans
    .filter(
      (plan) =>
        plan.commits.length &&
        plan.commits.every((key) => state.get(key) === "upstream"),
    )
    .map((plan) => plan.id);
}

export function snapshotOf(
  derived: DerivedFile,
  ledger: LedgerFile,
  now = Date.now(),
): SeenSnapshot {
  return {
    at: new Date(now).toISOString(),
    dispositions: Object.fromEntries(
      derived.commits.map((commit) => [commit.key, commit.disposition]),
    ),
    notReady: Object.fromEntries(
      derived.feeders.map((feeder) => [feeder.ref, feeder.notReady]),
    ),
    upstreamAnyway: derived.commits
      .filter((commit) => commit.upstreamAnyway)
      .map((commit) => commit.key),
    merged: mergedPlans(derived, ledger),
  };
}

/** What changed since the snapshot (What changed, the card's count). */
export function changesOf(
  derived: DerivedFile | null,
  ledger: LedgerFile,
  seen: SeenSnapshot | null,
): MrEffortChanges {
  const empty: MrEffortChanges = {
    since: seen?.at ?? null,
    unsorted: [],
    landed: [],
    inReview: [],
    feeders: [],
    partsMerged: [],
    proposals: [],
    upstreamAnyway: [],
  };
  if (!derived) return empty;
  const decided = (key: string) => !!ledger.matches[key]?.accepted;
  empty.proposals = Object.keys(derived.proposals ?? {}).filter(
    (key) => !decided(key),
  );
  if (!seen) return empty;
  for (const commit of derived.commits) {
    const was = seen.dispositions[commit.key];
    if (was === commit.disposition) continue;
    if (commit.disposition === "unsorted") empty.unsorted.push(commit.key);
    else if (commit.disposition === "upstream") empty.landed.push(commit.key);
    else if (commit.disposition === "in_review")
      empty.inReview.push(commit.key);
  }
  for (const feeder of derived.feeders) {
    const before = seen.notReady[feeder.ref];
    if (before !== undefined && feeder.notReady < before)
      empty.feeders.push({ ref: feeder.ref, landed: before - feeder.notReady });
  }
  const merged = new Set(seen.merged);
  empty.partsMerged = mergedPlans(derived, ledger)
    .filter((id) => !merged.has(id))
    .map((id) => ledger.plans.find((plan) => plan.id === id)?.name ?? id);
  const anyway = new Set(seen.upstreamAnyway);
  empty.upstreamAnyway = derived.commits
    .filter((commit) => commit.upstreamAnyway && !anyway.has(commit.key))
    .map((commit) => commit.key);
  return empty;
}

/** How many things What changed lists (the card's count). */
export function changeCount(changes: MrEffortChanges): number {
  return (
    changes.unsorted.length +
    changes.landed.length +
    changes.inReview.length +
    changes.feeders.length +
    changes.partsMerged.length +
    changes.upstreamAnyway.length
  );
}
