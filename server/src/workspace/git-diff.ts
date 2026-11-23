import { randomUUID } from "node:crypto";
import {
  parseRefsOutput,
  refsScript,
  resolveDefaultBase,
  selectDiffBase,
} from "./diff-base";
import { LARGE_DIFF_PATCH_BYTES } from "../../../shared/gitDiffLimits";
import { worktreeSnapshotCommand } from "./git-snapshot";
import { GIT_ONLY, gitShellCommandArgv } from "./git-shell";
import { combinedDiffScript, parseCombinedDiffOutput } from "./git-combined";
import { collectWorktreeFingerprints } from "./git-actions";
import {
  GIT_DIFF_MAX_BYTES,
  GIT_DIFF_TIMEOUT_MS,
  GIT_PULL_TIMEOUT_MS,
  GIT_UNTRACKED_NUMSTAT_BATCH_SIZE,
  GIT_UNTRACKED_NUMSTAT_CONCURRENCY,
  GIT_UNTRACKED_NUMSTAT_MAX_FILES,
} from "./file-constants";
import { sanitizeExplorerPath } from "./file-paths";
import { trimIncompleteUtf8Tail } from "./preview";
import type {
  GitDiffEntry,
  GitDiffKind,
  GitDiffMode,
  RunProcessWithCodeTimeout,
} from "./file-types";
import {
  BATCH_BLOCK_SH,
  BATCH_SH,
  CAPPED_DIFF_SH,
  LAST_STEP_REFS_SH,
  UNTRACKED_NUMSTAT_SH,
  fillTemplate,
} from "../assets";

const GIT_ATTRIBUTE_BATCH_SIZE = 100;
const LAST_STEP_SNAPSHOT_LIMIT = 64;
const LAST_STEP_STORE_DISPOSED = "LAST_STEP_STORE_DISPOSED";

function lastStepStoreDisposedError() {
  return Object.assign(new Error("last-step snapshot store is disposed"), {
    code: LAST_STEP_STORE_DISPOSED,
  });
}

/**
 * A completed last step: its trees, and as a review target its
 * id (the name of the refs keeping them), when it ended and the untracked
 * files its snapshots left out.
 */
export type LastStepRange = {
  baseline: string;
  current: string;
  step?: string;
  at?: string;
  skipped?: string[];
};

/** Steps kept under refs besides the ones with threads. */
export const LAST_STEPS_KEPT = 5;

/**
 * The steps of a checkout whose review has threads: their refs are kept
 * past the last LAST_STEPS_KEPT. Set by the review service.
 */
let lastStepKeeper: ((root: string) => readonly string[]) | null = null;

export function keepLastSteps(
  keeper: ((root: string) => readonly string[]) | null,
) {
  lastStepKeeper = keeper;
}

const STEP_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

/** The refs of a workspace's steps: `refs/roamgate/steps/<workspace>/`. */
export function lastStepRefPrefix(workspaceId: string): string {
  const name = workspaceId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  return `refs/roamgate/steps/${name || "_"}`;
}

/** A new step's id: its end in ms (sorts by time), and a few random letters. */
export function newLastStepId(at: number): string {
  return `${String(at).padStart(13, "0")}-${randomUUID().slice(0, 8)}`;
}

/** When a step ended, from its id. */
function lastStepTime(step: string): string | undefined {
  const ms = Number(step.split("-")[0]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/**
 * Keeps a step's trees under refs (and the untracked files it left out, as
 * a blob), then drops the refs of the workspace's older steps but the last
 * LAST_STEPS_KEPT and the ones `keep` names (they have threads): git
 * collects their trees as before.
 */
export async function persistLastStep({
  root,
  workspaceId,
  step,
  range,
  keep,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  workspaceId: string;
  step: string;
  range: { baseline: string; current: string; skipped?: string[] };
  keep: readonly string[];
} & GitCommandContext): Promise<void> {
  const prefix = lastStepRefPrefix(workspaceId);
  const kept = keep.filter((id) => STEP_ID.test(id)).join(" ");
  const skipped = range.skipped ?? [];
  const command = fillTemplate(LAST_STEP_REFS_SH, {
    root: shQuote(root),
    prefix: shQuote(prefix),
    before_ref: shQuote(`${prefix}/${step}/before`),
    baseline: shQuote(range.baseline),
    after_ref: shQuote(`${prefix}/${step}/after`),
    current: shQuote(range.current),
    skipped: skipped.length > 0,
    skipped_paths: skipped.map((path) => shQuote(path)).join(" "),
    skipped_ref: shQuote(`${prefix}/${step}/skipped`),
    keep_from: LAST_STEPS_KEPT + 1,
    kept,
  });
  const result = await runProcessWithCodeTimeout(
    gitShellCommandArgv(command, host),
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0)
    throw new Error(
      (result.stderr || `git update-ref exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
}

/**
 * The workspace's latest step kept under refs, after a restart lost the one
 * in memory; undefined when none is.
 */
export async function readLastStepRefs({
  root,
  workspaceId,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: { root: string; workspaceId: string } & GitCommandContext): Promise<
  LastStepRange | undefined
> {
  const prefix = lastStepRefPrefix(workspaceId);
  const listed = await runProcessWithCodeTimeout(
    gitShellCommandArgv(
      `cd ${shQuote(root)} && git for-each-ref --format='%(refname) %(objectname)' ${shQuote(`${prefix}/`)}`,
      host,
      GIT_ONLY,
    ),
    GIT_DIFF_TIMEOUT_MS,
  );
  if (listed.code !== 0) return undefined;
  const steps = new Map<string, Record<string, string>>();
  for (const line of listed.stdout.split("\n")) {
    const [ref, object] = line.trim().split(" ");
    if (!ref || !object || !ref.startsWith(`${prefix}/`)) continue;
    const [id, end] = ref.slice(prefix.length + 1).split("/");
    if (!id || !end || !STEP_ID.test(id)) continue;
    steps.set(id, { ...steps.get(id), [end]: object });
  }
  const step = [...steps.keys()]
    .filter((id) => steps.get(id)?.before && steps.get(id)?.after)
    .sort()
    .pop();
  if (!step) return undefined;
  const ends = steps.get(step)!;
  let skipped: string[] = [];
  if (ends.skipped) {
    const blob = await runProcessWithCodeTimeout(
      gitShellCommandArgv(
        `cd ${shQuote(root)} && git cat-file blob ${shQuote(ends.skipped)}`,
        host,
        GIT_ONLY,
      ),
      GIT_DIFF_TIMEOUT_MS,
    );
    if (blob.code === 0) skipped = blob.stdout.split("\n").filter(Boolean);
  }
  const at = lastStepTime(step);
  return {
    baseline: ends.before!,
    current: ends.after!,
    step,
    ...(at ? { at } : {}),
    ...(skipped.length ? { skipped } : {}),
  };
}

export type LastStepBaselineStore = {
  captureWorkspace: (
    workspaceId: string,
    resolveRoot: () => Promise<string>,
  ) => Promise<string>;
  completeWorkspace: (workspaceId: string) => Promise<boolean>;
  resolveCompleted: (
    workspaceId: string,
    root: string,
  ) => Promise<{ baseline: string; current: string } | undefined>;
  /**
   * The completed step as a review target needs it: its id,
   * end and left-out files too; after a restart, the latest one kept under
   * refs.
   */
  completedStep?: (
    workspaceId: string,
    root: string,
  ) => Promise<LastStepRange | undefined>;
  rememberSnapshot: (
    workspaceId: string,
    root: string,
    baseline: string,
    current: string,
  ) => string;
  resolveSnapshot: (
    workspaceId: string,
    root: string,
    snapshotId: string,
  ) => { baseline: string; current: string } | undefined;
  deleteSnapshot: (snapshotId: string) => void;
  invalidateWorkspace: (workspaceId: string, root: string) => void;
  dispose: () => Promise<void>;
};

type WorkspaceActivityCycle = {
  version: number;
  capture: Promise<{ root: string; baseline: string; skipped: string[] }>;
  completion?: Promise<boolean>;
  nextCapture?: Promise<{ root: string; baseline: string; skipped: string[] }>;
  /** The previous turn's end, when this turn started before it was done. */
  priorCompletion?: Promise<boolean>;
};

type GitCommandContext = {
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
};

// Git quotes paths containing spaces, quotes, backslashes, or control
// characters C-style ("a\nb"). core.quotepath=false only keeps non-ASCII
// raw, so undo the quoting before using paths as file identities.
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }
  const body = path.slice(1, -1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = body[(index += 1)];
    if (next === undefined) {
      result += "\\";
      break;
    }
    if (next >= "0" && next <= "7") {
      const octal = body.slice(index, index + 3);
      if (/^[0-7]{3}$/.test(octal)) {
        result += String.fromCharCode(Number.parseInt(octal, 8));
        index += 2;
        continue;
      }
      result += next;
      continue;
    }
    switch (next) {
      case "a":
        result += "\x07";
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "v":
        result += "\v";
        break;
      case "\\":
        result += "\\";
        break;
      default:
        result += next;
    }
  }
  return result;
}

export function statusLabel(code: string, kind: GitDiffKind) {
  if (kind === "untracked") return "untracked";
  if (kind === "conflicted") return "conflicted";
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type changed";
    case "M":
    default:
      return "modified";
  }
}

function isConflictedStatus(x: string, y: string) {
  return (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  );
}

export function parseStatusSummary(output: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const rawPath = line.slice(3);
    const renameParts = rawPath.split(" -> ");
    const oldPath =
      renameParts.length > 1 ? unquoteGitPath(renameParts[0] ?? "") : undefined;
    const path = unquoteGitPath(
      renameParts.length > 1 ? renameParts.slice(1).join(" -> ") : rawPath,
    );
    if (!path) continue;

    if (x === "?" && y === "?") {
      entries.push({
        path,
        kind: "untracked",
        status: "untracked",
      });
      continue;
    }
    if (isConflictedStatus(x, y)) {
      entries.push({
        path,
        old_path: oldPath,
        kind: "conflicted",
        status: "conflicted",
      });
      continue;
    }
    if (x !== " ") {
      entries.push({
        path,
        old_path: oldPath,
        kind: "staged",
        status: statusLabel(x, "staged"),
      });
    }
    if (y !== " ") {
      entries.push({
        path,
        old_path: oldPath,
        kind: "unstaged",
        status: statusLabel(y, "unstaged"),
      });
    }
  }
  return entries.sort(
    (a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: "base" }) ||
      a.kind.localeCompare(b.kind),
  );
}

export function parseBranchSummary(
  output: string,
  kind: "branch" | "last-step" = "branch",
): GitDiffEntry[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const rawStatus = parts[0] ?? "";
      const renamed = rawStatus.startsWith("R") || rawStatus.startsWith("C");
      const path = unquoteGitPath(
        renamed ? (parts[2] ?? parts[1] ?? "") : (parts[1] ?? ""),
      );
      const oldPath =
        renamed && parts[1] ? unquoteGitPath(parts[1]) : undefined;
      return {
        path,
        old_path: oldPath,
        kind,
        status: statusLabel(rawStatus[0] ?? "M", kind),
      };
    })
    .filter((entry) => entry.path)
    .sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
    );
}

function parseNumstatValue(value: string) {
  if (value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumstatPath(raw: string) {
  const trimmed = raw.trim();
  const tabParts = trimmed.split("\t").filter(Boolean);
  const path = tabParts[tabParts.length - 1] ?? trimmed;
  const braceRename = /\{.*? => (.*?)\}/.exec(path);
  if (braceRename) return path.replace(/\{.*? => (.*?)\}/, "$1");
  const arrowIndex = path.lastIndexOf(" => ");
  if (arrowIndex >= 0) return path.slice(arrowIndex + 4).replace(/[{}]/g, "");
  return path;
}

function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parseNumstatValue(parts[0] ?? "0");
    const deletions = parseNumstatValue(parts[1] ?? "0");
    const path = unquoteGitPath(
      normalizeNumstatPath(parts.slice(2).join("\t")),
    );
    if (!path) continue;
    const current = stats.get(path) ?? { additions: 0, deletions: 0 };
    stats.set(path, {
      additions: current.additions + additions,
      deletions: current.deletions + deletions,
    });
  }
  return stats;
}

export function parseGeneratedAttributes(output: string) {
  const generatedPaths = new Map<string, boolean>();
  const fields = output.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index] ?? "";
    const attribute = fields[index + 1] ?? "";
    const value = (fields[index + 2] ?? "").toLowerCase();
    if (
      !path ||
      !["linguist-generated", "gitlab-generated"].includes(attribute)
    )
      continue;
    if (value === "unset" || value === "false") generatedPaths.set(path, false);
    else if (
      (value === "set" || value === "true") &&
      generatedPaths.get(path) !== false
    )
      generatedPaths.set(path, true);
  }
  return generatedPaths;
}

function entryKeyForStats(entry: Pick<GitDiffEntry, "kind" | "path">) {
  return `${entry.kind}:${entry.path}`;
}

function diffMode(params: Record<string, unknown>): GitDiffMode {
  if (params.mode === "branch-main") return "branch-main";
  if (params.mode === "last-step") return "last-step";
  return "working";
}

function diffFileKind(mode: GitDiffMode, requestedKind: unknown): GitDiffKind {
  if (mode === "branch-main") return "branch";
  if (mode === "last-step") return "last-step";
  if (
    requestedKind === "staged" ||
    requestedKind === "untracked" ||
    requestedKind === "conflicted" ||
    requestedKind === "combined"
  ) {
    return requestedKind;
  }
  return "unstaged";
}

function workingDiffFileCommand(
  kind: GitDiffKind,
  path: string,
  pathspec: string,
  shQuote: (value: string) => string,
) {
  switch (kind) {
    case "staged":
      return `diff --cached --no-ext-diff -- ${pathspec}`;
    case "untracked":
      return `diff --no-ext-diff --no-index -- /dev/null ${shQuote(path)}`;
    case "conflicted":
      return `diff --cc --no-ext-diff -- ${pathspec}`;
    default:
      return `diff --no-ext-diff -- ${pathspec}`;
  }
}

function runGitShellCommand({
  root,
  command,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  timeoutMs = GIT_DIFF_TIMEOUT_MS,
}: {
  root: string;
  command: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  timeoutMs?: number;
}) {
  const fullCommand = `git -C ${shQuote(root)} -c core.quotepath=false ${command}`;
  return runProcessWithCodeTimeout(
    gitShellCommandArgv(fullCommand, host, GIT_ONLY),
    timeoutMs,
  );
}

// Keep full patches out of bridge/SSH memory, including explicitly opened
// oversized files. mktemp creates a private file and the trap removes it.
/** The script that writes one patch's size line, then its capped bytes. */
function gitPatchScript(
  root: string,
  command: string,
  shQuote: (value: string) => string,
  automatic: boolean,
) {
  return fillTemplate(CAPPED_DIFF_SH, {
    root: shQuote(root),
    command,
    automatic: automatic ? "1" : "0",
    large_patch_bytes: LARGE_DIFF_PATCH_BYTES,
    head_bytes: GIT_DIFF_MAX_BYTES + 4,
  });
}

function parseGitPatchOutput(
  result: { code: number; stdout: string; stderr: string },
  automatic: boolean,
) {
  if (result.code !== 0 && result.code !== 1)
    return {
      ...result,
      diff: "",
      patch_size: 0,
      truncated: false,
      deferred: false,
    };
  const newline = result.stdout.indexOf("\n");
  const patchSize = Number(result.stdout.slice(0, newline).trim());
  if (newline < 0 || !Number.isSafeInteger(patchSize) || patchSize < 0)
    throw new Error("invalid Git patch size");
  const truncated = patchSize > GIT_DIFF_MAX_BYTES;
  const prefix = Buffer.from(result.stdout.slice(newline + 1));
  return {
    ...result,
    diff: truncated
      ? trimIncompleteUtf8Tail(prefix.subarray(0, GIT_DIFF_MAX_BYTES)).toString(
          "utf8",
        )
      : prefix.toString("utf8"),
    patch_size: patchSize,
    truncated,
    deferred: automatic && patchSize >= LARGE_DIFF_PATCH_BYTES,
  };
}

// Keep full patches out of bridge/SSH memory, including explicitly opened
// oversized files. mktemp creates a private file and the trap removes it.
export async function readGitPatch({
  root,
  command,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  automatic = false,
}: { root: string; command: string; automatic?: boolean } & GitCommandContext) {
  const result = await runProcessWithCodeTimeout(
    gitShellCommandArgv(
      gitPatchScript(root, command, shQuote, automatic),
      host,
      GIT_ONLY,
    ),
    GIT_DIFF_TIMEOUT_MS,
  );
  return parseGitPatchOutput(result, automatic);
}

/**
 * Runs several self-contained scripts as one shell command (one process, or
 * one SSH round trip, instead of one per script) and gives back each one's
 * exit code, output and error output.
 */
export async function runScriptBatch({
  scripts,
  host,
  runProcessWithCodeTimeout,
  timeoutMs = GIT_DIFF_TIMEOUT_MS,
}: {
  scripts: string[];
  host?: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }[]> {
  // One script runs as it is, with no framing to send.
  if (scripts.length === 1)
    return [
      await runProcessWithCodeTimeout(
        gitShellCommandArgv(scripts[0]!, host, GIT_ONLY),
        timeoutMs,
      ),
    ];
  const marker = `ROAMGATE-BATCH-${randomUUID()}`;
  const blocks = scripts.map((script, index) =>
    fillTemplate(BATCH_BLOCK_SH, { index, script }),
  );
  const command = fillTemplate(BATCH_SH, { marker, blocks: blocks.join("\n") });
  const result = await runProcessWithCodeTimeout(
    gitShellCommandArgv(command, host, GIT_ONLY),
    timeoutMs,
  );
  const outputs = scripts.map(() => ({ code: -1, stdout: "", stderr: "" }));
  const parts = result.stdout.split(`\n${marker} `);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    const head = (newline < 0 ? part : part.slice(0, newline)).split(" ");
    const body = newline < 0 ? "" : part.slice(newline + 1);
    const index = Number(head[1]);
    const output = outputs[index];
    if (!output) continue;
    if (head[0] === "B") output.stdout = body;
    else if (head[0] === "E") {
      output.code = Number(head[2]);
      output.stderr = body;
    }
  }
  const failure = (result.stderr || result.stdout || "").trim().slice(0, 1000);
  for (const output of outputs)
    if (output.code === -1) {
      output.code = result.code || 1;
      output.stderr ||= failure || "git diff did not answer";
    }
  return outputs;
}

export async function snapshotWorktreeTree(
  args: { root: string } & GitCommandContext,
): Promise<string> {
  return (await snapshotWorktree(args)).tree;
}

/**
 * The checkout's files as a tree (`git write-tree` of a private index), and
 * the untracked files left out of it for their size.
 */
export async function snapshotWorktree({
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: { root: string } & GitCommandContext): Promise<{
  tree: string;
  skipped: string[];
}> {
  const command = worktreeSnapshotCommand(root, shQuote);
  const result = await runProcessWithCodeTimeout(
    gitShellCommandArgv(command, host),
    GIT_DIFF_TIMEOUT_MS,
  );
  const lines = result.stdout.trim().split("\n");
  const tree = (lines[lines.length - 1] ?? "").trim();
  const skipped = lines
    .filter((line) => line.startsWith("skipped\t"))
    .map((line) => line.slice("skipped\t".length));
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(
      (result.stderr || result.stdout || `git write-tree exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return { tree, skipped };
}

export function createLastStepBaselineStore(
  context: GitCommandContext,
  /**
   * `refs`: each completed step's trees are kept under refs, and
   * read back after a restart. Off, steps live in memory only.
   */
  { refs = false }: { refs?: boolean } = {},
): LastStepBaselineStore {
  const workspaceVersions = new Map<string, number>();
  const completedRanges = new Map<string, LastStepRange & { root: string }>();
  /** Steps read back from refs after a restart, by workspace and root. */
  const recovered = new Map<string, Promise<LastStepRange | undefined>>();
  const completedVersions = new Map<string, number>();
  const activityCycles = new Map<string, WorkspaceActivityCycle>();
  const snapshots = new Map<
    string,
    { workspaceId: string; root: string; baseline: string; current: string }
  >();
  const inFlight = new Set<Promise<unknown>>();
  const snapshotQueues = new Map<string, Promise<unknown>>();
  let disposed = false;
  let disposeTask: Promise<void> | null = null;

  function assertActive() {
    if (disposed) throw lastStepStoreDisposedError();
  }

  function track<T>(task: Promise<T>): Promise<T> {
    inFlight.add(task);
    const remove = () => inFlight.delete(task);
    void task.then(remove, remove);
    return task;
  }

  function clearState() {
    workspaceVersions.clear();
    completedRanges.clear();
    completedVersions.clear();
    activityCycles.clear();
    snapshots.clear();
    recovered.clear();
  }

  function deleteSnapshots(
    predicate: (workspaceId: string, root: string) => boolean,
  ) {
    for (const [snapshotId, snapshot] of snapshots) {
      if (predicate(snapshot.workspaceId, snapshot.root)) {
        snapshots.delete(snapshotId);
      }
    }
  }

  // Serialize captures sharing a checkout within this store. The on-disk
  // quarantine lock also excludes other stores and survives uncertain exits.
  function enqueueForRoot<T>(root: string, task: () => Promise<T>): Promise<T> {
    const prior = snapshotQueues.get(root) ?? Promise.resolve();
    const turn = prior.then(task);
    // The chain carries only the settlement so a failed turn cannot reject
    // later turns; callers still receive the original rejection.
    snapshotQueues.set(
      root,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    return turn;
  }

  async function snapshotRoot(
    root: string,
  ): Promise<{ tree: string; skipped: string[] }> {
    return enqueueForRoot(root, () =>
      snapshotWorktree({
        root,
        ...context,
      }),
    );
  }

  /**
   * Lets a read see the workspace's steps as of its call: the current
   * turn's baseline captured (so the turn's edits are not in it, however
   * soon they follow the read), and any turn's end that is still being
   * recorded. A failed capture or end keeps the previous step.
   */
  async function settleWorkspace(workspaceId: string) {
    const cycle = activityCycles.get(workspaceId);
    if (!cycle) return;
    await Promise.allSettled([
      cycle.capture,
      cycle.completion,
      cycle.priorCompletion,
    ]);
  }

  return {
    captureWorkspace(workspaceId, resolveRoot) {
      if (disposed) return Promise.reject(lastStepStoreDisposedError());
      const priorCycle = activityCycles.get(workspaceId);
      const version = (workspaceVersions.get(workspaceId) ?? 0) + 1;
      workspaceVersions.set(workspaceId, version);
      const capture = track(
        (async () => {
          const root = await resolveRoot();
          assertActive();
          const { tree: baseline, skipped } = await snapshotRoot(root);
          assertActive();
          return { root, baseline, skipped };
        })(),
      );
      const cycle: WorkspaceActivityCycle = {
        version,
        capture,
        ...(priorCycle?.completion
          ? { priorCompletion: priorCycle.completion }
          : {}),
      };
      activityCycles.set(workspaceId, cycle);
      if (priorCycle?.completion) priorCycle.nextCapture = capture;
      return capture.then((result) => result.baseline);
    },
    completeWorkspace(workspaceId) {
      if (disposed) return Promise.reject(lastStepStoreDisposedError());
      const cycle = activityCycles.get(workspaceId);
      if (!cycle) return Promise.resolve(false);
      if (cycle.completion) return cycle.completion;
      const task = (async () => {
        let captured: { root: string; baseline: string; skipped: string[] };
        try {
          captured = await cycle.capture;
        } catch {
          return false;
        }
        const after = await snapshotRoot(captured.root);
        let current = after.tree;
        let skippedAfter = after.skipped;
        if (cycle.nextCapture) {
          try {
            const next = await cycle.nextCapture;
            if (next.root === captured.root) {
              current = next.baseline;
              skippedAfter = next.skipped;
            }
          } catch {
            // Do not publish a potentially late endpoint after a newer period
            // started but failed to establish its boundary snapshot.
            return false;
          }
        }
        if (disposed) return false;
        if ((completedVersions.get(workspaceId) ?? 0) >= cycle.version) {
          return false;
        }
        completedVersions.set(workspaceId, cycle.version);
        const ended = Date.now();
        const step = newLastStepId(ended);
        const skipped = [
          ...new Set([...captured.skipped, ...skippedAfter]),
        ].sort();
        completedRanges.set(workspaceId, {
          root: captured.root,
          baseline: captured.baseline,
          current,
          step,
          at: new Date(ended).toISOString(),
          ...(skipped.length ? { skipped } : {}),
        });
        recovered.delete(`${workspaceId}\n${captured.root}`);
        // Kept under refs, so the step's review outlives a restart and gc;
        // without them the step still shows until then.
        if (refs)
          try {
            await persistLastStep({
              root: captured.root,
              workspaceId,
              step,
              range: { baseline: captured.baseline, current, skipped },
              keep: lastStepKeeper?.(captured.root) ?? [],
              ...context,
            });
          } catch {
            // Best effort: the step shows from memory.
          }
        deleteSnapshots(
          (snapshotWorkspaceId) => snapshotWorkspaceId === workspaceId,
        );
        return true;
      })();
      cycle.completion = track(task);
      return cycle.completion;
    },
    async resolveCompleted(workspaceId, root) {
      if (disposed) return undefined;
      await settleWorkspace(workspaceId);
      const range = completedRanges.get(workspaceId);
      if (!range || range.root !== root) return undefined;
      return { baseline: range.baseline, current: range.current };
    },
    async completedStep(workspaceId, root) {
      if (disposed) return undefined;
      await settleWorkspace(workspaceId);
      const range = completedRanges.get(workspaceId);
      if (range && range.root === root) {
        const step: LastStepRange = { ...range };
        delete (step as { root?: string }).root;
        return step;
      }
      if (range) return undefined;
      // After a restart: the latest step kept under refs, read once.
      const key = `${workspaceId}\n${root}`;
      let found = recovered.get(key);
      if (!refs) return undefined;
      if (!found) {
        found = readLastStepRefs({ root, workspaceId, ...context }).catch(
          () => undefined,
        );
        recovered.set(key, found);
      }
      return found;
    },
    rememberSnapshot(workspaceId, root, baseline, current) {
      assertActive();
      const snapshotId = randomUUID();
      snapshots.set(snapshotId, { workspaceId, root, baseline, current });
      while (snapshots.size > LAST_STEP_SNAPSHOT_LIMIT) {
        const oldest = snapshots.keys().next().value;
        if (typeof oldest !== "string") break;
        snapshots.delete(oldest);
      }
      return snapshotId;
    },
    resolveSnapshot(workspaceId, root, snapshotId) {
      const snapshot = snapshots.get(snapshotId);
      if (
        !snapshot ||
        snapshot.workspaceId !== workspaceId ||
        snapshot.root !== root
      ) {
        return undefined;
      }
      return { baseline: snapshot.baseline, current: snapshot.current };
    },
    deleteSnapshot: (snapshotId) => snapshots.delete(snapshotId),
    invalidateWorkspace(workspaceId, root) {
      deleteSnapshots(
        (snapshotWorkspaceId, snapshotRoot) =>
          snapshotWorkspaceId === workspaceId && snapshotRoot === root,
      );
      const range = completedRanges.get(workspaceId);
      if (range?.root === root) {
        completedRanges.delete(workspaceId);
        completedVersions.delete(workspaceId);
      }
      recovered.set(`${workspaceId}\n${root}`, Promise.resolve(undefined));
    },
    dispose() {
      if (disposeTask) return disposeTask;
      disposed = true;
      disposeTask = (async () => {
        // Git subprocess failures are owned by their original callers. This
        // shutdown boundary only drains every task before final state clearing.
        await Promise.allSettled(Array.from(inFlight));
        clearState();
        // Uncertain captures own their quarantine until operator recovery.
        snapshotQueues.clear();
      })();
      return disposeTask;
    },
  };
}

async function treeExists({
  root,
  tree,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: { root: string; tree: string } & GitCommandContext) {
  const result = await runGitShellCommand({
    root,
    command: `cat-file --batch-check=${shQuote("%(objectname) %(objecttype)")} <<'HERDR_EOF'\n${tree}\nHERDR_EOF`,
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git cat-file exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  const output = result.stdout.trim();
  if (output === `${tree} missing`) return false;
  if (output === `${tree} tree`) return true;
  throw new Error(`unexpected git cat-file response: ${output.slice(0, 1000)}`);
}

async function collectGeneratedPaths({
  root,
  entries,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  entries: GitDiffEntry[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const generatedPaths = new Map<string, boolean>();
  const paths = Array.from(new Set(entries.map((entry) => entry.path)));
  for (let index = 0; index < paths.length; index += GIT_ATTRIBUTE_BATCH_SIZE) {
    const batch = paths.slice(index, index + GIT_ATTRIBUTE_BATCH_SIZE);
    const result = await runGitShellCommand({
      root,
      command: `check-attr -z linguist-generated gitlab-generated -- ${batch.map(shQuote).join(" ")}`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
    if (result.code !== 0) continue;
    for (const [path, generated] of parseGeneratedAttributes(result.stdout)) {
      generatedPaths.set(path, generated);
    }
  }
  return generatedPaths;
}

async function collectDiffFileSizes({
  root,
  diffs,
  ...context
}: {
  root: string;
  diffs: { kind: GitDiffKind; command: string }[];
} & GitCommandContext) {
  const blobsByEntry = new Map<string, string[]>();
  await Promise.all(
    diffs.map(async ({ kind, command }) => {
      const result = await runGitShellCommand({
        root,
        command: `${command} --raw -z --no-abbrev`,
        ...context,
      });
      if (result.code !== 0) return;
      const fields = result.stdout.split("\0");
      for (let index = 0; index < fields.length - 1; ) {
        const header = (fields[index++] ?? "").split(" ");
        const firstPath = fields[index++] ?? "";
        const renamed = /^(R|C)/.test(header[4] ?? "");
        const path = renamed ? (fields[index++] ?? "") : firstPath;
        const blobs = header
          .slice(2, 4)
          .filter(
            (id) =>
              /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(id) && !/^0+$/.test(id),
          );
        if (!path || !blobs.length) continue;
        blobsByEntry.set(`${kind}:${path}`, blobs);
        if (kind === "unstaged") blobsByEntry.set(`conflicted:${path}`, blobs);
      }
    }),
  );
  const objectSizes = new Map<string, number>();
  const objects = Array.from(new Set(Array.from(blobsByEntry.values()).flat()));
  for (
    let index = 0;
    index < objects.length;
    index += GIT_ATTRIBUTE_BATCH_SIZE
  ) {
    const batch = objects.slice(index, index + GIT_ATTRIBUTE_BATCH_SIZE);
    const result = await runGitShellCommand({
      root,
      command: `cat-file --batch-check=${context.shQuote("%(objectname) %(objecttype) %(objectsize)")} <<'ROAMGATE_OBJECTS'\n${batch.join("\n")}\nROAMGATE_OBJECTS`,
      ...context,
    });
    if (result.code !== 0) continue;
    for (const line of result.stdout.split("\n")) {
      const [id, type, rawSize] = line.trim().split(" ");
      const size = Number(rawSize);
      if (id && type === "blob" && Number.isSafeInteger(size) && size >= 0)
        objectSizes.set(id, size);
    }
  }
  const sizes = new Map<string, number>();
  for (const [key, objects] of blobsByEntry) {
    const knownSizes = objects.flatMap((id) =>
      objectSizes.has(id) ? [objectSizes.get(id)!] : [],
    );
    if (knownSizes.length) sizes.set(key, Math.max(...knownSizes));
  }
  return sizes;
}

/**
 * Untracked files per line-count command. Over SSH a command is a login, so
 * a batch is as big as allowed; on this machine a command is a process, and
 * the files are spread over the commands that run at once.
 */
export function untrackedBatchSize(count: number, host?: string) {
  if (host) return GIT_UNTRACKED_NUMSTAT_BATCH_SIZE;
  return Math.min(
    GIT_UNTRACKED_NUMSTAT_BATCH_SIZE,
    Math.max(1, Math.ceil(count / GIT_UNTRACKED_NUMSTAT_CONCURRENCY)),
  );
}

async function collectStats({
  root,
  mode,
  base,
  target,
  entries,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  mode: GitDiffMode;
  base: string | undefined;
  target?: string;
  entries: GitDiffEntry[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const mergeStats = (
    kind: GitDiffKind,
    output: string,
    fallbackKind?: GitDiffKind,
  ) => {
    for (const [path, value] of parseNumstat(output)) {
      stats.set(`${kind}:${path}`, value);
      if (fallbackKind) stats.set(`${fallbackKind}:${path}`, value);
    }
  };

  if (mode === "branch-main" || mode === "last-step") {
    const kind = mode === "branch-main" ? "branch" : "last-step";
    const range =
      mode === "branch-main"
        ? `${shQuote(base ?? "main")}...HEAD`
        : `${shQuote(base ?? "")} ${shQuote(target ?? "")}`;
    const result = await runGitShellCommand({
      root,
      command: `diff --numstat --find-renames ${range}`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
    if (result.code === 0 || result.code === 1) mergeStats(kind, result.stdout);
    return stats;
  }

  // The staged, unstaged and untracked counts are independent commands: run
  // them at once, then merge in that order.
  const stagedTask = runGitShellCommand({
    root,
    command: "diff --cached --numstat --find-renames",
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  const unstagedTask = runGitShellCommand({
    root,
    command: "diff --numstat --find-renames",
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });

  const untrackedEntries = entries.filter(
    (entry) => entry.kind === "untracked",
  );
  // A remote command per untracked file is a fresh SSH login per untracked
  // file, so one workspace holding an ignored build tree turns a single
  // refresh into tens of thousands of logins. Count a whole batch per command,
  // and past the cap list the files with no line counts rather than paying for
  // them: a tree that large is noise in the panel either way.
  const countedEntries =
    untrackedEntries.length > GIT_UNTRACKED_NUMSTAT_MAX_FILES
      ? []
      : untrackedEntries;
  const batches: GitDiffEntry[][] = [];
  const batchSize = untrackedBatchSize(countedEntries.length, host);
  for (let index = 0; index < countedEntries.length; index += batchSize) {
    batches.push(countedEntries.slice(index, index + batchSize));
  }
  const untrackedStats = new Map<
    string,
    { additions: number; deletions: number }
  >();
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;
      if (!batch) continue;
      const command = fillTemplate(UNTRACKED_NUMSTAT_SH, {
        paths: batch.map((entry) => shQuote(entry.path)).join(" "),
        root: shQuote(root),
      });
      const result = await runProcessWithCodeTimeout(
        gitShellCommandArgv(command, host, GIT_ONLY),
        GIT_DIFF_TIMEOUT_MS,
      );
      if (result.code !== 0 && result.code !== 1) continue;
      const values = parseNumstat(result.stdout);
      for (const entry of batch) {
        const value = values.get(entry.path);
        if (value) untrackedStats.set(entryKeyForStats(entry), value);
      }
    }
  };
  const [staged, unstaged] = await Promise.all([
    stagedTask,
    unstagedTask,
    ...Array.from(
      { length: Math.min(GIT_UNTRACKED_NUMSTAT_CONCURRENCY, batches.length) },
      () => worker(),
    ),
  ]);
  if (staged.code === 0 || staged.code === 1)
    mergeStats("staged", staged.stdout);
  if (unstaged.code === 0 || unstaged.code === 1) {
    mergeStats("unstaged", unstaged.stdout, "conflicted");
  }
  for (const [key, value] of untrackedStats) stats.set(key, value);

  return stats;
}

async function resolveComparisonBase({
  root,
  requested,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  requested?: unknown;
} & GitCommandContext) {
  const result = await runProcessWithCodeTimeout(
    gitShellCommandArgv(refsScript(shQuote, root), host, GIT_ONLY),
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "Unable to read comparison branches")
        .trim()
        .slice(0, 1000),
    );
  }
  const listed = parseRefsOutput(result.stdout);
  if (requested !== undefined && requested !== "")
    return selectDiffBase(listed.refs, undefined, requested);
  // Automatic: the same base as the branch's review.
  const { base, branches } = await resolveDefaultBase({
    root,
    host,
    shQuote,
    runProcessWithCodeTimeout,
    timeoutMs: GIT_DIFF_TIMEOUT_MS,
    listed,
  });
  return { base, branches };
}

async function resolveLastStepRange({
  workspaceId,
  root,
  baselines,
  snapshotId,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  root: string;
  baselines?: LastStepBaselineStore;
  snapshotId?: string;
} & GitCommandContext) {
  if (snapshotId) {
    const snapshot = baselines?.resolveSnapshot(workspaceId, root, snapshotId);
    if (!snapshot) {
      throw new Error("last-step snapshot expired; refresh Changes");
    }
    return snapshot as LastStepRange;
  }

  const completed = await (baselines?.completedStep
    ? baselines.completedStep(workspaceId, root)
    : baselines?.resolveCompleted(workspaceId, root));
  if (!completed) return null;
  const [baselineExists, currentExists] = await Promise.all([
    treeExists({
      root,
      tree: completed.baseline,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }),
    treeExists({
      root,
      tree: completed.current,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }),
  ]);
  if (!baselineExists || !currentExists) {
    baselines?.invalidateWorkspace(workspaceId, root);
    return null;
  }
  return completed as LastStepRange;
}

export async function readDiffSummary({
  workspaceId,
  workspace,
  root,
  params,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  lastStepBaselines,
}: {
  workspaceId: string;
  workspace: any;
  root: string;
  params: Record<string, unknown>;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  lastStepBaselines?: LastStepBaselineStore;
}) {
  const mode = diffMode(params);
  const comparison =
    mode === "branch-main"
      ? await resolveComparisonBase({
          root,
          requested: params.base_branch,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : undefined;
  const base = comparison?.base;
  if (comparison && !base) {
    return {
      workspace_id: workspaceId,
      repo_name: workspace?.worktree?.repo_name ?? workspace?.label ?? "",
      root,
      mode,
      base: undefined,
      base_branches: comparison.branches,
      baseline_available: false,
      snapshot_id: undefined,
      entries: [] as GitDiffEntry[],
      counts: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        branch: 0,
        "last-step": 0,
      },
    };
  }

  const lastStepRange =
    mode === "last-step"
      ? await resolveLastStepRange({
          workspaceId,
          root,
          baselines: lastStepBaselines,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : null;
  let result = { code: 0, stdout: "", stderr: "" };
  if (mode === "branch-main") {
    result = await runGitShellCommand({
      root,
      command: `diff --name-status --find-renames ${shQuote(base ?? "main")}...HEAD`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  } else if (mode === "last-step" && lastStepRange) {
    result = await runGitShellCommand({
      root,
      command: `diff --name-status --find-renames ${shQuote(lastStepRange.baseline)} ${shQuote(lastStepRange.current)}`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  } else if (mode === "working") {
    result = await runGitShellCommand({
      root,
      command: "status --porcelain=v1 --untracked-files=all",
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  }
  if (result.code !== 0) {
    throw new Error(
      (
        result.stderr ||
        result.stdout ||
        `git ${mode === "working" ? "status" : "diff"} exited ${result.code}`
      )
        .trim()
        .slice(0, 1000),
    );
  }
  let entries: GitDiffEntry[];
  if (mode === "branch-main") {
    entries = parseBranchSummary(result.stdout);
  } else if (mode === "last-step") {
    entries = parseBranchSummary(result.stdout, "last-step");
  } else {
    entries = parseStatusSummary(result.stdout);
  }
  let statsTask: Promise<Map<string, { additions: number; deletions: number }>>;
  if (mode === "last-step" && !lastStepRange) {
    statsTask = Promise.resolve(new Map());
  } else {
    statsTask = collectStats({
      root,
      mode,
      base: mode === "last-step" ? lastStepRange?.baseline : base,
      target: lastStepRange?.current,
      entries,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  }
  const fingerprintTask =
    mode === "working"
      ? collectWorktreeFingerprints(
          { root, host, shQuote, runProcessWithCodeTimeout },
          entries.map((entry) => entry.path),
        )
      : Promise.resolve(new Map<string, { size: number; mtime_ms: number }>());
  const sizeDiffs =
    mode === "working"
      ? [
          {
            kind: "staged" as const,
            command: "diff --cached --no-ext-diff --find-renames",
          },
          {
            kind: "unstaged" as const,
            command: "diff --no-ext-diff --find-renames",
          },
        ]
      : mode === "branch-main"
        ? [
            {
              kind: "branch" as const,
              command: `diff --no-ext-diff --find-renames ${shQuote(base ?? "main")}...HEAD`,
            },
          ]
        : lastStepRange
          ? [
              {
                kind: "last-step" as const,
                command: `diff --no-ext-diff --find-renames ${shQuote(lastStepRange.baseline)} ${shQuote(lastStepRange.current)}`,
              },
            ]
          : [];
  // What the scope line says: the branch, and its commits beyond the base.
  const gitLine = (command: string) =>
    runGitShellCommand({
      root,
      command,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }).then(
      (out) => (out.code === 0 ? out.stdout.trim() : ""),
      () => "",
    );
  const branchTask = gitLine("rev-parse --abbrev-ref HEAD");
  const commitsTask =
    mode === "branch-main"
      ? gitLine(`rev-list --count ${shQuote(base ?? "main")}..HEAD`)
      : Promise.resolve("");
  const [stats, generatedPaths, fingerprints, fileSizes, branch, commits] =
    await Promise.all([
      statsTask,
      collectGeneratedPaths({
        root,
        entries,
        host,
        shQuote,
        runProcessWithCodeTimeout,
      }),
      fingerprintTask,
      collectDiffFileSizes({
        root,
        diffs: sizeDiffs,
        host,
        shQuote,
        runProcessWithCodeTimeout,
      }),
      branchTask,
      commitsTask,
    ]);
  const entriesWithStats = entries.map((entry) => {
    const fingerprint = fingerprints.get(entry.path);
    const blobSize = fileSizes.get(entryKeyForStats(entry));
    const worktreeSize =
      entry.kind !== "staged" ? fingerprint?.size : undefined;
    const fileSize =
      blobSize === undefined && worktreeSize === undefined
        ? undefined
        : Math.max(blobSize ?? 0, worktreeSize ?? 0);
    const entryWithStats = {
      ...entry,
      ...(stats.get(entryKeyForStats(entry)) ?? {}),
      ...(fingerprint
        ? { mtime_ms: fingerprint.mtime_ms, size: fingerprint.size }
        : {}),
      ...(fileSize !== undefined ? { file_size: fileSize } : {}),
    };
    return generatedPaths.has(entry.path)
      ? { ...entryWithStats, generated: generatedPaths.get(entry.path) }
      : entryWithStats;
  });
  const lastStepSnapshotId =
    mode === "last-step" && lastStepRange
      ? lastStepBaselines?.rememberSnapshot(
          workspaceId,
          root,
          lastStepRange.baseline,
          lastStepRange.current,
        )
      : undefined;
  return {
    workspace_id: workspaceId,
    repo_name: workspace?.worktree?.repo_name ?? workspace?.label ?? "",
    root,
    mode,
    base: mode === "last-step" ? lastStepRange?.baseline : base,
    base_branches: comparison?.branches,
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(/^\d+$/.test(commits) ? { commits: Number(commits) } : {}),
    baseline_available: mode !== "last-step" || lastStepRange !== null,
    snapshot_id: lastStepSnapshotId,
    // The step as a review target: its comments' review.
    ...(lastStepRange?.step
      ? {
          step: {
            step: lastStepRange.step,
            before: lastStepRange.baseline,
            after: lastStepRange.current,
            ...(lastStepRange.at ? { at: lastStepRange.at } : {}),
            ...(lastStepRange.skipped?.length
              ? { skipped: lastStepRange.skipped }
              : {}),
          },
        }
      : {}),
    entries: entriesWithStats,
    counts: {
      staged: entriesWithStats.filter((entry) => entry.kind === "staged")
        .length,
      unstaged: entriesWithStats.filter((entry) => entry.kind === "unstaged")
        .length,
      untracked: entriesWithStats.filter((entry) => entry.kind === "untracked")
        .length,
      conflicted: entriesWithStats.filter(
        (entry) => entry.kind === "conflicted",
      ).length,
      branch: entriesWithStats.filter((entry) => entry.kind === "branch")
        .length,
      "last-step": entriesWithStats.filter(
        (entry) => entry.kind === "last-step",
      ).length,
    },
  };
}

/**
 * How long a branch review's base, once resolved, serves the next file
 * reads: a review loads its files in several batches, and resolving the base
 * again for each costs a few Git commands (a few SSH round trips remote).
 */
export const COMPARISON_BASE_REUSE_MS = 5000;
const recentComparisonBases = new Map<
  string,
  { at: number; base: ReturnType<typeof resolveComparisonBase> }
>();

function recentComparisonBase(
  args: Parameters<typeof resolveComparisonBase>[0],
) {
  const key = JSON.stringify([
    args.host ?? "",
    args.root,
    args.requested ?? "",
  ]);
  const now = Date.now();
  const kept = recentComparisonBases.get(key);
  if (kept && now - kept.at < COMPARISON_BASE_REUSE_MS) return kept.base;
  for (const [each, value] of recentComparisonBases)
    if (now - value.at >= COMPARISON_BASE_REUSE_MS)
      recentComparisonBases.delete(each);
  const base = resolveComparisonBase(args);
  recentComparisonBases.set(key, { at: now, base });
  base.catch(() => {
    if (recentComparisonBases.get(key)?.base === base)
      recentComparisonBases.delete(key);
  });
  return base;
}

/** Most files one git.diff_files call reads (one shell command). */
export const GIT_DIFF_FILES_MAX = 32;

type DiffFileArgs = {
  workspaceId: string;
  root: string;
  params: Record<string, unknown>;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  lastStepBaselines?: LastStepBaselineStore;
};

export async function readDiffFile(args: DiffFileArgs) {
  const path = sanitizeExplorerPath(args.params.path);
  if (!path) throw new Error("git.diff_file requires path");
  const [file] = (
    await readDiffFiles({
      ...args,
      params: {
        ...args.params,
        entries: [
          { path, old_path: args.params.old_path, kind: args.params.kind },
        ],
      },
    })
  ).files;
  if (!file) throw new Error("git.diff_file requires path");
  if ("error" in file) throw new Error(file.error);
  return file;
}

/**
 * Several files' diffs of one scope, read with one shell command (one SSH
 * round trip on a remote checkout): the scope's base or Last step range is
 * resolved once, not once per file. A file that fails carries its `error`.
 */
export async function readDiffFiles({
  workspaceId,
  root,
  params,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  lastStepBaselines,
}: DiffFileArgs) {
  const requested = Array.isArray(params.entries) ? params.entries : [];
  if (!requested.length) throw new Error("git.diff_files requires entries");
  if (requested.length > GIT_DIFF_FILES_MAX)
    throw new Error(`git.diff_files reads at most ${GIT_DIFF_FILES_MAX} files`);
  const mode = diffMode(params);
  const snapshotId =
    typeof params.snapshot_id === "string" && params.snapshot_id
      ? params.snapshot_id
      : undefined;
  if (mode === "last-step" && !snapshotId) {
    throw new Error("last-step diff requires a fresh summary snapshot");
  }
  const automatic = params.automatic === true;
  const entries = requested.map((each) => {
    const entry = (each ?? {}) as Record<string, unknown>;
    const path = sanitizeExplorerPath(entry.path);
    if (!path) throw new Error("git.diff_file requires path");
    const oldPath = sanitizeExplorerPath(entry.old_path) || undefined;
    const diffPaths = oldPath && oldPath !== path ? [oldPath, path] : [path];
    return {
      path,
      oldPath,
      pathspec: diffPaths.map(shQuote).join(" "),
      kind: diffFileKind(mode, entry.kind),
    };
  });
  const comparison =
    mode === "branch-main"
      ? await recentComparisonBase({
          root,
          requested: params.base_branch,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : undefined;
  const base = comparison?.base;
  if (comparison && !base) {
    throw new Error(
      "Default comparison branch was not found; select a comparison branch.",
    );
  }

  const lastStepRange =
    mode === "last-step"
      ? await resolveLastStepRange({
          workspaceId,
          root,
          baselines: lastStepBaselines,
          snapshotId,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : null;
  const markers = entries.map(() => `ROAMGATE-COMBINED-${randomUUID()}`);
  const scripts = entries.map((entry, index) => {
    // The review's reading of the working changes: one diff per file, its
    // staged lines told exactly.
    if (entry.kind === "combined")
      return combinedDiffScript(
        root,
        entry.path,
        entry.oldPath,
        markers[index],
        shQuote,
        automatic,
      );
    let gitCommand: string | null = null;
    if (mode === "branch-main") {
      gitCommand = `diff --no-ext-diff --find-renames ${shQuote(base ?? "main")}...HEAD -- ${entry.pathspec}`;
    } else if (mode === "last-step" && lastStepRange) {
      gitCommand = `diff --no-ext-diff --find-renames ${shQuote(lastStepRange.baseline)} ${shQuote(lastStepRange.current)} -- ${entry.pathspec}`;
    } else if (mode === "working") {
      gitCommand = workingDiffFileCommand(
        entry.kind,
        entry.path,
        entry.pathspec,
        shQuote,
      );
    }
    return gitCommand
      ? gitPatchScript(root, gitCommand, shQuote, automatic)
      : null;
  });
  const runnable = scripts.filter((each): each is string => each !== null);
  const outputs = runnable.length
    ? await runScriptBatch({
        scripts: runnable,
        host,
        runProcessWithCodeTimeout,
        timeoutMs: GIT_DIFF_TIMEOUT_MS + 1000 * (runnable.length - 1),
      })
    : [];
  let next = 0;
  let expired: Promise<boolean> | null = null;
  const files = await Promise.all(
    entries.map(async (entry, index) => {
      const head = {
        workspace_id: workspaceId,
        root,
        path: entry.path,
        kind: entry.kind,
      };
      const failed = (result: {
        code: number;
        stdout: string;
        stderr: string;
      }) =>
        (result.stderr || result.stdout || `git diff exited ${result.code}`)
          .trim()
          .slice(0, 1000);
      try {
        if (scripts[index] === null)
          return {
            ...head,
            diff: "",
            patch_size: 0,
            truncated: false,
          };
        const output = outputs[next++]!;
        if (entry.kind === "combined") {
          if (output.code !== 0) return { ...head, error: failed(output) };
          // Whatever a login profile printed before the script's output goes.
          const start = output.stdout.search(/^\d+ [01] [01]\n/m);
          const combined = parseCombinedDiffOutput(
            start > 0 ? output.stdout.slice(start) : output.stdout,
            markers[index],
            entry.path,
            automatic,
          );
          return {
            ...head,
            diff: combined.diff,
            patch_size: combined.patch_size,
            truncated: combined.truncated,
            ...(combined.deferred ? { deferred: true } : {}),
            ...(combined.untracked ? { untracked: true } : {}),
            ...(combined.unmerged ? { unmerged: true } : {}),
            ...(combined.staged ? { staged: combined.staged } : {}),
          };
        }
        const result = parseGitPatchOutput(output, automatic);
        const diffExitOk =
          entry.kind === "untracked"
            ? result.code === 0 ||
              (result.code === 1 &&
                (result.patch_size > 0 || !result.stderr.trim()))
            : result.code === 0;
        if (!diffExitOk) {
          if (mode === "last-step" && snapshotId && lastStepRange) {
            expired ??= Promise.all([
              treeExists({
                root,
                tree: lastStepRange.baseline,
                host,
                shQuote,
                runProcessWithCodeTimeout,
              }),
              treeExists({
                root,
                tree: lastStepRange.current,
                host,
                shQuote,
                runProcessWithCodeTimeout,
              }),
            ]).then(([baselineExists, currentExists]) => {
              if (baselineExists && currentExists) return false;
              lastStepBaselines?.deleteSnapshot(snapshotId);
              return true;
            });
            if (await expired)
              return {
                ...head,
                error: "last-step snapshot expired; refresh Changes",
              };
          }
          return { ...head, error: failed(result) };
        }
        return {
          ...head,
          diff: result.diff,
          patch_size: result.patch_size,
          truncated: result.truncated,
          ...(result.deferred ? { deferred: true } : {}),
        };
      } catch (error) {
        return { ...head, error: (error as Error).message };
      }
    }),
  );
  return { workspace_id: workspaceId, root, files };
}

export async function pullGit({
  workspaceId,
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} -c core.quotepath=false pull --ff-only`;
  const result = await runProcessWithCodeTimeout(
    gitShellCommandArgv(command, host),
    GIT_PULL_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git pull exited ${result.code}`)
        .trim()
        .slice(0, 2000),
    );
  }
  return {
    workspace_id: workspaceId,
    root,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
