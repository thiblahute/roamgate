import { REVIEW_USER } from "../../../shared/review";
import type { ReviewRepo } from "../workspace/review-patch";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { saveReviewImage } from "./images";
import { ReviewError, type ReviewService } from "./service";
import { reviewDirectory } from "./storage";

export type ReviewRpcConnection = {
  id: string;
  resolveRoot: (workspaceId: string) => Promise<string>;
  readDefaultBase?: (root: string) => Promise<string>;
  /** The repository of a directory. */
  readRoot?: (path: string) => Promise<string>;
  scanRepos?: (paths: string[], agentPaths: string[]) => Promise<ReviewRepo[]>;
};

const SESSION_METHODS = new Set([
  "review.get",
  "review.update",
  "review.remove",
  "review.diff",
  "review.state",
  "review.commits",
  "review.file",
  "review.thread.add",
  "review.reply",
  "review.edit",
  "review.delete",
  "review.resolve",
  "review.restore",
  "review.handoff",
  "review.gitlab.refresh",
  "review.gitlab.find",
  "review.gitlab.open",
  "review.gitlab.push",
  "review.agent.review",
  "review.image.add",
]);

export function isReviewMethod(method: string): boolean {
  return method.startsWith("review.");
}

/**
 * Browser calls for one connection. The browser always writes as the user;
 * agents come through their own socket and sign with their name.
 */
export async function handleReviewRpc(
  service: ReviewService,
  connection: ReviewRpcConnection,
  method: string,
  raw: Record<string, unknown>,
): Promise<unknown> {
  const params: Record<string, unknown> = { ...raw, author: REVIEW_USER };
  const sessionId = raw.session_id ?? raw.sessionId;
  if (SESSION_METHODS.has(method)) {
    const { session } = service.get({ sessionId });
    if (session.connectionId !== connection.id)
      throw new ReviewError("no such review", 404);
    params.sessionId = session.id;
  }
  const commentId = raw.comment_id ?? raw.commentId;
  if (commentId !== undefined) params.commentId = commentId;

  switch (method) {
    case "review.list":
      return { sessions: service.list({ connectionId: connection.id }) };
    case "review.activity":
      return service.activity({ connectionId: connection.id });
    case "review.import":
      return service.importSession({
        connectionId: connection.id,
        snapshot: raw.snapshot,
      });
    case "review.open": {
      const workspaceId = raw.workspace_id;
      if (typeof workspaceId !== "string" || !workspaceId)
        throw new ReviewError("workspace_id is required");
      // A directory picks one of the workspace's repositories; else the
      // workspace's own.
      const path = typeof raw.path === "string" ? raw.path : "";
      const root =
        path.startsWith("/") && connection.readRoot
          ? await connection.readRoot(path)
          : await connection.resolveRoot(workspaceId);
      // Without a target the branch is reviewed against the default branch.
      // Without a default branch (nothing committed yet), the uncommitted
      // work is what there is to review.
      const defaultBase = connection.readDefaultBase
        ? await connection.readDefaultBase(root).catch(() => null)
        : undefined;
      const target =
        raw.target ??
        (defaultBase === null
          ? { kind: "worktree" }
          : defaultBase
            ? { kind: "range", base: defaultBase, head: "HEAD" }
            : undefined);
      return service.open({
        connectionId: connection.id,
        workspaceId,
        root,
        target,
        title: raw.title,
        // The workspace's agent, so comments can go to it from the start.
        agent: raw.agent,
        paneId: raw.agent_pane,
        raise: false,
      });
    }
    case "review.repos": {
      // The repositories under the given directories (the workspace's
      // panes), their neighbors and subprojects, that have changes.
      const strings = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((p): p is string => typeof p === "string")
          : [];
      const paths = strings(raw.paths);
      return {
        repos: connection.scanRepos
          ? await connection.scanRepos(paths, strings(raw.agent_paths))
          : [],
      };
    }
    case "review.get":
      return service.get(params);
    case "review.update":
      return service.update({ ...params, paneId: raw.agent_pane });
    case "review.remove": {
      const removed = service.remove(params);
      rmSync(join(reviewDirectory(), "images", String(params.sessionId)), {
        recursive: true,
        force: true,
      });
      return removed;
    }
    case "review.image.add": {
      // A pasted image: its path goes in the comment's Markdown, where
      // agents read it and the overlay shows it.
      const data = typeof raw.data === "string" ? raw.data : "";
      return {
        path: saveReviewImage(
          reviewDirectory(),
          String(params.sessionId),
          String(raw.type ?? ""),
          Buffer.from(data, "base64"),
        ),
      };
    }
    case "review.diff":
      return service.diff(params);
    case "review.state":
      return service.state(params);
    case "review.commits":
      return service.commits(params);
    case "review.file":
      return service.file(params);
    case "review.thread.add":
      return service.addThread(params);
    case "review.reply":
      return service.reply(params);
    case "review.edit":
      return service.edit(params);
    case "review.delete":
      return service.deleteComment(params);
    case "review.resolve":
      return service.resolve(params);
    case "review.restore":
      return service.restoreThread(params);
    case "review.handoff":
      return service.handoff(params);
    case "review.gitlab.refresh":
      return service.refreshGitlab(params);
    case "review.gitlab.find":
      // Reads only: the branch's merge request, to offer its review.
      return service.findGitlab(params);
    case "review.gitlab.open":
      // The review of the branch's merge request, opened or raised.
      return service.openGitlab(params);
    case "review.gitlab.push":
      return service.pushLocalDrafts(params);
    case "review.agent.review":
      return service.requestAgentReview({
        ...params,
        paneId: raw.pane_id,
        agent: raw.agent,
        author: undefined,
      });
    default:
      throw new ReviewError(`unknown review method: ${method}`, 404);
  }
}
