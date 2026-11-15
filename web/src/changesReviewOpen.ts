import type { ReviewSnapshot } from "../../shared/review";
import type { Pane } from "./types";
import { workspaceRepos, scanRepos } from "./reviewRepos";

/*
 * The review toggle on "in Changes" (plan: review into the inspector, D6):
 * it shows what the classic toggle would (the pinned review, else the one
 * `openWorkspaceReview` picks: the repository with work, its branch review
 * against the base, or its uncommitted work), in Changes' matching scope.
 * What Changes cannot show yet goes to the classic pane: a review of
 * another repository than the inspector's checkout, a merge request, and
 * a workspace with several repositories (the classic pane's series, until
 * Changes can switch repositories).
 */

export type ChangesReviewChoice =
  | { kind: "changes"; sessionId: string; scope: "working" | "branch-main" }
  | { kind: "classic"; sessionId: string; reason: string };

function sameRoot(a: string, b: string): boolean {
  const trim = (path: string) => path.replace(/\/+$/, "");
  return trim(a) === trim(b);
}

/** Where a picked review shows: Changes' scope, or the classic pane. */
export async function changesReviewChoice({
  snapshot,
  checkoutRoot,
  connectionId,
  panes,
  sessions,
  changed,
}: {
  snapshot: ReviewSnapshot;
  /** The inspector's checkout, null when it is the workspace's own. */
  checkoutRoot: string | null;
  connectionId: string;
  /** The workspace's panes: their directories hold its repositories. */
  panes: readonly Pane[];
  /** Every review known: the workspace's others name repositories too. */
  sessions: Iterable<ReviewSnapshot>;
  /** Whether a Changes scope holds anything (null: not known). */
  changed: (mode: "working" | "branch-main") => Promise<boolean | null>;
}): Promise<ChangesReviewChoice> {
  const { session } = snapshot;
  const classic = (reason: string): ChangesReviewChoice => ({
    kind: "classic",
    sessionId: session.id,
    reason,
  });
  if (session.target.kind !== "range" && session.target.kind !== "worktree")
    return classic("This review shows in the review pane.");
  const dirOf = (pane: Pane) => pane.foreground_cwd ?? pane.cwd ?? "";
  // A workspace without a known checkout shows its focused pane's
  // repository in Changes.
  const inside = (dir: string) =>
    sameRoot(dir, session.root) ||
    dir.startsWith(`${session.root.replace(/\/+$/, "")}/`);
  const focused = panes.find((pane) => pane.focused) ?? panes[0];
  const here = checkoutRoot
    ? sameRoot(session.root, checkoutRoot)
    : !!focused && inside(dirOf(focused));
  if (!here)
    return classic(
      "This review is of another repository: it shows in the review pane.",
    );
  const dirs = panes.map(dirOf).filter((dir) => dir.startsWith("/"));
  const agentDirs = panes
    .filter((pane) => pane.agent)
    .map((pane) => pane.cwd ?? dirOf(pane))
    .filter((dir) => dir.startsWith("/"));
  const scanned = await scanRepos(
    connectionId,
    [session.root, ...new Set(dirs)],
    [...new Set(agentDirs)],
  );
  if (workspaceRepos(scanned, sessions, session).length > 1)
    return classic(
      "Several repositories here: the review pane switches between them (p, ( and )).",
    );
  if (session.target.kind === "worktree")
    return { kind: "changes", sessionId: session.id, scope: "working" };
  // Nothing beyond the base (the default branch itself, say): the
  // uncommitted work, else the review pane, which lists the commits.
  if ((await changed("branch-main")) !== false)
    return { kind: "changes", sessionId: session.id, scope: "branch-main" };
  if ((await changed("working")) !== false)
    return { kind: "changes", sessionId: session.id, scope: "working" };
  return classic(
    "Nothing beyond the default branch: the review pane lists its commits.",
  );
}
