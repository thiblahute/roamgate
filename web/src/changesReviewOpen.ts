import type { ReviewSnapshot } from "../../shared/review";
import type { Pane } from "./types";
import { workspaceRepoDirs } from "./changesRepo";
import { workspaceRepos, scanRepos } from "./reviewRepos";

/*
 * The review toggle on "in Changes" (plan: review into the inspector, D6):
 * it shows what the classic toggle would (the pinned review, else the one
 * `openWorkspaceReview` picks: the repository with work, its branch review
 * against the base, or its uncommitted work), in Changes' matching scope.
 * A workspace with several repositories (the classic pane's series) shows
 * the one Changes showed last, else the review's, picked in Changes' scope
 * line. A range or compare opened by name, a step's review, and a branch
 * with nothing beyond its base (its history) show as a review scope (plan
 * phase 6). What Changes cannot show yet goes to the classic pane: a merge
 * request (phase 7), and a review of a repository the workspace does not
 * hold.
 */

export type ChangesReviewChoice =
  | {
      kind: "changes";
      sessionId: string;
      /** Absent: as Changes last showed that repository. */
      scope?: "working" | "branch-main";
      /** A review shown as Changes' scope: its session (plan phase 6). */
      review?: string;
      /** The repository, when another than the inspector's ("": its own). */
      root?: string;
    }
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
  lastRoot,
}: {
  snapshot: ReviewSnapshot;
  /** The inspector's checkout, null when it is the workspace's own. */
  checkoutRoot: string | null;
  connectionId: string;
  /** The workspace's panes: their directories hold its repositories. */
  panes: readonly Pane[];
  /** Every review known: the workspace's others name repositories too. */
  sessions: Iterable<ReviewSnapshot>;
  /**
   * Whether a Changes scope holds anything (null: not known), in the
   * repository `root` (absent: the checkout's).
   */
  changed: (
    mode: "working" | "branch-main",
    root?: string,
  ) => Promise<boolean | null>;
  /** The repository Changes showed last here ("": the checkout's). */
  lastRoot?: string;
}): Promise<ChangesReviewChoice> {
  const { session } = snapshot;
  const classic = (reason: string): ChangesReviewChoice => ({
    kind: "classic",
    sessionId: session.id,
    reason,
  });
  const { target } = session;
  if (
    target.kind !== "range" &&
    target.kind !== "worktree" &&
    target.kind !== "step"
  )
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
  const { dirs, agentDirs } = workspaceRepoDirs(panes);
  const scanned = await scanRepos(
    connectionId,
    [session.root, ...dirs],
    agentDirs,
  );
  const repos = workspaceRepos(scanned, sessions, session);
  // Found in the workspace, not only listed for being this review's.
  const held = (root: string) =>
    scanned.some((repo) => sameRoot(repo.root, root));
  if (!here && !held(session.root))
    return classic(
      "This review is of another repository: it shows in the review pane.",
    );
  // Several repositories: the one shown last, as it was left.
  if (
    repos.length > 1 &&
    lastRoot !== undefined &&
    (lastRoot === "" || held(lastRoot))
  )
    return { kind: "changes", sessionId: session.id, root: lastRoot };
  const root = here ? undefined : session.root;
  const at = root ? { root } : {};
  if (target.kind === "worktree")
    return { kind: "changes", sessionId: session.id, scope: "working", ...at };
  // A step's review, a range of other ends, two versions compared: the
  // review itself as the scope, with its commits.
  const review = {
    kind: "changes" as const,
    sessionId: session.id,
    review: session.id,
    ...at,
  };
  if (target.kind === "step" || target.compare || target.head !== "HEAD")
    return review;
  // Nothing beyond the base (the default branch itself, say): the
  // uncommitted work, else the review with the branch's history.
  if ((await changed("branch-main", root)) !== false)
    return {
      kind: "changes",
      sessionId: session.id,
      scope: "branch-main",
      ...at,
    };
  if ((await changed("working", root)) !== false)
    return { kind: "changes", sessionId: session.id, scope: "working", ...at };
  return review;
}
