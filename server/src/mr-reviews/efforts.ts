import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MR_DISPOSITIONS,
  type MrDisposition,
  type MrEffort,
  type MrEffortSummary,
  type MrOverlap,
} from "../../../shared/mrReviews";
import { replaceDataFile } from "../config/data-paths";
import { type MrConnection, shQuote } from "./clones";

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

export type LedgerFile = {
  version: number;
  /** By ledger key (the patch id the commit was first seen with). */
  entries: Record<string, AuthoredEntry>;
  /** A later patch id of a commit, to its ledger key. */
  aliases: Record<string, string>;
  /** The last bulk changes, newest last, for Undo. */
  journal: {
    id: number;
    at: string;
    by: "user" | "agent";
    summary: string;
    before: Record<string, AuthoredEntry | null>;
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
  error?: string;
};

export const emptyLedger = (): LedgerFile => ({
  version: 0,
  entries: {},
  aliases: {},
  journal: [],
});

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
    `printf "S\\t%s\\n" "$(git -C "$d" rev-parse -q --verify ${shQuote(effort.source)} 2>/dev/null)"`,
    `t=$(git -C "$d" rev-parse -q --verify ${shQuote(local)} 2>/dev/null) || t=$(git -C "$d" rev-parse -q --verify ${shQuote(`refs/remotes/${effort.target.remote}/${effort.target.branch}`)} 2>/dev/null)`,
    'printf "T\\t%s\\n" "$t"',
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
  const feeders: { ref: string; sha: string }[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, a = "", b = ""] = line.split("\t");
    if (kind === "S") source = a;
    else if (kind === "T") target = a;
    else if (kind === "F") feeders.push({ ref: a, sha: b });
    else if (kind === "E") error = a;
    else if (kind === "U") url = a;
  }
  return { source, target, feeders, error, url };
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
    `git -C "$d" log --no-merges --format='N%x09%H' --name-only ${shQuote(range)}`,
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
  let files: string[] | null = null;
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
        patchId: "",
        upstream: false,
      };
      commits.push(commit);
      bySha.set(commit.sha, commit);
      files = null;
    } else if (kind === "N" && parts.length === 2) {
      files = bySha.get(parts[1]!)?.files ?? null;
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
    } else if (line && files && !line.includes("\t")) files.push(line);
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

/** An effort's files: ledger, derived, history; written one at a time. */
export function createLedgerStore(root: string) {
  const queues = new Map<string, Promise<unknown>>();
  const dirOf = (id: string) => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const read = <T>(file: string, empty: () => T): T => {
    try {
      return existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as T)
        : empty();
    } catch {
      return empty();
    }
  };
  return {
    ledger: (id: string) => read(join(dirOf(id), "ledger.json"), emptyLedger),
    derived: (id: string): DerivedFile | null =>
      read<DerivedFile | null>(join(dirOf(id), "derived.json"), () => null),
    writeLedger(id: string, ledger: LedgerFile) {
      replaceDataFile(
        join(dirOf(id), "ledger.json"),
        `${JSON.stringify(ledger)}\n`,
      );
    },
    writeDerived(id: string, derived: DerivedFile) {
      replaceDataFile(
        join(dirOf(id), "derived.json"),
        `${JSON.stringify(derived)}\n`,
      );
    },
    /** Appends versions of commits (D24): one line each, never rewritten. */
    appendHistory(id: string, lines: Record<string, unknown>[]) {
      if (!lines.length) return;
      appendFileSync(
        join(dirOf(id), "history.jsonl"),
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
    },
    history(id: string, key?: string): Record<string, any>[] {
      const file = join(dirOf(id), "history.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line) => {
          if (!line) return [];
          try {
            const value = JSON.parse(line);
            return !key || value.key === key ? [value] : [];
          } catch {
            return [];
          }
        });
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
): MrEffortSummary {
  const commits = derived?.commits ?? [];
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
  const partsKey = (input.parts ?? [])
    .map((each) => `${each.label}:${each.ids.size}`)
    .join(",");
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
        dir: topDir(commit.files),
        ...disposition(
          commit,
          current.entries[ledgerKey],
          review.get(commit.patchId),
          part.get(commit.patchId),
        ),
      };
    });
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
    };
    store.writeDerived(effort.id, derived);
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
    const unknown: string[] = [];
    const found: DerivedCommit[] = [];
    for (const name of input.commits) {
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
