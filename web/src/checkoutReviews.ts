import {
  isMetadataRef,
  type ReviewHead,
  type ReviewSummarySession,
} from "../../shared/review";
import { trimRoot } from "./filesystemPaths";

/*
 * A checkout has one review in Changes and Files, whatever its comments
 * were written under: the working tree (Files, Working), the branch against
 * one base or another, a range an agent opened, one commit's view. Each
 * stays a review session of its own (it delivers its threads to its agent
 * and takes what is written on them), and Changes shows the threads of all
 * of them together, each placed in the view shown when its anchor is found
 * there and listed with where it was written when not.
 */

/**
 * A review of the checkout's own code, one with its others: its working
 * tree, or a range of its commits (not a compare of two versions of a
 * branch, a step, a merge request, a chat or a rendered page).
 */
export function checkoutCodeReview(session: ReviewSummarySession): boolean {
  const { target } = session;
  return (
    target.kind === "worktree" || (target.kind === "range" && !target.compare)
  );
}

/** The checkout's code reviews, the last updated first. */
export function checkoutReviews<T extends ReviewHead>(
  sessions: Iterable<T>,
  connectionId: string,
  root: string | null | undefined,
): T[] {
  if (!root) return [];
  const own = trimRoot(root);
  const found: T[] = [];
  for (const snapshot of sessions) {
    const { session } = snapshot;
    if (
      session.connectionId === connectionId &&
      trimRoot(session.root) === own &&
      checkoutCodeReview(session)
    )
      found.push(snapshot);
  }
  return found.sort((a, b) =>
    b.session.updatedAt.localeCompare(a.session.updatedAt),
  );
}

/**
 * A branch review that followed Automatic onto a metadata ref (a remote
 * HEAD naming Entire's checkpoints): no longer the Branch scope's, whose
 * first comment moves it onto the default branch.
 */
export function onMetadataBase(session: ReviewSummarySession): boolean {
  return session.target.kind === "range" && isMetadataRef(session.target.base);
}
