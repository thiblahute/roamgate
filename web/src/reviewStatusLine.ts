import { useEffect, useRef, useState } from "react";
import type { ReviewSnapshot, ReviewThread } from "../../shared/review";
import { plural } from "./components/MrThreadCard";
import { reviewDraftCount } from "./reviewDrafts";

/*
 * The review's status line: the agent waiting for an answer in its pane,
 * comments not delivered, a review pass going on and what it left, the
 * agent's work and last word, and the unsent drafts kept from before.
 */

type ReviewSession = ReviewSnapshot["session"];

/** The line, from the review's state and what was last said (`status`). */
export function reviewStatusText({
  session,
  agentName,
  now,
  status,
}: {
  session: ReviewSession;
  agentName: string;
  now: number;
  status: string;
}): string {
  const agent = session.agent;
  if (session.deliveryError)
    return /agent_blocked/.test(session.deliveryError)
      ? `${agentName} is waiting for an answer in its pane; your comments go to it once it is free.`
      : `Your comments were not delivered to ${agentName}: ${session.deliveryError} (Retry on a comment, or Send)`;
  if (agent.working?.message === "reviewing")
    return `${agentName} is reviewing, reading the code where needed (${Math.max(
      0,
      Math.round((now - Date.parse(agent.working.at)) / 1000),
    )} s)...`;
  return (
    status ||
    (agent.working
      ? `${agentName} is working: ${agent.working.message ?? ""}`
      : agent.update?.message
        ? `${agentName}: ${agent.update.message}`
        : "")
  );
}

/**
 * What the status line says of a review: the clock of a review pass, what
 * the pass left (said until the agent works again), the drafts kept from
 * before (said once, as the review opens). `status` is what an action said
 * last, `setStatus` for the actions to say more.
 */
export function useReviewStatusLine({
  session,
  threads,
  agentName,
  draftSession,
  status,
  setStatus,
}: {
  session: ReviewSession | null;
  threads: readonly ReviewThread[];
  agentName: string;
  /** Where the review's unsent drafts are kept. */
  draftSession: string;
  status: string;
  setStatus: (update: (current: string) => string) => void;
}): string {
  const [now, setNow] = useState(() => Date.now());
  const agent = session?.agent;
  const reviewing = agent?.working?.message === "reviewing";
  // The clock of "reviewing (12 s)", while a pass goes on.
  useEffect(() => {
    if (!reviewing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reviewing]);
  const wasReviewing = useRef(reviewing);
  const reviewSaid = useRef<string | null>(null);
  const update = agent?.update?.message;
  const name = agent?.name;
  useEffect(() => {
    if (wasReviewing.current && !reviewing) {
      const mine = threads.filter(
        (thread) =>
          thread.kind === "draft" &&
          thread.comments.every((comment) => comment.author === name),
      ).length;
      const said = mine
        ? `${agentName} left ${plural(mine, "comment")}: edit or delete them, n jumps to the next.`
        : `${agentName} found nothing to comment on.${update ? ` ${update}` : ""}`;
      reviewSaid.current = said;
      setStatus(() => said);
    }
    wasReviewing.current = reviewing;
  }, [reviewing, threads, name, update, agentName, setStatus]);
  const workingAt = agent?.working?.at;
  useEffect(() => {
    if (!workingAt || reviewSaid.current === null) return;
    const said = reviewSaid.current;
    reviewSaid.current = null;
    setStatus((current) => (current === said ? "" : current));
  }, [workingAt, setStatus]);
  // Drafts left from before: said once, as the review opens.
  useEffect(() => {
    const count = reviewDraftCount(draftSession);
    if (count)
      setStatus(
        () =>
          `${plural(count, "unsent draft")} kept: reopen the comment to go on.`,
      );
  }, [draftSession, setStatus]);
  return session
    ? reviewStatusText({ session, agentName, now, status })
    : status;
}
