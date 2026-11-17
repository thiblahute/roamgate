import type { ReviewSnapshot } from "../../shared/review";
import type { Pane } from "./types";
import { paneDir, workspaceRepoDirs } from "./changesRepo";
import { insideRoot, sameRoot } from "./filesystemPaths";
import { workspaceRepos, scanRepos } from "./reviewRepos";

/*
 * The review toggle (plan: review into the inspector, D6): it shows the
 * pinned review, else the one `openWorkspaceReview` picks (the repository
 * with work, its branch review against the base, or its uncommitted work),
 * in Changes' matching scope.
 * A workspace with several repositories (a series) shows
 * the one Changes showed last, else the review's, picked in Changes' scope
 * line. A range or compare opened by name, a step's review, a merge
 * request's review and a branch with nothing beyond its base (its history)
 * show as a review scope (plan phases 6 and 7). A review of a repository
 * the workspace does not hold (its workspace gone, an agent's without one)
 * shows in this workspace's Changes all the same, marked "from elsewhere"
 * (D3). Only chats and rendered files keep their own homes.
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
      /** Of a repository this workspace does not hold (D3). */
      elsewhere?: boolean;
    }
  /**
   * A review with a home of its own, never Changes (D16): a chat's is
   * discussed in its chat, a rendered file's or site's in the Files
   * preview. `reason` says so.
   */
  | {
      kind: "home";
      sessionId: string;
      home: "chat" | "files" | "reviews";
      reason: string;
    };

/** Where a picked review shows: Changes' scope, or its own home. */
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
  const { target } = session;
  if (target.kind === "chat")
    return {
      kind: "home",
      sessionId: session.id,
      home: "chat",
      reason: "A chat's review is discussed in its chat.",
    };
  if (target.kind === "rendered")
    return {
      kind: "home",
      sessionId: session.id,
      home: "files",
      reason: "A rendered file's review is discussed in the Files preview.",
    };
  if (target.kind === "effort")
    return {
      kind: "home",
      sessionId: session.id,
      home: "reviews",
      reason: "An effort's threads are discussed in its view in Reviews.",
    };
  // A workspace without a known checkout shows its focused pane's
  // repository in Changes.
  const focused = panes.find((pane) => pane.focused) ?? panes[0];
  const here = checkoutRoot
    ? sameRoot(session.root, checkoutRoot)
    : !!focused && insideRoot(paneDir(focused), session.root);
  const { dirs, agentDirs } = workspaceRepoDirs(panes);
  const scanned = await scanRepos(
    connectionId,
    [session.root, ...dirs],
    agentDirs,
  );
  const repos = workspaceRepos(scanned, sessions, session);
  // Found in the workspace, not only listed for being this review's: the
  // review's root is scanned too, so a repository is the workspace's when
  // one of its panes' or agents' directories is in it (or holds it, a
  // subproject).
  const near = (dir: string, root: string) =>
    insideRoot(dir, root) || insideRoot(root, dir);
  const held = (root: string) =>
    scanned.some((repo) => sameRoot(repo.root, root)) &&
    [...dirs, ...agentDirs].some((dir) => near(dir, root));
  // A repository this workspace does not hold: shown here, marked (D3).
  if (!here && !held(session.root))
    return target.kind === "worktree"
      ? {
          kind: "changes",
          sessionId: session.id,
          scope: "working",
          root: session.root,
          elsewhere: true,
        }
      : {
          kind: "changes",
          sessionId: session.id,
          review: session.id,
          root: session.root,
          elsewhere: true,
        };
  // Several repositories: the one shown last, as it was left.
  if (
    target.kind !== "mr" &&
    repos.length > 1 &&
    lastRoot !== undefined &&
    (lastRoot === "" || held(lastRoot))
  )
    return { kind: "changes", sessionId: session.id, root: lastRoot };
  // The checkout's own ("") when it is the review's: Changes comes back to
  // it from another repository shown last.
  const root = here ? "" : session.root;
  const at = { root };
  if (target.kind === "worktree")
    return { kind: "changes", sessionId: session.id, scope: "working", ...at };
  // A merge request's review: the review itself, its forge with it.
  if (target.kind === "mr")
    return {
      kind: "changes",
      sessionId: session.id,
      review: session.id,
      ...at,
    };
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
