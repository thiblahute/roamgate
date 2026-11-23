import { sshReadCommandArgv } from "../bridge/ssh-command";
import type {
  ReviewCommit,
  ReviewDiff,
  ReviewGoneCode,
  ReviewTarget,
} from "../../../shared/review";
import { parseUnifiedDiff } from "../review/patch";
import { resolveDefaultBase, shortRefName } from "./diff-base";
import { GIT_ONLY, gitShellCommandArgv } from "./git-shell";
import type { RunProcessWithCodeTimeout } from "./file-types";

/** The review's scripts run Git and POSIX tools only: no login shell. */
export { GIT_ONLY };

export const REVIEW_PATCH_MAX_BYTES = 4 * 1024 * 1024;
const REVIEW_PATCH_TIMEOUT_MS = 30_000;
const MAX_UNTRACKED_FILES = 200;
export const SHAS_MARKER = "ROAMGATE-REVIEW-SHAS";
/**
 * git with the user's settings that change how a diff reads pinned:
 * real UTF-8 names, `a/` and `b/` prefixes, blank context lines kept.
 */
export const GIT =
  "git -c core.quotePath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.suppressBlankEmpty=false";
/** Diff options that keep the output a plain patch of the files. */
export const DIFF_OPTIONS =
  "--no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/";
/** An absolute path on the host: POSIX, or a Windows drive (Git Bash). */
export function isHostPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

const NO_CHECKOUT_MARKER = "ROAMGATE-REVIEW-NO-CHECKOUT";

/**
 * A review whose checkout was removed (a deleted worktree) or whose range
 * names a commit the checkout no longer has. Reported as such, not as the
 * shell's error, so the overlay can offer to close or retarget it.
 */
export class ReviewGoneError extends Error {
  readonly status = 410;
  constructor(
    readonly code: ReviewGoneCode,
    message: string,
  ) {
    super(message);
  }
}

/** The first line of a review script: into the checkout, or say it is gone. */
export function enterCheckout(
  root: string,
  shQuote: (value: string) => string,
): string {
  return `cd ${shQuote(root)} 2>/dev/null || { echo ${NO_CHECKOUT_MARKER} >&2; exit 2; }`;
}

/** Where a review script runs: the checkout, on the host or over SSH. */
export type ReviewScriptHost = {
  root: string;
  host?: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
};

/**
 * Runs a read-only review script in its checkout, over SSH on a remote
 * host (`tag` names it there); its output, or reviewScriptError's error
 * (`label` when git says nothing, `max` characters of what it says).
 */
export async function runReviewScript(
  args: ReviewScriptHost,
  script: string,
  how: {
    tag: string;
    timeoutMs: number;
    label: string;
    target?: ReviewTarget;
    max?: number;
  },
): Promise<string> {
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], how.tag)
    : gitShellCommandArgv(script, undefined, GIT_ONLY);
  const result = await args.runProcessWithCodeTimeout(argv, how.timeoutMs);
  if (result.code !== 0)
    throw reviewScriptError(
      result.stderr,
      how.label,
      args.root,
      how.target,
      how.max,
    );
  return result.stdout;
}

/** A review script's failure, as a ReviewGoneError when that is what it is. */
export function reviewScriptError(
  stderr: string,
  fallback: string,
  root: string,
  target?: ReviewTarget,
  max = 500,
): Error {
  if (stderr.includes(NO_CHECKOUT_MARKER))
    return new ReviewGoneError(
      "checkout-gone",
      `This checkout no longer exists: ${root}`,
    );
  const unknown = /unknown revision: (\S+)/.exec(stderr);
  // A last step whose snapshot trees git collected.
  if (unknown && target?.kind === "step") {
    const end = unknown[1] === target.before ? "base" : "head";
    return new ReviewGoneError(
      end === "base" ? "base-gone" : "head-gone",
      `This step's snapshot is gone from this checkout (${end === "base" ? "before" : "after"} it)`,
    );
  }
  if (unknown && target?.kind === "range") {
    const rev = unknown[1]!;
    const end = rev === target.base.replace(/["$`\\]/g, "") ? "base" : "head";
    return new ReviewGoneError(
      end === "base" ? "base-gone" : "head-gone",
      `The review's ${end} ${rev} is gone from this checkout`,
    );
  }
  return new Error((stderr || fallback).trim().slice(0, max));
}

/**
 * A review's base into $b: a commit, or a tree such as git's empty tree
 * (4b825dc...), which agents use to review a repository from its start.
 * A root commit's parent (`SHA^`, `SHA~1`, `SHA~`, as Review this commit
 * and agents name one commit) is the empty tree: the commit adds it all.
 */
export function resolveBase(base: string, shQuote: (value: string) => string) {
  return `b=$(${baseRevision(base, shQuote)}) || ${unknownRevision(base)}`;
}

/** A script's exit on a revision it cannot find, naming it. */
export function unknownRevision(name: string): string {
  return `{ echo "unknown revision: ${name.replace(/["$`\\]/g, "")}" >&2; exit 3; }`;
}

/** A review's head commit into $h. */
export function resolveHead(head: string, shQuote: (value: string) => string) {
  return `h=$(git rev-parse --verify --quiet ${shQuote(`${head}^{commit}`)}) || ${unknownRevision(head)}`;
}

/** Fails the script unless `tree` (a step's snapshot) is there. */
export function checkTree(tree: string, shQuote: (value: string) => string) {
  return `git rev-parse --verify --quiet ${shQuote(`${tree}^{tree}`)} >/dev/null || ${unknownRevision(tree)}`;
}

/** The commands printing a review base's object name; false when none. */
function baseRevision(base: string, shQuote: (value: string) => string) {
  const parent = /^(.+?)(?:\^|~1?)$/.exec(base)?.[1];
  const root = parent
    ? ` || { c=$(git rev-parse --verify --quiet ${shQuote(`${parent}^{commit}`)}) && ! git rev-parse --verify --quiet "$c^1" >/dev/null && git hash-object -t tree /dev/null; }`
    : "";
  return `git rev-parse --verify --quiet ${shQuote(`${base}^{commit}`)} 2>/dev/null || git rev-parse --verify --quiet ${shQuote(`${base}^{tree}`)}${root}`;
}

/**
 * One shell script per review diff, so a remote host costs a single command on
 * the connection's SSH master. The first line carries the resolved commits;
 * the patch follows, cut at the size limit.
 */
export function reviewPatchScript(
  root: string,
  target: ReviewTarget,
  shQuote: (value: string) => string,
  maxBytes = REVIEW_PATCH_MAX_BYTES,
  /**
   * Only these files (a thread's, to place it): the whole of each, every
   * untracked one among them, no file count cap.
   */
  paths?: readonly string[],
): string {
  const only = paths?.length
    ? ` -- ${paths.map((path) => shQuote(path)).join(" ")}`
    : "";
  const diff = `${GIT} ${only ? "--literal-pathspecs " : ""}diff ${DIFF_OPTIONS} --find-renames`;
  const cap = `head -c ${maxBytes + 1}`;
  const lines = [enterCheckout(root, shQuote)];
  if (target.kind === "range") {
    lines.push(
      resolveBase(target.base, shQuote),
      resolveHead(target.head, shQuote),
      // Review what the head adds, as a merge request would show it; or,
      // comparing two versions of a branch, tree against tree.
      target.compare
        ? `m="$b"`
        : `m=$(git merge-base "$b" "$h" 2>/dev/null) || m="$b"`,
      `{ printf '${SHAS_MARKER} %s %s\\n' "$m" "$h"; ${diff} "$m" "$h"${only}; } | ${cap}`,
    );
  } else if (target.kind === "step") {
    // Tree against tree: what the agent's step changed.
    for (const tree of [target.before, target.after])
      lines.push(checkTree(tree, shQuote));
    lines.push(
      `{ printf '${SHAS_MARKER} %s %s\\n' ${shQuote(target.before)} ${shQuote(target.after)}; ${diff} ${shQuote(target.before)} ${shQuote(target.after)}${only}; } | ${cap}`,
    );
  } else if (target.kind === "worktree") {
    lines.push(
      `h=$(git rev-parse --verify --quiet HEAD) || h=`,
      `{ printf '${SHAS_MARKER} %s %s\\n' "$h" "";`,
      `  ${diff} HEAD${only} 2>/dev/null || ${diff} --cached${only};`,
      // A name git still quotes (a newline or quote in it) is skipped.
      only
        ? `  ${GIT} --literal-pathspecs ls-files --others --exclude-standard${only} |`
        : `  ${GIT} ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED_FILES} |`,
      `  while IFS= read -r f; do case "$f" in \\"*) continue;; esac; ${GIT} diff ${DIFF_OPTIONS} --no-index -- /dev/null "$f"; done;`,
      `} | ${cap}`,
    );
  } else {
    throw new Error("merge request diffs come from the forge");
  }
  return lines.join("\n");
}

export function parseReviewPatchOutput(
  output: string,
  maxBytes = REVIEW_PATCH_MAX_BYTES,
): ReviewDiff {
  // Whatever a login profile printed before the script's output goes.
  const marker = output.startsWith(SHAS_MARKER)
    ? 0
    : output.indexOf(`\n${SHAS_MARKER} `) + 1;
  let text = marker > 0 ? output.slice(marker) : output;
  let baseSha: string | undefined;
  let headSha: string | undefined;
  if (text.startsWith(SHAS_MARKER)) {
    const end = text.indexOf("\n");
    const [, base, head] = text
      .slice(0, end === -1 ? undefined : end)
      .split(" ");
    baseSha = base || undefined;
    headSha = head || undefined;
    text = end === -1 ? "" : text.slice(end + 1);
  }
  const truncated = Buffer.byteLength(output) > maxBytes;
  let cutFile = false;
  if (truncated) {
    // Drop the partial file at the cut so no hunk ends mid-line; a file cut
    // on its own keeps its whole lines, marked cut.
    const lastFile = text.lastIndexOf("\ndiff --git ");
    if (lastFile > 0) text = text.slice(0, lastFile + 1);
    else {
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      cutFile = true;
    }
  }
  const files = parseUnifiedDiff(text);
  if (cutFile && files.length === 1)
    files[0] = { ...files[0]!, truncated: true };
  return { files, baseSha, headSha, truncated };
}

/**
 * The most one file's patch is read to place a thread (anchorDiff, the
 * Changes anchors' migration): the review's 4 MiB cap is for the whole
 * patch, not for one file. A larger file is cut at its last whole line
 * and marked cut: a thread past the cut is not placed.
 */
export const REVIEW_FILE_PATCH_MAX_BYTES = 16 * 1024 * 1024;

export async function readReviewPatch(args: {
  root: string;
  target: ReviewTarget;
  /** Only these files, uncapped but for REVIEW_FILE_PATCH_MAX_BYTES. */
  paths?: readonly string[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewDiff> {
  const maxBytes = args.paths?.length
    ? REVIEW_FILE_PATCH_MAX_BYTES
    : REVIEW_PATCH_MAX_BYTES;
  const script = reviewPatchScript(
    args.root,
    args.target,
    args.shQuote,
    maxBytes,
    args.paths,
  );
  const output = await runReviewScript(args, script, {
    tag: "review.patch",
    timeoutMs: REVIEW_PATCH_TIMEOUT_MS,
    label: "git diff failed",
    target: args.target,
  });
  return parseReviewPatchOutput(output, maxBytes);
}

/**
 * A fingerprint of what a review shows, cheap enough to poll: the range's
 * ends, or for uncommitted work its HEAD, diff and untracked files. It
 * changes when a reload would show something else.
 */
export function reviewStateScript(
  root: string,
  target: ReviewTarget,
  shQuote: (value: string) => string,
): string {
  const lines = [enterCheckout(root, shQuote)];
  // A range's ends, a step's two snapshots: gone, the script says so.
  if (target.kind === "range")
    lines.push(
      resolveBase(target.base, shQuote),
      resolveHead(target.head, shQuote),
      `printf '%s\\n%s\\n' "$b" "$h"`,
    );
  else if (target.kind === "step")
    lines.push(
      ...[target.before, target.after].map(
        (tree) =>
          `git rev-parse --verify --quiet ${shQuote(`${tree}^{tree}`)} || ${unknownRevision(tree)}`,
      ),
    );
  else if (target.kind === "worktree")
    lines.push(
      "git rev-parse --verify --quiet HEAD",
      "{ git diff --no-color --no-ext-diff HEAD 2>/dev/null || git diff --no-color --no-ext-diff --cached; } | git hash-object --stdin",
      // Every untracked file counts (no 200-file cap):
      // Changes lists them all, and a change to any one is a change.
      `git ls-files --others --exclude-standard | { git hash-object --stdin-paths 2>/dev/null; git ls-files --others --exclude-standard; } | git hash-object --stdin`,
    );
  else throw new Error("merge request changes come from the forge");
  lines.push("exit 0");
  return lines.join("\n");
}

export async function readReviewState(args: {
  root: string;
  target: ReviewTarget;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<string> {
  const output = await runReviewScript(
    args,
    reviewStateScript(args.root, args.target, args.shQuote),
    {
      tag: "review.state",
      timeoutMs: 20_000,
      label: "git failed",
      target: args.target,
    },
  );
  return output.trim().split(/\s+/).join(" ");
}

/** The repository holding `path` on the connection's host. */
export async function readReviewRoot(args: {
  path: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<string> {
  // An empty or relative path would run Git in the login directory (the
  // SSH host's home), answering for the wrong place.
  if (!isHostPath(args.path))
    throw new Error(
      `a review's checkout must be an absolute path, not "${args.path.slice(0, 200)}"`,
    );
  const command = `git -C ${args.shQuote(args.path)} rev-parse --show-toplevel`;
  const argv = args.host
    ? sshReadCommandArgv(args.host, command, [], "review.root")
    : ["git", "-C", args.path, "rev-parse", "--show-toplevel"];
  const result = await args.runProcessWithCodeTimeout(argv, 10_000);
  const root = result.stdout.trim();
  if (result.code !== 0 || !root)
    throw new Error(
      (result.stderr || "not inside a Git repository").trim().slice(0, 500),
    );
  return root;
}

/**
 * The branch a review compares against when none is named: Automatic's
 * base, the one Changes' Branch scope draws against (resolveDefaultBase:
 * the newer of the local default branch and its remote counterpart), as
 * the review writes it (`origin/main`, `main`).
 */
export async function readDefaultBase(args: {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<string> {
  const { base } = await resolveDefaultBase(args).catch(() => ({
    base: undefined,
  }));
  if (!base)
    throw new Error("cannot find the default branch; pass --range BASE..HEAD");
  return shortRefName(base);
}

/** A repository a workspace's session may have changed. */
export type ReviewRepo = {
  root: string;
  branch: string;
  /** The default branch it is compared with; empty when none is found. */
  base: string;
  /** Commits on HEAD that the default branch lacks. */
  ahead: number;
  /** Uncommitted changes, new files included. */
  dirty: boolean;
  /** The repository of one of the given directories. */
  seed: boolean;
  /** Worked on by an agent of the workspace, by its session's record. */
  touched?: boolean;
  /** Last activity (seconds since the epoch): commit or index change. */
  active: number;
};

/** How much of an agent's session record is read: its latest work. */
const REVIEW_AGENT_RECORD_BYTES = 8 * 1024 * 1024;

/** Neighbors untouched for longer are not this session's work. */
const REVIEW_REPO_RECENT_S = 3 * 24 * 3600;

const REVIEW_REPO_LIMIT = 40;

/**
 * The repositories of the given directories, plus the repositories next to
 * them and in their `subprojects/`, keeping those with uncommitted changes
 * or commits ahead of their default branch. One script, so a remote host
 * costs one SSH round trip.
 */
export async function scanReviewRepos(args: {
  paths: string[];
  /**
   * The directories agents run in: their Claude Code session records say
   * which other repositories they edited (files written, `cd`, `git -C`).
   */
  agentPaths?: string[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewRepo[]> {
  const paths = args.paths.filter(isHostPath).slice(0, 20);
  if (!paths.length) return [];
  const agentPaths = (args.agentPaths ?? [])
    .filter((path) => path.startsWith("/"))
    .slice(0, 10);
  // The tail of the agent's latest session record: the directories of the
  // files it wrote and those it went into. Read where the agent runs.
  const touched = agentPaths.length
    ? [
        "touched=$(",
        `  for a in ${agentPaths.map(args.shQuote).join(" ")}; do`,
        `    d="$HOME/.claude/projects/$(printf %s "$a" | sed 's/[^a-zA-Z0-9]/-/g')"`,
        '    f=$(ls -t "$d"/*.jsonl 2>/dev/null | head -n 1)',
        '    [ -n "$f" ] || continue',
        `    tail -c ${REVIEW_AGENT_RECORD_BYTES} "$f" | grep -o '"file_path":"/[^"]*"' | sed 's/^"file_path":"//; s/"$//; s|/[^/]*$||'`,
        `    tail -c ${REVIEW_AGENT_RECORD_BYTES} "$f" | grep -oE '(cd|git -C) /[^ &;|"\\]+' | sed -E 's/^(cd|git -C) //'`,
        "  done | sort -u | head -n 200)",
        "set -f; old_ifs=$IFS; IFS='",
        "'",
        "for p in $touched; do",
        '  r=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || continue',
        '  t_roots="$t_roots',
        '$r"',
        "done",
        'for r in $(printf \'%s\\n\' "$t_roots" | sort -u); do report "$r" 2; done',
        "IFS=$old_ifs; set +f",
      ]
    : [];
  const script = [
    `set -- ${paths.map(args.shQuote).join(" ")}`,
    'seen=" "; n=0',
    "report() {",
    '  case "$seen" in *" $1 "*) return;; esac',
    `  [ "$n" -ge ${REVIEW_REPO_LIMIT} ] && return`,
    '  seen="$seen$1 "; n=$((n + 1))',
    '  b=$(git -C "$1" symbolic-ref -q --short HEAD || echo HEAD)',
    '  base=""',
    '  for x in "$(git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD)" origin/main origin/master main master; do',
    '    [ -n "$x" ] && git -C "$1" rev-parse --verify -q "$x^{commit}" >/dev/null && { base=$x; break; }',
    "  done",
    "  ahead=0",
    '  [ -n "$base" ] && ahead=$(git -C "$1" rev-list --count "$base..HEAD" 2>/dev/null || echo 0)',
    "  dirty=0",
    // New files count: a repository may have nothing committed yet.
    '  [ -n "$(git -C "$1" status --porcelain 2>/dev/null | head -n 1)" ] && dirty=1',
    '  t=$(git -C "$1" log -1 --format=%ct 2>/dev/null || echo 0)',
    '  i=$(date -r "$(git -C "$1" rev-parse --git-path index)" +%s 2>/dev/null || echo 0)',
    '  [ "$i" -gt "$t" ] 2>/dev/null && t=$i',
    '  printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$1" "$b" "$base" "$ahead" "$dirty" "$2" "$t"',
    "}",
    'for p in "$@"; do',
    '  r=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || continue',
    '  report "$r" 1',
    "done",
    ...touched,
    // Its subprojects someone works in: on a branch, not where a build
    // tool pinned them (a detached HEAD). Its neighbors are other work.
    'for p in "$@"; do',
    '  r=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || continue',
    '  for c in "$r"/subprojects/*/; do',
    '    [ -e "$c.git" ] || continue',
    '    git -C "$c" symbolic-ref -q HEAD >/dev/null || continue',
    '    report "${c%/}" 0',
    "  done",
    "done",
  ].join("\n");
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.repos")
    : gitShellCommandArgv(script, undefined, GIT_ONLY);
  const result = await args.runProcessWithCodeTimeout(argv, 30_000);
  const repos: ReviewRepo[] = [];
  for (const line of result.stdout.split("\n")) {
    const [root, branch, base, ahead, dirty, seed, active] = line.split("\t");
    if (!root || !isHostPath(root) || seed === undefined) continue;
    const repo = {
      root,
      branch: branch ?? "",
      base: base ?? "",
      ahead: Number(ahead) || 0,
      dirty: dirty === "1",
      seed: seed === "1",
      touched: seed === "2",
      active: Number(active) || 0,
    };
    const changed = repo.ahead > 0 || repo.dirty;
    const recent = Date.now() / 1000 - repo.active < REVIEW_REPO_RECENT_S;
    // An agent's repositories count while they have changes or were active
    // lately (work committed straight to the default branch has no
    // changes left); subprojects need both.
    if (
      repo.seed ||
      (repo.touched && (changed || recent)) ||
      (changed && recent)
    )
      repos.push(repo);
  }
  // The given directories' repositories first, then the most recent.
  return repos.sort(
    (a, b) => Number(b.seed) - Number(a.seed) || b.active - a.active,
  );
}

export const REVIEW_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** A repository-relative path that cannot leave the checkout. */
export function validReviewPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === "")
  );
}

/**
 * One file of the review, for showing context around hunks: at a commit, or
 * from the working tree when `rev` is empty. Larger files are refused.
 */
export async function readReviewFile(args: {
  root: string;
  rev: string;
  path: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<string> {
  if (!validReviewPath(args.path)) throw new Error("invalid path");
  if (args.rev && !/^[0-9a-f]{7,64}$/.test(args.rev))
    throw new Error("invalid revision");
  // From the working tree: a regular file whose directory, links
  // resolved, is inside the checkout. A link out of it, or a FIFO, is
  // refused rather than read.
  const read = args.rev
    ? `git show ${args.shQuote(`${args.rev}:${args.path}`)}`
    : [
        `f=${args.shQuote(args.path)}`,
        "top=$(pwd -P)",
        `real=$(cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd -P) || { echo "cannot read the file" >&2; exit 4; }`,
        `case "$real/" in "$top"/*) ;; *) echo "the file is outside the checkout" >&2; exit 4;; esac`,
        `{ [ -f "$f" ] && [ ! -L "$f" ]; } || { echo "not a regular file of the checkout" >&2; exit 4; }`,
        'cat -- "$f"',
      ].join("\n");
  const script = `${enterCheckout(args.root, args.shQuote)}\n${read} | head -c ${REVIEW_FILE_MAX_BYTES + 1}`;
  const output = await runReviewScript(args, script, {
    tag: "review.file",
    timeoutMs: 20_000,
    label: "cannot read the file",
    max: 300,
  });
  if (Buffer.byteLength(output) > REVIEW_FILE_MAX_BYTES)
    throw new Error("the file is too large to show context from");
  return output;
}

/**
 * The current commit of several refs in several checkouts, in one command:
 * one output line per entry, empty when the ref does not resolve.
 */
export async function readReviewHeads(args: {
  entries: { root: string; ref: string }[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<(string | null)[]> {
  if (!args.entries.length) return [];
  // Each line says which entry it answers: anything else printed (a login
  // profile) cannot shift the answers.
  const script = args.entries
    .map(
      ({ root, ref }, index) =>
        `printf '${HEAD_MARKER}${index} %s\\n' "$(git -C ${args.shQuote(root)} rev-parse --verify --quiet ${args.shQuote(`${ref}^{commit}`)} 2>/dev/null)"`,
    )
    .join("\n");
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.heads")
    : gitShellCommandArgv(script, undefined, GIT_ONLY);
  const result = await args.runProcessWithCodeTimeout(argv, 20_000);
  const heads = new Map<number, string>();
  for (const line of result.stdout.split("\n")) {
    const match = new RegExp(
      `^${HEAD_MARKER}(\\d+) ([0-9a-f]{7,64})\\s*$`,
    ).exec(line);
    if (match) heads.set(Number(match[1]), match[2]!);
  }
  return args.entries.map((_, index) => heads.get(index) ?? null);
}

const HEAD_MARKER = "ROAMGATE-REVIEW-HEAD-";

export const REVIEW_MAX_COMMITS = 500;
const HISTORY_MARKER = "history";
const COMMIT_FIELD = "\x1f";
const COMMIT_END = "\x1e";

/** One commit's own changes against its first parent (or nothing, for a root). */
export function reviewCommitScript(
  root: string,
  commit: string,
  shQuote: (value: string) => string,
  maxBytes = REVIEW_PATCH_MAX_BYTES,
): string {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new Error("invalid commit");
  return [
    enterCheckout(root, shQuote),
    `c=$(git rev-parse --verify --quiet ${shQuote(`${commit}^{commit}`)}) || { echo "unknown commit" >&2; exit 3; }`,
    `p=$(git rev-parse --verify --quiet "$c^" 2>/dev/null) || p=`,
    `{ printf '${SHAS_MARKER} %s %s\\n' "$p" "$c"; ${GIT} diff-tree -p -r --root --no-commit-id ${DIFF_OPTIONS} --find-renames --first-parent -m "$c"; } | head -c ${maxBytes + 1}`,
  ].join("\n");
}

/** The commits a range adds, oldest first, as they were made. */
export function reviewCommitsScript(
  root: string,
  base: string,
  head: string,
  shQuote: (value: string) => string,
): string {
  const format = ["%H", "%P", "%an", "%aI", "%s", "%b"].join("%x1f") + "%x1e";
  return [
    enterCheckout(root, shQuote),
    resolveBase(base, shQuote),
    resolveHead(head, shQuote),
    // From a tree (the empty tree, to review everything): every commit.
    `if [ "$(git cat-file -t "$b")" = tree ]; then git log --reverse --no-color --format=${shQuote(format)} -n ${REVIEW_MAX_COMMITS} "$h"; exit 0; fi`,
    `m=$(git merge-base "$b" "$h") || m="$b"`,
    // Nothing of its own (the default branch itself): its history, latest
    // first, marked so it is not taken for the branch's work.
    `if [ "$m" = "$h" ]; then printf '${HISTORY_MARKER}${COMMIT_END}'; git log --no-color --format=${shQuote(format)} -n ${REVIEW_MAX_COMMITS} "$h"; exit 0; fi`,
    `git log --reverse --no-color --format=${shQuote(format)} -n ${REVIEW_MAX_COMMITS} "$m..$h"`,
  ].join("\n");
}

/**
 * `git patch-id --stable` of each of these commits the checkout has: the
 * same for a commit rebased or reworded, as long as its change is.
 */
export function reviewPatchIdsScript(
  root: string,
  shas: readonly string[],
  shQuote: (value: string) => string,
): string {
  for (const sha of shas)
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("invalid commit");
  return [
    enterCheckout(root, shQuote),
    // Unknown ones (gone with a gc, never fetched) are left out.
    `s=$(for c in ${shas.map((sha) => shQuote(sha)).join(" ")}; do git rev-parse --verify --quiet "$c^{commit}"; done)`,
    `[ -n "$s" ] || exit 0`,
    `${GIT} show ${DIFF_OPTIONS} --format='commit %H' -p $s | git patch-id --stable`,
  ].join("\n");
}

/** `patch-id sha` lines, as patch ids by sha. */
export function parseReviewPatchIds(output: string): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const [id, sha] = line.trim().split(/\s+/);
    if (
      id &&
      sha &&
      /^[0-9a-f]{40,64}$/.test(id) &&
      /^[0-9a-f]{40,64}$/.test(sha)
    )
      ids[sha] = id;
  }
  return ids;
}

export async function readReviewPatchIds(args: {
  root: string;
  shas: readonly string[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<Record<string, string>> {
  if (!args.shas.length) return {};
  const output = await runReviewScript(
    args,
    reviewPatchIdsScript(args.root, args.shas, args.shQuote),
    {
      tag: "review.patch-ids",
      timeoutMs: 20_000,
      label: "git patch-id failed",
      max: 300,
    },
  );
  return parseReviewPatchIds(output);
}

export function parseReviewCommits(output: string): ReviewCommit[] {
  const history = output.startsWith(`${HISTORY_MARKER}${COMMIT_END}`);
  return output
    .split(COMMIT_END)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.includes(COMMIT_FIELD))
    .map((record) => {
      const [
        sha = "",
        parents = "",
        author = "",
        date = "",
        subject = "",
        body = "",
      ] = record.split(COMMIT_FIELD);
      return {
        sha,
        parent: parents.split(" ")[0] || null,
        author,
        date,
        subject,
        body: body.trim(),
        ...(history ? { history: true as const } : {}),
      };
    });
}

export async function readReviewCommits(args: {
  root: string;
  base: string;
  head: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewCommit[]> {
  const output = await runReviewScript(
    args,
    reviewCommitsScript(args.root, args.base, args.head, args.shQuote),
    {
      tag: "review.commits",
      timeoutMs: 20_000,
      label: "git log failed",
      target: { kind: "range", base: args.base, head: args.head },
      max: 300,
    },
  );
  return parseReviewCommits(output);
}

export async function readReviewCommitPatch(args: {
  root: string;
  commit: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewDiff> {
  const output = await runReviewScript(
    args,
    reviewCommitScript(args.root, args.commit, args.shQuote),
    {
      tag: "review.commit",
      timeoutMs: 30_000,
      label: "git diff failed",
      max: 300,
    },
  );
  return parseReviewPatchOutput(output);
}
