import type { MrItem } from "../../../shared/mrReviews";
import { estimateComplexity } from "./complexity";

/** What the inbox asked its forges for (the server's fetchers). */
type FetchCall = { feature: string; kind: string; reuseMs?: number };
type InboxFetchers = {
  gitlab(host: string, query: string, call?: FetchCall): Promise<unknown>;
  github(host: string, query: string, call?: FetchCall): Promise<unknown>;
  gitlabDrafts(item: MrItem): Promise<number>;
  gitlabLabelEvents?(item: MrItem): Promise<Record<string, string>>;
};

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** When each label was last added, from GitLab's label events. */
function parseLabelEvents(answer: unknown): Record<string, string> {
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

/**
 * A fake forge for the user's own requests, GitLab or GitHub: it answers
 * the inbox's own-request queries (the light list and its pages, the
 * details by project) from a list of requests, with only the fields each
 * query asks, and counts the calls and their bytes. Tests only.
 */

export type FakeRequest = {
  project: string;
  number: number;
  state: "open" | "merged" | "closed";
  createdAt: string;
  updatedAt: string;
  head?: string;
  pipeline?: "success" | "failed" | "running" | "pending";
  approvedBy?: string[];
  unresolved?: number;
  conflicts?: boolean;
  /** Section 15: labels, who is assigned, auto-merge, the merge queue. */
  labels?: string[];
  /** GitLab's label events (REST), oldest first. */
  labelEvents?: { label: string; action?: "add" | "remove"; at: string }[];
  assignees?: string[];
  reviewers?: string[];
  autoMerge?: { by: string; at: string };
  /** GitHub's merge queue. */
  queue?: { position: number; at: string };
  /** Notes: GitLab discussions (system ones too), GitHub comments. */
  notes?: { author: string; at: string; body: string; system?: boolean }[];
  /** GitHub timeline items, as the API gives them (__typename first). */
  timeline?: Record<string, unknown>[];
};

export type FakeCall = {
  kind: "inbox" | "list" | "details" | "labels" | "other";
  query: string;
  /** Bytes sent and received. */
  bytes: number;
  /** The requests whose details were asked. */
  numbers: number[];
};

const PAGE_LIMIT = 100;

function string(query: string, pattern: RegExp): string | undefined {
  return pattern.exec(query)?.[1];
}

function first(query: string, alias: string): number {
  const match = new RegExp(`${alias}: [a-zA-Z]+\\([^)]*first: (\\d+)`).exec(
    query,
  );
  return Math.min(PAGE_LIMIT, Number(match?.[1] ?? PAGE_LIMIT));
}

function byCreated(a: FakeRequest, b: FakeRequest) {
  return b.createdAt.localeCompare(a.createdAt) || b.number - a.number;
}

function byUpdated(a: FakeRequest, b: FakeRequest) {
  return b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number;
}

export function createOwnForge(
  provider: "gitlab" | "github",
  host: string,
  initial: FakeRequest[],
  options: {
    refuseFull?: boolean;
    /**
     * GitLab's complexity limit: a query whose complexity (the estimate
     * times `complexityScale`, as the real count differs) is above it is
     * refused as glab refuses it, with an error.
     */
    maxComplexity?: number;
    complexityScale?: number;
    /** Others' open requests, the followed projects' (GitLab). */
    followed?: FakeRequest[];
  } = {},
) {
  let requests = initial;
  const calls: FakeCall[] = [];
  const gitlabState = { open: "opened", merged: "merged", closed: "closed" };
  const githubState = { open: "OPEN", merged: "MERGED", closed: "CLOSED" };
  const url = (r: FakeRequest) =>
    provider === "gitlab"
      ? `https://${host}/${r.project}/-/merge_requests/${r.number}`
      : `https://${host}/${r.project}/pull/${r.number}`;
  const head = (r: FakeRequest) =>
    r.head ?? `${String(r.number).padStart(7, "a")}0`;

  const gitlabLight = (r: FakeRequest) => ({
    iid: String(r.number),
    title: `Request ${r.number} of ${r.project}`,
    webUrl: url(r),
    draft: false,
    state: gitlabState[r.state],
    updatedAt: r.updatedAt,
    diffHeadSha: head(r),
    sourceBranch: `topic-${r.number}`,
    targetBranch: "main",
    project: { fullPath: r.project },
    author: { username: "me" },
    labels: { nodes: (r.labels ?? []).map((title) => ({ title })) },
  });
  const gitlabMerge = (r: FakeRequest, query: string) =>
    query.includes("assignees")
      ? {
          assignees: {
            nodes: (r.assignees ?? []).map((username) => ({ username })),
          },
          reviewers: {
            nodes: (r.reviewers ?? []).map((username) => ({ username })),
          },
          autoMergeEnabled: !!r.autoMerge,
          mergeUser: r.autoMerge ? { username: r.autoMerge.by } : null,
        }
      : {};
  const gitlabNotes = (r: FakeRequest, query: string) =>
    query.includes("discussions(")
      ? {
          discussions: {
            nodes: (r.notes ?? []).map((note) => ({
              resolvable: false,
              resolved: false,
              notes: {
                nodes: [
                  {
                    author: { username: note.author },
                    createdAt: note.at,
                    body: note.body,
                    system: note.system === true,
                  },
                ],
              },
            })),
          },
        }
      : {};
  const gitlabDetails = (r: FakeRequest, full: boolean) => ({
    iid: String(r.number),
    webUrl: url(r),
    updatedAt: r.updatedAt,
    diffHeadSha: head(r),
    userNotesCount: 3,
    project: { fullPath: r.project },
    headPipeline: { status: (r.pipeline ?? "success").toUpperCase() },
    diffRefs: { baseSha: "bbbbbbbb" },
    conflicts: r.conflicts === true,
    shouldBeRebased: false,
    ...(full
      ? {
          approved: (r.approvedBy?.length ?? 0) > 0,
          detailedMergeStatus: r.conflicts ? "CONFLICT" : "MERGEABLE",
          approvedBy: {
            nodes: (r.approvedBy ?? []).map((username) => ({ username })),
          },
          resolvableDiscussionsCount: (r.unresolved ?? 0) + 2,
          resolvedDiscussionsCount: 2,
        }
      : {}),
  });
  const githubLight = (r: FakeRequest) => ({
    number: r.number,
    title: `Request ${r.number} of ${r.project}`,
    url: url(r),
    isDraft: false,
    state: githubState[r.state],
    updatedAt: r.updatedAt,
    headRefOid: head(r),
    headRefName: `topic-${r.number}`,
    baseRefName: "main",
    repository: { nameWithOwner: r.project },
    author: { login: "me" },
    labels: { nodes: (r.labels ?? []).map((name) => ({ name })) },
  });
  const githubMerge = (r: FakeRequest, query: string) =>
    query.includes("mergeTimeline")
      ? {
          assignees: { nodes: (r.assignees ?? []).map((login) => ({ login })) },
          reviewRequests: {
            nodes: (r.reviewers ?? []).map((login) => ({
              requestedReviewer: { login },
            })),
          },
          autoMergeRequest: r.autoMerge
            ? {
                enabledAt: r.autoMerge.at,
                enabledBy: { login: r.autoMerge.by },
              }
            : null,
          mergeQueueEntry: r.queue
            ? { position: r.queue.position, enqueuedAt: r.queue.at }
            : null,
          mergeTimeline: { nodes: r.timeline ?? [] },
          lastComments: {
            nodes: (r.notes ?? [])
              .filter((note) => !note.system)
              .map((note) => ({
                author: { login: note.author },
                createdAt: note.at,
                body: note.body,
              })),
          },
        }
      : {};
  const githubDetails = (r: FakeRequest) => ({
    number: r.number,
    url: url(r),
    updatedAt: r.updatedAt,
    headRefOid: head(r),
    baseRefOid: "bbbbbbbb",
    repository: { nameWithOwner: r.project },
    comments: { totalCount: 2 },
    reviewThreads: { totalCount: 1 },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state:
                r.pipeline === "failed"
                  ? "FAILURE"
                  : r.pipeline === "running" || r.pipeline === "pending"
                    ? "PENDING"
                    : "SUCCESS",
            },
          },
        },
      ],
    },
    reviews: { nodes: [] },
    mergeable: r.conflicts ? "CONFLICTING" : "MERGEABLE",
    reviewDecision: r.approvedBy?.length ? "APPROVED" : "REVIEW_REQUIRED",
    latestOpinionatedReviews: {
      nodes: (r.approvedBy ?? []).map((login) => ({
        state: "APPROVED",
        author: { login },
      })),
    },
    openThreads: {
      nodes: Array.from({ length: r.unresolved ?? 0 }, () => ({
        isResolved: false,
      })),
    },
  });

  /** A page of the open ones, from an offset cursor. */
  function openPage(query: string, alias: string) {
    const offset = Number(string(query, /after: "(\d+)"/) ?? 0);
    const size = first(query, alias);
    const open = requests.filter((r) => r.state === "open").sort(byCreated);
    const page = open.slice(offset, offset + size);
    return {
      page,
      pageInfo: {
        hasNextPage: offset + size < open.length,
        endCursor: String(offset + size),
      },
    };
  }

  /** The followed projects a GitLab inbox query asks, by alias. */
  function followedAnswer(query: string): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const match of query.matchAll(
      /(f\d+): project\(fullPath: "([^"]+)"\)/g,
    ))
      data[match[1]!] = {
        fullPath: match[2],
        mergeRequests: {
          nodes: (options.followed ?? [])
            .filter((r) => r.project === match[2] && r.state === "open")
            .map((r) => ({
              ...gitlabLight(r),
              author: { username: "someone" },
              diffStats: [],
            })),
        },
      };
    return data;
  }

  function answer(query: string): {
    kind: FakeCall["kind"];
    body: unknown;
    numbers: number[];
  } {
    if (provider === "gitlab" && /\bf\d+: project\(/.test(query))
      return {
        kind: "inbox",
        numbers: [],
        body: {
          data: {
            ...(/\brr: /.test(query)
              ? {
                  currentUser: {
                    username: "me",
                    rr: { nodes: [] },
                    as: { nodes: [] },
                    todos: { nodes: [] },
                  },
                }
              : {}),
            ...followedAnswer(query),
          },
        },
      };
    if (/\brr: /.test(query))
      return {
        kind: "inbox",
        numbers: [],
        body:
          provider === "gitlab"
            ? {
                data: {
                  currentUser: {
                    username: "me",
                    rr: { nodes: [] },
                    as: { nodes: [] },
                    todos: { nodes: [] },
                  },
                },
              }
            : {
                data: {
                  viewer: { login: "me" },
                  rr: { nodes: [] },
                  as: { nodes: [] },
                  mn: { nodes: [] },
                },
              },
      };
    const full = !options.refuseFull;
    if (/approvedBy|approved /.test(query) && options.refuseFull)
      return {
        kind: "details",
        numbers: [],
        body: {
          errors: [
            {
              message: "Field 'approved' doesn't exist on type 'MergeRequest'",
            },
          ],
        },
      };
    if (provider === "gitlab") {
      if (query.includes("mergeRequests(iids:")) {
        const data: Record<string, unknown> = {};
        const numbers: number[] = [];
        for (const match of query.matchAll(
          /(p\d+): project\(fullPath: "([^"]+)"\) \{ mergeRequests\(iids: (\[[^\]]*\])/g,
        )) {
          const iids = (JSON.parse(match[3]!) as string[]).map(Number);
          numbers.push(...iids);
          data[match[1]!] = {
            mergeRequests: {
              nodes: requests
                .filter(
                  (r) => r.project === match[2] && iids.includes(r.number),
                )
                .map((r) => ({
                  ...gitlabDetails(r, full && query.includes("approvedBy")),
                  ...gitlabNotes(r, query),
                  ...gitlabMerge(r, query),
                })),
            },
          };
        }
        return { kind: "details", numbers, body: { data } };
      }
      if (query.includes("op: authoredMergeRequests")) {
        const { page, pageInfo } = openPage(query, "op");
        const settled = (state: FakeRequest["state"], alias: string) =>
          query.includes(`${alias}: authoredMergeRequests`)
            ? {
                [alias]: {
                  nodes: requests
                    .filter((r) => r.state === state)
                    .sort(byUpdated)
                    .slice(0, first(query, alias))
                    .map(gitlabLight),
                },
              }
            : {};
        return {
          kind: "list",
          numbers: [],
          body: {
            data: {
              currentUser: {
                username: "me",
                op: { pageInfo, nodes: page.map(gitlabLight) },
                ...settled("merged", "mg"),
                ...settled("closed", "cl"),
              },
            },
          },
        };
      }
      if (query.includes("au: authoredMergeRequests")) {
        // The single query of before: the latest in any state, all fields.
        return {
          kind: "list",
          numbers: [],
          body: {
            data: {
              currentUser: {
                username: "me",
                au: {
                  nodes: [...requests]
                    .sort(byUpdated)
                    .slice(0, first(query, "au"))
                    .map((r) => ({
                      ...gitlabLight(r),
                      ...gitlabDetails(r, query.includes("approvedBy")),
                    })),
                },
              },
            },
          },
        };
      }
      return { kind: "other", numbers: [], body: { data: {} } };
    }
    if (query.includes("pullRequest(number:")) {
      const data: Record<string, Record<string, unknown>> = {};
      const numbers: number[] = [];
      for (const segment of query.split(/(?=p\d+: repository\()/).slice(1)) {
        const repo =
          /^(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(
            segment,
          );
        if (!repo) continue;
        const project = `${repo[2]}/${repo[3]}`;
        const pulls: Record<string, unknown> = {};
        for (const pull of segment.matchAll(
          /(n\d+): pullRequest\(number: (\d+)\)/g,
        )) {
          const number = Number(pull[2]);
          numbers.push(number);
          const r = requests.find(
            (entry) => entry.project === project && entry.number === number,
          );
          pulls[pull[1]!] = r
            ? { ...githubDetails(r), ...githubMerge(r, query) }
            : null;
        }
        data[repo[1]!] = pulls;
      }
      return { kind: "details", numbers, body: { data } };
    }
    if (query.includes("op: search")) {
      const { page, pageInfo } = openPage(query, "op");
      return {
        kind: "list",
        numbers: [],
        body: {
          data: {
            viewer: { login: "me" },
            op: { pageInfo, nodes: page.map(githubLight) },
            ...(query.includes("st: search")
              ? {
                  st: {
                    nodes: requests
                      .filter((r) => r.state !== "open")
                      .sort(byUpdated)
                      .slice(0, first(query, "st"))
                      .map(githubLight),
                  },
                }
              : {}),
          },
        },
      };
    }
    if (query.includes("au: search")) {
      return {
        kind: "list",
        numbers: [],
        body: {
          data: {
            viewer: { login: "me" },
            au: {
              nodes: [...requests]
                .sort(byUpdated)
                .slice(0, first(query, "au"))
                .map((r) => ({ ...githubLight(r), ...githubDetails(r) })),
            },
          },
        },
      };
    }
    return { kind: "other", numbers: [], body: { data: {} } };
  }

  /** Complexity refusals, the queries glab was told off for. */
  const refused: { query: string; complexity: number }[] = [];

  async function ask(query: string): Promise<unknown> {
    if (options.maxComplexity !== undefined) {
      const complexity = Math.ceil(
        estimateComplexity(query) * (options.complexityScale ?? 1),
      );
      if (complexity > options.maxComplexity) {
        refused.push({ query, complexity });
        throw new Error(
          `GitLab: glab: Query has complexity of ${complexity}, which exceeds max complexity of ${options.maxComplexity}`,
        );
      }
    }
    const { kind, body, numbers } = answer(query);
    calls.push({
      kind,
      query,
      numbers,
      bytes: query.length + JSON.stringify(body).length,
    });
    return body;
  }

  const fetchers: InboxFetchers = {
    async gitlab(_host, query) {
      if (provider !== "gitlab") throw new Error("not this forge");
      return ask(query);
    },
    async github(_host, query) {
      if (provider !== "github") throw new Error("not this forge");
      return ask(query);
    },
    async gitlabDrafts() {
      return 0;
    },
    async gitlabLabelEvents(item) {
      const r = requests.find(
        (each) => each.project === item.project && each.number === item.number,
      );
      const body = (r?.labelEvents ?? []).map((event) => ({
        action: event.action ?? "add",
        label: { name: event.label },
        created_at: event.at,
      }));
      calls.push({
        kind: "labels",
        query: `${item.project}!${item.number}`,
        numbers: [item.number],
        bytes: JSON.stringify(body).length,
      });
      return parseLabelEvents(body);
    },
  };

  return {
    fetchers,
    calls,
    refused,
    /** The calls since the last reset, and resets them. */
    take(): FakeCall[] {
      return calls.splice(0);
    },
    update(change: (list: FakeRequest[]) => FakeRequest[]) {
      requests = change(requests);
    },
  };
}

/** `count` requests spread over three projects, numbered from `from`. */
export function fakeRequests(
  count: number,
  state: FakeRequest["state"],
  at: (index: number) => string,
  from = 1,
  projects = ["group/app", "group/lib", "other/tool"],
): FakeRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    project: projects[index % projects.length]!,
    number: from + index,
    state,
    createdAt: at(index),
    updatedAt: at(index),
  }));
}
