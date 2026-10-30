import { sshReadCommandArgv } from "../bridge/ssh-command";
import type {
  ReviewCommit,
  ReviewDiff,
  ReviewGoneCode,
  ReviewTarget,
} from "../../../shared/review";
import { parseUnifiedDiff } from "../review/patch";
import { gitShellCommandArgv } from "./git-shell";
import type { RunProcessWithCodeTimeout } from "./file-types";

export const REVIEW_PATCH_MAX_BYTES = 4 * 1024 * 1024;
const REVIEW_PATCH_TIMEOUT_MS = 30_000;
const MAX_UNTRACKED_FILES = 200;
const SHAS_MARKER = "ROAMGATE-REVIEW-SHAS";
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
 */
function resolveBase(base: string, shQuote: (value: string) => string) {
  return `b=$(git rev-parse --verify --quiet ${shQuote(`${base}^{commit}`)} 2>/dev/null || git rev-parse --verify --quiet ${shQuote(`${base}^{tree}`)}) || { echo "unknown revision: ${base.replace(/["$`\\]/g, "")}" >&2; exit 3; }`;
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
): string {
  const diff = "git diff --no-color --no-ext-diff --find-renames";
  const cap = `head -c ${maxBytes + 1}`;
  const lines = [enterCheckout(root, shQuote)];
  if (target.kind === "range") {
    lines.push(
      resolveBase(target.base, shQuote),
      `h=$(git rev-parse --verify --quiet ${shQuote(`${target.head}^{commit}`)}) || { echo "unknown revision: ${target.head.replace(/["$`\\]/g, "")}" >&2; exit 3; }`,
      // Review what the head adds, as a merge request would show it.
      `m=$(git merge-base "$b" "$h" 2>/dev/null) || m="$b"`,
      `{ printf '${SHAS_MARKER} %s %s\\n' "$m" "$h"; ${diff} "$m" "$h"; } | ${cap}`,
    );
  } else if (target.kind === "worktree") {
    lines.push(
      `h=$(git rev-parse --verify --quiet HEAD) || h=`,
      `{ printf '${SHAS_MARKER} %s %s\\n' "$h" "";`,
      `  ${diff} HEAD 2>/dev/null || ${diff} --cached;`,
      `  git ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED_FILES} |`,
      `  while IFS= read -r f; do git diff --no-color --no-index -- /dev/null "$f"; done;`,
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
  let text = output;
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
  if (truncated) {
    // Drop the partial file at the cut so no hunk ends mid-line.
    const lastFile = text.lastIndexOf("\ndiff --git ");
    if (lastFile > 0) text = text.slice(0, lastFile + 1);
  }
  return { files: parseUnifiedDiff(text), baseSha, headSha, truncated };
}

export async function readReviewPatch(args: {
  root: string;
  target: ReviewTarget;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewDiff> {
  const script = reviewPatchScript(args.root, args.target, args.shQuote);
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.patch")
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(
    argv,
    REVIEW_PATCH_TIMEOUT_MS,
  );
  if (result.code !== 0)
    throw reviewScriptError(
      result.stderr,
      "git diff failed",
      args.root,
      args.target,
    );
  return parseReviewPatchOutput(result.stdout);
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
  if (target.kind === "range")
    lines.push(
      `git rev-parse --verify --quiet ${shQuote(`${target.base}^{commit}`)} 2>/dev/null || git rev-parse --verify --quiet ${shQuote(`${target.base}^{tree}`)}`,
      `git rev-parse --verify --quiet ${shQuote(`${target.head}^{commit}`)}`,
    );
  else if (target.kind === "worktree")
    lines.push(
      "git rev-parse --verify --quiet HEAD",
      "{ git diff --no-color --no-ext-diff HEAD 2>/dev/null || git diff --no-color --no-ext-diff --cached; } | git hash-object --stdin",
      `git ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED_FILES} | { git hash-object --stdin-paths 2>/dev/null; git ls-files --others --exclude-standard | head -n ${MAX_UNTRACKED_FILES}; } | git hash-object --stdin`,
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
  const script = reviewStateScript(args.root, args.target, args.shQuote);
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.state")
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(argv, 20_000);
  if (result.code !== 0)
    throw reviewScriptError(result.stderr, "git failed", args.root);
  return result.stdout.trim().split(/\s+/).join(" ");
}

/** The repository holding `path` on the connection's host. */
export async function readReviewRoot(args: {
  path: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<string> {
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
 * The branch a review compares against when the agent names none: the
 * remote's default branch, else main or master.
 */
export async function readDefaultBase(args: {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<string> {
  const script = [
    `cd ${args.shQuote(args.root)} || exit 2`,
    'for r in "$(git symbolic-ref -q --short refs/remotes/origin/HEAD)" origin/main origin/master main master; do',
    '  [ -n "$r" ] && git rev-parse --verify -q "$r^{commit}" >/dev/null && { printf %s "$r"; exit 0; }',
    "done",
    "exit 3",
  ].join("\n");
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.base")
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(argv, 10_000);
  const base = result.stdout.trim();
  if (result.code !== 0 || !base)
    throw new Error("cannot find the default branch; pass --range BASE..HEAD");
  return base;
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
  const paths = args.paths.filter((path) => path.startsWith("/")).slice(0, 20);
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
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(argv, 30_000);
  const repos: ReviewRepo[] = [];
  for (const line of result.stdout.split("\n")) {
    const [root, branch, base, ahead, dirty, seed, active] = line.split("\t");
    if (!root?.startsWith("/") || seed === undefined) continue;
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
  const read = args.rev
    ? `git show ${args.shQuote(`${args.rev}:${args.path}`)}`
    : `cat -- ${args.shQuote(args.path)}`;
  const script = `${enterCheckout(args.root, args.shQuote)}\n${read} | head -c ${REVIEW_FILE_MAX_BYTES + 1}`;
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.file")
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(argv, 20_000);
  if (result.code !== 0)
    throw reviewScriptError(
      result.stderr,
      "cannot read the file",
      args.root,
      undefined,
      300,
    );
  if (Buffer.byteLength(result.stdout) > REVIEW_FILE_MAX_BYTES)
    throw new Error("the file is too large to show context from");
  return result.stdout;
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
  const script = args.entries
    .map(
      ({ root, ref }) =>
        `git -C ${args.shQuote(root)} rev-parse --verify --quiet ${args.shQuote(`${ref}^{commit}`)} 2>/dev/null || echo`,
    )
    .join("\n");
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.heads")
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(argv, 20_000);
  const lines = result.stdout.split("\n");
  return args.entries.map((_, index) => {
    const sha = lines[index]?.trim();
    return sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
  });
}

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
    `{ printf '${SHAS_MARKER} %s %s\\n' "$p" "$c"; git diff-tree -p -r --root --no-commit-id --no-color --no-ext-diff --find-renames --first-parent -m "$c"; } | head -c ${maxBytes + 1}`,
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
    `h=$(git rev-parse --verify --quiet ${shQuote(`${head}^{commit}`)}) || { echo "unknown revision: ${head.replace(/["$`\\]/g, "")}" >&2; exit 3; }`,
    // From a tree (the empty tree, to review everything): every commit.
    `if [ "$(git cat-file -t "$b")" = tree ]; then git log --reverse --no-color --format=${shQuote(format)} -n ${REVIEW_MAX_COMMITS} "$h"; exit 0; fi`,
    `m=$(git merge-base "$b" "$h") || m="$b"`,
    // Nothing of its own (the default branch itself): its history, latest
    // first, marked so it is not taken for the branch's work.
    `if [ "$m" = "$h" ]; then printf '${HISTORY_MARKER}${COMMIT_END}'; git log --no-color --format=${shQuote(format)} -n ${REVIEW_MAX_COMMITS} "$h"; exit 0; fi`,
    `git log --reverse --no-color --format=${shQuote(format)} -n ${REVIEW_MAX_COMMITS} "$m..$h"`,
  ].join("\n");
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
  const script = reviewCommitsScript(
    args.root,
    args.base,
    args.head,
    args.shQuote,
  );
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.commits")
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(argv, 20_000);
  if (result.code !== 0)
    throw reviewScriptError(
      result.stderr,
      "git log failed",
      args.root,
      { kind: "range", base: args.base, head: args.head },
      300,
    );
  return parseReviewCommits(result.stdout);
}

export async function readReviewCommitPatch(args: {
  root: string;
  commit: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewDiff> {
  const script = reviewCommitScript(args.root, args.commit, args.shQuote);
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], "review.commit")
    : gitShellCommandArgv(script);
  const result = await args.runProcessWithCodeTimeout(argv, 30_000);
  if (result.code !== 0)
    throw reviewScriptError(
      result.stderr,
      "git diff failed",
      args.root,
      undefined,
      300,
    );
  return parseReviewPatchOutput(result.stdout);
}
