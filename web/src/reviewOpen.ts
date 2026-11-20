import type { ReviewHead, ReviewSnapshot } from "../../shared/review";
import { reviewAgentPanes } from "./annotations";
import {
  clearReviewOpenRequest,
  type ReviewOpenRequest,
  rememberReviewSnapshot,
  reviewCall,
} from "./review";
import { readReviewMemory, withLatest, writeReviewMemory } from "./reviewPins";
import { store } from "./store";
import { paneDir } from "./changesRepo";
import { insideRoot } from "./filesystemPaths";
import type { WorkspaceRepo } from "./reviewModel";

/** A repository review.repos found: the pane's own (seed), the agent's. */
type ScannedRepo = WorkspaceRepo & {
  seed: boolean;
  touched?: boolean;
  active: number;
};

/** The review last shown in each workspace: Option+R goes back to it. */
const LAST_KEY = "roamgate.review.last";

/**
 * Option+R, or a repository picked in the review: the workspace's review of
 * that repository, or a new one, with the workspace's agent attached: your
 * comments are typed into its pane as you write them. Without a repository it is the one of
 * the focused pane, else of the agent's pane, else the latest review.
 * Returns the review to show, or null after saying why there is none.
 */
export async function openWorkspaceReview(
  sessions: ReadonlyMap<string, ReviewHead>,
  options: {
    root?: string;
    /** Review its uncommitted work: it has no commits of its own. */
    worktree?: boolean;
    /**
     * From a merge request's review: the checkout's review of its branch,
     * the first of these (latest first) shown in this workspace, else a
     * new one (the checkout is on that branch); never another review.
     */
    local?: string[];
  } = {},
): Promise<string | null> {
  const current = store.get();
  const connectionId = current.activeConnectionId;
  const workspace = current.workspaces.find((w) => w.focused);
  if (!connectionId || !workspace) {
    store.notify({
      kind: "error",
      message: "Cannot open a review",
      detail: connectionId
        ? "No workspace is focused."
        : "Roamgate is not connected to Herdr.",
    });
    return null;
  }

  const reviews = [...sessions.values()]
    .filter(
      (snapshot) =>
        snapshot.session.connectionId === connectionId &&
        snapshot.session.workspaceId === workspace.workspace_id &&
        // A chat's threads, or an effort's, are not a review of the
        // workspace's code.
        snapshot.session.target.kind !== "chat" &&
        snapshot.session.target.kind !== "effort" &&
        snapshot.session.target.kind !== "work" &&
        // Nor is a file or a site shown rendered.
        snapshot.session.target.kind !== "rendered" &&
        !(options.local && snapshot.session.target.kind === "mr"),
    )
    .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
  const workspaceKey = `${connectionId}\n${workspace.workspace_id}`;
  // Option+R shows the repository you last reviewed here, if still there.
  const last = options.root
    ? undefined
    : reviews.find(
        (snapshot) =>
          snapshot.session.id === readReviewMemory(LAST_KEY)[workspaceKey],
      );
  const agentPane = reviewAgentPanes(current.panes, workspace.workspace_id)[0];
  const focusedPane = current.panes.find(
    (pane) => pane.workspace_id === workspace.workspace_id && pane.focused,
  );
  // Where to look: the repository asked for, else the focused pane's, else
  // the agent's.
  let dirs = options.root
    ? [options.root]
    : [paneDir(focusedPane), paneDir(agentPane)].filter(Boolean);
  let worktree = options.worktree;
  // The pane's repository has nothing to review but the agent works in
  // another one: that one, by its session's record.
  if (!options.root && !last && agentPane) {
    const scan = await reviewCall<{ repos: ScannedRepo[] }>(
      connectionId,
      "review.repos",
      { paths: dirs, agent_paths: [agentPane.cwd ?? paneDir(agentPane)] },
    ).catch(() => ({ repos: [] }));
    const changed = (repo: ScannedRepo) => !!repo.ahead || !!repo.dirty;
    const own = scan.repos.find((repo) => repo.seed);
    const touched = scan.repos
      .filter((repo) => repo.touched)
      .sort(
        (a, b) =>
          Number(changed(b)) - Number(changed(a)) || b.active - a.active,
      )[0];
    if (touched && (!own || !changed(own))) {
      dirs = [touched.root];
      worktree = !touched.ahead && touched.dirty;
    }
  }
  // A repository picked by its root is that one, not a repository around
  // it (a subproject inside a checkout); a pane's directory is in the
  // closest repository with a review.
  const reviewIn = (dir: string) =>
    reviews
      .filter((snapshot) =>
        options.root
          ? snapshot.session.root === dir
          : insideRoot(dir, snapshot.session.root),
      )
      .sort((a, b) => b.session.root.length - a.session.root.length)[0];
  const agentName = agentPane?.agent ?? "agent";
  const agentLabel = agentName.charAt(0).toUpperCase() + agentName.slice(1);
  // Attach the workspace's agent when the review has none.
  const attachAgent = async (snapshot: ReviewHead) => {
    if (!agentPane || snapshot.session.agent.paneId) return;
    try {
      rememberReviewSnapshot(
        await reviewCall<ReviewSnapshot>(connectionId, "review.update", {
          session_id: snapshot.session.id,
          agent: agentLabel,
          agent_pane: agentPane.pane_id,
        }),
      );
    } catch {}
  };
  const show = (snapshot: ReviewHead) => {
    void attachAgent(snapshot);
    writeReviewMemory(
      LAST_KEY,
      withLatest(readReviewMemory(LAST_KEY), workspaceKey, snapshot.session.id),
    );
    return snapshot.session.id;
  };
  const open = (path?: string) =>
    reviewCall<ReviewSnapshot>(connectionId, "review.open", {
      workspace_id: workspace.workspace_id,
      ...(path ? { path } : {}),
      ...(worktree ? { target: { kind: "worktree" } } : {}),
      // The workspace's agent gets the comments from the start.
      ...(agentPane
        ? { agent_pane: agentPane.pane_id, agent: agentLabel }
        : {}),
    });

  try {
    if (options.local) {
      // Another local review of the repository is another branch's.
      const mine = options.local
        .map((id) => reviews.find((snapshot) => snapshot.session.id === id))
        .find(Boolean);
      if (mine) return show(mine);
      const opened = await open(options.root);
      rememberReviewSnapshot(opened);
      return show(opened);
    }
    if (last) return show(last);
    // A directory outside any repository falls back to the next one, then
    // to the latest review, then to the workspace's own repository.
    for (const dir of dirs) {
      const existing = reviewIn(dir);
      if (existing) return show(existing);
      try {
        const opened = await open(dir);
        rememberReviewSnapshot(opened);
        return show(opened);
      } catch (error) {
        if (options.root) throw error;
      }
    }
    if (reviews[0]) return show(reviews[0]);
    const opened = await open();
    rememberReviewSnapshot(opened);
    return show(opened);
  } catch (error) {
    store.notify({
      kind: "error",
      message: "Cannot open a review here",
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Commits' Review this commit: a review of that one commit (`SHA^..SHA`) in
 * the workspace (the focused one by default), the workspace's agent
 * attached; a review of it already there is shown again. Returns the
 * review, or null after saying why there is none.
 */
export async function openCommitReview(
  sha: string,
  options: { workspaceId?: string | undefined; path?: string } = {},
): Promise<string | null> {
  const current = store.get();
  const connectionId = current.activeConnectionId;
  const workspaceId =
    options.workspaceId ??
    current.workspaces.find((w) => w.focused)?.workspace_id;
  if (!connectionId || !workspaceId) {
    store.notify({
      kind: "error",
      message: "Cannot review this commit",
      detail: connectionId
        ? "No workspace is focused."
        : "Roamgate is not connected to Herdr.",
    });
    return null;
  }
  const agentPane = reviewAgentPanes(current.panes, workspaceId)[0];
  const agentName = agentPane?.agent ?? "agent";
  try {
    const snapshot = await reviewCall<ReviewSnapshot>(
      connectionId,
      "review.open",
      {
        workspace_id: workspaceId,
        ...(options.path ? { path: options.path } : {}),
        target: { kind: "range", base: `${sha}^`, head: sha },
        ...(agentPane
          ? {
              agent_pane: agentPane.pane_id,
              agent: agentName.charAt(0).toUpperCase() + agentName.slice(1),
            }
          : {}),
      },
    );
    rememberReviewSnapshot(snapshot);
    return snapshot.session.id;
  } catch (error) {
    store.notify({
      kind: "error",
      message: "Cannot review this commit",
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * An agent raised a review: shown when this tab is on its connection (the
 * review to pin is returned); otherwise it opens once the user switches.
 */
export function takeOpenRequest(
  request: ReviewOpenRequest,
  activeConnectionId: string | null,
): string | null {
  if (request.connectionId !== activeConnectionId) {
    store.notify({
      kind: "info",
      message: "An agent opened a review on another connection",
      detail: request.message,
      autoDismissMs: 8000,
    });
    return null;
  }
  clearReviewOpenRequest();
  if (request.message)
    store.notify({
      kind: "info",
      message: request.message,
      autoDismissMs: 6000,
    });
  return request.sessionId;
}
