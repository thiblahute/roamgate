import { useCallback, useMemo, useState } from "react";
import {
  REVIEW_USER,
  type ReviewSnapshot,
  type ReviewThread,
} from "../../shared/review";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "./review";
import { heldCommentCount, reviewAgent } from "./reviewDelivery";
import { handoffStatus, notSavedStatus, saveOrKeep } from "./reviewSave";

/*
 * The checkout's own review in Changes (plan: review into the inspector,
 * phase 4): the worktree review the comments written there belong to, found
 * by a read-only lookup (showing Changes never opens or touches a session),
 * and what the review's agent group does on it: Comments go to the agent,
 * Hold, Send, Agent review, the overall comment.
 */

const trimRoot = (root: string) => root.replace(/\/+$/, "");

/**
 * The worktree review of a checkout: the one last updated when the bridge
 * keeps several; null when none was opened yet (the first comment opens it).
 */
export function worktreeReview(
  sessions: Iterable<ReviewSnapshot>,
  connectionId: string,
  root: string | null | undefined,
): ReviewSnapshot | null {
  if (!root) return null;
  let found: ReviewSnapshot | null = null;
  for (const snapshot of sessions) {
    const { session } = snapshot;
    if (
      session.connectionId !== connectionId ||
      session.target.kind !== "worktree" ||
      trimRoot(session.root) !== trimRoot(root)
    )
      continue;
    if (!found || session.updatedAt > found.session.updatedAt) found = snapshot;
  }
  return found;
}

export type ChangesAgent = {
  /** The review the comments are in, once there is one. */
  snapshot: ReviewSnapshot | null;
  /** The agent's name; null when the review has none to talk to. */
  agentName: string | null;
  /** Comments go to the agent as they are written. */
  talk: boolean;
  held: boolean;
  /** Your comments the agent has not had, while held. */
  heldCount: number;
  /** Open discussions the agent has not answered. */
  waiting: number;
  reviewing: boolean;
  status: string;
  setTalk: (on: boolean) => void;
  toggleHold: () => void;
  send: () => void;
  review: (focus?: string) => void;
  /**
   * Writes reviewed marks (`session.reviewed` changes: null drops one),
   * opening the checkout's review for the first mark as a comment does.
   */
  markReviewed: (changes: Record<string, string | null>) => Promise<void>;
  /** Saves the overall comment, sent to the agent as it is saved when live. */
  saveOverall: (text: string) => Promise<void>;
  summary: string;
};

/** What the review's agent group does, on the checkout's worktree review. */
export function useChangesAgent(
  connectionId: string,
  root: string | null | undefined,
  workspaceId?: string | null,
): ChangesAgent {
  const { sessions } = useReviewState();
  const snapshot = useMemo(
    () => worktreeReview(sessions.values(), connectionId, root),
    [connectionId, root, sessions],
  );
  const [status, setStatus] = useState("");
  const agent = snapshot ? reviewAgent(snapshot, []) : null;
  const sessionId = snapshot?.session.id;
  const run = useCallback(
    async (
      method: string,
      params: Record<string, unknown>,
      failure: string,
    ) => {
      if (!sessionId) return;
      try {
        rememberReviewSnapshot(
          await reviewCall<ReviewSnapshot>(connectionId, method, {
            session_id: sessionId,
            ...params,
          }),
        );
      } catch (error) {
        setStatus(
          `${failure}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [connectionId, sessionId],
  );
  const threads: readonly ReviewThread[] = snapshot?.threads ?? [];
  const session = snapshot?.session;
  const name = agent?.agentName ?? "Agent";
  const openDiscussions = (): number =>
    threads.filter(
      (thread) =>
        thread.kind === "discussion" &&
        !thread.resolved &&
        thread.comments[thread.comments.length - 1]?.author === REVIEW_USER,
    ).length;
  return {
    snapshot,
    agentName: agent?.agentPaneId ? name : null,
    talk: agent?.talk ?? false,
    held: agent?.held ?? false,
    heldCount:
      session && agent ? heldCommentCount(threads, session, agent.held) : 0,
    waiting: openDiscussions(),
    reviewing: session?.agent.working?.message === "reviewing",
    status,
    summary: session?.summary ?? "",
    setTalk: (on) => void run("review.update", { autoSend: on }, "Not changed"),
    toggleHold: () => {
      if (!agent) return;
      void run("review.update", { holdComments: !agent.held }, "Not changed");
      setStatus(
        agent.held
          ? `Your comments go to ${name} as you write them.`
          : `Your comments wait until you Send them to ${name}.`,
      );
    },
    send: () => {
      if (!sessionId) return;
      const open = openDiscussions();
      void saveOrKeep(
        async () =>
          rememberReviewSnapshot(
            await reviewCall<ReviewSnapshot>(connectionId, "review.handoff", {
              session_id: sessionId,
            }),
          ),
        () => {},
      ).then((error) => setStatus(handoffStatus(name, error, open, false)));
    },
    review: (focus) => {
      if (!agent?.agentPaneId) {
        setStatus(`${name} could not review: no agent pane in this workspace`);
        return;
      }
      void run(
        "review.agent.review",
        {
          pane_id: agent.agentPaneId,
          agent: name,
          ...(focus?.trim() ? { focus: focus.trim() } : {}),
        },
        `${name} could not review`,
      );
    },
    markReviewed: async (changes) => {
      if (!Object.keys(changes).length) return;
      let id = sessionId;
      if (!id) {
        if (!workspaceId || !root) throw new Error("no checkout to review");
        const opened = await reviewCall<ReviewSnapshot>(
          connectionId,
          "review.open",
          {
            workspace_id: workspaceId,
            path: root,
            target: { kind: "worktree" },
          },
        );
        rememberReviewSnapshot(opened);
        id = opened.session.id;
      }
      rememberReviewSnapshot(
        await reviewCall<ReviewSnapshot>(connectionId, "review.update", {
          session_id: id,
          reviewed: changes,
        }),
      );
    },
    saveOverall: async (text) => {
      if (!sessionId) return;
      const error = await saveOrKeep(
        async () => {
          rememberReviewSnapshot(
            await reviewCall<ReviewSnapshot>(connectionId, "review.update", {
              session_id: sessionId,
              summary: text,
            }),
          );
          if (agent?.talk && !agent.held && text.trim())
            rememberReviewSnapshot(
              await reviewCall<ReviewSnapshot>(connectionId, "review.handoff", {
                session_id: sessionId,
              }),
            );
        },
        () => {},
      );
      setStatus(
        error
          ? notSavedStatus(error)
          : agent?.talk && !agent.held
            ? handoffStatus(name, null, openDiscussions(), true)
            : "Overall comment saved.",
      );
      if (error) throw new Error(error);
    },
  };
}
