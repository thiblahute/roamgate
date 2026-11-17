import { sshReadCommandArgv } from "../bridge/ssh-command";
import type { RunProcessWithCodeTimeout } from "./file-types";
import { gitShellCommandArgv } from "./git-shell";

type Ref = { name: string; symbolic?: string; sha?: string };

/**
 * The default branch a branch is compared with, both forms it may have
 * here: the local branch and its remote-tracking counterpart (full ref
 * names). Either may be missing.
 */
export type DefaultBaseCandidates = { local?: string; remote?: string };

/**
 * The repository's recorded default branch, as a remote-tracking ref and
 * the local branch of the same name. A remote HEAD is the recorded
 * default, unlike the current feature branch's upstream: origin's first,
 * then other remotes'; without one, origin's `init.defaultBranch`, main
 * or master, and the local one of the same name.
 */
export function defaultBaseCandidates(
  refs: Ref[],
  configuredDefault: string,
): DefaultBaseCandidates {
  const existing = new Set(
    refs.filter((ref) => !ref.symbolic).map((ref) => ref.name),
  );
  const has = (name: string) => (existing.has(name) ? name : undefined);
  const remoteHeads = refs
    .filter(
      (ref) =>
        ref.name.startsWith("refs/remotes/") &&
        ref.name.endsWith("/HEAD") &&
        ref.symbolic,
    )
    .sort(
      (a, b) =>
        Number(b.name === "refs/remotes/origin/HEAD") -
          Number(a.name === "refs/remotes/origin/HEAD") ||
        a.name.localeCompare(b.name),
    );
  for (const head of remoteHeads) {
    const target = head.symbolic!;
    const remotePrefix = head.name.slice(0, -"HEAD".length);
    const local = target.startsWith(remotePrefix)
      ? has(`refs/heads/${target.slice(remotePrefix.length)}`)
      : undefined;
    const remote = has(target);
    if (local || remote) return { local, remote };
  }
  for (const name of [configuredDefault, "main", "master"]) {
    if (!name) continue;
    const local = has(`refs/heads/${name}`);
    const remote = has(`refs/remotes/origin/${name}`);
    if (local || remote) return { local, remote };
  }
  return {};
}

/** What git says of the two candidates, against HEAD. */
export type DefaultBaseFacts = {
  /** The local branch is checked out: comparing HEAD with it shows nothing. */
  onLocal: boolean;
  /** The remote ref is an ancestor of the local branch (or the same). */
  remoteInLocal: boolean;
  /** The local branch is an ancestor of the remote ref (or the same). */
  localInRemote: boolean;
  /** Each one's merge-base with HEAD: its commit time, 0 when none. */
  localForkTime: number;
  remoteForkTime: number;
  /** The local merge-base is an ancestor of the remote one, and back. */
  localForkInRemoteFork: boolean;
  remoteForkInLocalFork: boolean;
};

/**
 * Automatic's base: the more recent of the local default branch
 * and its remote counterpart, so a stale local `main` does not show its
 * gap as the branch's own work. When one contains the other, the one
 * ahead (the remote when they are the same, the review's base until
 * now); when they diverged, the one whose merge-base with HEAD is newest.
 * On the local default branch itself, its remote counterpart: the local
 * one would compare HEAD with itself.
 */
export function chooseDefaultBase(
  candidates: DefaultBaseCandidates,
  facts?: DefaultBaseFacts,
): string | undefined {
  const { local, remote } = candidates;
  if (!local || !remote || !facts) return remote ?? local;
  if (facts.onLocal) return remote;
  if (facts.localInRemote) return remote;
  if (facts.remoteInLocal) return local;
  if (facts.localForkInRemoteFork) return remote;
  if (facts.remoteForkInLocalFork) return local;
  return facts.localForkTime > facts.remoteForkTime ? local : remote;
}

/** A full ref name as the review writes a base: `origin/main`, `main`. */
export function shortRefName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, "");
}

/** One script: the refs, then `init.defaultBranch`. */
export function refsScript(shQuote: (value: string) => string, root: string) {
  return `
set -eu
git -C ${shQuote(root)} for-each-ref --format='%(refname)%09%(symref)%09%(objectname)' refs/heads/ refs/remotes/
printf '\\n--diff-base-config--\\n'
git -C ${shQuote(root)} config --get init.defaultBranch || test "$?" = 1
`;
}

export function parseRefsOutput(stdout: string): {
  refs: Ref[];
  configuredDefault: string;
} {
  const [refOutput = "", configuredDefault = ""] = stdout.split(
    "\n--diff-base-config--\n",
  );
  const refs = refOutput
    .split("\n")
    .filter((line) => line.startsWith("refs/"))
    .map((line) => {
      const [name = "", symbolic, sha] = line.split("\t");
      return { name, symbolic: symbolic || undefined, sha: sha || undefined };
    });
  return { refs, configuredDefault: configuredDefault.trim() };
}

/** One script: the facts chooseDefaultBase needs, one per line. */
function factsScript(
  shQuote: (value: string) => string,
  root: string,
  local: string,
  remote: string,
) {
  return `
cd ${shQuote(root)} || exit 2
l=${shQuote(local)}; r=${shQuote(remote)}
flag() { if "$@" >/dev/null 2>&1; then printf '1\\n'; else printf '0\\n'; fi; }
flag test "$(git symbolic-ref -q HEAD)" = "$l"
flag git merge-base --is-ancestor "$r" "$l"
flag git merge-base --is-ancestor "$l" "$r"
ml=$(git merge-base HEAD "$l" 2>/dev/null || true)
mr=$(git merge-base HEAD "$r" 2>/dev/null || true)
if [ -n "$ml" ]; then git log -1 --format=%ct "$ml"; else printf '0\\n'; fi
if [ -n "$mr" ]; then git log -1 --format=%ct "$mr"; else printf '0\\n'; fi
if [ -n "$ml" ] && [ -n "$mr" ]; then
  flag git merge-base --is-ancestor "$ml" "$mr"
  flag git merge-base --is-ancestor "$mr" "$ml"
else printf '0\\n0\\n'; fi
`;
}

export function parseFactsOutput(stdout: string): DefaultBaseFacts | undefined {
  // A login profile may print first: the facts are the last seven lines.
  const lines = stdout.trim().split("\n").slice(-7);
  if (lines.length < 7) return undefined;
  const [onLocal, remoteInLocal, localInRemote, lt, rt, lInR, rInL] = lines;
  return {
    onLocal: onLocal === "1",
    remoteInLocal: remoteInLocal === "1",
    localInRemote: localInRemote === "1",
    localForkTime: Number(lt) || 0,
    remoteForkTime: Number(rt) || 0,
    localForkInRemoteFork: lInR === "1",
    remoteForkInLocalFork: rInL === "1",
  };
}

/**
 * Automatic's base, the one Changes' Branch scope, Option+R and the
 * agent's `review_open` all use, read with only refs already present in
 * this repository (never a fetch), in one or two git scripts on the
 * connection's host: the refs, then, when the local and remote default
 * branches differ, how they relate to HEAD. The base and the other
 * candidate, full ref names; the branches to offer in Compare against.
 */
export async function resolveDefaultBase(args: {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  timeoutMs?: number;
  /** The refs, when the caller already read them. */
  listed?: { refs: Ref[]; configuredDefault: string };
}): Promise<{ base?: string; alternate?: string; branches: string[] }> {
  const timeout = args.timeoutMs ?? 10_000;
  const run = (script: string, tag: string) =>
    args.runProcessWithCodeTimeout(
      args.host
        ? sshReadCommandArgv(args.host, script, [], tag)
        : gitShellCommandArgv(script, undefined, { login: false }),
      timeout,
    );
  let listed = args.listed;
  if (!listed) {
    const result = await run(refsScript(args.shQuote, args.root), "git.refs");
    if (result.code !== 0)
      throw new Error(
        (result.stderr || result.stdout || "Unable to read branches")
          .trim()
          .slice(0, 1000),
      );
    listed = parseRefsOutput(result.stdout);
  }
  const { refs } = listed;
  const branches = refs.filter((ref) => !ref.symbolic).map((ref) => ref.name);
  const candidates = defaultBaseCandidates(refs, listed.configuredDefault);
  const { local, remote } = candidates;
  let facts: DefaultBaseFacts | undefined;
  if (local && remote) {
    const sha = (name: string) => refs.find((ref) => ref.name === name)?.sha;
    // The same commit: nothing to tell apart.
    if (!sha(local) || sha(local) !== sha(remote)) {
      const result = await run(
        factsScript(args.shQuote, args.root, local, remote),
        "git.base",
      );
      if (result.code === 0) facts = parseFactsOutput(result.stdout);
    }
  }
  const base = chooseDefaultBase(candidates, facts);
  const alternate =
    base === local ? remote : base === remote ? local : undefined;
  return { base, alternate, branches };
}

/**
 * Resolve Inspector comparisons using only refs already present in this
 * repository. Never fetch or update tracking refs while inspecting a diff.
 * `automatic` is Automatic's base (resolveDefaultBase), taken when no
 * branch is picked.
 */
export function selectDiffBase(
  refs: Ref[],
  automatic: string | undefined,
  requested?: unknown,
) {
  const branches = refs.filter((ref) => !ref.symbolic).map((ref) => ref.name);
  const existing = new Set(branches);
  const resolve = (name: string) =>
    [name, `refs/heads/${name}`, `refs/remotes/${name}`].find((ref) =>
      existing.has(ref),
    );
  if (requested !== undefined && requested !== "") {
    if (typeof requested !== "string" || !resolve(requested)) {
      throw new Error(
        "Comparison branch was not found; select an existing branch.",
      );
    }
    return { base: resolve(requested)!, branches };
  }
  return { base: automatic ? resolve(automatic) : undefined, branches };
}
