import type { ReviewSnapshot } from "../../../shared/review";
import { reviewAgentPanes } from "../annotations";
import { useReviewState } from "../review";
import { openWorkspaceReview, rememberWorkspaceReview } from "../reviewOpen";
import type { Pane } from "../types";
import { ReviewOverlay } from "./ReviewOverlay";

/**
 * The reviews pinned to the connection's workspaces. Each stays mounted, so
 * it keeps its place, and only the focused workspace's one shows.
 */
export function ReviewHost({
  connectionId,
  pinned,
  shownId,
  panes,
  onClose,
  onShow,
  onShowList,
  onFocusAgentPane,
  onOpenFile,
}: {
  connectionId: string;
  pinned: ReviewSnapshot[];
  shownId: string | null;
  panes: Pane[];
  onClose: () => void;
  /** Shows another review (of another repository of the workspace). */
  onShow: (sessionId: string) => void;
  onShowList: () => void;
  onFocusAgentPane: (paneId: string) => void;
  /** Opens a file of the workspace's host (absolute path) at a line. */
  onOpenFile: (workspaceId: string, path: string, line?: number) => void;
}) {
  const { sessions } = useReviewState();
  const openRepo = (root: string, worktree?: boolean) =>
    void openWorkspaceReview(sessions, { root, worktree }).then((id) => {
      if (id) onShow(id);
    });
  // From a merge request's review: the checkout's own review of its branch.
  const openLocal = (root: string, reviews: string[]) =>
    void openWorkspaceReview(sessions, { root, local: reviews }).then((id) => {
      if (id) onShow(id);
    });
  // From a local review: the review of its branch's merge request.
  const showReview = (snapshot: ReviewSnapshot) => {
    rememberWorkspaceReview(snapshot);
    onShow(snapshot.session.id);
  };
  return pinned.map((snapshot) => {
    const workspaceId = snapshot.session.workspaceId ?? "";
    const here = panes.filter((pane) => pane.workspace_id === workspaceId);
    const dirOf = (pane: Pane) => pane.foreground_cwd ?? pane.cwd ?? "";
    const dirs = here.map(dirOf).filter((dir) => dir.startsWith("/"));
    // Agents' directories: their session records name the repositories
    // they work in from there.
    const agentDirs = here
      .filter((pane) => pane.agent)
      .map((pane) => pane.cwd ?? dirOf(pane))
      .filter((dir) => dir.startsWith("/"));
    return (
      <ReviewOverlay
        key={snapshot.session.id}
        snapshot={snapshot}
        hidden={snapshot.session.id !== shownId}
        connectionId={connectionId}
        onClose={onClose}
        repoDirs={[...new Set(dirs)]}
        agentDirs={[...new Set(agentDirs)]}
        onOpenRepo={openRepo}
        onOpenLocal={openLocal}
        onShowReview={showReview}
        agentPanes={reviewAgentPanes(
          panes,
          workspaceId,
          snapshot.session.agent.paneId,
        ).map((pane) => ({
          paneId: pane.pane_id,
          agent: pane.agent ?? "agent",
        }))}
        onShowList={onShowList}
        onFocusAgentPane={onFocusAgentPane}
        onOpenFile={
          workspaceId
            ? (path, line) => onOpenFile(workspaceId, path, line)
            : undefined
        }
      />
    );
  });
}
