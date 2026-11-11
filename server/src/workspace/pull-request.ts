import type {
  PullRequest,
  PullRequestStatus,
  ReviewProvider,
  ReviewRemote,
} from "../../../shared/pullRequest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  type ForgeCall,
  ForgeBusyError,
  type ProcessOutput,
  forgeGate,
} from "./forge-calls";
import type { GitActionContext } from "./git-actions";

/** What the CLIs say of their hosts and logins: rarely changes. */
const HOSTS_REUSE_MS = 10 * 60_000;
/**
 * The longest a host listing may take: `glab auth status` can wait forever
 * on a keyring nobody unlocks (a locked macOS keychain over SSH).
 */
const HOSTS_TIMEOUT_MS = 8_000;
/** The exit status a listing that ran out of time is remembered by. */
const TIMED_OUT = 124;
/** A project's id and fork parent. */
const PROJECT_REUSE_MS = 30 * 60_000;
/** A branch's request list, for the sidebar's summaries. */
const LIST_REUSE_MS = 2 * 60_000;
/** A request's pipeline and approvals, for the card. */
const DETAIL_REUSE_MS = 15_000;

/** Local answers (CLI versions, glab's configured logins), by runner. */
const localFacts = new WeakMap<
  object,
  Map<string, { until: number; value: Promise<ProcessOutput> }>
>();
function rememberLocal(
  owner: object,
  key: string,
  load: () => Promise<ProcessOutput>,
): Promise<ProcessOutput> {
  let facts = localFacts.get(owner);
  if (!facts) {
    facts = new Map();
    localFacts.set(owner, facts);
  }
  const known = facts.get(key);
  if (known && known.until > Date.now()) return known.value;
  const entry = { until: Number.POSITIVE_INFINITY, value: load() };
  facts.set(key, entry);
  entry.value.then(
    (output) => {
      // A missing CLI may be installed any time; a present one stays, and
      // one that ran out of time would only hang again soon.
      entry.until =
        Date.now() +
        (output.code === 0 || output.code === TIMED_OUT
          ? HOSTS_REUSE_MS
          : 60_000);
    },
    () => {
      if (facts.get(key) === entry) facts.delete(key);
    },
  );
  return entry.value;
}

// Remote URLs and CLI diagnostics can contain credentials. Only project identity
// and explicitly selected provider fields may cross the browser boundary.
export function parseReviewRemote(
  name: string,
  value: string,
): ReviewRemote | null {
  try {
    const scp = value.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/);
    const url = new URL(
      value.includes("://") ? value : scp ? `ssh://${scp[1]}/${scp[2]}` : "",
    );
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol))
      return null;
    const host = url.protocol === "ssh:" ? url.hostname : url.host;
    const repository = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/, "");
    if (
      !/^[a-z0-9][a-z0-9.-]*(?::\d+)?$/i.test(host) ||
      !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..")
    )
      return null;
    return { name, host: host.toLowerCase(), repository };
  } catch {
    return null;
  }
}

/**
 * A failure whose message names the step that failed. It only holds text
 * this module writes (commands, API paths, HTTP status codes), never CLI
 * output, which can contain credentials.
 */
class StatusError extends Error {}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StatusError("invalid provider response");
  return value as Record<string, any>;
}
function text(value: unknown, fallback = "Unknown"): string {
  return typeof value === "string" && value ? value.slice(0, 2000) : fallback;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new StatusError("invalid provider identifier");
  return value as number;
}
function list(value: unknown, step: string): any[] {
  if (!Array.isArray(value))
    throw new StatusError(`${step} did not return a list`);
  // Never silently choose from a truncated result set.
  if (value.length >= 100)
    throw new StatusError(`${step} returned 100 or more requests`);
  return value;
}
function webUrl(host: string, value: unknown): string {
  const url = new URL(String(value));
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.host.toLowerCase() !== host ||
    url.username ||
    url.password
  )
    throw new StatusError("invalid provider URL");
  return url.href;
}

/** Host names listed one per line, as `gh` and `glab auth status` print them. */
function hostLines(output: string): Set<string> {
  return new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) =>
        /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?::\d+)?$/.test(line),
      ),
  );
}

/** A command as an error message names it: `glab api <path>` for API calls. */
function describeStep(argv: string[]): string {
  const step =
    argv[1] === "api" ? `${argv[0]} api ${argv.at(-1)}` : argv.join(" ");
  return step.length > 200 ? `${step.slice(0, 200)}...` : step;
}

export function githubChecks(value: unknown): string {
  if (!Array.isArray(value)) return "Unavailable";
  if (!value.length) return "No checks reported";
  const counts = new Map<string, number>();
  for (const item of value) {
    const check = object(item);
    const state =
      check.__typename === "CheckRun"
        ? check.status === "COMPLETED"
          ? text(check.conclusion)
          : text(check.status)
        : check.__typename === "StatusContext"
          ? text(check.state)
          : "Unknown";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
}

export function gitlabApprovals(value: unknown): string {
  const data = object(value);
  // approved_by alone does not establish that approval rules are satisfied.
  if (typeof data.approved !== "boolean") {
    return Number.isSafeInteger(data.approvals_left) && data.approvals_left >= 0
      ? `${data.approvals_left} approvals remaining (provider-reported)`
      : "Unavailable";
  }
  const count = Array.isArray(data.approved_by)
    ? data.approved_by.length
    : null;
  return `${data.approved ? "Approved" : "Not approved"} (provider-reported)${count === null ? "" : `; ${count} approver(s)`}`;
}

/** A branch with an open request: a push, review or merge shows soon. */
export const BATCH_OPEN_MS = 2 * 60_000;
/** No request yet: one being opened shows within this. */
export const BATCH_NONE_MS = 3 * 60_000;
/** Only merged or closed requests. */
export const BATCH_SETTLED_MS = 30 * 60_000;
/** How long summaries asked together wait for each other. */
export const BATCH_WINDOW_MS = 100;
/** A branch asked about this recently is refreshed with the others. */
const INTEREST_MS = 15 * 60_000;
const BATCH_BRANCHES = 50;

type BranchRequests = Record<string, any>[] | "overflow";
type MergeRequestBatch = {
  /** Branches asked about, by project path, with when. */
  interest: Map<string, Map<string, number>>;
  answers: Map<string, { until: number; requests: BranchRequests }>;
  waiting: {
    project: string;
    branch: string;
    resolve: (requests: BranchRequests) => void;
    reject: (error: unknown) => void;
  }[];
  timer: ReturnType<typeof setTimeout> | null;
  ask: (query: string) => Promise<unknown>;
};
const batches = new WeakMap<object, Map<string, MergeRequestBatch>>();

function validPath(path: string): boolean {
  return (
    /^[\w.-]+(?:\/[\w.-]+)+$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

const REQUEST_FIELDS =
  "iid title state draft webUrl createdAt sourceBranch targetBranch sourceProjectId targetProjectId author { username }";

/**
 * One GraphQL query for the requests of several branches of several
 * projects. Strings are JSON literals, which GraphQL reads as its own.
 */
export function gitlabBranchesQuery(projects: [string, string[]][]): string {
  const parts = projects.map(
    ([path, branches], index) =>
      `p${index}: project(fullPath: ${JSON.stringify(path)}) { mergeRequests(sourceBranches: ${JSON.stringify(branches)}, first: 100) { pageInfo { hasNextPage } nodes { ${REQUEST_FIELDS} } } }`,
  );
  return `query { ${parts.join(" ")} }`;
}

/** A GraphQL merge request in the REST shape the lookup reads. */
function restShape(node: Record<string, any>): Record<string, any> {
  return {
    iid: Number(node.iid),
    title: node.title,
    author: { username: node.author?.username },
    source_branch: node.sourceBranch,
    target_branch: node.targetBranch,
    source_project_id: node.sourceProjectId,
    target_project_id: node.targetProjectId,
    state: node.state,
    draft: node.draft,
    web_url: node.webUrl,
    created_at: node.createdAt,
  };
}

function answerTtl(requests: BranchRequests): number {
  if (requests === "overflow") return 0;
  if (!requests.length) return BATCH_NONE_MS;
  return requests.some((mr) => mr.state === "opened" || mr.state === "locked")
    ? BATCH_OPEN_MS
    : BATCH_SETTLED_MS;
}

async function flushBatch(batch: MergeRequestBatch) {
  batch.timer = null;
  const waiting = batch.waiting.splice(0);
  if (!waiting.length) return;
  const at = Date.now();
  const projects = new Map<string, string[]>();
  for (const { project, branch } of waiting) {
    const branches = projects.get(project) ?? [];
    if (!branches.includes(branch)) branches.push(branch);
    projects.set(project, branches);
  }
  // The other branches asked about lately ride along for free.
  for (const [project, branches] of projects) {
    const asked = batch.interest.get(project);
    if (!asked) continue;
    for (const [branch, when] of [...asked].sort((a, b) => b[1] - a[1])) {
      if (when <= at - INTEREST_MS) asked.delete(branch);
      else if (branches.length < BATCH_BRANCHES && !branches.includes(branch))
        branches.push(branch);
    }
  }
  const list = [...projects];
  try {
    const answer = (await batch.ask(gitlabBranchesQuery(list))) as Record<
      string,
      any
    > | null;
    const data = answer?.data;
    if (!data || typeof data !== "object")
      throw new StatusError("GitLab GraphQL returned no data");
    const done = Date.now();
    list.forEach(([project, branches], index) => {
      const found = data[`p${index}`]?.mergeRequests;
      if (!found || !Array.isArray(found.nodes)) return;
      const overflow = found.pageInfo?.hasNextPage === true;
      for (const branch of branches) {
        const requests: BranchRequests = overflow
          ? "overflow"
          : found.nodes
              .filter(
                (node: unknown) =>
                  !!node &&
                  typeof node === "object" &&
                  (node as Record<string, unknown>).sourceBranch === branch,
              )
              .map(restShape);
        batch.answers.set(`${project}\0${branch}`, {
          until: done + answerTtl(requests),
          requests,
        });
      }
    });
    for (const waiter of waiting) {
      const known = batch.answers.get(`${waiter.project}\0${waiter.branch}`);
      if (known) waiter.resolve(known.requests);
      else waiter.reject(new StatusError("GitLab GraphQL had no such project"));
    }
  } catch (error) {
    for (const waiter of waiting) waiter.reject(error);
  }
  // Old answers go; the map stays small.
  if (batch.answers.size > 500)
    for (const [key, answer] of batch.answers)
      if (answer.until <= Date.now()) batch.answers.delete(key);
}

/**
 * The merge requests of a branch in a project, from one GraphQL query
 * per forge host for every branch asked about together (and those asked
 * lately), remembered for as long as what they say can wait.
 */
function branchRequests(
  owner: object,
  key: string,
  project: string,
  branch: string,
  ask: (query: string) => Promise<unknown>,
): Promise<BranchRequests> {
  let byHost = batches.get(owner);
  if (!byHost) {
    byHost = new Map();
    batches.set(owner, byHost);
  }
  let batch = byHost.get(key);
  if (!batch) {
    batch = {
      interest: new Map(),
      answers: new Map(),
      waiting: [],
      timer: null,
      ask,
    };
    byHost.set(key, batch);
  }
  const asked = batch.interest.get(project) ?? new Map<string, number>();
  asked.set(branch, Date.now());
  batch.interest.set(project, asked);
  const known = batch.answers.get(`${project}\0${branch}`);
  if (known && known.until > Date.now()) return Promise.resolve(known.requests);
  const current = batch;
  current.ask = ask;
  return new Promise((resolve, reject) => {
    current.waiting.push({ project, branch, resolve, reject });
    current.timer ??= setTimeout(
      () => void flushBatch(current),
      BATCH_WINDOW_MS,
    );
  });
}

/** A badge's answer is reused this long while the checkout's HEAD stays. */
export const SHARED_SUMMARY_MS = LIST_REUSE_MS;

type SharedAnswers = {
  answers: Map<string, { at: number; head: string; status: PullRequestStatus }>;
  inFlight: Map<string, Promise<PullRequestStatus>>;
};
const sharedAnswers = new WeakMap<object, SharedAnswers>();

/** Where HEAD is, as one cheap command: its ref and commit. */
async function readHead(context: GitActionContext): Promise<string | null> {
  const argv = ["git", "rev-parse", "--symbolic-full-name", "HEAD", "HEAD"];
  try {
    const output = context.host
      ? await context.runProcessWithCodeTimeout(
          sshCommandArgv(
            context.host,
            `cd ${context.shQuote(context.root)} && ${argv.map(context.shQuote).join(" ")}`,
            [],
            "git.pull_request",
          ),
          15_000,
        )
      : await context.runProcessWithCodeTimeout(argv, 15_000, {
          cwd: context.root,
        });
    return output.code === 0 ? output.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * A checkout's pull or merge request status, shared by every browser
 * asking: identical lookups in flight are one, and a badge's answer is
 * reused for SHARED_SUMMARY_MS while HEAD is on the same ref and commit
 * (the forge lists behind it are reused that long anyway). A card's
 * lookup (not a summary) is always read afresh, and replaces what the
 * badges of that checkout knew.
 */
export function sharedPullRequestStatus(
  context: GitActionContext,
  params: Record<string, unknown>,
): Promise<PullRequestStatus> {
  const owner = context.runProcessWithCodeTimeout;
  let shared = sharedAnswers.get(owner);
  if (!shared) {
    shared = { answers: new Map(), inFlight: new Map() };
    sharedAnswers.set(owner, shared);
  }
  const state = shared;
  const checkout = JSON.stringify([context.host ?? "", context.root]);
  const asked = Object.entries(params)
    .filter(([name]) => name !== "workspace_id" && name !== "worktree_path")
    .toSorted(([a], [b]) => a.localeCompare(b));
  const key = `${checkout}\0${JSON.stringify(asked)}`;
  const flying = state.inFlight.get(key);
  if (flying) return flying;
  const summary = params.summary === true;
  const task = (async () => {
    const known = summary ? state.answers.get(key) : undefined;
    const fresh = known && Date.now() - known.at < SHARED_SUMMARY_MS;
    // Read before the lookup: a HEAD that moves during it misses next time.
    const head = summary ? await readHead(context) : null;
    if (fresh && head !== null && head === known.head) return known.status;
    const status = await readPullRequestStatus(context, params);
    if (!summary) {
      for (const each of state.answers.keys())
        if (each.startsWith(`${checkout}\0`)) state.answers.delete(each);
    } else if (
      head !== null &&
      status.state !== "error" &&
      status.retryable !== true
    ) {
      state.answers.set(key, { at: Date.now(), head, status });
      if (state.answers.size > 500)
        for (const [each, answer] of state.answers)
          if (Date.now() - answer.at >= SHARED_SUMMARY_MS)
            state.answers.delete(each);
    } else state.answers.delete(key);
    return status;
  })().finally(() => {
    if (state.inFlight.get(key) === task) state.inFlight.delete(key);
  });
  state.inFlight.set(key, task);
  return task;
}

export async function readPullRequestStatus(
  context: GitActionContext,
  params: Record<string, unknown>,
): Promise<PullRequestStatus> {
  const result: PullRequestStatus = {
    state: "error",
    root: context.root,
    branch: "",
    remotes: [],
    refreshedAt: new Date().toISOString(),
  };
  const deadline = Date.now() + 55_000;
  async function run(argv: string[], limitMs = 15_000) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new StatusError(`timed out before ${describeStep(argv)}`);
    const timeout = Math.min(limitMs, remaining);
    try {
      if (context.host) {
        const command = `cd ${context.shQuote(context.root)} && GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 NO_COLOR=1 ${argv.map(context.shQuote).join(" ")}`;
        return await context.runProcessWithCodeTimeout(
          sshCommandArgv(context.host, command, [], "git.pull_request"),
          timeout,
        );
      }
      return await context.runProcessWithCodeTimeout(argv, timeout, {
        cwd: context.root,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
          NO_COLOR: "1",
        },
      });
    } catch (error) {
      // Native spawning reports a missing executable by throwing, unlike SSH's shell.
      if (!context.host && (error as NodeJS.ErrnoException).code === "ENOENT")
        return { code: 127, stdout: "", stderr: "" };
      throw new StatusError(
        /timed out/i.test(String((error as Error)?.message))
          ? `${describeStep(argv)} timed out`
          : `${describeStep(argv)} could not run`,
      );
    }
  }
  const checkout = context.host ?? "";
  const owner = context.runProcessWithCodeTimeout;
  const feature = params.summary === true ? "badge" : "card";
  // A network call to a forge: budgeted per host, shared, logged.
  async function forgeCall(
    call: Pick<
      ForgeCall,
      "host" | "kind" | "conditional" | "include" | "reuseMs"
    >,
    argv: string[],
    timeoutMs?: number,
  ): Promise<ProcessOutput & { status?: number }> {
    try {
      return await forgeGate.run(
        owner,
        { checkout, feature, deadline, ...call },
        argv,
        (argv) => run(argv, timeoutMs),
      );
    } catch (error) {
      if (error instanceof ForgeBusyError)
        throw new StatusError(
          `${describeStep(argv)} waited too long: ${call.host} is busy or rate limited`,
        );
      throw error;
    }
  }
  async function json(
    argv: string[],
    answer?: Promise<ProcessOutput & { status?: number }>,
  ) {
    const step = describeStep(argv);
    const output: ProcessOutput & { status?: number } = await (answer ??
      run(argv));
    if (output.code !== 0) {
      // Only the HTTP status is taken from the CLI's diagnostics.
      const status =
        output.status !== undefined && output.status >= 400
          ? String(output.status)
          : /\(HTTP (\d{3})\)/.exec(output.stderr)?.[1];
      throw new StatusError(
        status
          ? `${step} returned HTTP ${status}`
          : `${step} failed with exit code ${output.code}`,
      );
    }
    try {
      return JSON.parse(output.stdout);
    } catch {
      throw new StatusError(`${step} returned invalid JSON`);
    }
  }
  function finish(state: PullRequestStatus["state"], message?: string) {
    return { ...result, state, message, refreshedAt: new Date().toISOString() };
  }
  // Rebases stop on a detached HEAD, but Git records the branch being rebased.
  // That ref is trusted only while the rebase itself last moved HEAD; other
  // detached checkouts stay unresolved instead of guessing from commits.
  async function readBranch(): Promise<{
    name: string;
    rebasing: boolean;
  } | null> {
    const branch = await run([
      "git",
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (branch.code === 0)
      return { name: branch.stdout.trim(), rebasing: false };
    if (branch.code !== 1)
      throw new StatusError("git symbolic-ref HEAD failed");
    // --git-path resolves linked worktrees' private rebase state.
    const paths = await run([
      "git",
      "rev-parse",
      "--git-path",
      "rebase-merge/head-name",
      "--git-path",
      "rebase-apply/head-name",
    ]);
    if (paths.code !== 0)
      throw new StatusError("git rev-parse --git-path failed");
    for (const path of paths.stdout.split(/\r?\n/).filter(Boolean)) {
      const ref = (await readGitFile(path))?.trim();
      if (!ref) continue;
      if (!ref.startsWith("refs/heads/") || ref === "refs/heads/") return null;
      const exists = await run([
        "git",
        "rev-parse",
        "--verify",
        "--quiet",
        ref,
      ]);
      if (exists.code !== 0) return null;
      // A manual checkout or reset mid-rebase (even to the rebase's own base)
      // must not inherit the rebased branch's request. Commits and amends
      // made at a rebase stop keep HEAD on the rebase.
      const reflog = await run([
        "git",
        "log",
        "--walk-reflogs",
        "--format=%gs",
        "-n",
        "50",
        "HEAD",
      ]);
      if (reflog.code !== 0) return null;
      const moved = reflog.stdout
        .split(/\r?\n/)
        .find((entry) => entry && !/^commit(?: \([a-z]+\))?: /.test(entry));
      // `pull --rebase` logs its whole command line before each step; a merge
      // pull logs no step and never leaves rebase metadata behind.
      if (
        !moved ||
        !/^(?:rebase(?: \([a-z-]+\))?|pull\b.* \([a-z-]+\)): /.test(moved)
      )
        return null;
      return { name: ref.slice("refs/heads/".length), rebasing: true };
    }
    return null;
  }
  async function readGitFile(path: string): Promise<string | null> {
    if (context.host) {
      const output = await run(["cat", "--", path]);
      return output.code === 0 ? output.stdout : null;
    }
    try {
      return await readFile(resolve(context.root, path), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }
  try {
    const branch = await readBranch();
    if (!branch)
      return finish("detached", "Detached HEAD has no branch to resolve.");
    result.branch = branch.name;
    if (branch.rebasing) result.rebasing = true;
    // Workspace status reports any detached HEAD as the "detached" sentinel.
    if (
      params.branch &&
      params.branch !== result.branch &&
      !(branch.rebasing && params.branch === "detached")
    )
      return finish(
        "error",
        "The branch changed. Refresh workspace status and try again.",
      );
    const remotes = await run(["git", "remote", "-v"]);
    if (remotes.code !== 0) throw new StatusError("git remote -v failed");
    for (const line of remotes.stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(.+)\s+\(fetch\)$/);
      if (!match) continue;
      const remote = parseReviewRemote(match[1], match[2]);
      if (remote) result.remotes.push(remote);
    }
    if (!result.remotes.length)
      return finish("unsupported", "No supported network remote found.");
    const remoteNamed = (name: string | undefined) =>
      name === undefined
        ? undefined
        : result.remotes.find((remote) => remote.name === name);

    // A host listing that runs out of time answers TIMED_OUT, which is
    // remembered as long as an answer: the hosts are then unknown.
    const bounded = async (
      read: () => Promise<ProcessOutput>,
    ): Promise<ProcessOutput> => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof StatusError && /timed out$/.test(error.message))
          return { code: TIMED_OUT, stdout: "", stderr: "" };
        throw error;
      }
    };
    // Ask CLIs only about their configured hosts; never probe an arbitrary
    // remote with a token intended for another host.
    type Listing = { hosts: Set<string> | null; error?: string };
    const listing = (read: () => Promise<Set<string>>) => {
      let pending: Promise<Listing> | undefined;
      return () =>
        (pending ??= read().then(
          (hosts): Listing => ({ hosts }),
          (error): Listing => ({
            hosts: null,
            error:
              error instanceof StatusError ? error.message : "it could not run",
          }),
        ));
    };
    const ghHosts = listing(async () => {
      const output = await forgeCall(
        { host: "*", kind: "auth-hosts", reuseMs: HOSTS_REUSE_MS },
        ["gh", "auth", "status", "--json", "hosts", "--jq", ".hosts | keys[]"],
      );
      return hostLines(output.stdout);
    });
    // `glab auth status` calls every configured instance's API, which can
    // take longer than a request may wait, so glab's own configuration is
    // asked first, without a network call.
    const glabLogins = new Map<string, Promise<boolean>>();
    const glabLogin = (host: string) => {
      let login = glabLogins.get(host);
      if (!login) {
        // A token from the environment (or one for no host in particular,
        // which a made-up host gets) is not a login for this host. Only the
        // host is printed, never the token.
        const script = `token() { (unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN; GLAB_NO_PROMPT=1 glab config get token --host "$1" 2>/dev/null); }; t=$(token "$1"); [ -n "$t" ] && [ "$t" != "$(token roamgate.invalid)" ] && printf '%s\\n' "$1"; exit 0`;
        login = rememberLocal(owner, `${checkout}\nglab-login\n${host}`, () =>
          bounded(() =>
            run(["sh", "-c", script, "sh", host], HOSTS_TIMEOUT_MS),
          ),
        ).then(
          (output) => output.code === 0 && output.stdout.trim() === host,
          () => false,
        );
        glabLogins.set(host, login);
      }
      return login;
    };
    // Asked once per connection, not per checkout, within HOSTS_TIMEOUT_MS
    // (a keyring can keep it waiting forever), and an answer that ran out
    // of time is not asked again for HOSTS_REUSE_MS.
    const glabHosts = listing(async () => {
      const output = await rememberLocal(owner, `${checkout}\nglab-hosts`, () =>
        bounded(async () => {
          const hosts = {
            host: "*",
            kind: "auth-hosts",
            reuseMs: HOSTS_REUSE_MS,
          };
          const status = (argv: string[]) =>
            forgeCall(hosts, argv, HOSTS_TIMEOUT_MS);
          const all = await status(["glab", "auth", "status", "--all"]);
          // Older glab (1.67, for one) has no --all and lists every host
          // without it.
          return all.code !== 0 &&
            /unknown flag:? '?--all/i.test(`${all.stdout}\n${all.stderr}`)
            ? status(["glab", "auth", "status"])
            : all;
        }),
      );
      if (output.code === TIMED_OUT)
        throw new StatusError("glab auth status timed out");
      return hostLines(`${output.stdout}\n${output.stderr}`);
    });
    type Forge = { provider: ReviewProvider; apiHost: string };
    // GitLab instances often serve SSH on ssh.<host>; such a remote uses the
    // API of <host> when that one is a known or configured instance.
    async function forgeFor(host: string): Promise<Forge | "ambiguous" | null> {
      const hosts = host.startsWith("ssh.") ? [host, host.slice(4)] : [host];
      for (const apiHost of hosts) {
        if (apiHost === "github.com") return { provider: "github", apiHost };
        if (apiHost === "gitlab.com") return { provider: "gitlab", apiHost };
      }
      const gh = await ghHosts();
      const find = async (
        gitlabHas: (apiHost: string) => boolean | Promise<boolean>,
      ) => {
        for (const apiHost of hosts) {
          const github = gh.hosts?.has(apiHost) ?? false;
          const gitlab = await gitlabHas(apiHost);
          if (github && gitlab) return "ambiguous" as const;
          if (github) return { provider: "github" as const, apiHost };
          if (gitlab) return { provider: "gitlab" as const, apiHost };
        }
        return null;
      };
      const configured = await find(glabLogin);
      if (configured) return configured;
      const glab = await glabHosts();
      const listed = await find((apiHost) => glab.hosts?.has(apiHost) ?? false);
      if (listed) return listed;
      const failure = gh.error ?? glab.error;
      if (failure)
        throw new StatusError(
          `could not list the hosts configured in gh and glab for ${host}: ${failure}`,
        );
      return null;
    }

    const branchRef = `refs/heads/${result.branch}`;
    const [refs, config] = await Promise.all([
      run([
        "git",
        "for-each-ref",
        "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(symref)",
        branchRef,
        `refs/remotes/*/${result.branch}`,
        "refs/remotes/*/HEAD",
      ]),
      run([
        "git",
        "config",
        "--get-regexp",
        "^(branch\\..*\\.pushremote|remote\\.pushdefault)$",
      ]),
    ]);
    if (refs.code !== 0) throw new StatusError("git for-each-ref failed");
    // 1: none of these keys is set.
    if (config.code !== 0 && config.code !== 1)
      throw new StatusError("git config --get-regexp failed");
    let upstream: { remote: string; ref: string } | undefined;
    const pushed: ReviewRemote[] = [];
    const remoteHeads = new Map<string, string>();
    for (const line of refs.stdout.split(/\r?\n/)) {
      const [ref = "", upstreamRemote = "", upstreamRef = "", symref = ""] =
        line.split("\0");
      if (ref === branchRef) {
        upstream = { remote: upstreamRemote, ref: upstreamRef };
        continue;
      }
      for (const remote of result.remotes) {
        const prefix = `refs/remotes/${remote.name}/`;
        if (ref === `${prefix}${result.branch}`) pushed.push(remote);
        else if (ref === `${prefix}HEAD` && symref.startsWith(prefix))
          remoteHeads.set(remote.name, symref.slice(prefix.length));
      }
    }
    const settings = new Map<string, string>();
    for (const line of config.stdout.split(/\r?\n/)) {
      const space = line.indexOf(" ");
      if (space > 0) settings.set(line.slice(0, space), line.slice(space + 1));
    }
    const tracked = remoteNamed(upstream?.remote);

    // The source is where the branch is pushed, chosen as `git push` does:
    // its push remote, then the default push remote, then a remote that has
    // the branch, then the remote it tracks. A fork workflow tracks the
    // upstream's main and pushes to a personal fork.
    let selected: ReviewRemote | undefined;
    if (typeof params.remote === "string")
      selected = remoteNamed(params.remote);
    else {
      selected =
        remoteNamed(settings.get(`branch.${result.branch}.pushremote`)) ??
        remoteNamed(settings.get("remote.pushdefault"));
      if (!selected && pushed.length) {
        const usable: ReviewRemote[] = [];
        for (const remote of pushed) {
          const forge = await forgeFor(remote.host).catch(() => null);
          if (forge && forge !== "ambiguous") usable.push(remote);
        }
        const candidates = usable.length ? usable : pushed;
        selected =
          candidates.length === 1
            ? candidates[0]
            : (candidates.find((remote) => remote === tracked) ??
              candidates.find((remote) => remote.name === "origin"));
        if (!selected)
          return finish(
            "select_remote",
            "Several remotes have this branch. Select the source repository remote.",
          );
      }
      selected ??=
        tracked ??
        remoteNamed("origin") ??
        (result.remotes.length === 1 ? result.remotes[0] : undefined);
    }
    if (!selected)
      return finish(
        "select_remote",
        "Select the source repository remote to resolve this branch.",
      );
    result.remote = selected.name;
    // A checkout may use a local alias (e.g. pr-299). Only the source
    // remote's upstream names the provider-side branch, and not when it is
    // the default branch the local one was started from.
    const upstreamBranch =
      tracked === selected && upstream?.ref.startsWith("refs/heads/")
        ? upstream.ref.slice("refs/heads/".length)
        : undefined;
    const sourceBranch =
      upstreamBranch &&
      (upstreamBranch === result.branch ||
        !["main", "master", remoteHeads.get(selected.name)].includes(
          upstreamBranch,
        ))
        ? upstreamBranch
        : result.branch;
    const forge = await forgeFor(selected.host);
    if (forge === "ambiguous")
      return finish(
        "unsupported",
        "This host is configured in both gh and glab; provider is ambiguous.",
      );
    if (!forge)
      return {
        ...finish(
          "unsupported",
          `Unsupported or unconfigured host ${selected.host}. Configure this instance in gh or glab on the checkout host.`,
        ),
        retryable: true,
      };
    const { provider, apiHost } = forge;
    result.provider = provider;
    // The tracked remote's project is a target too, when it is on the same
    // instance: a fork's requests usually go there.
    let trackedTarget: string | undefined;
    if (tracked && tracked !== selected) {
      const target = await forgeFor(tracked.host).catch(() => null);
      if (
        target &&
        target !== "ambiguous" &&
        target.provider === provider &&
        target.apiHost === apiHost
      )
        trackedTarget = tracked.repository;
    }
    const cli = provider === "github" ? "gh" : "glab";
    const version = await rememberLocal(
      owner,
      `${checkout}\nversion\n${cli}`,
      () => run([cli, "--version"]),
    );
    if (version.code === 127)
      return finish("missing_cli", `Install ${cli} on the checkout host.`);
    if (version.code !== 0)
      throw new StatusError(
        `${cli} --version failed with exit code ${version.code}`,
      );
    const auth = await forgeCall(
      { host: apiHost, kind: "auth", reuseMs: HOSTS_REUSE_MS },
      [
        cli,
        "auth",
        "status",
        "--hostname",
        apiHost,
        ...(provider === "github" ? ["--active"] : []),
      ],
    );
    if (auth.code !== 0)
      return finish(
        "unauthenticated",
        `${cli} authentication is unavailable or could not be verified for ${apiHost}. Check it on the checkout host.`,
      );
    const apiArgv = (path: string) => [
      cli,
      "api",
      "--hostname",
      apiHost,
      "--method",
      "GET",
      path,
    ];
    const api = (path: string, kind: string, reuseMs?: number) =>
      json(
        apiArgv(path),
        forgeCall(
          { host: apiHost, kind, conditional: true, reuseMs },
          apiArgv(path),
        ),
      );
    const apiList = async (path: string) =>
      list(
        await api(
          path,
          "request-list",
          params.summary === true ? LIST_REUSE_MS : undefined,
        ),
        describeStep(apiArgv(path)),
      );
    const matches: PullRequest[] = [];
    const createdAt = new Map<string, number>();
    if (provider === "github") {
      const repo = object(
        await api(`repos/${selected.repository}`, "project", PROJECT_REUSE_MS),
      );
      // GitHub redirects renamed/transferred repositories; compare canonical
      // identity rather than the old name still present in the Git remote.
      const sourceRepository = text(repo.full_name, selected.repository);
      const repositories = [sourceRepository];
      if (repo.fork && repo.parent?.full_name)
        repositories.push(text(repo.parent.full_name));
      if (trackedTarget) repositories.push(trackedTarget);
      const seen = new Set<string>();
      for (const repository of repositories) {
        if (seen.has(repository.toLowerCase())) continue;
        seen.add(repository.toLowerCase());
        const query = new URLSearchParams({
          state: "all",
          head: `${sourceRepository.split("/")[0]}:${sourceBranch}`,
          per_page: "100",
        });
        const pulls = await apiList(`repos/${repository}/pulls?${query}`);
        for (const raw of pulls) {
          const pr = object(raw);
          if (
            pr.head?.ref !== sourceBranch ||
            pr.head?.repo?.full_name?.toLowerCase() !==
              sourceRepository.toLowerCase()
          )
            continue;
          const id = number(pr.number);
          createdAt.set(
            `${repository}#${id}`,
            Date.parse(text(pr.created_at, "")),
          );
          matches.push({
            id: `${repository}#${id}`,
            number: id,
            title: text(pr.title),
            author: text(pr.user?.login),
            source: text(pr.head?.label),
            target: text(pr.base?.label),
            state: pr.merged_at ? "merged" : text(pr.state),
            draft: pr.draft === true,
            url: webUrl(apiHost, pr.html_url),
          });
        }
      }
    } else {
      const repo = object(
        await api(
          `projects/${encodeURIComponent(selected.repository)}`,
          "project",
          PROJECT_REUSE_MS,
        ),
      );
      const sourceId = number(repo.id);
      // REST names a project by id; GraphQL by path.
      const projects: { rest: string; path?: string }[] = [
        {
          rest: String(sourceId),
          path:
            typeof repo.path_with_namespace === "string"
              ? repo.path_with_namespace
              : selected.repository,
        },
      ];
      const parent = repo.forked_from_project;
      if (parent?.id)
        projects.push({
          rest: String(number(parent.id)),
          path:
            typeof parent.path_with_namespace === "string"
              ? parent.path_with_namespace
              : undefined,
        });
      // The fork's parent already covers the tracked project.
      const covered = [
        selected.repository,
        repo.path_with_namespace,
        parent?.path_with_namespace,
      ]
        .filter((path) => typeof path === "string")
        .map((path: string) => path.toLowerCase());
      if (trackedTarget && !covered.includes(trackedTarget.toLowerCase()))
        projects.push({
          rest: encodeURIComponent(trackedTarget),
          path: trackedTarget,
        });
      const seen = new Set<string>();
      const graphqlArgv = (query: string) => [
        "glab",
        "api",
        "--hostname",
        apiHost,
        "graphql",
        "-f",
        `query=${query}`,
      ];
      // The sidebar's summaries of every branch of a project share one
      // GraphQL query; the card (and a failed query) asks REST.
      const listed = async (project: { rest: string; path?: string }) => {
        if (params.summary === true && project.path && validPath(project.path))
          try {
            const requests = await branchRequests(
              owner,
              `${checkout}\n${apiHost}`,
              project.path,
              sourceBranch,
              async (query) =>
                json(
                  graphqlArgv(query),
                  forgeCall(
                    { host: apiHost, kind: "mr-batch", include: true },
                    graphqlArgv(query),
                  ),
                ),
            );
            if (requests !== "overflow") return requests;
          } catch {
            // REST below says what is wrong, if anything.
          }
        const query = new URLSearchParams({
          scope: "all",
          state: "all",
          source_branch: sourceBranch,
          per_page: "100",
        });
        return apiList(`projects/${project.rest}/merge_requests?${query}`);
      };
      const unique = projects.filter(
        (project) => !seen.has(project.rest) && !!seen.add(project.rest),
      );
      // Asked together: one GraphQL query covers them all.
      const lists = await Promise.all(unique.map(listed));
      for (const found of lists) {
        for (const raw of found) {
          const mr = object(raw);
          if (
            mr.source_project_id !== sourceId ||
            mr.source_branch !== sourceBranch
          )
            continue;
          const id = number(mr.iid);
          createdAt.set(
            `${number(mr.target_project_id)}#${id}`,
            Date.parse(text(mr.created_at, "")),
          );
          matches.push({
            id: `${number(mr.target_project_id)}#${id}`,
            number: id,
            title: text(mr.title),
            author: text(mr.author?.username),
            source: text(mr.source_branch),
            target: text(mr.target_branch),
            state: text(mr.state),
            draft: mr.draft === true || mr.work_in_progress === true,
            url: webUrl(apiHost, mr.web_url),
          });
        }
      }
    }
    const uniqueMatches = [
      ...new Map(matches.map((match) => [match.id, match])).values(),
    ];
    result.matches = uniqueMatches;
    if (!uniqueMatches.length)
      return finish(
        "no_match",
        "No pull or merge request found for this source repository and branch.",
      );
    const latest = params.summary === true && params.latest === true;
    if (latest && uniqueMatches.length > 1) {
      if (
        uniqueMatches.some((match) => !Number.isFinite(createdAt.get(match.id)))
      )
        throw new StatusError("invalid provider creation time");
      uniqueMatches.sort(
        (a, b) =>
          createdAt.get(b.id)! - createdAt.get(a.id)! ||
          b.number - a.number ||
          a.id.localeCompare(b.id),
      );
    }
    const request =
      typeof params.match === "string"
        ? uniqueMatches.find((m) => m.id === params.match)
        : uniqueMatches.length === 1 || latest
          ? uniqueMatches[0]
          : undefined;
    if (!request)
      return finish(
        "select_match",
        "Multiple requests match this branch. Select one explicitly.",
      );
    result.request = request;
    const [repository, id] = request.id.split("#");
    if (params.summary !== true && provider === "github") {
      const readField = (field: string) => {
        const argv = [
          "gh",
          "pr",
          "view",
          id,
          "--repo",
          `${apiHost}/${repository}`,
          "--json",
          field,
        ];
        return json(
          argv,
          forgeCall(
            { host: apiHost, kind: "pr-view", reuseMs: DETAIL_REUSE_MS },
            argv,
          ),
        );
      };
      const [ci, review] = await Promise.allSettled([
        readField("statusCheckRollup").then((data) =>
          githubChecks(object(data).statusCheckRollup),
        ),
        readField("reviewDecision").then((data) =>
          text(object(data).reviewDecision, "No review decision reported"),
        ),
      ]);
      result.ci =
        ci.status === "fulfilled"
          ? ci.value
          : "Unavailable (checks request failed)";
      result.review =
        review.status === "fulfilled"
          ? review.value
          : "Unavailable (review request failed)";
    } else if (params.summary !== true) {
      const path = `projects/${repository}/merge_requests/${id}`;
      const [ci, review] = await Promise.allSettled([
        api(path, "request", DETAIL_REUSE_MS).then((data) => {
          const pipeline = object(data).head_pipeline;
          return pipeline === null
            ? "No pipeline reported"
            : text(pipeline?.status, "Unavailable");
        }),
        api(`${path}/approvals`, "approvals", DETAIL_REUSE_MS).then(
          gitlabApprovals,
        ),
      ]);
      result.ci =
        ci.status === "fulfilled"
          ? ci.value
          : "Unavailable (pipeline request failed)";
      result.review =
        review.status === "fulfilled"
          ? review.value
          : "Unavailable (approvals request failed)";
    }
    const currentBranch = await readBranch();
    if (currentBranch?.name !== result.branch) {
      delete result.request;
      delete result.matches;
      return finish(
        "error",
        "The branch changed during refresh. Refresh again.",
      );
    }
    return finish("ready");
  } catch (error) {
    delete result.request;
    // Branch-change guards above are authoritative; only this catch-all
    // failure may be retried while the browser keeps its last-known status.
    // Only messages written here are shown; other errors may quote output.
    const reason = error instanceof StatusError ? `: ${error.message}` : "";
    return {
      ...finish(
        "error",
        `Could not read PR/MR status${reason}. Check repository access, CLI version and network connectivity on the checkout host, then refresh.`,
      ),
      retryable: true,
    };
  }
}
