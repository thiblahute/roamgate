import {
  type ForgePipelineStatus,
  type ForgeRequestState,
  forgeRefKey,
  ownRequestUrl,
  validProject,
} from "../../../shared/forge";
import type { MrItem, MrOwnStatus, MrReason } from "../../../shared/mrReviews";
import type {
  MrMergeEvent,
  MrMergeFacts,
} from "../../../shared/mrReviewsMerge";
import { githubPipelineStatus, gitlabPipelineStatus } from "../review/forge";

/**
 * The reviews inbox's forge queries and their parsers: one GraphQL query
 * per host and refresh gives the user's requests (review requested,
 * assigned, mentioned) and the open requests of the followed projects.
 * Pure: the inbox runs them through the forge gate.
 */

/** Requests per list asked. */
export const INBOX_PAGE = 50;
/** Open requests asked per followed project. */
export const FOLLOWED_PAGE = 40;
/** Changed paths kept per suggestion candidate. */
export const FILES_KEPT = 40;

const GITLAB_FIELDS =
  "iid title webUrl draft state updatedAt userNotesCount diffHeadSha sourceBranch targetBranch project { fullPath } author { username } headPipeline { status } diffRefs { baseSha } labels { nodes { title } }";

/**
 * A part of the inbox query: the user's own lists ("mine") or a followed
 * project by its index. The parts can be asked in several queries (a host's
 * complexity limit) and their answers merged with mergeAnswers.
 */
export type InboxPart = "mine" | number;

/** Every part of the inbox query for these followed projects. */
export function inboxParts(followed: string[]): InboxPart[] {
  return ["mine", ...followed.map((_, index) => index)];
}

/** One GraphQL query for a GitLab host. JSON strings are GraphQL strings. */
export function gitlabInboxQuery(
  followed: string[],
  parts: InboxPart[] = inboxParts(followed),
): string {
  const followedParts = parts.flatMap((part) => {
    if (part === "mine" || followed[part] === undefined) return [];
    return [
      `f${part}: project(fullPath: ${JSON.stringify(followed[part])}) { fullPath mergeRequests(state: opened, sort: UPDATED_DESC, first: ${FOLLOWED_PAGE}) { nodes { ${GITLAB_FIELDS} diffStats { path } } } }`,
    ];
  });
  const mine = parts.includes("mine")
    ? `currentUser { username rr: reviewRequestedMergeRequests(state: opened, sort: UPDATED_DESC, first: ${INBOX_PAGE}) { nodes { ${GITLAB_FIELDS} } } as: assignedMergeRequests(state: opened, sort: UPDATED_DESC, first: ${INBOX_PAGE}) { nodes { ${GITLAB_FIELDS} } } todos(state: pending, action: [mentioned, directly_addressed], type: [MERGEREQUEST], first: ${INBOX_PAGE}) { nodes { action target { ... on MergeRequest { ${GITLAB_FIELDS} } } } } } `
    : "";
  return `query { ${mine}${followedParts.join(" ")} }`;
}

const GITHUB_FIELDS =
  "number title url isDraft state updatedAt headRefOid baseRefOid headRefName baseRefName repository { nameWithOwner } author { login } comments { totalCount } reviewThreads { totalCount } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } reviews(states: PENDING, first: 1) { nodes { comments { totalCount } } } labels(first: 10) { nodes { name } }";

function githubSearch(alias: string, filter: string): string {
  return `${alias}: search(type: ISSUE, query: ${JSON.stringify(`is:open is:pr archived:false ${filter}`)}, first: ${INBOX_PAGE}) { nodes { ... on PullRequest { ${GITHUB_FIELDS} } } }`;
}

/** One GraphQL query for a GitHub host. */
export function githubInboxQuery(
  followed: string[],
  parts: InboxPart[] = inboxParts(followed),
): string {
  const followedParts = parts.flatMap((part) => {
    if (part === "mine" || followed[part] === undefined) return [];
    const [owner, name, ...rest] = followed[part].split("/");
    if (!owner || !name || rest.length) return [];
    return [
      `f${part}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner pullRequests(states: OPEN, first: ${FOLLOWED_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${GITHUB_FIELDS} files(first: ${FILES_KEPT}) { nodes { path } } } } }`,
    ];
  });
  const mine = parts.includes("mine")
    ? `viewer { login } ${githubSearch("rr", "review-requested:@me")} ${githubSearch("as", "assignee:@me")} ${githubSearch("mn", "mentions:@me")} `
    : "";
  return `query { ${mine}${followedParts.join(" ")} }`;
}

/**
 * The answers of a query asked in several parts, as one: their data
 * merged (an object both have, like currentUser, merged in turn), their
 * errors together. An answer without data adds its errors only.
 */
export function mergeAnswers(answers: unknown[]): unknown {
  if (answers.length === 1) return answers[0];
  const data: Record<string, any> = {};
  const errors: unknown[] = [];
  let any = false;
  for (const answer of answers) {
    const part = (answer as { data?: unknown } | null)?.data;
    const partErrors = (answer as { errors?: unknown } | null)?.errors;
    if (Array.isArray(partErrors)) errors.push(...partErrors);
    if (!part || typeof part !== "object") continue;
    any = true;
    for (const [key, value] of Object.entries(part)) {
      const before = data[key];
      data[key] =
        before &&
        value &&
        typeof before === "object" &&
        typeof value === "object" &&
        !Array.isArray(value)
          ? { ...before, ...value }
          : value;
    }
  }
  return {
    ...(any ? { data } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function sha(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value)
    ? value.toLowerCase()
    : "";
}

function gitlabState(value: unknown): ForgeRequestState {
  const state = text(value, 20).toLowerCase();
  return state === "merged"
    ? "merged"
    : state === "closed"
      ? "closed"
      : state === "locked"
        ? "locked"
        : "open";
}

function githubState(value: unknown): ForgeRequestState {
  return value === "MERGED" ? "merged" : value === "CLOSED" ? "closed" : "open";
}

/** A GitLab merge request node, or null when it is not one we can trust. */
export function gitlabItem(host: string, node: unknown): MrItem | null {
  if (!node || typeof node !== "object") return null;
  const mr = node as Record<string, any>;
  const project = text(mr.project?.fullPath, 300);
  const number = Number(mr.iid);
  if (!validProject(project) || !Number.isSafeInteger(number) || number <= 0)
    return null;
  const ref = { provider: "gitlab" as const, host, project, number };
  const url = ownRequestUrl(ref, mr.webUrl);
  if (!url) return null;
  const status = mr.headPipeline
    ? gitlabPipelineStatus(text(mr.headPipeline.status, 40).toLowerCase())
    : null;
  const files = Array.isArray(mr.diffStats)
    ? mr.diffStats
        .map((stat: any) => text(stat?.path, 400))
        .filter(Boolean)
        .slice(0, FILES_KEPT)
    : undefined;
  return {
    ...ref,
    key: forgeRefKey(ref),
    url,
    title: text(mr.title, 300),
    author: text(mr.author?.username, 100),
    draft: mr.draft === true,
    state: gitlabState(mr.state),
    updatedAt: text(mr.updatedAt, 40),
    headSha: sha(mr.diffHeadSha),
    ...(sha(mr.diffRefs?.baseSha) ? { baseSha: sha(mr.diffRefs.baseSha) } : {}),
    sourceBranch: text(mr.sourceBranch, 300),
    targetBranch: text(mr.targetBranch, 300),
    pipeline: status,
    notes: count(mr.userNotesCount),
    reasons: [],
    ...(files ? { files } : {}),
    ...labelsOf(mr.labels, "title"),
  };
}

/** The forge's labels of a request (at most 10), when it gave some. */
function labelsOf(
  value: unknown,
  field: "title" | "name",
): { labels?: string[] } {
  const list = (value as { nodes?: unknown })?.nodes;
  if (!Array.isArray(list)) return {};
  const labels = list
    .map((node) => text((node as Record<string, unknown>)?.[field], 60))
    .filter(Boolean)
    .slice(0, 10);
  return labels.length ? { labels } : {};
}

/** A GitHub pull request node, or null. */
export function githubItem(host: string, node: unknown): MrItem | null {
  if (!node || typeof node !== "object") return null;
  const pr = node as Record<string, any>;
  const project = text(pr.repository?.nameWithOwner, 300);
  const number = Number(pr.number);
  if (!validProject(project) || !Number.isSafeInteger(number) || number <= 0)
    return null;
  const ref = { provider: "github" as const, host, project, number };
  const url = ownRequestUrl(ref, pr.url);
  if (!url) return null;
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const pipeline: ForgePipelineStatus | null = rollup
    ? githubPipelineStatus(rollup.state)
    : null;
  const pending = pr.reviews?.nodes?.[0];
  const files = Array.isArray(pr.files?.nodes)
    ? pr.files.nodes
        .map((file: any) => text(file?.path, 400))
        .filter(Boolean)
        .slice(0, FILES_KEPT)
    : undefined;
  return {
    ...ref,
    key: forgeRefKey(ref),
    url,
    title: text(pr.title, 300),
    author: text(pr.author?.login, 100),
    draft: pr.isDraft === true,
    state: githubState(pr.state),
    updatedAt: text(pr.updatedAt, 40),
    headSha: sha(pr.headRefOid),
    ...(sha(pr.baseRefOid) ? { baseSha: sha(pr.baseRefOid) } : {}),
    sourceBranch: text(pr.headRefName, 300),
    targetBranch: text(pr.baseRefName, 300),
    pipeline,
    notes: count(pr.comments?.totalCount) + count(pr.reviewThreads?.totalCount),
    reasons: [],
    // The viewer's pending review is theirs alone: its comments are drafts.
    drafts: pending ? count(pending.comments?.totalCount) : 0,
    ...(files ? { files } : {}),
    ...labelsOf(pr.labels, "name"),
  };
}

export type HostAnswer = {
  user: string;
  /** The user's requests, each with why. */
  mine: MrItem[];
  /** Open requests of the followed projects (with their files). */
  followed: MrItem[];
  /** Followed projects the forge could not show. */
  missing: string[];
};

function nodes(value: unknown): unknown[] {
  const list = (value as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(list) ? list : [];
}

/** Adds an item to a list by key, merging why it is there. */
function addItem(list: Map<string, MrItem>, item: MrItem, reason?: MrReason) {
  const known = list.get(item.key);
  const reasons = new Set([...(known?.reasons ?? []), ...item.reasons]);
  if (reason) reasons.add(reason);
  list.set(item.key, { ...(known ?? item), reasons: [...reasons] });
}

/** A GitLab host's answer to gitlabInboxQuery. */
export function parseGitlabInbox(
  host: string,
  followed: string[],
  answer: unknown,
): HostAnswer {
  const data = (answer as { data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== "object")
    throw new Error(
      `GitLab: ${graphqlError(answer) ?? "no data in the answer"}`,
    );
  const user = data.currentUser;
  if (!user) throw new Error("GitLab: not signed in");
  const mine = new Map<string, MrItem>();
  for (const node of nodes(user.rr)) {
    const item = gitlabItem(host, node);
    if (item) addItem(mine, item, "review_requested");
  }
  for (const node of nodes(user.as)) {
    const item = gitlabItem(host, node);
    if (item) addItem(mine, item, "assigned");
  }
  for (const todo of nodes(user.todos)) {
    const item = gitlabItem(host, (todo as any)?.target);
    if (item && item.state === "open") addItem(mine, item, "mentioned");
  }
  const followedItems = new Map<string, MrItem>();
  const missing: string[] = [];
  followed.forEach((project, index) => {
    const entry = data[`f${index}`];
    if (!entry) {
      missing.push(project);
      return;
    }
    for (const node of nodes(entry.mergeRequests)) {
      const item = gitlabItem(host, node);
      if (item) addItem(followedItems, item);
    }
  });
  return {
    user: text(user.username, 100),
    mine: [...mine.values()],
    followed: [...followedItems.values()],
    missing,
  };
}

/** A GitHub host's answer to githubInboxQuery. */
export function parseGithubInbox(
  host: string,
  followed: string[],
  answer: unknown,
): HostAnswer {
  const data = (answer as { data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== "object")
    throw new Error(
      `GitHub: ${graphqlError(answer) ?? "no data in the answer"}`,
    );
  const mine = new Map<string, MrItem>();
  const lists: [string, MrReason][] = [
    ["rr", "review_requested"],
    ["as", "assigned"],
    ["mn", "mentioned"],
  ];
  for (const [alias, reason] of lists)
    for (const node of nodes(data[alias])) {
      const item = githubItem(host, node);
      if (item) addItem(mine, item, reason);
    }
  const followedItems = new Map<string, MrItem>();
  const missing: string[] = [];
  followed.forEach((project, index) => {
    const entry = data[`f${index}`];
    if (!entry) {
      missing.push(project);
      return;
    }
    for (const node of nodes(entry.pullRequests)) {
      const item = githubItem(host, node);
      if (item) addItem(followedItems, item);
    }
  });
  return {
    user: text(data.viewer?.login, 100),
    mine: [...mine.values()],
    followed: [...followedItems.values()],
    missing,
  };
}

/**
 * The user's own requests are read in two steps, so that a refresh costs
 * little whatever their number: a light list of every open one (paged to
 * its end) and a few recently settled ones, then the costly details
 * (pipeline, approvals, threads, conflicts, notes) only for those new or
 * changed since they were last read.
 */

/** Open own requests asked per page (the forges' maximum). */
export const OWN_PAGE = 100;
/** Pages of open own requests read per host at most; logged when hit. */
export const OWN_MAX_PAGES = 10;
/** Recently merged or closed own requests asked (each state on GitLab). */
export const OWN_SETTLED_PAGE = 10;
/** Requests whose details one query asks at most. */
export const OWN_DETAILS_BATCH = 40;

/** What a row needs of an own merge request, cheap for GitLab to answer. */
const GITLAB_OWN_LIST =
  "iid title webUrl draft state updatedAt diffHeadSha sourceBranch targetBranch project { fullPath } author { username } labels { nodes { title } }";
const GITLAB_OWN_DETAILS =
  "iid webUrl updatedAt diffHeadSha userNotesCount project { fullPath } headPipeline { status } diffRefs { baseSha }";

/**
 * What GitLab says of the user's own merge requests besides the list's
 * fields. "full" also asks who is assigned and auto-merge (merge bots,
 * section 15); "nomerge" leaves those out; "basic" leaves out what some
 * GitLab versions lack too. A host that refuses a level is asked the next
 * from then on.
 */
const GITLAB_STATUS_FIELDS =
  "conflicts shouldBeRebased approved detailedMergeStatus approvedBy { nodes { username } } resolvableDiscussionsCount resolvedDiscussionsCount description discussions(last: 10) { nodes { resolvable resolved notes(last: 1) { nodes { author { username } createdAt body system } } } }";
const GITLAB_OWN_FIELDS = {
  full: `${GITLAB_STATUS_FIELDS} assignees { nodes { username } } reviewers { nodes { username } } autoMergeEnabled mergeUser { username }`,
  nomerge: GITLAB_STATUS_FIELDS,
  basic: "conflicts shouldBeRebased",
} as const;

export type OwnFields = keyof typeof GITLAB_OWN_FIELDS;

/** The level asked after a host refused one. */
export function lesserOwnFields(
  provider: "gitlab" | "github",
  fields: OwnFields,
): OwnFields | null {
  if (fields === "full") return "nomerge";
  if (fields === "nomerge" && provider === "gitlab") return "basic";
  return null;
}

const GITHUB_OWN_LIST =
  "number title url isDraft state updatedAt headRefOid headRefName baseRefName repository { nameWithOwner } author { login } labels(first: 10) { nodes { name } }";
const GITHUB_OWN_DETAILS =
  "number url updatedAt headRefOid baseRefOid repository { nameWithOwner } comments { totalCount } reviewThreads { totalCount } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } reviews(states: PENDING, first: 1) { nodes { comments { totalCount } } } mergeable reviewDecision latestOpinionatedReviews(first: 20) { nodes { state submittedAt author { login } } } openThreads: reviewThreads(first: 100) { nodes { isResolved } } body lastComments: comments(last: 5) { nodes { author { login } createdAt body } } lastThreads: reviewThreads(last: 20) { nodes { isResolved comments(last: 1) { nodes { author { login } createdAt body } } } }";

/** GitHub: who is assigned, auto-merge, the merge queue, and their events (section 15). */
const GITHUB_MERGE_FIELDS =
  "assignees(first: 10) { nodes { login } } reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } } autoMergeRequest { enabledAt enabledBy { login } } mergeQueueEntry { position enqueuedAt } mergeTimeline: timelineItems(last: 30, itemTypes: [LABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT]) { nodes { __typename ... on LabeledEvent { createdAt actor { login } label { name } } ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on UnassignedEvent { createdAt actor { login } assignee { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on ReviewRequestRemovedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on AddedToMergeQueueEvent { createdAt actor { login } } ... on RemovedFromMergeQueueEvent { createdAt actor { login } reason } ... on AutoMergeEnabledEvent { createdAt actor { login } } ... on AutoMergeDisabledEvent { createdAt actor { login } reason } } }";

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

/**
 * One page of the user's open merge requests on a GitLab host, newest
 * first by creation (an order that holds while paging); the first page also
 * asks the latest merged and closed ones.
 */
export function gitlabOwnListQuery(
  after?: string,
  parts: OwnListPart[] = ownListParts("gitlab", after),
): string {
  const open = parts.includes("op")
    ? ` op: authoredMergeRequests(state: opened, sort: CREATED_DESC, first: ${OWN_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ""}) { ${PAGE_INFO} nodes { ${GITLAB_OWN_LIST} } }`
    : "";
  const settled = (
    [
      ["mg", "merged"],
      ["cl", "closed"],
    ] as const
  )
    .filter(([alias]) => parts.includes(alias))
    .map(
      ([alias, state]) =>
        ` ${alias}: authoredMergeRequests(state: ${state}, sort: UPDATED_DESC, first: ${OWN_SETTLED_PAGE}) { nodes { ${GITLAB_OWN_LIST} } }`,
    )
    .join("");
  return `query { currentUser { username${open}${settled} } }`;
}

/**
 * The lists of an own-requests page: the open ones ("op"), and on the
 * first page the settled ones (GitLab "mg" and "cl", GitHub "st"). They
 * can be asked in several queries (a host's complexity limit).
 */
export type OwnListPart = "op" | "mg" | "cl" | "st";

export function ownListParts(
  provider: "gitlab" | "github",
  after?: string,
): OwnListPart[] {
  if (after) return ["op"];
  return provider === "gitlab" ? ["op", "mg", "cl"] : ["op", "st"];
}

/** One page of the user's open pull requests on a GitHub host, and on the first the latest closed. */
export function githubOwnListQuery(
  after?: string,
  parts: OwnListPart[] = ownListParts("github", after),
): string {
  const open = parts.includes("op")
    ? ` op: search(type: ISSUE, query: ${JSON.stringify("is:pr is:open author:@me archived:false sort:created-desc")}, first: ${OWN_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ""}) { ${PAGE_INFO} nodes { ... on PullRequest { ${GITHUB_OWN_LIST} } } }`
    : "";
  const settled = parts.includes("st")
    ? ` st: search(type: ISSUE, query: ${JSON.stringify("is:pr is:closed author:@me archived:false sort:updated-desc")}, first: ${OWN_SETTLED_PAGE}) { nodes { ... on PullRequest { ${GITHUB_OWN_LIST} } } }`
    : "";
  return `query { viewer { login }${open}${settled} }`;
}

export type OwnListPage = {
  /** The page's requests, open and settled, without their details. */
  items: MrItem[];
  /** The cursor of the next page of open ones, when there is one. */
  next: string | null;
};

/** A page of gitlabOwnListQuery or githubOwnListQuery. */
export function parseOwnList(
  provider: "gitlab" | "github",
  host: string,
  answer: unknown,
): OwnListPage {
  const data = (answer as { data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== "object")
    throw new Error(
      `${provider === "gitlab" ? "GitLab" : "GitHub"}: ${graphqlError(answer) ?? "no data in the answer"}`,
    );
  const root = provider === "gitlab" ? data.currentUser : data;
  if (!root) throw new Error("GitLab: not signed in");
  const lists =
    provider === "gitlab" ? [root.op, root.mg, root.cl] : [root.op, root.st];
  const items: MrItem[] = [];
  for (const list of lists)
    for (const node of nodes(list)) {
      const item =
        provider === "gitlab" ? gitlabItem(host, node) : githubItem(host, node);
      if (item) items.push({ ...item, reasons: ["authored"] });
    }
  const info = root.op?.pageInfo;
  const next =
    info?.hasNextPage === true && typeof info.endCursor === "string"
      ? info.endCursor.slice(0, 500)
      : null;
  return { items, next };
}

/**
 * The details of some own requests (at most OWN_DETAILS_BATCH): one alias
 * per project, its requests by number.
 */
export function ownDetailsQuery(
  provider: "gitlab" | "github",
  items: Pick<MrItem, "project" | "number">[],
  fields: OwnFields = "full",
): string {
  const byProject = new Map<string, number[]>();
  for (const item of items)
    byProject.set(item.project, [
      ...(byProject.get(item.project) ?? []),
      item.number,
    ]);
  const parts = [...byProject].flatMap(([project, numbers], index) => {
    if (provider === "gitlab")
      return [
        `p${index}: project(fullPath: ${JSON.stringify(project)}) { mergeRequests(iids: ${JSON.stringify(numbers.map(String))}, first: ${numbers.length}) { nodes { ${GITLAB_OWN_DETAILS} ${GITLAB_OWN_FIELDS[fields]} } } }`,
      ];
    const [owner, name, ...rest] = project.split("/");
    if (!owner || !name || rest.length) return [];
    const pulls = numbers
      .map(
        (number) =>
          `n${number}: pullRequest(number: ${number}) { ${GITHUB_OWN_DETAILS}${fields === "full" ? ` ${GITHUB_MERGE_FIELDS}` : ""} }`,
      )
      .join(" ");
    return [
      `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${pulls} }`,
    ];
  });
  return `query { ${parts.join(" ")} }`;
}

/** What the costly fields say of an own request, kept between refreshes. */
export type OwnDetails = {
  /** The request's updatedAt and head when they were read. */
  updatedAt: string;
  headSha: string;
  pipeline: ForgePipelineStatus | null;
  notes: number;
  baseSha?: string;
  /** GitHub: the comments of the user's pending review. */
  drafts?: number;
  own: MrOwnStatus;
  /** The description's start, for the inference (DESCRIPTION_KEPT). */
  description?: string;
  /** The last note of each recent thread and comment, oldest first. */
  lastNotes?: OwnNote[];
  /** Who is assigned, auto-merge, the merge queue and their events (section 15). */
  merge?: MrMergeFacts;
  /** The merge-after labels whose add times were read (GitLab), sorted. */
  labelTimesFor?: string;
  /**
   * Something the forge settles later without touching updatedAt (a
   * pipeline running, mergeability being computed): read again next time.
   */
  settling: boolean;
};

/** A request's recent note, as the inference reads it. */
export type OwnNote = {
  author: string;
  at: string;
  body: string;
  /** A thread one can resolve (a review thread), and whether it is. */
  resolvable: boolean;
  resolved: boolean;
};

export const OWN_DESCRIPTION_KEPT = 1500;
export const OWN_NOTES_KEPT = 10;
const OWN_NOTE_BODY = 300;

/** The last notes of a GitLab merge request's discussions or a GitHub pull request's comments and threads. */
export function ownNotes(provider: "gitlab" | "github", node: any): OwnNote[] {
  const out: OwnNote[] = [];
  const add = (
    note: any,
    resolvable: boolean,
    resolved: boolean,
    login: (note: any) => unknown,
  ) => {
    if (!note || note.system === true) return;
    const body = text(note.body, 2000).replace(/\s+/g, " ").trim();
    if (!body) return;
    out.push({
      author: text(login(note), 100),
      at: text(note.createdAt, 40),
      body: body.slice(0, OWN_NOTE_BODY),
      resolvable,
      resolved,
    });
  };
  if (provider === "gitlab")
    for (const discussion of nodes(node?.discussions) as any[])
      for (const note of nodes(discussion?.notes))
        add(
          note,
          discussion?.resolvable === true,
          discussion?.resolved === true,
          (each) => each?.author?.username,
        );
  else {
    for (const comment of nodes(node?.lastComments))
      add(comment, false, false, (each) => each?.author?.login);
    for (const thread of nodes(node?.lastThreads) as any[])
      for (const comment of nodes(thread?.comments))
        add(
          comment,
          true,
          thread?.isResolved === true,
          (each) => each?.author?.login,
        );
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-OWN_NOTES_KEPT);
}

function users(list: unknown, field: string): string[] {
  return names(list, (node) => node?.[field]);
}

function login(value: any): string {
  return text(value?.login ?? value?.username, 100);
}

/** @names in a GitLab system note, up to the next clause. */
function mentioned(clause: string): string[] {
  return [...clause.matchAll(/@([\w.-]+)/g)].map((match) => match[1]!);
}

/**
 * A GitLab system note read as merge events: assigned / unassigned,
 * review requested / removed, approved, automatic merge set or aborted.
 */
export function gitlabSystemEvents(
  body: string,
  at: string,
  actor: string,
): MrMergeEvent[] {
  const out: MrMergeEvent[] = [];
  const base = { at, ...(actor ? { actor } : {}) };
  const assigned = /\bassigned to ((?:@[\w.-]+(?:,\s*|\s+and\s+)?)+)/i.exec(
    body,
  );
  if (assigned)
    out.push({ ...base, kind: "assigned", who: mentioned(assigned[1]!) });
  const unassigned = /\bunassigned ((?:@[\w.-]+(?:,\s*|\s+and\s+)?)+)/i.exec(
    body,
  );
  if (unassigned)
    out.push({ ...base, kind: "unassigned", who: mentioned(unassigned[1]!) });
  const requested =
    /\brequested reviews? from ((?:@[\w.-]+(?:,\s*|\s+and\s+)?)+)/i.exec(body);
  if (requested)
    out.push({
      ...base,
      kind: "review_requested",
      who: mentioned(requested[1]!),
    });
  const removed =
    /\bremoved review requests? for ((?:@[\w.-]+(?:,\s*|\s+and\s+)?)+)/i.exec(
      body,
    );
  if (removed)
    out.push({ ...base, kind: "review_removed", who: mentioned(removed[1]!) });
  if (/^approved this merge request/i.test(body))
    out.push({ ...base, kind: "approved" });
  if (
    /\b(enabled an automatic merge|set to auto-merge|enabled auto-merge)/i.test(
      body,
    )
  )
    out.push({ ...base, kind: "auto_merge_on" });
  const aborted =
    /\b(?:aborted|canceled|cancelled) the automatic merge(?: because (.*))?/i.exec(
      body,
    );
  if (aborted)
    out.push({
      ...base,
      kind: "auto_merge_off",
      reason: (aborted[1] ?? "canceled")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200),
    });
  return out;
}

/** A GitHub timeline item read as a merge event. */
function githubEvent(node: any): MrMergeEvent | null {
  const at = text(node?.createdAt, 40);
  if (!at) return null;
  const actor = login(node?.actor);
  const base = { at, ...(actor ? { actor } : {}) };
  const who = (value: any) => {
    const name = login(value);
    return name ? [name] : [];
  };
  switch (node?.__typename) {
    case "LabeledEvent": {
      const label = text(node?.label?.name, 60);
      return label ? { ...base, kind: "labeled", label } : null;
    }
    case "AssignedEvent":
      return { ...base, kind: "assigned", who: who(node.assignee) };
    case "UnassignedEvent":
      return { ...base, kind: "unassigned", who: who(node.assignee) };
    case "ReviewRequestedEvent":
      return {
        ...base,
        kind: "review_requested",
        who: who(node.requestedReviewer),
      };
    case "ReviewRequestRemovedEvent":
      return {
        ...base,
        kind: "review_removed",
        who: who(node.requestedReviewer),
      };
    case "AddedToMergeQueueEvent":
      return { ...base, kind: "queued" };
    case "RemovedFromMergeQueueEvent": {
      const reason = text(node?.reason, 200).replace(/_/g, " ").toLowerCase();
      return { ...base, kind: "dequeued", ...(reason ? { reason } : {}) };
    }
    case "AutoMergeEnabledEvent":
      return { ...base, kind: "auto_merge_on" };
    case "AutoMergeDisabledEvent": {
      const reason = text(node?.reason, 200).replace(/_/g, " ").toLowerCase();
      return { ...base, kind: "auto_merge_off", ...(reason ? { reason } : {}) };
    }
  }
  return null;
}

/** Events kept per request. */
const MERGE_EVENTS_KEPT = 20;

/**
 * What the details say about merging, when they were asked (the "full"
 * fields): assignees, reviewers, auto-merge, the merge queue, the latest
 * approval and the events (GitLab system notes, GitHub timeline).
 */
export function ownMergeFacts(
  provider: "gitlab" | "github",
  node: any,
): MrMergeFacts | undefined {
  if (!node || typeof node !== "object" || !("assignees" in node))
    return undefined;
  const events: MrMergeEvent[] = [];
  let approvedAt: string | undefined;
  const labelsAddedAt: Record<string, string> = {};
  if (provider === "gitlab") {
    for (const discussion of nodes(node.discussions) as any[])
      for (const note of nodes(discussion?.notes) as any[]) {
        if (note?.system !== true) continue;
        events.push(
          ...gitlabSystemEvents(
            text(note.body, 500),
            text(note.createdAt, 40),
            text(note.author?.username, 100),
          ),
        );
      }
  } else {
    for (const each of nodes(node.mergeTimeline)) {
      const event = githubEvent(each);
      if (!event) continue;
      if (event.kind === "labeled" && event.label)
        labelsAddedAt[event.label] = event.at;
      else events.push(event);
    }
    for (const review of nodes(node.latestOpinionatedReviews) as any[])
      if (review?.state === "APPROVED") {
        const at = text(review.submittedAt, 40);
        if (at && (!approvedAt || at > approvedAt)) approvedAt = at;
      }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  for (const event of events)
    if (event.kind === "approved" && (!approvedAt || event.at > approvedAt))
      approvedAt = event.at;
  const autoMerge =
    provider === "gitlab"
      ? node.autoMergeEnabled === true
        ? { ...(login(node.mergeUser) ? { by: login(node.mergeUser) } : {}) }
        : undefined
      : node.autoMergeRequest
        ? {
            ...(login(node.autoMergeRequest.enabledBy)
              ? { by: login(node.autoMergeRequest.enabledBy) }
              : {}),
            ...(text(node.autoMergeRequest.enabledAt, 40)
              ? { at: text(node.autoMergeRequest.enabledAt, 40) }
              : {}),
          }
        : undefined;
  const entry = provider === "github" ? node.mergeQueueEntry : null;
  const position = Number(entry?.position);
  const queue = entry
    ? {
        ...(Number.isSafeInteger(position) && position > 0 ? { position } : {}),
        ...(text(entry.enqueuedAt, 40)
          ? { at: text(entry.enqueuedAt, 40) }
          : {}),
      }
    : undefined;
  return {
    assignees: users(
      node.assignees,
      provider === "gitlab" ? "username" : "login",
    ),
    reviewers:
      provider === "gitlab"
        ? users(node.reviewers, "username")
        : names(node.reviewRequests, (request) =>
            login(request?.requestedReviewer),
          ),
    ...(autoMerge ? { autoMerge } : {}),
    ...(queue ? { queue } : {}),
    ...(approvedAt ? { approvedAt } : {}),
    events: events.slice(-MERGE_EVENTS_KEPT),
    ...(Object.keys(labelsAddedAt).length ? { labelsAddedAt } : {}),
  };
}

/**
 * GitLab's label events of a merge request (REST
 * `resource_label_events`): when each label present was last added.
 */
export function parseLabelEvents(answer: unknown): Record<string, string> {
  const added: Record<string, string> = {};
  if (!Array.isArray(answer)) return added;
  for (const event of answer as any[]) {
    const name = text(event?.label?.name, 60);
    const at = text(event?.created_at, 40);
    if (!name || !at) continue;
    if (event.action === "add") added[name] = at;
    else if (event.action === "remove") delete added[name];
  }
  return added;
}

const GITLAB_MERGE_SETTLING = new Set([
  "CHECKING",
  "UNCHECKED",
  "PREPARING",
  "CI_STILL_RUNNING",
]);

/** The answer to ownDetailsQuery, by request key. */
export function parseOwnDetails(
  provider: "gitlab" | "github",
  host: string,
  answer: unknown,
): Map<string, OwnDetails> {
  const data = (answer as { data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== "object")
    throw new Error(
      `${provider === "gitlab" ? "GitLab" : "GitHub"}: ${graphqlError(answer) ?? "no data in the answer"}`,
    );
  const found = new Map<string, OwnDetails>();
  for (const entry of Object.values(data)) {
    if (!entry || typeof entry !== "object") continue;
    const list =
      provider === "gitlab"
        ? nodes((entry as any).mergeRequests)
        : Object.values(entry as Record<string, unknown>);
    for (const node of list) {
      const item =
        provider === "gitlab" ? gitlabItem(host, node) : githubItem(host, node);
      if (!item) continue;
      const running =
        item.pipeline === "running" || item.pipeline === "pending";
      const settling =
        provider === "gitlab"
          ? GITLAB_MERGE_SETTLING.has(
              text((node as any).detailedMergeStatus, 60).toUpperCase(),
            )
          : (node as any).mergeable === "UNKNOWN";
      const description = text(
        provider === "gitlab" ? (node as any).description : (node as any).body,
        OWN_DESCRIPTION_KEPT,
      );
      const lastNotes = ownNotes(provider, node);
      const merge = ownMergeFacts(provider, node);
      found.set(item.key, {
        updatedAt: item.updatedAt,
        headSha: item.headSha,
        pipeline: item.pipeline,
        notes: item.notes,
        ...(description ? { description } : {}),
        ...(lastNotes.length ? { lastNotes } : {}),
        ...(item.baseSha ? { baseSha: item.baseSha } : {}),
        ...(item.drafts !== undefined ? { drafts: item.drafts } : {}),
        ...(merge ? { merge } : {}),
        own:
          provider === "gitlab" ? gitlabOwnStatus(node) : githubOwnStatus(node),
        settling: running || settling,
      });
    }
  }
  return found;
}

/** A listed own request with its details, as the inbox shows it. */
export function withOwnDetails(item: MrItem, details?: OwnDetails): MrItem {
  if (!details) return item;
  return {
    ...item,
    pipeline: details.pipeline,
    notes: details.notes,
    ...(details.baseSha ? { baseSha: details.baseSha } : {}),
    ...(details.drafts !== undefined ? { drafts: details.drafts } : {}),
    own: details.own,
  };
}

function names(list: unknown, field: (node: any) => unknown): string[] {
  return [
    ...new Set(
      nodes(list)
        .map((node) => text(field(node), 100))
        .filter(Boolean),
    ),
  ];
}

/** A GitLab own merge request's status, from the details' fields. */
export function gitlabOwnStatus(node: any): MrOwnStatus {
  const resolvable = Number(node?.resolvableDiscussionsCount);
  const resolved = Number(node?.resolvedDiscussionsCount);
  const merge = text(node?.detailedMergeStatus, 60).toUpperCase();
  return {
    approvedBy: names(node?.approvedBy, (user) => user?.username),
    approved: typeof node?.approved === "boolean" ? node.approved : null,
    changesRequested: [],
    unresolved:
      Number.isSafeInteger(resolvable) && Number.isSafeInteger(resolved)
        ? Math.max(0, resolvable - resolved)
        : null,
    conflicts: node?.conflicts === true || merge === "CONFLICT",
    needsRebase: node?.shouldBeRebased === true || merge === "NEED_REBASE",
  };
}

/** A GitHub own pull request's status, from the details' fields. */
export function githubOwnStatus(node: any): MrOwnStatus {
  const reviews = nodes(node?.latestOpinionatedReviews);
  const by = (state: string) =>
    names(
      { nodes: reviews.filter((review: any) => review?.state === state) },
      (review) => review?.author?.login,
    );
  const threads = node?.openThreads ? nodes(node.openThreads) : null;
  return {
    approvedBy: by("APPROVED"),
    approved:
      node?.reviewDecision === "APPROVED"
        ? true
        : node?.reviewDecision
          ? false
          : null,
    changesRequested: by("CHANGES_REQUESTED"),
    unresolved: threads
      ? threads.filter((thread: any) => thread?.isResolved === false).length
      : null,
    conflicts: node?.mergeable === "CONFLICTING",
    needsRebase: false,
  };
}

/** Whether a GraphQL answer refused a field (an older or smaller forge). */
export function unknownFieldError(answer: unknown): boolean {
  const message = graphqlError(answer);
  return (
    !!message &&
    !(answer as { data?: unknown } | null)?.data &&
    /field|doesn't exist|does not exist|undefined/i.test(message)
  );
}

/** The first GraphQL error's message, if the answer has one. */
export function graphqlError(answer: unknown): string | null {
  const errors = (answer as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || !errors.length) return null;
  const message = (errors[0] as { message?: unknown })?.message;
  return typeof message === "string" ? message.slice(0, 300) : "error";
}
