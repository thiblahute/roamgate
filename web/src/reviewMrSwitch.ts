import type {
  ReviewMergeRequest,
  ReviewMergeRequestLink,
  ReviewSession,
} from "../../shared/review";

/**
 * The review head's merge request chip: the mode the review is in, and
 * what a click (gm, :switch) does. `gitlab` opens (or raises) the review
 * of the branch's merge request; `local` opens the local review of the
 * checkout's branch. Each is its own review: nothing is mixed.
 */
export type ReviewMrSwitch = {
  label: string;
  mode: string;
  title: string;
  on: boolean;
  action: "gitlab" | "local";
};

/** The `!` number of a merge request URL. */
export function mergeRequestNumber(url: string): number | null {
  const match = /\/-\/merge_requests\/(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

export function reviewMrSwitch(
  session: Pick<ReviewSession, "target">,
  /** A merge request's review: its merge request, once read. */
  current: ReviewMergeRequest | null,
  /** The branch's merge request (for an MR's review: when checked out). */
  found: ReviewMergeRequestLink | null,
  /** A local review can be opened from here. */
  canOpenLocal: boolean,
): ReviewMrSwitch | null {
  const keys = "(gm, :switch)";
  const { kind } = session.target;
  if (kind === "mr") {
    if (!found || !canOpenLocal) return null;
    return {
      label: `MR !${found.number}`,
      mode: "on GitLab",
      title: `${current?.title ?? found.title}\nReviewing the merge request from GitLab; the checkout is on its branch: click for its local review ${keys}`,
      on: true,
      action: "local",
    };
  }
  if ((kind !== "range" && kind !== "worktree") || !found) return null;
  return {
    label: `MR !${found.number}`,
    mode: "local",
    title: `${found.title}\nThis branch has a merge request; local review: click to review the merge request from GitLab, with its discussions and your comments as draft notes ${keys}`,
    on: false,
    action: "gitlab",
  };
}
