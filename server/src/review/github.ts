import type {
  ReviewCommit,
  ReviewDiff,
  ReviewThread,
} from "../../../shared/review";
import { forgeGate } from "../workspace/forge-calls";
import { spawnGh } from "./forge";
import type { GlabContext, MergeRequestInfo, MergeRequestRef } from "./gitlab";
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
  const read = method === "GET" || path === "graphql";
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
    (full) => spawnGh(context, full),
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
 * The pull request's review comments, grouped in their threads, read only.
 * (The user's pending review drafts come with step d.)
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
  return [...threads.values()];
}
