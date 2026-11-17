import type {
  ReviewAnchor,
  ReviewCommit,
  ReviewDiff,
  ReviewThread,
} from "../../../shared/review";
import { forgeGate } from "../workspace/forge-calls";
import { spawnGh } from "./forge";
import type {
  GitLabDraft,
  GlabContext,
  MergeRequestInfo,
  MergeRequestRef,
} from "./gitlab";
import { parseUnifiedDiff } from "./patch";

/**
 * GitHub pull requests for the review pane, shaped like review/gitlab.ts's
 * merge requests so the review service has one code path: `gh api` with
 * the user's own gh login on the checkout's host, through the forge gate.
 */

export function isGithubPullUrl(url: string): boolean {
  return /^https:\/\/[^/\s]+\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:[/?#].*)?$/.test(
    url,
  );
}

export function parseGithubPullUrl(url: string): MergeRequestRef | null {
  const match =
    /^https:\/\/([^/\s]+)\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
      url,
    );
  if (!match) return null;
  return { host: match[1]!, project: match[2]!, iid: Number(match[3]) };
}

/** `gh api` on the checkout's host, as JSON; lists paginated. */
export async function ghApi(
  context: GlabContext,
  host: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: {
    paginate?: boolean;
    fields?: [string, string, "raw" | "typed"][];
    kind?: string;
  } = {},
): Promise<unknown> {
  // A GraphQL query reads; a mutation writes, as REST's other methods do.
  const query = options.fields?.find(([key]) => key === "query")?.[1] ?? "";
  const read =
    method === "GET" || (path === "graphql" && !/^\s*mutation\b/.test(query));
  const argv = [
    "gh",
    "api",
    ...(host === "github.com" ? [] : ["--hostname", host]),
    "--method",
    method,
    ...(options.paginate ? ["--paginate"] : []),
    path,
    ...(options.fields ?? []).flatMap(([key, value, kind]) => [
      kind === "raw" ? "-f" : "-F",
      `${key}=${value}`,
    ]),
  ];
  const result = await forgeGate.run(
    context.runProcessWithCodeTimeout,
    {
      checkout: context.host ?? "",
      host,
      feature: "review",
      kind: options.kind ?? (read ? "read" : method.toLowerCase()),
      ...(method === "GET" && !options.paginate ? { conditional: true } : {}),
    },
    argv,
    (full) => spawnGh(context, full, read),
  );
  if (result.code === 127) throw new Error("gh is not installed on this host");
  const body = result.stdout.trim();
  if (result.code !== 0) {
    // GraphQL errors come with a body.
    if (path === "graphql" && body.startsWith("{")) return JSON.parse(body);
    const message = (result.stderr || body || "GitHub request failed")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" ")
      .slice(0, 300);
    throw new Error(`GitHub: ${message}`);
  }
  if (!body) return null;
  if (!options.paginate) return JSON.parse(body);
  // --paginate prints one JSON array per page back to back.
  const { parseJsonPages } = await import("./gitlab");
  const pages = parseJsonPages(body);
  return pages.length === 1 ? pages[0] : (pages as unknown[][]).flat();
}

function pullPath(ref: MergeRequestRef): string {
  return `repos/${ref.project}/pulls/${ref.iid}`;
}

export async function readPullRequest(
  context: GlabContext,
  url: string,
): Promise<MergeRequestInfo> {
  const ref = parseGithubPullUrl(url);
  if (!ref) throw new Error("not a GitHub pull request URL");
  const pr = (await ghApi(context, ref.host, "GET", pullPath(ref))) as Record<
    string,
    any
  >;
  const headSha = String(pr?.head?.sha ?? "");
  const baseSha = String(pr?.base?.sha ?? "");
  if (!headSha || !baseSha)
    throw new Error("GitHub has no diff for this pull request");
  const state = pr.merged_at
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : "opened";
  const htmlUrl = typeof pr.html_url === "string" ? pr.html_url : url;
  return {
    ...ref,
    forge: "github",
    projectPath: parseGithubPullUrl(htmlUrl)?.project ?? ref.project,
    url: htmlUrl,
    title: String(pr.title ?? ""),
    state,
    baseSha,
    startSha: baseSha,
    headSha,
    ...(typeof pr.updated_at === "string" ? { updatedAt: pr.updated_at } : {}),
  };
}

function filesDiff(files: Record<string, any>[]): string {
  return files
    .map((file) => {
      const newPath = String(file.filename ?? "");
      const oldPath = String(file.previous_filename ?? newPath);
      const header = [
        `diff --git a/${oldPath} b/${newPath}`,
        `--- ${file.status === "added" ? "/dev/null" : `a/${oldPath}`}`,
        `+++ ${file.status === "removed" ? "/dev/null" : `b/${newPath}`}`,
      ];
      if (typeof file.patch !== "string")
        return [header[0], "Binary files differ"].join("\n");
      return [...header, file.patch.replace(/\n$/, "")].join("\n");
    })
    .join("\n");
}

export async function readPullDiff(
  context: GlabContext,
  mr: MergeRequestInfo,
): Promise<ReviewDiff> {
  const files = (await ghApi(
    context,
    mr.host,
    "GET",
    `${pullPath(mr)}/files?per_page=100`,
    { paginate: true },
  )) as Record<string, any>[];
  return {
    files: parseUnifiedDiff(filesDiff(files ?? [])),
    baseSha: mr.baseSha,
    headSha: mr.headSha,
    truncated: false,
  };
}

export async function readPullCommits(
  context: GlabContext,
  mr: MergeRequestInfo,
): Promise<ReviewCommit[]> {
  const commits = (await ghApi(
    context,
    mr.host,
    "GET",
    `${pullPath(mr)}/commits?per_page=100`,
    { paginate: true },
  )) as Record<string, any>[];
  return (commits ?? []).map((entry) => {
    const message = String(entry?.commit?.message ?? "");
    const [subject = "", ...rest] = message.split("\n");
    return {
      sha: String(entry?.sha ?? ""),
      parent: entry?.parents?.[0]?.sha ?? null,
      author: String(entry?.commit?.author?.name ?? ""),
      date: String(entry?.commit?.author?.date ?? ""),
      subject,
      body: rest.join("\n").trim(),
    };
  });
}

export async function readPullCommitDiff(
  context: GlabContext,
  mr: MergeRequestInfo,
  sha: string,
  parent: string | null,
): Promise<ReviewDiff> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("invalid commit");
  const commit = (await ghApi(
    context,
    mr.host,
    "GET",
    `repos/${mr.project}/commits/${sha}`,
  )) as Record<string, any>;
  return {
    files: parseUnifiedDiff(filesDiff(commit?.files ?? [])),
    baseSha: parent ?? undefined,
    headSha: sha,
    truncated: false,
  };
}

export async function readPullRawFile(
  context: GlabContext,
  mr: MergeRequestInfo,
  path: string,
  sha: string,
): Promise<string> {
  const result = (await ghApi(
    context,
    mr.host,
    "GET",
    `repos/${mr.project}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
  )) as Record<string, unknown> | null;
  const content = result?.content;
  if (typeof content !== "string") throw new Error("GitHub returned no file");
  return Buffer.from(content, "base64").toString("utf8");
}

/**
 * The pull request's review comments, grouped in their threads (read
 * only); the user's pending review comes with them as drafts
 * (readPullDrafts), whichever app wrote them.
 */
export async function readPullThreads(
  context: GlabContext,
  mr: MergeRequestInfo,
  sessionId: string,
): Promise<ReviewThread[]> {
  const comments = (await ghApi(
    context,
    mr.host,
    "GET",
    `${pullPath(mr)}/comments?per_page=100`,
    { paginate: true },
  )) as Record<string, any>[];
  const threads = new Map<number, ReviewThread>();
  for (const comment of comments ?? []) {
    const id = Number(comment?.id);
    const root = Number(comment?.in_reply_to_id ?? id);
    const at = String(comment?.created_at ?? "");
    const entry = {
      id: `gh:${root}:${id}`,
      author: `@${comment?.user?.login ?? "someone"}`,
      body: String(comment?.body ?? ""),
      createdAt: at,
      updatedAt: String(comment?.updated_at ?? at),
    };
    const known = threads.get(root);
    if (known) {
      known.comments.push(entry);
      continue;
    }
    const line = Number(comment?.line ?? comment?.original_line) || undefined;
    const side = comment?.side === "LEFT" ? "old" : "new";
    threads.set(root, {
      id: `gh:${root}`,
      sessionId,
      kind: "merge-request",
      anchor: {
        path: String(comment?.path ?? ""),
        ...(line ? { line, side } : {}),
      },
      resolved: false,
      comments: [entry],
      createdAt: at,
      updatedAt: at,
      gitlab: {
        discussionId: String(root),
        headSha: comment?.commit_id ? String(comment.commit_id) : undefined,
      },
    });
  }
  // The pull request's conversation (issue) comments: general threads,
  // one per comment. GitHub has no draft reply to them: no discussion id.
  const conversation = (await ghApi(
    context,
    mr.host,
    "GET",
    `repos/${mr.project}/issues/${mr.iid}/comments?per_page=100`,
    { paginate: true },
  )) as Record<string, any>[];
  const general: ReviewThread[] = (conversation ?? []).map((comment) => {
    const at = String(comment?.created_at ?? "");
    return {
      id: `ghc:${comment?.id}`,
      sessionId,
      kind: "merge-request",
      anchor: {},
      resolved: false,
      comments: [
        {
          id: `ghc:${comment?.id}`,
          author: `@${comment?.user?.login ?? "someone"}`,
          body: String(comment?.body ?? ""),
          createdAt: at,
          updatedAt: String(comment?.updated_at ?? at),
        },
      ],
      createdAt: at,
      updatedAt: at,
      gitlab: {},
    };
  });
  return [...general, ...threads.values()];
}

/*
 * The user's pending GitHub review: its comments are drafts nobody else
 * sees until the user submits the review on GitHub. Roamgate only adds,
 * edits and deletes them (on the user's own action in the review pane)
 * and never submits the review. The pending review's body is the overall
 * comment, draft id 0.
 */

const PENDING_QUERY = `query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { pullRequest(number: $n) { id reviews(states: PENDING, first: 1) { nodes { id body } } reviewThreads(first: 100) { nodes { id diffSide comments(first: 100) { nodes { id fullDatabaseId body path line originalLine startLine replyTo { fullDatabaseId } pullRequestReview { id } } } } } } } }`;

/** A comment's fields; its side is its thread's. */
const COMMENT_FIELDS =
  "id fullDatabaseId body path line originalLine startLine replyTo { fullDatabaseId } pullRequestReview { id }";

type PendingComment = {
  id: string;
  fullDatabaseId: string;
  body: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  replyTo: { fullDatabaseId: string } | null;
  pullRequestReview?: { id: string } | null;
};

/** A comment as GitHub answers it, with its thread's side. */
function withSide(comment: any, diffSide: unknown): PendingComment {
  return { ...comment, diffSide: diffSide === "LEFT" ? "LEFT" : "RIGHT" };
}

type Pending = {
  pullId: string;
  /** Each thread's node id, by its first comment's id (our discussion id). */
  threads: Map<string, string>;
  review: { id: string; body: string; comments: PendingComment[] } | null;
};

async function graphql(
  context: GlabContext,
  host: string,
  query: string,
  variables: Record<string, string | number>,
  kind: string,
): Promise<any> {
  const answer = (await ghApi(context, host, "POST", "graphql", {
    kind,
    fields: [
      ["query", query, "raw"],
      ...Object.entries(variables).map(
        ([key, value]): [string, string, "raw" | "typed"] => [
          key,
          String(value),
          typeof value === "number" ? "typed" : "raw",
        ],
      ),
    ],
  })) as any;
  const error = answer?.errors?.[0]?.message;
  if (error) throw new Error(`GitHub: ${String(error).slice(0, 300)}`);
  return answer?.data;
}

async function readPending(
  context: GlabContext,
  mr: MergeRequestInfo,
): Promise<Pending> {
  const [owner, name] = mr.project.split("/");
  const data = await graphql(
    context,
    mr.host,
    PENDING_QUERY,
    { o: owner!, r: name!, n: mr.iid },
    "drafts",
  );
  const pull = data?.repository?.pullRequest;
  if (!pull?.id) throw new Error("GitHub: no such pull request");
  const review = pull.reviews?.nodes?.[0];
  // The pending review's comments, each with its thread's side (only the
  // viewer's pending review is ever listed).
  const comments: PendingComment[] = review
    ? (pull.reviewThreads?.nodes ?? []).flatMap((thread: any) =>
        (thread?.comments?.nodes ?? [])
          .filter(
            (comment: any) => comment?.pullRequestReview?.id === review.id,
          )
          .map((comment: any) => withSide(comment, thread.diffSide)),
      )
    : [];
  const threads = new Map<string, string>();
  for (const thread of pull.reviewThreads?.nodes ?? []) {
    const root = thread?.comments?.nodes?.[0]?.fullDatabaseId;
    if (thread?.id && root) threads.set(String(root), String(thread.id));
  }
  return {
    pullId: String(pull.id),
    threads,
    review: review
      ? { id: String(review.id), body: String(review.body ?? ""), comments }
      : null,
  };
}

/** A pending comment as GitLab would answer a draft note. */
function asDraft(comment: PendingComment): GitLabDraft {
  const line = comment.line ?? comment.originalLine;
  const old = comment.diffSide === "LEFT";
  return {
    id: Number(comment.fullDatabaseId),
    note: comment.body,
    discussion_id: comment.replyTo
      ? String(comment.replyTo.fullDatabaseId)
      : null,
    position: comment.path
      ? {
          old_path: comment.path,
          new_path: comment.path,
          old_line: old ? line : null,
          new_line: old ? null : line,
        }
      : null,
  };
}

/** The user's pending drafts on the pull request, the overall one first. */
export async function readPullDrafts(
  context: GlabContext,
  mr: MergeRequestInfo,
): Promise<GitLabDraft[]> {
  const { review } = await readPending(context, mr);
  if (!review) return [];
  return [
    ...(review.body.trim()
      ? [{ id: 0, note: review.body, position: null } as GitLabDraft]
      : []),
    ...review.comments.map(asDraft),
  ];
}

/** The pending review, made (without an event, so it stays pending). */
async function pendingReview(
  context: GlabContext,
  mr: MergeRequestInfo,
): Promise<{ id: string; comments: PendingComment[]; body: string }> {
  const pending = await readPending(context, mr);
  if (pending.review) return pending.review;
  const data = await graphql(
    context,
    mr.host,
    "mutation($p: ID!, $c: GitObjectID) { addPullRequestReview(input: {pullRequestId: $p, commitOID: $c}) { pullRequestReview { id state } } }",
    { p: pending.pullId, c: mr.headSha },
    "draft-review",
  );
  const review = data?.addPullRequestReview?.pullRequestReview;
  if (!review?.id || review.state !== "PENDING")
    throw new Error("GitHub did not start a pending review");
  return { id: String(review.id), comments: [], body: "" };
}

export async function createPullDraft(
  context: GlabContext,
  mr: MergeRequestInfo,
  anchor: ReviewAnchor,
  note: string,
): Promise<GitLabDraft> {
  const review = await pendingReview(context, mr);
  if (!anchor.path) {
    await setReviewBody(context, mr, review.id, note);
    return { id: 0, note, position: null };
  }
  if (anchor.commit)
    throw new Error(
      "GitHub takes review comments on the whole change: comment there, not on one commit",
    );
  const line = anchor.endLine ?? anchor.line;
  const side = anchor.side === "old" ? "LEFT" : "RIGHT";
  const fields =
    line === undefined
      ? `subjectType: FILE`
      : `line: ${line}, side: ${side}${anchor.endLine !== undefined && anchor.line !== undefined && anchor.line < anchor.endLine ? `, startLine: ${anchor.line}, startSide: ${side}` : ""}`;
  const data = await graphql(
    context,
    mr.host,
    `mutation($r: ID!, $path: String!, $body: String!) { addPullRequestReviewThread(input: {pullRequestReviewId: $r, path: $path, body: $body, ${fields}}) { thread { diffSide comments(first: 1) { nodes { ${COMMENT_FIELDS} } } } } }`,
    { r: review.id, path: anchor.path, body: note },
    "draft",
  );
  const thread = data?.addPullRequestReviewThread?.thread;
  const comment = thread?.comments?.nodes?.[0];
  if (!comment) throw new Error("GitHub did not add the draft comment");
  return asDraft(withSide(comment, thread.diffSide));
}

async function setReviewBody(
  context: GlabContext,
  mr: MergeRequestInfo,
  reviewId: string,
  body: string,
) {
  await graphql(
    context,
    mr.host,
    "mutation($r: ID!, $b: String!) { updatePullRequestReview(input: {pullRequestReviewId: $r, body: $b}) { pullRequestReview { id } } }",
    { r: reviewId, b: body },
    "draft",
  );
}

/** The pending comment with that id, from the user's pending review. */
async function pendingComment(
  context: GlabContext,
  mr: MergeRequestInfo,
  id: number,
) {
  const { review } = await readPending(context, mr);
  const comment = review?.comments.find(
    (each) => Number(each.fullDatabaseId) === id,
  );
  if (!review || (id !== 0 && !comment))
    throw new Error("that draft is no longer in your pending GitHub review");
  return { review, comment };
}

export async function updatePullDraft(
  context: GlabContext,
  mr: MergeRequestInfo,
  id: number,
  note: string,
): Promise<GitLabDraft> {
  const { review, comment } = await pendingComment(context, mr, id);
  if (id === 0) {
    await setReviewBody(context, mr, review.id, note);
    return { id: 0, note, position: null };
  }
  const data = await graphql(
    context,
    mr.host,
    `mutation($c: ID!, $b: String!) { updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $c, body: $b}) { pullRequestReviewComment { ${COMMENT_FIELDS} } } }`,
    { c: comment!.id, b: note },
    "draft",
  );
  const updated =
    data?.updatePullRequestReviewComment?.pullRequestReviewComment;
  if (!updated) throw new Error("GitHub did not update the draft");
  return asDraft(withSide(updated, comment!.diffSide));
}

export async function deletePullDraft(
  context: GlabContext,
  mr: MergeRequestInfo,
  id: number,
): Promise<void> {
  const { review, comment } = await pendingComment(context, mr, id);
  if (id === 0) {
    await setReviewBody(context, mr, review.id, "");
    return;
  }
  await graphql(
    context,
    mr.host,
    "mutation($c: ID!) { deletePullRequestReviewComment(input: {id: $c}) { pullRequestReview { id } } }",
    { c: comment!.id },
    "draft",
  );
}

/**
 * A draft reply in a discussion: a reply comment of the user's pending
 * review, published only when they submit it on GitHub.
 */
export async function createPullDraftReply(
  context: GlabContext,
  mr: MergeRequestInfo,
  discussionId: string,
  note: string,
): Promise<GitLabDraft> {
  const pending = await readPending(context, mr);
  const threadId = pending.threads.get(discussionId);
  if (!threadId)
    throw new Error("GitHub: no such discussion on the pull request");
  const review = pending.review ?? (await pendingReview(context, mr));
  const data = await graphql(
    context,
    mr.host,
    `mutation($r: ID!, $t: ID!, $b: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewId: $r, pullRequestReviewThreadId: $t, body: $b}) { comment { ${COMMENT_FIELDS} } } }`,
    { r: review.id, t: threadId, b: note },
    "draft",
  );
  const comment = data?.addPullRequestReviewThreadReply?.comment;
  if (!comment) throw new Error("GitHub did not add the draft reply");
  if (comment.pullRequestReview?.id !== review.id)
    throw new Error("GitHub did not keep the reply in your pending review");
  return {
    ...asDraft(withSide(comment, "RIGHT")),
    discussion_id: discussionId,
  };
}
