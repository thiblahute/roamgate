import {
  parseStorageWrite,
  type RenderedMode,
  type RenderedStorageWrite,
} from "../../../shared/renderedPage";
import { REVIEW_USER, type ReviewTarget } from "../../../shared/review";
import { isHostPath, type ReviewRepo } from "../workspace/review-patch";
import { RENDERED_SVG_MAX_BYTES } from "../http/rendered-pages";
import { saveReviewImage } from "./images";
import { renderedFileTarget } from "./rendered-target";
import { parseReviewTarget, ReviewError, type ReviewService } from "./service";
import { reviewDirectory } from "./storage";

export type ReviewRpcConnection = {
  id: string;
  resolveRoot: (workspaceId: string) => Promise<string>;
  readDefaultBase?: (root: string) => Promise<string>;
  /** The repository of a directory. */
  readRoot?: (path: string) => Promise<string>;
  scanRepos?: (paths: string[], agentPaths: string[]) => Promise<ReviewRepo[]>;
  /**
   * Where the browser frames a rendered review's page (an HTML file, or a
   * site): `page` is a path under the first one served, to go back where
   * the user was.
   */
  renderedPage?: (
    place: { root: string; target: ReviewTarget },
    page?: string,
    scripts?: boolean,
  ) => Promise<RenderedPageAddress>;
  /** One SVG as a static page in the sandbox: paused and cropped there. */
  renderedSvg?: (
    svg: string,
    color?: string,
    scripts?: boolean,
  ) => RenderedPageAddress;
  /**
   * A write of a listed site's page to its `localStorage`, under the
   * token of the page's frame: false when the token is not a listed
   * site's. Throws a quota error over the bounds.
   */
  renderedStorage?: (token: string, write: RenderedStorageWrite) => boolean;
  /** Forgets what a listed site's pages stored. */
  clearRenderedStorage?: (site: string) => void;
};

/** A page to frame: its `/rendered/<token>/...` path and mode. */
export type RenderedPageAddress = {
  src: string;
  mode: RenderedMode;
  /** The listed site or directory that lowered the restrictions. */
  site?: string;
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
  "review.thread.move",
  "review.thread.release",
  "review.reply",
  "review.edit",
  "review.delete",
  "review.resolve",
  "review.restore",
  "review.handoff",
  "review.retry",
  "review.gitlab.refresh",
  "review.gitlab.find",
  "review.gitlab.open",
  "review.gitlab.push",
  "review.adopt",
  "review.agent.review",
  "review.image.add",
]);

/** Reads a scope's diff without a review (`target` instead of a session). */
const PREVIEW_METHODS = new Set([
  "review.diff",
  "review.commits",
  "review.state",
  "review.file",
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
  // A scope Changes shows with no review yet (showing a scope never makes
  // a session): its commits and diffs, read only.
  if (
    PREVIEW_METHODS.has(method) &&
    sessionId === undefined &&
    raw.target !== undefined
  ) {
    const workspaceId = raw.workspace_id;
    if (typeof workspaceId !== "string" || !workspaceId)
      throw new ReviewError("workspace_id is required");
    // The checkout's directory (`path` is a file's, for review.file).
    const checkout = typeof raw.checkout === "string" ? raw.checkout : "";
    const root =
      isHostPath(checkout) && connection.readRoot
        ? await connection.readRoot(checkout)
        : await connection.resolveRoot(workspaceId);
    const preview = { ...params, connectionId: connection.id, root };
    if (method === "review.commits") return service.previewCommits(preview);
    if (method === "review.diff") return service.previewDiff(preview);
    if (method === "review.file") return service.previewFile(preview);
    return service.previewState(preview);
  }
  if (SESSION_METHODS.has(method)) {
    const { session } = service.get({ sessionId });
    if (session.connectionId !== connection.id)
      throw new ReviewError("no such review", 404);
    params.sessionId = session.id;
  }
  const commentId = raw.comment_id ?? raw.commentId;
  if (commentId !== undefined) params.commentId = commentId;
  // Ids the browser made, so a write sent twice is made once.
  if (raw.new_comment_id !== undefined)
    params.newCommentId = raw.new_comment_id;
  if (raw.new_thread_id !== undefined) params.newThreadId = raw.new_thread_id;

  switch (method) {
    case "review.list":
      // The page shows a chat's threads in the chat, from these too: without
      // them a reload would lose them until the next change.
      return {
        sessions: service.list({ connectionId: connection.id, chats: true }),
      };
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
      if (path && !isHostPath(path))
        throw new ReviewError(
          `the review's path must be absolute, not "${path.slice(0, 200)}"`,
        );
      // With its title and the workspace's agent, so comments can go to
      // it from the start.
      const open = (
        root: string,
        target: unknown,
        more: { automatic?: boolean } = {},
      ) =>
        service.open({
          connectionId: connection.id,
          workspaceId,
          root,
          target,
          ...more,
          title: raw.title,
          agent: raw.agent,
          paneId: raw.agent_pane,
          raise: false,
        });
      const asked = raw.target as { kind?: unknown; url?: unknown } | undefined;
      // A chat has no repository: its agent's directory names it.
      if (asked?.kind === "chat") return open(path || "/", raw.target);
      // A site has no checkout.
      if (asked?.kind === "rendered" && asked.url !== undefined)
        return open("/", asked);
      // A file to discuss, rendered: its checkout and path in it.
      if (
        asked?.kind === "rendered" &&
        typeof raw.file === "string" &&
        connection.readRoot
      ) {
        const { readRoot } = connection;
        const { root, target } = await renderedFileTarget(
          (directory) => readRoot(directory),
          raw.file,
        );
        return open(root, target);
      }
      const root =
        isHostPath(path) && connection.readRoot
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
      return open(root, target, { automatic: !raw.target && !!defaultBase });
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
    case "review.remove":
      // Its pasted images stay until the bridge next starts, so the list's
      // undo brings the review back whole (pruneReviewImages).
      return service.remove(params);
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
    case "review.rendered.storage": {
      const write = parseStorageWrite(raw.write);
      if (
        !connection.renderedStorage ||
        typeof raw.token !== "string" ||
        !write
      )
        throw new ReviewError("invalid storage write");
      try {
        return { stored: connection.renderedStorage(raw.token, write) };
      } catch (error) {
        if (error instanceof Error && error.name === "QuotaExceededError")
          throw new ReviewError("the site's storage is full", 413);
        throw error;
      }
    }
    case "review.rendered.storage.clear": {
      if (!connection.clearRenderedStorage || typeof raw.site !== "string")
        throw new ReviewError("invalid site");
      connection.clearRenderedStorage(raw.site);
      return { cleared: true };
    }
    case "review.rendered.page": {
      // A page shown in the Files preview, which may have no review yet.
      if (!connection.renderedPage)
        throw new ReviewError("pages cannot be shown here", 503);
      const page = raw.page;
      if (
        page !== undefined &&
        (typeof page !== "string" || page.length > 2048)
      )
        throw new ReviewError("invalid page");
      if (typeof raw.svg === "string") {
        if (!connection.renderedSvg)
          throw new ReviewError("pages cannot be shown here", 503);
        if (Buffer.byteLength(raw.svg) > RENDERED_SVG_MAX_BYTES)
          throw new ReviewError("that SVG is too large to draw here");
        return connection.renderedSvg(
          raw.svg,
          typeof raw.color === "string" ? raw.color : undefined,
          // Only the browser calls this: asked for by the user, never an agent.
          raw.scripts === true,
        );
      }
      let place: { root: string; target: ReviewTarget };
      if (sessionId !== undefined) {
        const { session } = service.get({ sessionId });
        if (session.connectionId !== connection.id)
          throw new ReviewError("no such review", 404);
        place = { root: session.root, target: session.target };
      } else if (typeof raw.file === "string" && connection.readRoot) {
        const { readRoot } = connection;
        place = await renderedFileTarget(
          (directory) => readRoot(directory),
          raw.file,
        );
      } else place = { root: "/", target: parseReviewTarget(raw.target) };
      if (place.target.kind !== "rendered")
        throw new ReviewError("not a rendered review");
      return connection.renderedPage(
        place,
        page || undefined,
        raw.scripts === true,
      );
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
    case "review.thread.move":
      return service.moveHeld(params);
    case "review.thread.release":
      return service.releaseHeld(params);
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
    case "review.retry":
      return service.retry(params);
    case "review.prompts":
      // The connection's agents waiting on a permission answer.
      return { prompts: service.prompts.list(connection.id) };
    case "review.prompt.answer": {
      // "In the terminal": the hook gives up, Claude Code asks there.
      if (raw.release === true)
        return {
          answered: service.prompts.release({
            connectionId: connection.id,
            id: String(raw.id ?? ""),
          }),
        };
      const answer = raw.answer;
      // Questions are answered with each question's chosen option(s).
      const answers = raw.answers;
      if (answers && typeof answers === "object" && !Array.isArray(answers)) {
        const clean: Record<string, string> = {};
        for (const [question, value] of Object.entries(answers))
          if (typeof value === "string") clean[question] = value.slice(0, 4000);
        return {
          answered: service.prompts.answer({
            connectionId: connection.id,
            id: String(raw.id ?? ""),
            answer: { answers: clean },
          }),
        };
      }
      if (
        answer !== "allow" &&
        answer !== "always" &&
        answer !== "deny" &&
        answer !== "dismiss"
      )
        throw new ReviewError("answer must be allow, always, deny or dismiss");
      return {
        answered: service.prompts.answer({
          connectionId: connection.id,
          id: String(raw.id ?? ""),
          answer,
        }),
      };
    }
    case "review.gitlab.refresh":
      return service.refreshGitlab(params);
    case "review.gitlab.find":
      // Reads only: the branch's merge request, to offer its review.
      return service.findGitlab(params);
    case "review.gitlab.open":
      // The review of the branch's merge request, opened or raised; `url`:
      // the one the user picked (Changes' card's remote).
      return service.openGitlab({
        ...params,
        ...(raw.url !== undefined ? { url: raw.url } : {}),
      });
    case "review.gitlab.push":
      return service.pushLocalDrafts(params);
    case "review.adopt":
      // The user's click: an agent's thread becomes their forge draft.
      return service.adoptThread({
        ...params,
        threadId: raw.thread_id,
        text: raw.text,
      });
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
