import { tmpdir } from "node:os";
import type { MrCurationState, MrItem } from "../../../shared/mrReviews";
import { mrProjectKey } from "../../../shared/mrReviews";
import { type Logger, serverLogger } from "../utils/logger";
import { backgroundClaudeEnv } from "../voice/voice-cleaner";
import type { MrConnection } from "./clones";
import { shQuote } from "./clones";
import type { MrRanked, MrStore } from "./store";

/**
 * Suggestions: Claude picks, from the followed projects' open requests,
 * the few the user would want to review, each with a one-line reason. It
 * only filters: a bare model with no tool, no session file, no pane, fed
 * the user's own signals (their history in their clones, their branches,
 * the requests they reviewed and with whom, their hints and their
 * feedback as precedent). In batches, at most one at a time, rarely.
 */

/** The model measured best for the job (docs/ARCHITECTURE.md). */
export const CURATION_MODEL = "opus";
export const BATCH_SIZE = 25;
/** At most one batch this often. */
export const CURATION_EVERY_MS = 20 * 60_000;
export const PICKS_PER_BATCH = 8;
const FEEDBACK_SHOWN = 30;
const TIMEOUT_MS = 180_000;

export type Signals = {
  /** Paths (and their directories) the user committed to lately, by count. */
  paths: [string, number][];
  /** Paths of the user's own branches not merged yet. */
  branches: string[];
  /** Authors of requests the user reviewed or was asked to. */
  collaborators: string[];
  /** Requests the user reviewed: title and files. */
  reviewed: { title: string; author: string; files: string[] }[];
  hints: string;
  feedback: {
    verdict: string;
    title: string;
    project: string;
    author: string;
    files: string[];
  }[];
};

/**
 * The user's history in a clone, as `C path` (one per file of each of
 * their commits over 180 days) and `B path` (files of their recent
 * branches not in the default branch). Their identity is the clone's own
 * git user.email: nothing is assumed.
 */
export function historyScript(clone: string): string {
  return [
    `cd ${shQuote(clone)} || exit 0`,
    "e=$(git config user.email)",
    '[ -n "$e" ] || exit 0',
    'git log --since=180.days --no-merges --author="$e" --name-only --format= -n 400 2>/dev/null | sed "/^$/d; s/^/C /"',
    "base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || git rev-parse --abbrev-ref upstream/HEAD 2>/dev/null || echo main)",
    'for b in $(git for-each-ref --sort=-committerdate --count=15 --format="%(refname:short)" refs/heads); do',
    '  git log --no-merges --author="$e" --name-only --format= "$base..$b" -n 30 2>/dev/null | sed "/^$/d; s/^/B /"',
    "done | sort -u | head -300",
  ].join("\n");
}

/** Counts of files and their directories, most touched first. */
export function topPaths(files: string[], max = 60): [string, number][] {
  const counts = new Map<string, number>();
  for (const file of files) {
    counts.set(file, (counts.get(file) ?? 0) + 1);
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    if (dir) counts.set(`${dir}/`, (counts.get(`${dir}/`) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
}

export function parseHistory(stdout: string): {
  committed: string[];
  branches: string[];
} {
  const committed: string[] = [];
  const branches: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("C ")) committed.push(line.slice(2).trim());
    else if (line.startsWith("B ")) branches.push(line.slice(2).trim());
  }
  return { committed, branches: [...new Set(branches)].slice(0, 120) };
}

export const CURATION_SYSTEM_PROMPT = `You filter merge requests for one code reviewer. You never review code, never comment on the changes and never take any action: you only pick, among candidate open merge requests of projects the reviewer follows, the few they would most want to review, and say why in one short line.

Ground every pick in the reviewer's signals: files and directories they changed lately, their unmerged branches, requests they reviewed and the people involved, their own hints, and their past feedback ("more_like_this" and "not_interested" verdicts are precedent: pick what resembles the former, avoid what resembles the latter). A candidate with no concrete link to the signals is not picked. Prefer overlap with files the reviewer touched over loose topical similarity. Files every change touches (CI configuration such as .gitlab-ci.yml, top-level build files, release notes) are weak signals on their own. "people" are authors the reviewer was asked to review or reviewed: a person alone is a weak reason.

Answer with JSON only, no prose: an array with one object per candidate, in any order: {"key": the candidate's key, "pick": true or false, "score": 0-100, "reason": at most 90 characters naming the concrete signal (a file, a directory, a person, a precedent), empty when not picked}. Pick at most ${PICKS_PER_BATCH}.`;

export function curationPrompt(signals: Signals, candidates: MrItem[]): string {
  const compact = candidates.map((item) => ({
    key: item.key,
    project: item.project,
    title: item.title,
    author: item.author,
    draft: item.draft || undefined,
    files: (item.files ?? []).slice(0, 25),
  }));
  return JSON.stringify({
    reviewer: {
      changed_lately: signals.paths,
      unmerged_branches: signals.branches.slice(0, 80),
      reviewed: signals.reviewed.slice(0, 20),
      people: signals.collaborators.slice(0, 30),
      hints: signals.hints || undefined,
      feedback: signals.feedback.slice(-FEEDBACK_SHOWN),
    },
    candidates: compact,
  });
}

/** What a ranking stands on: the head and the title. */
export function versionOf(item: Pick<MrItem, "headSha" | "title">): string {
  return `${item.headSha}\n${item.title}`;
}

export type Ranking = {
  key: string;
  pick: boolean;
  score: number;
  reason: string;
};

/** The model's answer, checked: only keys it was given, a few picks. */
export function parseRanking(text: string, keys: Set<string>): Ranking[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("no JSON array in the answer");
  const raw = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(raw)) throw new Error("the answer is not an array");
  const out: Ranking[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.key !== "string" || !keys.has(entry.key))
      continue;
    const score = Math.max(0, Math.min(100, Number(entry.score) || 0));
    const reason =
      typeof entry.reason === "string"
        ? entry.reason.replace(/\s+/g, " ").trim().slice(0, 120)
        : "";
    out.push({
      key: entry.key,
      pick: entry.pick === true && !!reason,
      score,
      reason,
    });
  }
  // At most the picks asked for, the best ones.
  const picks = out
    .filter((entry) => entry.pick)
    .sort((a, b) => b.score - a.score);
  for (const extra of picks.slice(PICKS_PER_BATCH)) extra.pick = false;
  return out;
}

export type RunModel = (
  model: string,
  system: string,
  prompt: string,
) => Promise<{ text: string; costUsd?: number; ms: number }>;

/** `claude -p` as a bare model: no tool, no session, no MCP, no hooks. */
export const runClaudeModel: RunModel = async (model, system, prompt) => {
  const started = Date.now();
  const child = Bun.spawn(
    [
      "claude",
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt",
      system,
    ],
    {
      cwd: tmpdir(),
      env: backgroundClaudeEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(prompt);
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        `claude exited ${code}: ${(stderr || stdout).trim().slice(-300)}`,
      );
    const answer = JSON.parse(stdout);
    if (answer.is_error)
      throw new Error(String(answer.result ?? "error").slice(0, 300));
    return {
      text: String(answer.result ?? ""),
      ...(typeof answer.total_cost_usd === "number"
        ? { costUsd: answer.total_cost_usd }
        : {}),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
};

export function createMrCuration(deps: {
  store: MrStore;
  settings: () => Promise<{
    curation: boolean;
    hints: string;
    followed: unknown[];
    suggestDays?: number;
  }>;
  connections: () => MrConnection[];
  /** The user's name per forge host: their own requests are no picks. */
  users?: () => Map<string, string>;
  /** The user's clones of the followed projects (their history). */
  clones?: () => Promise<{ connectionId: string; path: string }[]>;
  run?: RunModel;
  model?: string;
  now?: () => number;
  logger?: Logger;
  onChange?: () => void;
}) {
  const run = deps.run ?? runClaudeModel;
  const model = deps.model ?? CURATION_MODEL;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? serverLogger.child("mr-reviews");
  let running: Promise<void> | null = null;
  let lastRun = 0;
  let status: MrCurationState = { state: "idle" };

  async function signals(items: MrItem[], hints: string): Promise<Signals> {
    const state = deps.store.get();
    const committed: string[] = [];
    const branches: string[] = [];
    const clones = new Map<string, { connectionId: string; path: string }>();
    for (const project of Object.values(state.projects))
      clones.set(`${project.connectionId}\n${project.clone}`, {
        connectionId: project.connectionId,
        path: project.clone,
      });
    for (const clone of (await deps.clones?.().catch(() => [])) ?? [])
      clones.set(`${clone.connectionId}\n${clone.path}`, clone);
    for (const clone of clones.values()) {
      const conn = deps.connections().find((c) => c.id === clone.connectionId);
      if (!conn) continue;
      try {
        const history = parseHistory(
          (await conn.run(historyScript(clone.path), 60_000)).stdout,
        );
        committed.push(...history.committed);
        branches.push(...history.branches);
      } catch {}
    }
    const byKey = new Map(items.map((item) => [item.key, item]));
    const reviewedItems = Object.keys(state.reviews)
      .map((key) => byKey.get(key))
      .filter((item): item is MrItem => !!item);
    const mine = items.filter((item) => item.reasons.length);
    return {
      paths: topPaths(committed),
      branches: [...new Set(branches)],
      collaborators: [
        ...new Set(
          [...reviewedItems, ...mine]
            .filter((item) => !own(item))
            .map((item) => item.author)
            .filter(Boolean),
        ),
      ],
      reviewed: reviewedItems.map((item) => ({
        title: item.title,
        author: item.author,
        files: (item.files ?? []).slice(0, 15),
      })),
      hints,
      feedback: state.feedback.map((entry) => ({
        verdict: entry.verdict,
        title: entry.title,
        project: entry.project,
        author: entry.author,
        files: entry.files.slice(0, 10),
      })),
    };
  }

  /** The candidates not ranked at their current state, newest first. */
  function own(item: MrItem): boolean {
    return deps.users?.().get(item.host) === item.author.toLowerCase();
  }

  /**
   * The candidates not ranked on their current head and title, updated
   * lately, newest first: a first run ranks the recent ones, and an old
   * request comes back only once it changes.
   */
  function candidates(items: MrItem[], days: number): MrItem[] {
    const state = deps.store.get();
    const since = now() - days * 24 * 60 * 60_000;
    const dismissed = new Set(
      state.feedback
        .filter((f) => f.verdict === "not_interested")
        .map((f) => f.key),
    );
    return items
      .filter(
        (item) =>
          item.state === "open" &&
          !item.reasons.length &&
          !own(item) &&
          !dismissed.has(item.key) &&
          Date.parse(item.updatedAt) >= since &&
          state.ranked[item.key]?.version !== versionOf(item),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, BATCH_SIZE);
  }

  async function batch(items: MrItem[]) {
    const settings = await deps.settings();
    if (!settings.curation || !settings.followed.length) {
      status = { state: "off" };
      return;
    }
    const batchItems = candidates(items, settings.suggestDays ?? 30);
    if (!batchItems.length) return;
    status = { state: "running", at: new Date(now()).toISOString() };
    deps.onChange?.();
    const answer = await run(
      model,
      CURATION_SYSTEM_PROMPT,
      curationPrompt(await signals(items, settings.hints), batchItems),
    );
    const ranking = parseRanking(
      answer.text,
      new Set(batchItems.map((item) => item.key)),
    );
    const at = new Date(now()).toISOString();
    deps.store.update((state) => {
      for (const item of batchItems) {
        const entry = ranking.find((each) => each.key === item.key);
        const ranked: MrRanked = {
          updatedAt: item.updatedAt,
          version: versionOf(item),
          pick: entry?.pick ?? false,
          score: entry?.score ?? 0,
          reason: entry?.reason ?? "",
          at,
        };
        state.ranked[item.key] = ranked;
      }
    });
    logger.info("suggestions ranked", {
      model,
      candidates: batchItems.length,
      picked: ranking.filter((entry) => entry.pick).length,
      ms: answer.ms,
      ...(answer.costUsd !== undefined ? { cost_usd: answer.costUsd } : {}),
    });
    status = { state: "idle", at };
  }

  return {
    state: (): MrCurationState => status,
    /** After a refresh: one batch when due and none is running. */
    maybeRun(items: MrItem[], force = false): Promise<void> {
      if (running) return running;
      if (!force && now() - lastRun < CURATION_EVERY_MS)
        return Promise.resolve();
      lastRun = now();
      running = batch(items)
        .catch((error) => {
          status = {
            state: "error",
            at: new Date(now()).toISOString(),
            message: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 300),
          };
          logger.warn("suggestions not ranked", { error: status.message });
        })
        .finally(() => {
          running = null;
          deps.onChange?.();
        });
      return running;
    },
    key: mrProjectKey,
  };
}

export type MrCuration = ReturnType<typeof createMrCuration>;
