import { useCallback, useMemo, useRef, useState } from "react";
import {
  REVIEW_USER,
  type ReviewSnapshot,
  type ReviewTarget,
  type ReviewThread,
} from "../../shared/review";
import type { LastStepTarget } from "./types";
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

/**
 * What Changes shows, as a review (plan phase 6): its scope, each bound to
 * its review session by a read-only lookup.
 */
export type ChangesScope =
  | { kind: "working" }
  /**
   * The branch against its base: `base`, the one picked in Compare against
   * (its own range review, D12); else Automatic's, `automaticBase` as the
   * summary resolved it.
   */
  | { kind: "branch"; base?: string; automaticBase?: string }
  /** The Last step (D15). */
  | { kind: "step"; step: LastStepTarget }
  /** A review opened by name (a range, a compare, a commit's). */
  | { kind: "review"; sessionId: string };

export const WORKING_SCOPE: ChangesScope = { kind: "working" };

/** `main` and `origin/main`: one branch, local and remote-tracking. */
function counterparts(a: string, b: string): boolean {
  const remoteOf = (remote: string, local: string) =>
    remote.endsWith(`/${local}`) &&
    !remote.slice(0, -local.length - 1).includes("/");
  return a === b || remoteOf(a, b) || remoteOf(b, a);
}

/** The step a scope shows, as the review target its comments go to. */
export function stepTarget(
  step: LastStepTarget,
): Extract<ReviewTarget, { kind: "step" }> {
  return {
    kind: "step",
    step: step.step,
    before: step.before,
    after: step.after,
    ...(step.at ? { at: step.at } : {}),
    ...(step.skipped?.length ? { skipped: step.skipped } : {}),
  };
}

/**
 * The review a scope shows: the one last updated when the bridge keeps
 * several; null when none was opened yet (the first comment opens it).
 * Read only: showing a scope never opens or touches a session.
 */
export function scopeReview(
  sessions: Iterable<ReviewSnapshot>,
  connectionId: string,
  root: string | null | undefined,
  scope: ChangesScope = WORKING_SCOPE,
): ReviewSnapshot | null {
  if (scope.kind === "review") {
    for (const snapshot of sessions)
      if (
        snapshot.session.id === scope.sessionId &&
        snapshot.session.connectionId === connectionId
      )
        return snapshot;
    return null;
  }
  if (scope.kind === "working")
    return worktreeReview(sessions, connectionId, root);
  if (!root) return null;
  let found: ReviewSnapshot | null = null;
  let foundRank = 0;
  for (const snapshot of sessions) {
    const { session } = snapshot;
    if (
      session.connectionId !== connectionId ||
      trimRoot(session.root) !== trimRoot(root)
    )
      continue;
    const { target } = session;
    let rank = 0;
    if (scope.kind === "step")
      rank =
        target.kind === "step" &&
        target.before === scope.step.before &&
        target.after === scope.step.after
          ? 1
          : 0;
    else if (
      target.kind === "range" &&
      !target.compare &&
      target.head === "HEAD"
    ) {
      if (scope.base) rank = target.base === scope.base ? 1 : 0;
      else if (session.automaticBase !== false)
        // Automatic's review: of that base, else of its counterpart, else
        // any review that follows Automatic.
        rank = !scope.automaticBase
          ? session.automaticBase
            ? 1
            : 0
          : target.base === scope.automaticBase
            ? 3
            : counterparts(target.base, scope.automaticBase)
              ? 2
              : session.automaticBase
                ? 1
                : 0;
    }
    if (!rank) continue;
    if (
      !found ||
      rank > foundRank ||
      (rank === foundRank && session.updatedAt > found.session.updatedAt)
    ) {
      found = snapshot;
      foundRank = rank;
    }
  }
  return found;
}

/**
 * What `review.open` takes to make the scope's review, for its first
 * comment or mark: its target, or none (the branch under Automatic: the
 * bridge picks the base, as Option+R does). Null: a review opened by name,
 * which exists.
 */
export function scopeOpenTarget(
  scope: ChangesScope,
): { target?: ReviewTarget } | null {
  if (scope.kind === "review") return null;
  if (scope.kind === "working") return { target: { kind: "worktree" } };
  if (scope.kind === "step") return { target: stepTarget(scope.step) };
  return scope.base
    ? { target: { kind: "range", base: scope.base, head: "HEAD" } }
    : {};
}

export type ChangesAgent = {
  /** The review the comments are in, once there is one. */
  snapshot: ReviewSnapshot | null;
  /**
   * The agent's name; null when the review has none to talk to (or keeps
   * agents out: a security merge request, one not read yet).
   */
  agentName: string | null;
  /** The agent's pane (bound, else the workspace's); null without one. */
  agentPaneId: string | null;
  /** A merge request's review: its Send is the agent's, said so. */
  gitlab: boolean;
  /** The scope's review, opened for a first write when it is not yet. */
  open: () => Promise<string>;
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
  /**
   * A file of the checkout as it reads now (the review's `review.file`),
   * for the lines Changes reveals around a hunk.
   */
  readFile: (path: string) => Promise<string>;
  /**
   * Saves the overall comment; `send` hands the review to the agent with
   * it (unset: when comments go to the agent as written). Throws when it
   * was not saved.
   */
  saveOverall: (text: string, send?: boolean) => Promise<void>;
  summary: string;
};

/** The same scope object while its value is the same. */
export function useScopeByValue(scope: ChangesScope): ChangesScope {
  const kept = useRef(scope);
  if (JSON.stringify(kept.current) !== JSON.stringify(scope))
    kept.current = scope;
  return kept.current;
}

/** What the review's agent group does, on the scope's review. */
export function useChangesAgent(
  connectionId: string,
  root: string | null | undefined,
  workspaceId?: string | null,
  scope: ChangesScope = WORKING_SCOPE,
  /** The workspace's agent panes: the agent when the review has none. */
  agentPanes: readonly { paneId: string; agent: string }[] = [],
): ChangesAgent {
  const { sessions } = useReviewState();
  const shownScope = useScopeByValue(scope);
  const snapshot = useMemo(
    () => scopeReview([...sessions.values()], connectionId, root, shownScope),
    [connectionId, root, sessions, shownScope],
  );
  const [status, setStatus] = useState("");
  const agent = snapshot ? reviewAgent(snapshot, agentPanes) : null;
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
  /** The scope's review, opened for a first write as a comment opens it. */
  const opened = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const open = scopeOpenTarget(scope);
    if (!open) throw new Error("this review is gone");
    if (!workspaceId || !root) throw new Error("no checkout to review");
    const made = await reviewCall<ReviewSnapshot>(connectionId, "review.open", {
      workspace_id: workspaceId,
      path: root,
      ...open,
    });
    rememberReviewSnapshot(made);
    return made.session.id;
  };
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
    agentName: agent?.agentPaneId && agent.agentAllowed ? name : null,
    agentPaneId: agent?.agentAllowed ? (agent.agentPaneId ?? null) : null,
    gitlab: !!session?.gitlab,
    open: opened,
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
      const id = await opened();
      rememberReviewSnapshot(
        await reviewCall<ReviewSnapshot>(connectionId, "review.update", {
          session_id: id,
          reviewed: changes,
        }),
      );
    },
    readFile: async (path) => {
      const id = await opened();
      const { text } = await reviewCall<{ text: string }>(
        connectionId,
        "review.file",
        { session_id: id, path, rev: "" },
      );
      return text;
    },
    saveOverall: async (text, send) => {
      const sends = send ?? (!!agent?.talk && !agent.held && !!text.trim());
      // Left as it was, and nothing to send: nothing to write.
      if (!sends && text === (session?.summary ?? "")) return;
      const error = await saveOrKeep(
        async () => {
          const id = await opened();
          if (text !== (session?.summary ?? ""))
            rememberReviewSnapshot(
              await reviewCall<ReviewSnapshot>(connectionId, "review.update", {
                session_id: id,
                summary: text,
              }),
            );
          if (sends)
            rememberReviewSnapshot(
              await reviewCall<ReviewSnapshot>(connectionId, "review.handoff", {
                session_id: id,
              }),
            );
        },
        () => {},
      );
      setStatus(
        error
          ? notSavedStatus(error)
          : sends
            ? handoffStatus(name, null, openDiscussions(), true)
            : "Overall comment saved.",
      );
      if (error) throw new Error(error);
    },
  };
}
