import { useEffect, useRef } from "react";
import {
  REVIEW_USER,
  type ReviewSnapshot,
  type ReviewThread,
  type ReviewThreadKind,
} from "../../shared/review";
import { rememberReviewSnapshot } from "./review";
import type { ReviewSessionCall } from "./reviewSessionCall";

/*
 * How a review's comments reach its agent: as they are written, held for
 * Send, or held in the workspace's threads when the review has no agent;
 * why the last delivery failed; and, for an agent that opened the review
 * without naming its pane, the workspace's agent pane told to the review.
 */

type ReviewSession = ReviewSnapshot["session"];

/** An agent pane of the review's workspace, best candidate first. */
export type AgentPane = { paneId: string; agent: string };

export type ReviewAgent = {
  /** The agent's name, else its pane's agent's, else "Agent". */
  agentName: string;
  /** The pane comments go to: the review's agent's, else the workspace's. */
  agentPaneId: string | undefined;
  /** A merge request's review only once the forge told it is not confidential. */
  agentAllowed: boolean;
  /**
   * Your discussions go to the agent as they are written, on a merge
   * request's review too (its drafts for the forge stay yours to send there).
   */
  talk: boolean;
  /**
   * What a new comment is: a discussion with the agent in a review that
   * talks (on the forge, with an agent bound to the review), else a draft
   * (for the forge, on a merge request's review).
   */
  commentKind: ReviewThreadKind;
  /** Comments wait for Send instead of going as they are written. */
  held: boolean;
  /**
   * A question for the agent of a review with none (C, :ask) is held for
   * the user's Send in the workspace's threads (To send), as a terminal's
   * comment is: not a thread no agent receives.
   */
  holdForSend: boolean;
  /** Why the comments did not reach the agent, while they wait. */
  undeliveredReason: string | null;
};

/**
 * Why the comments did not reach the agent, shown on each with a retry. An
 * agent busy with a question in its pane is retried by the bridge on its
 * own: no reason then.
 */
export function undeliveredReason(session: ReviewSession): string | null {
  return session.deliveryError && !/agent_blocked/.test(session.deliveryError)
    ? session.deliveryError
    : null;
}

/** How the review's comments reach its agent (see ReviewAgent). */
export function reviewAgent(
  snapshot: Pick<ReviewSnapshot, "session" | "mergeRequest">,
  agentPanes: readonly AgentPane[],
): ReviewAgent {
  const { session } = snapshot;
  const agent = session.agent;
  const agentName =
    agent.name ??
    (agentPanes[0]
      ? agentPanes[0].agent.charAt(0).toUpperCase() +
        agentPanes[0].agent.slice(1)
      : "Agent");
  const agentPaneId = agent.paneId ?? agentPanes[0]?.paneId;
  const agentAllowed =
    session.target.kind !== "mr" || snapshot.mergeRequest?.security === false;
  const talk = session.autoSend !== false && !!agentPaneId && agentAllowed;
  return {
    agentName,
    agentPaneId,
    agentAllowed,
    talk,
    // On the forge too, a comment asks the agent bound to the review (C
    // writes the draft there); one only offered by the workspace leaves
    // the forge's drafts as they were.
    commentKind:
      talk && (!session.gitlab || !!agent.paneId) ? "discussion" : "draft",
    held: talk && session.holdComments === true,
    holdForSend: !agentPaneId && agentAllowed && !!session.workspaceId,
    undeliveredReason: undeliveredReason(session),
  };
}

/** Your discussion comments the agent has not had yet, while held. */
export function heldCommentCount(
  threads: readonly ReviewThread[],
  session: ReviewSession,
  held: boolean,
): number {
  if (!held) return 0;
  return threads
    .filter(
      (thread) =>
        thread.sessionId === session.id &&
        thread.kind === "discussion" &&
        !thread.resolved,
    )
    .flatMap((thread) => thread.comments)
    .filter(
      (comment) =>
        comment.author === REVIEW_USER &&
        comment.updatedAt > (session.deliveredAt ?? ""),
    ).length;
}

/** When an agent last answered in a discussion ("" for never). */
export function latestAnswerAt(threads: readonly ReviewThread[]): string {
  return threads
    .filter((thread) => thread.kind === "discussion")
    .flatMap((thread) => thread.comments)
    .filter((comment) => comment.author !== REVIEW_USER)
    .reduce(
      (latest, comment) =>
        comment.createdAt > latest ? comment.createdAt : latest,
      "",
    );
}

/** How a thread's comments go to its agent, and how to send them again. */
export type ThreadDelivery = {
  review: ReviewSession;
  talk: boolean;
  held: boolean;
  undeliveredReason: string | null;
  agentName: string;
  retry: () => void;
};

/**
 * The delivery of a thread shared from another review (a rendered file of
 * the checkout): that review's way, its agent named after the review's
 * own when it has no name.
 */
export function sharedThreadDelivery(
  own: ReviewSession,
  agentName: string,
): Omit<ThreadDelivery, "retry"> {
  const talk = own.autoSend !== false && !!own.agent.paneId;
  return {
    review: own,
    talk,
    held: talk && own.holdComments === true,
    undeliveredReason: undeliveredReason(own),
    agentName: own.agent.name ?? agentName,
  };
}

/** The pane to tell the review: comments go out, it names none of its own. */
export function paneToAttach(
  session: ReviewSession,
  agent: Pick<ReviewAgent, "talk" | "agentPaneId">,
): string | null {
  return agent.talk && !session.agent.paneId && agent.agentPaneId
    ? agent.agentPaneId
    : null;
}

/**
 * "live" with the workspace's agent pane: the review is told that pane,
 * else the bridge has nowhere to send the comments (an agent that opened
 * the review without naming its pane). Once per review and pane; told
 * again after a failure.
 */
export function useAttachAgentPane(
  sessionId: string,
  pane: string | null,
  agentName: string,
  call: ReviewSessionCall,
  /** The review was told the pane: what it sends, now, goes out. */
  onAttached?: (snapshot: ReviewSnapshot) => void,
) {
  const attachedPane = useRef<string | null>(null);
  const attached = useRef(onAttached);
  attached.current = onAttached;
  useEffect(() => {
    const key = pane && `${sessionId}\n${pane}`;
    if (!pane || attachedPane.current === key) return;
    attachedPane.current = key;
    void call<ReviewSnapshot>("review.update", {
      agent: agentName,
      agent_pane: pane,
    }).then(
      (snapshot) => {
        rememberReviewSnapshot(snapshot);
        attached.current?.(snapshot);
      },
      () => {
        attachedPane.current = null;
      },
    );
  }, [pane, sessionId, agentName, call]);
}
