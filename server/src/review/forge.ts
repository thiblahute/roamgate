import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  type ForgePipeline,
  type ForgePipelineStatus,
  type ForgeProject,
  type ForgeRef,
  type ForgeRequestState,
  type ForgeSession,
  type ForgeSessionRepo,
  type ForgeStatus,
  forgeRefKey,
  ownRequestUrl,
  parseForgeUrl,
  validHost,
  validProject,
} from "../../../shared/forge";
import { sshCommandArgv, sshReadCommandArgv } from "../bridge/ssh-command";
import { forgeGate } from "../workspace/forge-calls";
import { gitShellCommandArgv } from "../workspace/git-shell";
import { readPullRequestStatus } from "../workspace/pull-request";
import { enterCheckout, scanReviewRepos } from "../workspace/review-patch";
import {
  findBranchMergeRequest,
  type GlabContext,
  glab,
  glabHostAccess,
  gitlabHostFor,
  isSecurityProject,
  mergeRequestSource,
  readCheckout,
  remoteProject,
} from "./gitlab";

/**
 * The merge and pull requests the agent chats show, read through the
 * review pane's GitLab plumbing (glab on the checkout's host, the token
 * only ever to glab's default host or a host glab has its own login for)
 * and the PR card's gh path (gh's own login for each host). It only reads:
 * nothing it learns goes to an agent, and only a request's own https page
 * is linked.
 */

const TIMEOUT_MS = 30_000;
/** How long an answer is shared by every chip and browser asking it. */
export const FORGE_STATUS_TTL_MS = 15_000;
/** A session's repositories and their branches' requests. */
export const FORGE_SESSION_TTL_MS = 5 * 60_000;
/** How long chips asked together wait for each other. */
export const FORGE_BATCH_WINDOW_MS = 100;
/** A request asked about this recently is read again with the others. */
const FORGE_INTEREST_MS = 5 * 60_000;
const FORGE_BATCH_SIZE = 50;

/**
 * How long a batch's answer stands for a chip that asks again (a little
 * less than the browser waits for it, so that a due chip gets news).
 */
export function forgeAnswerTtl(status: ForgeStatus): number {
  if (status.state !== "ready" || !status.request)
    return status.state === "not_found" ? 5 * 60_000 : 0;
  if (status.request.state !== "open") return 30 * 60_000;
  const pipeline = status.request.pipeline?.status;
  return pipeline === "running" || pipeline === "pending" ? 45_000 : 150_000;
}
/** What `!N` and `#N` mean in a checkout (its project, or its fork's parent). */
const DEFAULT_PROJECT_TTL_MS = 30 * 60_000;
/** Repositories of one session whose branch's request is looked up. */
const SESSION_REPO_LIMIT = 8;
const FAILED_JOBS_SHOWN = 8;

type Run = GlabContext["runProcessWithCodeTimeout"];

export type ForgeContext = GlabContext;

function now() {
  return new Date().toISOString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** GitLab's pipeline statuses, folded to the chip's. */
export function gitlabPipelineStatus(value: unknown): ForgePipelineStatus {
  switch (value) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
    case "canceling":
      return "canceled";
    case "skipped":
      return "skipped";
    case "manual":
      return "manual";
    case "running":
      return "running";
    default:
      // created, pending, preparing, scheduled, waiting_for_resource...
      return "pending";
  }
}

/** A GitHub status check rollup state, folded to the chip's. */
export function githubPipelineStatus(value: unknown): ForgePipelineStatus {
  switch (value) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failed";
    case "PENDING":
      return "running";
    default:
      return "pending";
  }
}

function gitlabState(value: unknown): ForgeRequestState {
  return value === "merged"
    ? "merged"
    : value === "closed"
      ? "closed"
      : value === "locked"
        ? "locked"
        : "open";
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Why glab refused a host: no login, or no glab at all. */
function classifyAccess(ref: ForgeRef, error: unknown): ForgeStatus {
  const reason = message(error);
  if (/not installed/i.test(reason))
    return {
      ref,
      state: "unavailable",
      message: "glab is not installed where the checkout is",
      fetchedAt: now(),
    };
  if (/no login/i.test(reason))
    return {
      ref,
      state: "not_signed_in",
      message: `Not signed in to ${ref.host} (glab auth login --hostname ${ref.host})`,
      fetchedAt: now(),
    };
  return {
    ref,
    state: "error",
    message: reason.slice(0, 300),
    fetchedAt: now(),
  };
}

/** A GitLab merge request, its pipeline, approvals and open threads. */
export async function readGitlabStatus(
  context: ForgeContext,
  ref: ForgeRef,
): Promise<ForgeStatus> {
  // Confidential security work never leaves GitLab: not even its title.
  if (isSecurityProject(ref.project))
    return { ref, state: "security", fetchedAt: now() };
  let access: { ownLogin: boolean };
  try {
    access = await glabHostAccess(context, ref.host);
  } catch (error) {
    return classifyAccess(ref, error);
  }
  const host = { host: ref.host, ownLogin: access.ownLogin };
  const path = `projects/${encodeURIComponent(ref.project)}/merge_requests/${ref.number}`;
  let mr: Record<string, any>;
  try {
    mr = (await glab(context, host, "GET", path, [], false, {
      feature: "chip",
      kind: "request",
    })) as Record<string, any>;
  } catch (error) {
    const reason = message(error);
    return /404|not found/i.test(reason)
      ? {
          ref,
          state: "not_found",
          message: "No such merge request",
          fetchedAt: now(),
        }
      : {
          ref,
          state: "error",
          message: reason.slice(0, 300),
          fetchedAt: now(),
        };
  }
  if (!mr || typeof mr !== "object")
    return {
      ref,
      state: "error",
      message: "Unexpected answer",
      fetchedAt: now(),
    };
  const guarded = guardedUrl(ref, mr.web_url, mr.references?.full);
  if (!guarded) return { ref, state: "security", fetchedAt: now() };
  const project = guarded.project;
  const pipeline = mr.head_pipeline ?? mr.pipeline ?? null;
  const [approvals, threads, jobs] = await Promise.allSettled([
    glab(context, host, "GET", `${path}/approvals`, [], false, {
      feature: "chip",
      kind: "approvals",
    }),
    glab(
      context,
      host,
      "POST",
      "graphql",
      [
        [
          "query",
          "query($p: ID!, $i: String!) { project(fullPath: $p) { mergeRequest(iid: $i) { resolvableDiscussionsCount resolvedDiscussionsCount } } }",
          "raw",
        ],
        ["p", project, "raw"],
        ["i", String(ref.number), "raw"],
      ],
      false,
      { feature: "chip", kind: "graphql" },
    ),
    pipeline?.status === "failed" &&
    Number.isSafeInteger(pipeline.id) &&
    Number.isSafeInteger(pipeline.project_id)
      ? glab(
          context,
          host,
          "GET",
          `projects/${pipeline.project_id}/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=50`,
          [],
          false,
          { feature: "chip", kind: "jobs" },
        )
      : Promise.resolve([]),
  ]);
  const approved =
    approvals.status === "fulfilled" && approvals.value
      ? (approvals.value as Record<string, any>)
      : null;
  const counts =
    threads.status === "fulfilled"
      ? (threads.value as any)?.data?.project?.mergeRequest
      : null;
  return gitlabStatusOf(ref, {
    mr,
    pipeline: pipeline ? text(pipeline.status, 40) : null,
    failed:
      jobs.status === "fulfilled" && Array.isArray(jobs.value)
        ? (jobs.value as Record<string, any>[]).map((job) => ({
            name: job.name,
            stage: job.stage,
            allowFailure: job.allow_failure === true,
          }))
        : [],
    approvals: approved
      ? {
          approved:
            typeof approved.approved === "boolean" ? approved.approved : null,
          count: Array.isArray(approved.approved_by)
            ? approved.approved_by.length
            : 0,
        }
      : null,
    resolvable: counts?.resolvableDiscussionsCount,
    resolved: counts?.resolvedDiscussionsCount,
  });
}

/**
 * The request's own page, when GitLab names a project that is not a
 * security one anywhere (fail closed otherwise).
 */
function guardedUrl(
  ref: ForgeRef,
  webUrl: unknown,
  reference: unknown,
): { url: string; project: string } | null {
  const url = ownRequestUrl(ref, webUrl);
  const project = url ? parseForgeUrl(url)?.project : undefined;
  const full = text(reference).replace(/!\d+$/, "");
  if (!url || !project) return null;
  if (isSecurityProject(project) || (full && isSecurityProject(full)))
    return null;
  return { url, project };
}

/** What a merge request says, from REST or GraphQL. */
type GitlabFacts = {
  /** REST-shaped: web_url, references.full, title, state, draft... */
  mr: Record<string, any>;
  /** The head pipeline's status (REST's lower case), null for none. */
  pipeline: string | null;
  failed: { name: unknown; stage: unknown; allowFailure: boolean }[];
  approvals: { approved: boolean | null; count: number } | null;
  resolvable: unknown;
  resolved: unknown;
};

function gitlabStatusOf(ref: ForgeRef, facts: GitlabFacts): ForgeStatus {
  const { mr } = facts;
  const guarded = guardedUrl(ref, mr.web_url, mr.references?.full);
  if (!guarded) return { ref, state: "security", fetchedAt: now() };
  const { resolvable, resolved } = facts;
  return {
    ref,
    state: "ready",
    fetchedAt: now(),
    request: {
      url: guarded.url,
      project: guarded.project,
      title: text(mr.title, 300),
      state: gitlabState(mr.state),
      draft: mr.draft === true || mr.work_in_progress === true,
      author: text(mr.author?.username, 100),
      sourceBranch: text(mr.source_branch, 300),
      targetBranch: text(mr.target_branch, 300),
      updatedAt: text(mr.updated_at, 40),
      pipeline:
        facts.pipeline === null
          ? null
          : {
              status: gitlabPipelineStatus(facts.pipeline),
              failed: facts.failed.slice(0, FAILED_JOBS_SHOWN).map((job) => ({
                name: text(job.name, 200),
                stage: text(job.stage, 100) || undefined,
                allowFailure: job.allowFailure,
              })),
            },
      approvals: facts.approvals,
      unresolved:
        Number.isSafeInteger(resolvable) && Number.isSafeInteger(resolved)
          ? Math.max(0, (resolvable as number) - (resolved as number))
          : null,
    },
  };
}

const GITLAB_REQUEST_FIELDS =
  "iid webUrl reference(full: true) title state draft updatedAt sourceBranch targetBranch author { username } approved approvedBy { nodes { username } } resolvableDiscussionsCount resolvedDiscussionsCount headPipeline { status jobs(statuses: [FAILED], first: 8) { nodes { name allowFailure stage { name } } } }";

/**
 * One GraphQL query for several merge requests of several projects.
 * Strings are JSON literals, which GraphQL reads as its own.
 */
export function gitlabStatusesQuery(projects: [string, number[]][]): string {
  return `query { ${projects
    .map(
      ([project, numbers], index) =>
        `p${index}: project(fullPath: ${JSON.stringify(project)}) { mergeRequests(iids: ${JSON.stringify(numbers.map(String))}, first: 100) { nodes { ${GITLAB_REQUEST_FIELDS} } } }`,
    )
    .join(" ")} }`;
}

/** Projects by path (as GitLab compares them), with their refs. */
function byProject(refs: ForgeRef[]): Map<string, ForgeRef[]> {
  const projects = new Map<string, ForgeRef[]>();
  for (const ref of refs) {
    const key = ref.project.toLowerCase();
    projects.set(key, [...(projects.get(key) ?? []), ref]);
  }
  return projects;
}

/**
 * Several GitLab merge requests of one host in one GraphQL query. Throws
 * when GitLab answers no data at all (the caller reads them one by one).
 */
export async function readGitlabStatuses(
  context: ForgeContext,
  host: { host: string; ownLogin: boolean },
  refs: ForgeRef[],
): Promise<Map<string, ForgeStatus>> {
  const projects = [...byProject(refs).values()];
  const answer = (await glab(
    context,
    host,
    "POST",
    "graphql",
    [
      [
        "query",
        gitlabStatusesQuery(
          projects.map((group) => [
            group[0]!.project,
            group.map((ref) => ref.number),
          ]),
        ),
        "raw",
      ],
    ],
    false,
    { feature: "chip", kind: "mr-batch" },
  )) as Record<string, any> | null;
  const data = answer?.data;
  if (!data || typeof data !== "object")
    throw new Error("GitLab: no data in the GraphQL answer");
  const statuses = new Map<string, ForgeStatus>();
  // A project GitLab cannot show is null; an answer without it is not one.
  if (projects.some((_, index) => !(`p${index}` in data)))
    throw new Error("GitLab: unexpected GraphQL answer");
  projects.forEach((group, index) => {
    const nodes: Record<string, any>[] = Array.isArray(
      data[`p${index}`]?.mergeRequests?.nodes,
    )
      ? data[`p${index}`].mergeRequests.nodes
      : [];
    for (const ref of group) {
      const node = nodes.find((entry) => Number(entry?.iid) === ref.number);
      statuses.set(
        forgeRefKey(ref),
        node
          ? gitlabStatusOf(ref, {
              mr: {
                web_url: node.webUrl,
                references: { full: node.reference },
                title: node.title,
                state: node.state,
                draft: node.draft,
                author: node.author,
                source_branch: node.sourceBranch,
                target_branch: node.targetBranch,
                updated_at: node.updatedAt,
              },
              pipeline: node.headPipeline
                ? text(node.headPipeline.status, 40).toLowerCase()
                : null,
              failed: Array.isArray(node.headPipeline?.jobs?.nodes)
                ? node.headPipeline.jobs.nodes.map((job: any) => ({
                    name: job?.name,
                    stage: job?.stage?.name,
                    allowFailure: job?.allowFailure === true,
                  }))
                : [],
              approvals:
                typeof node.approved === "boolean" ||
                Array.isArray(node.approvedBy?.nodes)
                  ? {
                      approved:
                        typeof node.approved === "boolean"
                          ? node.approved
                          : null,
                      count: Array.isArray(node.approvedBy?.nodes)
                        ? node.approvedBy.nodes.length
                        : 0,
                    }
                  : null,
              resolvable: node.resolvableDiscussionsCount,
              resolved: node.resolvedDiscussionsCount,
            })
          : {
              ref,
              state: "not_found",
              message: "No such merge request",
              fetchedAt: now(),
            },
      );
    }
  });
  return statuses;
}

/** gh on the checkout's host; its own login answers for each host. */
async function gh(
  context: ForgeContext,
  argv: string[],
  /** For the forge gate: the host asked, what, and how it may be shared. */
  call: { host: string; kind: string; include?: boolean; reuseMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return forgeGate.run(
    context.runProcessWithCodeTimeout,
    { checkout: context.host ?? "", feature: "chip", ...call },
    ["gh", ...argv],
    // The chips' gh calls only read.
    (full) => spawnGh(context, full, true),
  );
}

/**
 * gh on the checkout's host. Only a read may be `retrySafe`: a cold SSH
 * retry of a write (a REST POST, PATCH or DELETE, a GraphQL mutation) could
 * make it twice, such as a second pending comment.
 */
export async function spawnGh(
  context: ForgeContext,
  full: string[],
  retrySafe: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
  if (context.host) {
    const command = `{ cd ${context.shQuote(context.root)} 2>/dev/null || cd; } && ${Object.entries(
      env,
    )
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")} ${full.map(context.shQuote).join(" ")}`;
    return context.runProcessWithCodeTimeout(
      retrySafe
        ? sshReadCommandArgv(context.host, command, [], "forge.github")
        : sshCommandArgv(context.host, command, [], "forge.github"),
      TIMEOUT_MS,
    );
  }
  try {
    return await context.runProcessWithCodeTimeout(full, TIMEOUT_MS, {
      cwd: existsSync(context.root) ? context.root : homedir(),
      env: { ...process.env, ...env },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { code: 127, stdout: "", stderr: "" };
    throw error;
  }
}

/** Whether gh is logged in to a host, by runner, checkout host and host. */
const ghLogins = new WeakMap<
  Run,
  Map<string, { until: number; answer: Promise<number> }>
>();

/** gh's exit code for `auth status` on that host: 0 when logged in. */
export function ghHostLogin(context: ForgeContext, host: string) {
  let known = ghLogins.get(context.runProcessWithCodeTimeout);
  if (!known) {
    known = new Map();
    ghLogins.set(context.runProcessWithCodeTimeout, known);
  }
  const key = `${context.host ?? ""}\n${host}`;
  const entry = known.get(key);
  if (entry && entry.until > Date.now()) return entry.answer;
  const answer = gh(context, ["auth", "status", "--hostname", host], {
    host,
    kind: "auth",
  }).then((result) => result.code);
  const next = { until: Date.now() + 5 * 60_000, answer };
  known.set(key, next);
  answer.catch(() => known.delete(key));
  return answer;
}

const GITHUB_QUERY = `query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { nameWithOwner pullRequest(number: $n) { number title url state isDraft updatedAt baseRefName headRefName author { login } reviewDecision reviews(states: APPROVED) { totalCount } reviewThreads(first: 100) { nodes { isResolved } } commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } } } } }`;

/** A GitHub pull request, its checks, approvals and open threads. */
export async function readGithubStatus(
  context: ForgeContext,
  ref: ForgeRef,
): Promise<ForgeStatus> {
  const [owner, repo, ...rest] = ref.project.split("/");
  if (!owner || !repo || rest.length)
    return { ref, state: "not_found", fetchedAt: now() };
  const login = await ghHostLogin(context, ref.host).catch(() => -1);
  if (login === 127)
    return {
      ref,
      state: "unavailable",
      message: "gh is not installed where the checkout is",
      fetchedAt: now(),
    };
  if (login !== 0)
    return {
      ref,
      state: "not_signed_in",
      message: `Not signed in to ${ref.host} (gh auth login --hostname ${ref.host})`,
      fetchedAt: now(),
    };
  let data: any;
  try {
    const result = await gh(
      context,
      [
        "api",
        "--hostname",
        ref.host,
        "graphql",
        "-f",
        `query=${GITHUB_QUERY}`,
        "-f",
        `o=${owner}`,
        "-f",
        `r=${repo}`,
        "-F",
        `n=${ref.number}`,
      ],
      { host: ref.host, kind: "graphql", include: true },
    );
    if (result.code !== 0)
      return {
        ref,
        state: /Could not resolve/i.test(result.stdout + result.stderr)
          ? "not_found"
          : "error",
        message: (result.stderr || "GitHub request failed")
          .trim()
          .slice(0, 300),
        fetchedAt: now(),
      };
    data = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ref,
      state: "error",
      message: message(error).slice(0, 300),
      fetchedAt: now(),
    };
  }
  return githubStatusOf(
    ref,
    data?.data?.repository?.nameWithOwner,
    data?.data?.repository?.pullRequest,
  );
}

/** What GraphQL says of a pull request, as a chip shows it. */
function githubStatusOf(
  ref: ForgeRef,
  nameWithOwner: unknown,
  pr: any,
): ForgeStatus {
  const url = pr ? ownRequestUrl(ref, pr.url) : null;
  if (!pr || !url) return { ref, state: "not_found", fetchedAt: now() };
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const contexts: any[] = Array.isArray(rollup?.contexts?.nodes)
    ? rollup.contexts.nodes
    : [];
  const failed = contexts
    .filter((check) =>
      check?.__typename === "CheckRun"
        ? [
            "FAILURE",
            "TIMED_OUT",
            "STARTUP_FAILURE",
            "ACTION_REQUIRED",
          ].includes(check.conclusion)
        : ["FAILURE", "ERROR"].includes(check?.state),
    )
    .slice(0, FAILED_JOBS_SHOWN)
    .map((check) => ({ name: text(check.name ?? check.context, 200) }));
  const threads: any[] = Array.isArray(pr.reviewThreads?.nodes)
    ? pr.reviewThreads.nodes
    : [];
  return {
    ref,
    state: "ready",
    fetchedAt: now(),
    request: {
      url,
      project: text(nameWithOwner, 300) || ref.project,
      title: text(pr.title, 300),
      state:
        pr.state === "MERGED"
          ? "merged"
          : pr.state === "CLOSED"
            ? "closed"
            : "open",
      draft: pr.isDraft === true,
      author: text(pr.author?.login, 100),
      sourceBranch: text(pr.headRefName, 300),
      targetBranch: text(pr.baseRefName, 300),
      updatedAt: text(pr.updatedAt, 40),
      pipeline: rollup
        ? { status: githubPipelineStatus(rollup.state), failed }
        : null,
      approvals: {
        approved:
          pr.reviewDecision === "APPROVED"
            ? true
            : pr.reviewDecision
              ? false
              : null,
        count: Number.isSafeInteger(pr.reviews?.totalCount)
          ? pr.reviews.totalCount
          : 0,
      },
      unresolved: threads.filter((thread) => thread?.isResolved === false)
        .length,
    },
  };
}

const GITHUB_REQUEST_FIELDS =
  /^.*pullRequest\(number: \$n\) \{ (.*) \} \} \}$/.exec(GITHUB_QUERY)![1]!;

/** One GraphQL query for several pull requests of several repositories. */
export function githubStatusesQuery(repos: [string, number[]][]): string {
  return `query { ${repos
    .map(([project, numbers], index) => {
      const [owner, name] = project.split("/");
      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner ${numbers
        .map(
          (number) =>
            `n${number}: pullRequest(number: ${number}) { ${GITHUB_REQUEST_FIELDS} }`,
        )
        .join(" ")} }`;
    })
    .join(" ")} }`;
}

/**
 * Several GitHub pull requests of one host in one GraphQL query; one that
 * does not exist is not found, the others are read. Throws when GitHub
 * answers no data at all.
 */
export async function readGithubStatuses(
  context: ForgeContext,
  host: string,
  refs: ForgeRef[],
): Promise<Map<string, ForgeStatus>> {
  const repos = [...byProject(refs).values()].filter((group) => {
    const [owner, name, ...rest] = group[0]!.project.split("/");
    return owner && name && !rest.length;
  });
  const result = await gh(
    context,
    [
      "api",
      "--hostname",
      host,
      "graphql",
      "-f",
      `query=${githubStatusesQuery(
        repos.map((group) => [
          group[0]!.project,
          [...new Set(group.map((ref) => ref.number))],
        ]),
      )}`,
    ],
    { host, kind: "pr-batch", include: true },
  );
  // A missing pull request is an error beside the others' data.
  let data: any;
  try {
    data = JSON.parse(result.stdout)?.data;
  } catch {}
  if (!data || typeof data !== "object")
    throw new Error(
      (result.stderr || "GitHub request failed").trim().slice(0, 300),
    );
  const statuses = new Map<string, ForgeStatus>();
  for (const ref of refs)
    statuses.set(forgeRefKey(ref), {
      ref,
      state: "not_found",
      fetchedAt: now(),
    });
  if (repos.some((_, index) => !(`r${index}` in data)))
    throw new Error("GitHub: unexpected GraphQL answer");
  repos.forEach((group, index) => {
    const repo = data[`r${index}`];
    for (const ref of group)
      statuses.set(
        forgeRefKey(ref),
        githubStatusOf(ref, repo?.nameWithOwner, repo?.[`n${ref.number}`]),
      );
  });
  return statuses;
}

type Cached<T> = { until: number; value: Promise<T> };

/**
 * Shares answers: one request per (checkout host, forge host, project,
 * number) in flight, and each answer for a few seconds, whichever chips
 * and browsers ask.
 */
export function createForgeCache(clock: () => number = Date.now) {
  const statuses = new Map<string, Cached<ForgeStatus>>();
  const sessions = new Map<string, Cached<ForgeSession>>();
  const projects = new Map<string, Cached<ForgeProject | null>>();
  const projectIds = new Map<string, number>();
  function remember<T>(
    map: Map<string, Cached<T>>,
    key: string,
    ttl: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const known = map.get(key);
    if (known && known.until > clock()) return known.value;
    // Expired entries go; the map stays small.
    if (map.size > 500)
      for (const [other, entry] of map)
        if (entry.until <= clock()) map.delete(other);
    const entry: Cached<T> = {
      until: Number.POSITIVE_INFINITY,
      value: load(),
    };
    map.set(key, entry);
    entry.value.then(
      () => {
        entry.until = clock() + ttl;
      },
      () => {
        if (map.get(key) === entry) map.delete(key);
      },
    );
    return entry.value;
  }
  // Chips of one forge host asked together, and those asked lately, are
  // read with one GraphQL query; each answer stands as long as it can.
  type Waiter = {
    ref: ForgeRef;
    resolve: (status: ForgeStatus) => void;
    reject: (error: unknown) => void;
  };
  type Group = {
    interest: Map<string, { ref: ForgeRef; at: number }>;
    answers: Map<string, { until: number; status: ForgeStatus }>;
    waiting: Waiter[];
    timer: ReturnType<typeof setTimeout> | null;
    read: (refs: ForgeRef[]) => Promise<Map<string, ForgeStatus>>;
  };
  const groups = new Map<string, Group>();
  async function flush(group: Group) {
    group.timer = null;
    const waiting = group.waiting.splice(0);
    if (!waiting.length) return;
    const refs = new Map<string, ForgeRef>();
    for (const { ref } of waiting) refs.set(forgeRefKey(ref), ref);
    for (const [key, { ref, at }] of [...group.interest].sort(
      (a, b) => b[1].at - a[1].at,
    )) {
      if (at <= clock() - FORGE_INTEREST_MS) group.interest.delete(key);
      else if (refs.size < FORGE_BATCH_SIZE) refs.set(key, ref);
    }
    try {
      const read = await group.read([...refs.values()]);
      for (const [key, status] of read) {
        const ttl = forgeAnswerTtl(status);
        if (ttl > 0) group.answers.set(key, { until: clock() + ttl, status });
        else group.answers.delete(key);
      }
      for (const waiter of waiting) {
        const status = read.get(forgeRefKey(waiter.ref));
        if (status) waiter.resolve({ ...status, ref: waiter.ref });
        else waiter.reject(new Error("not in the batch's answer"));
      }
    } catch (error) {
      for (const waiter of waiting) waiter.reject(error);
    }
    if (group.answers.size > 500)
      for (const [key, answer] of group.answers)
        if (answer.until <= clock()) group.answers.delete(key);
  }
  function batched(
    key: string,
    ref: ForgeRef,
    fresh: boolean,
    read: Group["read"],
  ): Promise<ForgeStatus> {
    let group = groups.get(key);
    if (!group) {
      group = {
        interest: new Map(),
        answers: new Map(),
        waiting: [],
        timer: null,
        read,
      };
      groups.set(key, group);
    }
    const refKey = forgeRefKey(ref);
    group.interest.set(refKey, { ref, at: clock() });
    const known = group.answers.get(refKey);
    if (!fresh && known && known.until > clock())
      return Promise.resolve({ ...known.status, ref });
    const current = group;
    current.read = read;
    return new Promise((resolve, reject) => {
      current.waiting.push({ ref, resolve, reject });
      current.timer ??= setTimeout(
        () => void flush(current),
        FORGE_BATCH_WINDOW_MS,
      );
    });
  }
  async function gitlabStatus(
    context: ForgeContext,
    ref: ForgeRef,
    fresh: boolean,
  ): Promise<ForgeStatus> {
    // Confidential security work never leaves GitLab: not even its title.
    if (isSecurityProject(ref.project))
      return { ref, state: "security", fetchedAt: now() };
    let access: { ownLogin: boolean };
    try {
      access = await glabHostAccess(context, ref.host);
    } catch (error) {
      return classifyAccess(ref, error);
    }
    const host = { host: ref.host, ownLogin: access.ownLogin };
    try {
      return await batched(
        `gitlab\n${context.host ?? ""}\n${ref.host}\n${access.ownLogin}`,
        ref,
        fresh,
        (refs) => readGitlabStatuses(context, host, refs),
      );
    } catch {
      // An older GitLab, or no answer: one by one, through REST.
      return readGitlabStatus(context, ref);
    }
  }
  async function githubStatus(
    context: ForgeContext,
    ref: ForgeRef,
    fresh: boolean,
  ): Promise<ForgeStatus> {
    const [owner, repo, ...rest] = ref.project.split("/");
    if (!owner || !repo || rest.length)
      return { ref, state: "not_found", fetchedAt: now() };
    const login = await ghHostLogin(context, ref.host).catch(() => -1);
    if (login !== 0) return readGithubStatus(context, ref);
    try {
      return await batched(
        `github\n${context.host ?? ""}\n${ref.host}`,
        ref,
        fresh,
        (refs) => readGithubStatuses(context, ref.host, refs),
      );
    } catch (error) {
      return {
        ref,
        state: "error",
        message: message(error).slice(0, 300),
        fetchedAt: now(),
      };
    }
  }
  return {
    /** `fresh`: a click on refresh, not answered from what is known. */
    status(
      context: ForgeContext,
      ref: ForgeRef,
      options: { fresh?: boolean } = {},
    ): Promise<ForgeStatus> {
      const key = `${context.host ?? ""}\n${forgeRefKey(ref)}`;
      const fresh = options.fresh === true;
      if (fresh && statuses.get(key)?.until !== Number.POSITIVE_INFINITY)
        statuses.delete(key);
      return remember(statuses, key, FORGE_STATUS_TTL_MS, () =>
        ref.provider === "gitlab"
          ? gitlabStatus(context, ref, fresh)
          : githubStatus(context, ref, fresh),
      );
    },
    session(
      context: ForgeContext,
      agentPath: string | undefined,
    ): Promise<ForgeSession> {
      return remember(
        sessions,
        `${context.host ?? ""}\n${context.root}\n${agentPath ?? ""}`,
        FORGE_SESSION_TTL_MS,
        () =>
          readForgeSession(context, agentPath, {
            defaultProject: (root) =>
              remember(
                projects,
                `${context.host ?? ""}\n${root}`,
                DEFAULT_PROJECT_TTL_MS,
                () => readDefaultProject({ ...context, root }),
              ),
            projectIds,
          }),
      );
    },
  };
}

export type ForgeCache = ReturnType<typeof createForgeCache>;

/** The fetch remotes of a checkout, by name. */
export function remotesScript(
  root: string,
  shQuote: (value: string) => string,
): string {
  return [
    enterCheckout(root, shQuote),
    `printf 'glab %s\\n' "$(GLAB_NO_PROMPT=1 glab config get host 2>/dev/null)"`,
    `git remote -v | while read -r n u k; do [ "$k" = "(fetch)" ] && printf 'url %s %s\\n' "$n" "$u"; done`,
    "exit 0",
  ].join("\n");
}

/**
 * The remote whose project `!N` and `#N` name: `upstream` when there is
 * one, else `origin`, else the only remote.
 */
export function pickDefaultRemote(
  remotes: Record<string, string>,
): string | null {
  const names = Object.keys(remotes);
  if (remotes.upstream) return "upstream";
  if (remotes.origin) return "origin";
  return names.length === 1 ? names[0]! : null;
}

function hostOnly(value: string): string {
  return value
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/**
 * What `!N` and `#N` mean in a checkout: the project of its upstream (or
 * origin) remote, or that project's parent when it is a fork (merge
 * requests of a fork go to its parent).
 */
export async function readDefaultProject(
  context: ForgeContext,
): Promise<ForgeProject | null> {
  const script = remotesScript(context.root, context.shQuote);
  const result = await context.runProcessWithCodeTimeout(
    context.host
      ? sshReadCommandArgv(context.host, script, [], "forge.remotes")
      : gitShellCommandArgv(script),
    TIMEOUT_MS,
  );
  if (result.code !== 0) return null;
  const remotes: Record<string, string> = {};
  let glabHost = "";
  for (const line of result.stdout.split("\n")) {
    const url = /^url (\S+) (\S+)$/.exec(line.trim());
    if (url) remotes[url[1]!] = url[2]!;
    else if (line.startsWith("glab ")) glabHost = hostOnly(line.slice(5));
  }
  const name = pickDefaultRemote(remotes);
  const remote = name ? remoteProject(remotes[name]!) : null;
  if (!remote || !validProject(remote.project)) return null;
  let host = remote.host.replace(/^ssh\./, "");
  if (!validHost(host)) return null;
  if (glabHost && remote.host === `ssh.${glabHost}`) host = glabHost;
  const github =
    host !== glabHost &&
    (host === "github.com" ||
      (await ghHostLogin(context, host).catch(() => 1)) === 0);
  if (github) {
    // The fork's parent, where its pull requests go.
    if (name !== "upstream") {
      const repo = await gh(
        context,
        ["api", "--hostname", host, `repos/${remote.project}`],
        { host, kind: "project", include: true, reuseMs: 30 * 60_000 },
      ).catch(() => null);
      try {
        const parent =
          repo?.code === 0 ? JSON.parse(repo.stdout)?.parent : null;
        if (
          typeof parent?.full_name === "string" &&
          validProject(parent.full_name)
        )
          return { provider: "github", host, project: parent.full_name };
      } catch {}
    }
    return { provider: "github", host, project: remote.project };
  }
  const project: ForgeProject = {
    provider: "gitlab",
    host,
    project: remote.project,
  };
  if (name === "upstream") return project;
  try {
    const access = await glabHostAccess(context, host);
    const answer = (await glab(
      context,
      { host, ownLogin: access.ownLogin },
      "GET",
      `projects/${encodeURIComponent(remote.project)}`,
      [],
      false,
      { feature: "chip", kind: "project", reuseMs: 30 * 60_000 },
    )) as Record<string, any> | null;
    const parent = answer?.forked_from_project?.path_with_namespace;
    if (typeof parent === "string" && validProject(parent))
      return { ...project, project: parent };
  } catch {
    // Not signed in, or unreachable: the remote's own project, whose
    // chips say why they cannot show more.
  }
  return project;
}

/**
 * The repositories a session works in, as the review pane finds them (the
 * pane's checkout, its subprojects on a branch, and the repositories its
 * agent's record shows it worked in), each with its branch's request.
 */
export async function readForgeSession(
  context: ForgeContext,
  agentPath: string | undefined,
  deps: {
    defaultProject: (root: string) => Promise<ForgeProject | null>;
    projectIds: Map<string, number>;
  },
): Promise<ForgeSession> {
  const scanned = await scanReviewRepos({
    paths: [context.root],
    agentPaths: agentPath ? [agentPath] : [],
    host: context.host,
    shQuote: context.shQuote,
    runProcessWithCodeTimeout: context.runProcessWithCodeTimeout,
  });
  const seed = scanned.find((repo) => repo.seed);
  const repos = scanned
    .filter((repo) => repo.seed || repo.branch !== "HEAD")
    .slice(0, SESSION_REPO_LIMIT);
  const [defaultProject, ...found] = await Promise.all([
    deps.defaultProject(seed?.root ?? context.root).catch(() => null),
    ...repos.map((repo) =>
      readRepoRequest({ ...context, root: repo.root }, deps.projectIds).catch(
        () => ({ project: null, request: null }),
      ),
    ),
  ]);
  return {
    defaultProject,
    repos: repos.map((repo, index) => ({
      root: repo.root,
      branch: repo.branch,
      ...found[index]!,
    })),
    refreshedAt: now(),
  };
}

/** A repository's forge project and its branch's request. */
async function readRepoRequest(
  context: ForgeContext,
  projectIds: Map<string, number>,
): Promise<Pick<ForgeSessionRepo, "project" | "request">> {
  const checkout = await readCheckout(context);
  const source = mergeRequestSource(checkout);
  const url = source ? checkout.remotes[source.remote] : undefined;
  const remote = url ? remoteProject(url) : null;
  if (!source || !remote) return { project: null, request: null };
  const remoteHost = remote.host.replace(/^ssh\./, "");
  if (
    remoteHost === "github.com" ||
    (remoteHost !== checkout.gitlabHost &&
      (await ghHostLogin(context, remoteHost).catch(() => 1)) === 0)
  ) {
    const project: ForgeProject = {
      provider: "github",
      host: remoteHost,
      project: remote.project,
    };
    // The PR card's own lookup, through gh.
    const status = await readPullRequestStatus(context, {
      summary: true,
      latest: true,
    });
    const request =
      status.state === "ready" && status.provider === "github"
        ? status.request
        : undefined;
    return {
      project,
      request: request
        ? { url: request.url, number: request.number, title: request.title }
        : null,
    };
  }
  const host = gitlabHostFor(remote.host, checkout);
  const project: ForgeProject = {
    provider: "gitlab",
    host: host ?? remoteHost,
    project: remote.project,
  };
  // No login for that host: its token is never sent there.
  if (!host || isSecurityProject(remote.project))
    return { project, request: null };
  const found = await findBranchMergeRequest(context, checkout, projectIds);
  if (!found || isSecurityProject(parseForgeUrl(found.url)?.project ?? ""))
    return { project, request: null };
  return {
    project,
    request: { url: found.url, number: found.number, title: found.title },
  };
}

/** A reference from the browser, checked before anything runs. */
export function parseForgeRefParam(value: unknown): ForgeRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.provider !== "gitlab" && raw.provider !== "github") return null;
  const host = typeof raw.host === "string" ? raw.host.toLowerCase() : "";
  const project = typeof raw.project === "string" ? raw.project : "";
  const number = raw.number;
  if (
    !validHost(host) ||
    !validProject(project) ||
    !Number.isSafeInteger(number) ||
    (number as number) <= 0
  )
    return null;
  return { provider: raw.provider, host, project, number: number as number };
}

export type { ForgePipeline };
