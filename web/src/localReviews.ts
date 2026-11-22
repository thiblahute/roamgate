import type {
  ReviewActivity,
  ReviewGoneCode,
  ReviewSession,
} from "../../shared/review";
import type { ReviewListItem } from "./reviewModel";

/*
 * The board's Local reviews: Roamgate's own reviews of a checkout (ranges,
 * worktrees, merge requests), the workspace's or every workspace's, ranked
 * as rankReviews ranks them, with the chips that say where each stands.
 */

/** What a local review row reads of its review: its session's fields. */
export type LocalReviewSession = Pick<
  ReviewSession,
  | "id"
  | "connectionId"
  | "workspaceId"
  | "root"
  | "target"
  | "title"
  | "summary"
  | "updatedAt"
  | "agent"
  | "gitlab"
>;

/** A review of a checkout: not a chat's, a rendered file's, an effort's or a Work item's threads. */
export function isLocalReview(session: Pick<ReviewSession, "target">): boolean {
  // A session read from elsewhere may name no target.
  const kind = session.target?.kind;
  if (!kind) return false;
  return (
    kind !== "chat" &&
    kind !== "rendered" &&
    kind !== "effort" &&
    kind !== "work"
  );
}

/** The workspace the lane shows the reviews of; null: every workspace. */
export type LocalReviewScope = {
  connectionId: string;
  workspaceId: string;
} | null;

/** The local reviews of the scope, from every review the page knows. */
export function localReviewsOf<T extends { session: LocalReviewSession }>(
  reviews: Iterable<T>,
  scope: LocalReviewScope,
): T[] {
  return [...reviews].filter(
    ({ session }) =>
      isLocalReview(session) &&
      (!scope ||
        (session.connectionId === scope.connectionId &&
          session.workspaceId === scope.workspaceId)),
  );
}

/**
 * What the lane knows of a review's branch: being read, read, its
 * connection offline (not asked), or the read failed.
 */
export type LocalReviewBranch =
  | { state: "reading" }
  | { state: "read"; activity: ReviewActivity }
  | { state: "offline"; connection: string }
  | { state: "failed" };

export type LocalReviewChip = {
  text: string;
  /** news: something new since the user looked; bad: its code is gone. */
  tone?: "news" | "good" | "bad" | "wait" | "label";
};

function goneText(code: ReviewGoneCode): string {
  return code === "checkout-gone"
    ? "checkout removed"
    : code === "base-gone"
      ? "base gone"
      : "head gone";
}

/**
 * A row's chips: its comments, the news (new commits since it was seen,
 * discussions waiting for you), its agent at work, GitLab, and its branch
 * as read (gone, unreadable, offline). The branch's chips come as they are
 * read; none while being read.
 */
export function localReviewChips(
  item: Pick<ReviewListItem, "comments" | "waiting" | "newCommits"> & {
    snapshot: { session: Pick<ReviewSession, "summary" | "agent" | "gitlab"> };
  },
  branch: LocalReviewBranch | undefined,
): LocalReviewChip[] {
  const { session } = item.snapshot;
  const chips: LocalReviewChip[] = [
    {
      text: item.comments
        ? `${item.comments} comment${item.comments === 1 ? "" : "s"}`
        : session.summary.trim()
          ? "overall comment only"
          : "empty",
    },
  ];
  if (item.newCommits) chips.push({ text: "new commits since", tone: "news" });
  if (item.waiting)
    chips.push({ text: `${item.waiting} waiting for you`, tone: "news" });
  if (session.agent.working)
    chips.push({
      text: `${session.agent.name ?? "agent"} working`,
      tone: "good",
    });
  if (session.gitlab) chips.push({ text: "GitLab", tone: "label" });
  if (branch?.state === "read" && branch.activity.gone)
    chips.push({ text: goneText(branch.activity.gone), tone: "bad" });
  else if (branch?.state === "read" && branch.activity.unreadable)
    chips.push({ text: "branch not read in time", tone: "wait" });
  else if (branch?.state === "offline")
    chips.push({ text: `on ${branch.connection}, offline`, tone: "wait" });
  else if (branch?.state === "failed")
    chips.push({ text: "branch not read", tone: "wait" });
  return chips;
}

/** The reviews whose branch moved since they were last seen. */
export function movedReviews(
  branches: ReadonlyMap<string, LocalReviewBranch>,
): Set<string> {
  const moved = new Set<string>();
  for (const [id, branch] of branches)
    if (branch.state === "read" && branch.activity.newCommits) moved.add(id);
  return moved;
}

/** The key a local review's row has among the board's rows. */
export const LOCAL_REVIEW_KEY = "local:";

export function localReviewKey(sessionId: string): string {
  return `${LOCAL_REVIEW_KEY}${sessionId}`;
}

/** The review a row key names, or null for a request's. */
export function localReviewOfKey(key: string | null): string | null {
  return key?.startsWith(LOCAL_REVIEW_KEY)
    ? key.slice(LOCAL_REVIEW_KEY.length)
    : null;
}
