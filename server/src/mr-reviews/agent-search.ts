import {
  type ForgeProvider,
  type ForgeRef,
  forgeRefKey,
  validProject,
} from "../../../shared/forge";
import type { MrItem } from "../../../shared/mrReviews";
import { githubItem, gitlabItem, graphqlError } from "./queries";

/**
 * The reviews agent's forge searches, as pure query builders and parsers:
 * read-only GraphQL queries (a `query`, never a `mutation`; every value
 * given by the model goes in as a JSON-quoted string, a checked date or a
 * number), run by the agent's tools through the forge gate.
 */

/** Requests asked per project and search, at most. */
export const SEARCH_PAGE = 30;
/** Changed paths read per request found. */
export const SEARCH_FILES = 60;
/** What the search tool reads of a description. */
export const DESCRIPTION_KEPT = 1500;

export type SearchState = "opened" | "merged" | "closed" | "all";

export type SearchFilters = {
  /** Words searched in titles and descriptions. */
  text?: string;
  labels?: string[];
  author?: string;
  /** ISO date (YYYY-MM-DD or a full timestamp). */
  updatedAfter?: string;
  state: SearchState;
  first: number;
};

const GITLAB_FIELDS =
  "iid title webUrl draft state updatedAt userNotesCount diffHeadSha sourceBranch targetBranch project { fullPath } author { username } headPipeline { status } diffRefs { baseSha } labels { nodes { title } }";

const GITHUB_FIELDS =
  "number title url isDraft state updatedAt headRefOid baseRefOid headRefName baseRefName repository { nameWithOwner } author { login } comments { totalCount } reviewThreads { totalCount } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } labels(first: 10) { nodes { name } }";

const DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const NAME = /^[\w.@-]{1,100}$/;

/** A date the forges take, or null. "7d" counts back from `now`. */
export function searchDate(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const days = /^(\d{1,4})\s*d(?:ays?)?$/i.exec(trimmed);
  if (days)
    return new Date(now - Number(days[1]) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  return DATE.test(trimmed) && Number.isFinite(Date.parse(trimmed))
    ? trimmed
    : null;
}

export function validUserName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

function quoted(value: string): string {
  // JSON strings are GraphQL strings.
  return JSON.stringify(value);
}

/** One GraphQL query searching `projects` of a GitLab host. */
export function gitlabSearchQuery(
  projects: string[],
  filters: SearchFilters,
): string {
  const args = [
    ...(filters.state === "all" ? [] : [`state: ${filters.state}`]),
    ...(filters.text ? [`search: ${quoted(filters.text)}`] : []),
    ...(filters.labels?.length
      ? [`labels: [${filters.labels.map(quoted).join(", ")}]`]
      : []),
    ...(filters.author ? [`authorUsername: ${quoted(filters.author)}`] : []),
    ...(filters.updatedAfter
      ? [`updatedAfter: ${quoted(filters.updatedAfter)}`]
      : []),
    "sort: UPDATED_DESC",
    `first: ${filters.first}`,
  ].join(", ");
  const parts = projects.map(
    (project, index) =>
      `p${index}: project(fullPath: ${quoted(project)}) { fullPath mergeRequests(${args}) { nodes { ${GITLAB_FIELDS} diffStats { path } } } }`,
  );
  return `query { ${parts.join(" ")} }`;
}

/** The search qualifier string of a GitHub search. */
export function githubSearchString(
  projects: string[],
  filters: SearchFilters,
): string {
  const words = [
    "is:pr",
    "archived:false",
    ...projects.map((project) => `repo:${project}`),
    ...(filters.state === "opened"
      ? ["is:open"]
      : filters.state === "merged"
        ? ["is:merged"]
        : filters.state === "closed"
          ? ["is:closed", "is:unmerged"]
          : []),
    ...(filters.labels ?? []).map(
      (label) => `label:"${label.replace(/["\\]/g, "")}"`,
    ),
    ...(filters.author ? [`author:${filters.author}`] : []),
    ...(filters.updatedAfter
      ? [`updated:>=${filters.updatedAfter.slice(0, 10)}`]
      : []),
    ...(filters.text ? [filters.text.replace(/[\r\n]+/g, " ")] : []),
  ];
  return words.join(" ");
}

/** One GraphQL query searching `projects` of a GitHub host. */
export function githubSearchQuery(
  projects: string[],
  filters: SearchFilters,
): string {
  return `query { s: search(type: ISSUE, query: ${quoted(githubSearchString(projects, filters))}, first: ${filters.first}) { nodes { ... on PullRequest { ${GITHUB_FIELDS} files(first: ${SEARCH_FILES}) { nodes { path } } } } } }`;
}

/** A request found, with what the inbox item does not carry. */
export type FoundRequest = {
  item: MrItem;
  labels: string[];
  description?: string;
  /** Per changed path, when the forge said. */
  changes?: { path: string; additions: number; deletions: number }[];
};

function labelsOf(node: any): string[] {
  const nodes = Array.isArray(node?.labels?.nodes) ? node.labels.nodes : [];
  return nodes
    .map((label: any) =>
      typeof label?.title === "string"
        ? label.title
        : typeof label?.name === "string"
          ? label.name
          : "",
    )
    .filter(Boolean)
    .slice(0, 20)
    .map((label: string) => label.slice(0, 80));
}

function withFiles(item: MrItem, node: any): MrItem {
  const raw = Array.isArray(node?.diffStats)
    ? node.diffStats
    : Array.isArray(node?.files?.nodes)
      ? node.files.nodes
      : null;
  if (!raw) return item;
  const files = raw
    .map((entry: any) =>
      typeof entry?.path === "string" ? entry.path.slice(0, 400) : "",
    )
    .filter(Boolean)
    .slice(0, SEARCH_FILES);
  return { ...item, files };
}

function answerData(forge: string, answer: unknown): Record<string, any> {
  const data = (answer as { data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== "object")
    throw new Error(
      `${forge}: ${graphqlError(answer) ?? "no data in the answer"}`,
    );
  return data;
}

/** A GitLab host's answer to gitlabSearchQuery. */
export function parseGitlabSearch(
  host: string,
  projects: string[],
  answer: unknown,
): { found: FoundRequest[]; missing: string[] } {
  const data = answerData("GitLab", answer);
  const found: FoundRequest[] = [];
  const missing: string[] = [];
  projects.forEach((project, index) => {
    const entry = data[`p${index}`];
    if (!entry) {
      missing.push(project);
      return;
    }
    const nodes = Array.isArray(entry.mergeRequests?.nodes)
      ? entry.mergeRequests.nodes
      : [];
    for (const node of nodes) {
      const item = gitlabItem(host, node);
      if (item)
        found.push({ item: withFiles(item, node), labels: labelsOf(node) });
    }
  });
  return { found, missing };
}

/** A GitHub host's answer to githubSearchQuery. */
export function parseGithubSearch(
  host: string,
  answer: unknown,
): { found: FoundRequest[] } {
  const data = answerData("GitHub", answer);
  const nodes = Array.isArray(data.s?.nodes) ? data.s.nodes : [];
  const found: FoundRequest[] = [];
  for (const node of nodes) {
    const item = githubItem(host, node);
    if (!item) continue;
    // Not asked: the user's pending review is the inbox's to count.
    delete item.drafts;
    found.push({ item: withFiles(item, node), labels: labelsOf(node) });
  }
  return { found };
}

/** One request with its changed files and description. */
export function gitlabRequestQuery(ref: ForgeRef): string {
  return `query { project(fullPath: ${quoted(ref.project)}) { mergeRequest(iid: ${quoted(String(ref.number))}) { ${GITLAB_FIELDS} description diffStats { path additions deletions } } } }`;
}

export function githubRequestQuery(ref: ForgeRef): string {
  const [owner, name] = ref.project.split("/");
  return `query { repository(owner: ${quoted(owner ?? "")}, name: ${quoted(name ?? "")}) { pullRequest(number: ${ref.number}) { ${GITHUB_FIELDS} body files(first: 100) { nodes { path additions deletions } } } } }`;
}

function changesOf(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((entry: any) => ({
      path: typeof entry?.path === "string" ? entry.path.slice(0, 400) : "",
      additions: Number(entry?.additions) || 0,
      deletions: Number(entry?.deletions) || 0,
    }))
    .filter((entry) => entry.path)
    .slice(0, 200);
}

/** The answer to gitlabRequestQuery / githubRequestQuery, or null. */
export function parseRequest(
  ref: ForgeRef,
  answer: unknown,
): FoundRequest | null {
  const data = answerData(
    ref.provider === "gitlab" ? "GitLab" : "GitHub",
    answer,
  );
  const node =
    ref.provider === "gitlab"
      ? data.project?.mergeRequest
      : data.repository?.pullRequest;
  if (!node) return null;
  const item =
    ref.provider === "gitlab"
      ? gitlabItem(ref.host, node)
      : githubItem(ref.host, node);
  if (!item || item.key !== forgeRefKey(ref)) return null;
  delete item.drafts;
  const changes = changesOf(
    ref.provider === "gitlab" ? node.diffStats : node.files?.nodes,
  );
  const text =
    typeof node.description === "string"
      ? node.description
      : typeof node.body === "string"
        ? node.body
        : "";
  return {
    item: changes
      ? { ...item, files: changes.slice(0, SEARCH_FILES).map((c) => c.path) }
      : item,
    labels: labelsOf(node),
    ...(text ? { description: text.slice(0, DESCRIPTION_KEPT) } : {}),
    ...(changes ? { changes } : {}),
  };
}

/**
 * A request as the agent names it: an inbox key, a URL, "project!12" /
 * "owner/repo#12", or "!12" / "#12" alone (found among `known`). Null when
 * it names none; an error when "!12" fits several.
 */
export function parseRequestRef(
  value: string,
  known: readonly MrItem[],
  hosts: readonly { host: string; provider: ForgeProvider }[],
): ForgeRef | { ambiguous: MrItem[] } | null {
  const text = value.trim();
  const byKey = known.find((item) => item.key === text.toLowerCase());
  if (byKey) return refOf(byKey);
  const url =
    /^https:\/\/([\w.-]+)\/(.+?)\/(?:-\/merge_requests|pull)\/(\d+)\b/.exec(
      text,
    );
  if (url) {
    const host = url[1]!.toLowerCase();
    const known = hosts.find((entry) => entry.host === host);
    const provider: ForgeProvider = text.includes("/-/merge_requests/")
      ? "gitlab"
      : "github";
    if (!known || known.provider !== provider) return null;
    return checkedRef({ provider, host, project: url[2]!, number: +url[3]! });
  }
  const full = /^([\w.-]+(?:\/[\w.-]+)+)([!#])(\d+)$/.exec(text);
  if (full) {
    const provider: ForgeProvider = full[2] === "!" ? "gitlab" : "github";
    const project = full[1]!;
    const listed = known.filter(
      (item) =>
        item.provider === provider &&
        item.project.toLowerCase() === project.toLowerCase() &&
        item.number === Number(full[3]),
    );
    if (listed.length === 1) return refOf(listed[0]!);
    const host = hosts.filter((entry) => entry.provider === provider);
    if (host.length !== 1) return listed.length ? { ambiguous: listed } : null;
    return checkedRef({
      provider,
      host: host[0]!.host,
      project,
      number: Number(full[3]),
    });
  }
  const short = /^([!#])(\d+)$/.exec(text);
  if (short) {
    const provider: ForgeProvider = short[1] === "!" ? "gitlab" : "github";
    const matches = known.filter(
      (item) => item.provider === provider && item.number === Number(short[2]),
    );
    if (matches.length === 1) return refOf(matches[0]!);
    if (matches.length > 1) return { ambiguous: matches };
  }
  return null;
}

function refOf(item: MrItem): ForgeRef {
  return {
    provider: item.provider,
    host: item.host,
    project: item.project,
    number: item.number,
  };
}

function checkedRef(ref: ForgeRef): ForgeRef | null {
  return validProject(ref.project) &&
    Number.isSafeInteger(ref.number) &&
    ref.number > 0
    ? ref
    : null;
}
