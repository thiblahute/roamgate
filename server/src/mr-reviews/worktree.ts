import type { ForgeProvider } from "../../../shared/forge";
import { shQuote } from "./clones";

/**
 * The review worktree of a project: `<clone>.worktrees/review`, sharing
 * the clone's objects, checked out detached on the request under review.
 * The scripts run on the clone's host; nothing is built, nothing is ever
 * lost: local changes are kept on a branch or discarded only when the
 * user says so.
 */

export function reviewWorktreePath(clone: string): string {
  // gstreamer.git (a repository directory) -> gstreamer.worktrees/review.
  return `${clone.replace(/\/+$/, "").replace(/\.git$/, "")}.worktrees/review`;
}

/** Where a request's head is kept in the clone. */
export function mrRef(number: number): string {
  return `refs/roamgate/mr/${number}`;
}

/** The forge's ref of a request's head. */
export function forgeHeadRef(provider: ForgeProvider, number: number): string {
  return provider === "gitlab"
    ? `refs/merge-requests/${number}/head`
    : `refs/pull/${number}/head`;
}

/** The project's https URL, to fetch from when no remote is the project. */
export function projectUrl(host: string, project: string): string {
  return `https://${host}/${project}.git`;
}

const GIT_ENV =
  'export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"';

/** Creates the worktree (detached at START) unless it is there. */
export function ensureWorktreeScript(
  clone: string,
  path: string,
  start: string,
): string {
  return [
    "set -e",
    GIT_ENV,
    `cd ${shQuote(clone)}`,
    `if [ -e ${shQuote(`${path}/.git`)} ]; then echo EXISTS; exit 0; fi`,
    `mkdir -p "$(dirname ${shQuote(path)})"`,
    `s=$(git rev-parse --verify --quiet ${shQuote(`${start}^{commit}`)} || git rev-parse HEAD)`,
    `git worktree add --detach ${shQuote(path)} "$s" >&2`,
    "echo CREATED",
  ].join("\n");
}

export type FetchWant = {
  number: number;
  headSha: string;
  /** The diff base: fetched with the target branch when missing. */
  baseSha?: string;
  targetBranch?: string;
};

/**
 * Fetches the heads (and bases) of the requests that the clone does not
 * have yet, in one `git fetch`. Prints `HAVE n` / `FETCHED n` / `MISSING n`.
 */
export function fetchScript(
  clone: string,
  source: string,
  provider: ForgeProvider,
  wants: FetchWant[],
): string {
  const checks = wants.map((want) => {
    const spec = `+${forgeHeadRef(provider, want.number)}:${mrRef(want.number)}`;
    const base =
      want.baseSha && want.targetBranch
        ? ` ${shQuote(`+refs/heads/${want.targetBranch}:refs/roamgate/target/${want.targetBranch}`)}`
        : "";
    const haveBase = want.baseSha
      ? ` && git cat-file -e ${shQuote(`${want.baseSha}^{commit}`)} 2>/dev/null`
      : "";
    return [
      `if git cat-file -e ${shQuote(`${want.headSha}^{commit}`)} 2>/dev/null${haveBase}; then`,
      `  git update-ref ${shQuote(mrRef(want.number))} ${shQuote(want.headSha)} 2>/dev/null || true`,
      `  echo "HAVE ${want.number}"`,
      "else",
      `  specs="$specs ${shQuote(spec)}${base}"; nums="$nums ${want.number}"`,
      "fi",
    ].join("\n");
  });
  return [
    GIT_ENV,
    `cd ${shQuote(clone)} || exit 2`,
    'specs=""; nums=""',
    ...checks,
    '[ -z "$specs" ] && exit 0',
    `if eval git fetch --no-tags --quiet ${shQuote(source)} $specs >&2; then`,
    '  for n in $nums; do echo "FETCHED $n"; done',
    "else",
    // One request gone (merged and its ref removed) must not keep the
    // others: one at a time then.
    "  for n in $nums; do",
    `    case "${provider}" in gitlab) r="refs/merge-requests/$n/head" ;; *) r="refs/pull/$n/head" ;; esac`,
    `    if git fetch --no-tags --quiet ${shQuote(source)} "+$r:refs/roamgate/mr/$n" >&2; then echo "FETCHED $n"; else echo "MISSING $n"; fi`,
    "  done",
    "fi",
    "exit 0",
  ].join("\n");
}

export function parseFetch(stdout: string): {
  have: number[];
  fetched: number[];
  missing: number[];
} {
  const out = {
    have: [] as number[],
    fetched: [] as number[],
    missing: [] as number[],
  };
  for (const line of stdout.split("\n")) {
    const [word, n] = line.trim().split(" ");
    const number = Number(n);
    if (!Number.isSafeInteger(number)) continue;
    if (word === "HAVE") out.have.push(number);
    else if (word === "FETCHED") out.fetched.push(number);
    else if (word === "MISSING") out.missing.push(number);
  }
  return out;
}

/** The worktree's head and its local changes (`git status --porcelain`). */
export function statusScript(path: string): string {
  return [
    `cd ${shQuote(path)} || exit 2`,
    'printf "HEAD %s\\n" "$(git rev-parse HEAD 2>/dev/null)"',
    'printf "BRANCH %s\\n" "$(git symbolic-ref -q --short HEAD 2>/dev/null)"',
    "git status --porcelain=v1 -uall 2>/dev/null | head -200 | sed 's/^/C /'",
  ].join("\n");
}

export type WorktreeStatus = {
  head: string;
  branch: string;
  /** Changed paths, `XY path` as git prints them. */
  changes: string[];
};

export function parseStatus(stdout: string): WorktreeStatus {
  const status: WorktreeStatus = { head: "", branch: "", changes: [] };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("HEAD ")) status.head = line.slice(5).trim();
    else if (line.startsWith("BRANCH ")) status.branch = line.slice(7).trim();
    else if (line.startsWith("C ")) status.changes.push(line.slice(2));
  }
  return status;
}

/** What to do with local changes before switching. */
export type LocalChanges = "refuse" | "wip" | "discard";

/**
 * Checks out SHA detached. With local changes: `refuse` prints DIRTY and
 * changes nothing; `wip` commits them all on a new `review/<label>` branch
 * (another name if taken) first and prints `KEPT <branch>`; `discard`
 * resets and cleans, as the user asked.
 */
export function checkoutScript(
  path: string,
  sha: string,
  local: LocalChanges,
  label: string,
): string {
  const branch = `review/${label.replace(/[^\w.-]+/g, "-")}`;
  return [
    GIT_ENV,
    `cd ${shQuote(path)} || exit 2`,
    `git cat-file -e ${shQuote(`${sha}^{commit}`)} 2>/dev/null || { echo "NOCOMMIT"; exit 3; }`,
    'if [ -n "$(git status --porcelain=v1 -uall 2>/dev/null | head -1)" ]; then',
    ...(local === "refuse"
      ? ['  echo "DIRTY"; exit 4']
      : local === "wip"
        ? [
            `  b=${shQuote(branch)}`,
            '  if git show-ref --verify --quiet "refs/heads/$b"; then b="$b-$(date +%Y%m%d-%H%M%S)"; fi',
            '  git checkout -q -b "$b" >&2 || exit 5',
            `  git add -A >&2 && git commit -q --no-verify -m ${shQuote(`WIP review of ${label}`)} >&2 || exit 5`,
            '  echo "KEPT $b"',
          ]
        : [
            "  git reset -q --hard >&2 && git clean -fdq >&2 || exit 5",
            '  echo "DISCARDED"',
          ]),
    "fi",
    `git checkout -q --detach ${shQuote(sha)} >&2 || exit 6`,
    'echo "AT $(git rev-parse HEAD)"',
  ].join("\n");
}

export type CheckoutResult =
  | { state: "done"; head: string; kept?: string; discarded?: boolean }
  | { state: "dirty" }
  | { state: "missing" }
  | { state: "error"; message: string };

export function parseCheckout(result: {
  code: number;
  stdout: string;
  stderr: string;
}): CheckoutResult {
  const lines = result.stdout.split("\n").map((line) => line.trim());
  if (lines.includes("DIRTY")) return { state: "dirty" };
  if (lines.includes("NOCOMMIT")) return { state: "missing" };
  const at = lines.find((line) => line.startsWith("AT "));
  if (result.code === 0 && at) {
    const kept = lines.find((line) => line.startsWith("KEPT "));
    return {
      state: "done",
      head: at.slice(3),
      ...(kept ? { kept: kept.slice(5) } : {}),
      ...(lines.includes("DISCARDED") ? { discarded: true } : {}),
    };
  }
  return {
    state: "error",
    message: (result.stderr || "the checkout failed").trim().slice(-300),
  };
}
