import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSnapshot } from "../../shared/review";
import type { ReviewAnnotation } from "./annotations";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "./review";
import { type HeldFeedback, heldFeedback } from "./workspaceFeedback";

const EDIT_DELAY_MS = 500;

/**
 * The workspace's held Review feedback: review threads that wait for the
 * user's Send, shown and edited as the panel's notes.
 */
export function useHeldFeedback(
  connectionId: string | null | undefined,
  workspaceId: string | undefined,
) {
  const { sessions } = useReviewState();
  const held = useMemo(
    () => heldFeedback(sessions.values(), connectionId, workspaceId),
    [sessions, connectionId, workspaceId],
  );
  const heldRef = useRef(held);
  heldRef.current = held;
  /** Words being typed: shown at once, saved a moment later. */
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const write = useCallback(
    async (
      entry: HeldFeedback,
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (!connectionId) return;
      await reviewCall(connectionId, method, {
        session_id: entry.sessionId,
        ...params,
      });
      const snapshot = await reviewCall<ReviewSnapshot>(
        connectionId,
        "review.get",
        { session_id: entry.sessionId },
      );
      rememberReviewSnapshot(snapshot);
    },
    [connectionId],
  );

  const find = (id: string) =>
    heldRef.current.find((entry) => entry.threadId === id);

  const flush = useCallback(
    (id: string, text: string) => {
      const entry = heldRef.current.find((each) => each.threadId === id);
      // A comment needs words: blank, it waits for some.
      if (!entry || !text.trim()) return;
      void write(entry, "review.edit", {
        comment_id: entry.commentId,
        text: text.trim(),
      })
        .then(() =>
          setEdits((current) => {
            if (current.get(id) !== text) return current;
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        )
        .catch(() => {});
    },
    [write],
  );

  const edit = useCallback(
    (id: string, text: string) => {
      setEdits((current) => new Map(current).set(id, text));
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => flush(id, text), EDIT_DELAY_MS),
      );
    },
    [flush],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const remove = useCallback(
    (id: string) => {
      const entry = heldRef.current.find((each) => each.threadId === id);
      if (entry)
        void write(entry, "review.delete", { comment_id: entry.commentId });
    },
    [write],
  );

  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      const list = heldRef.current;
      const index = list.findIndex((each) => each.threadId === id);
      const other = list[index + delta];
      const entry = list[index];
      if (!entry || !other) return;
      void write(entry, "review.thread.move", {
        comment_id: entry.threadId,
        held: other.held,
      });
      void write(other, "review.thread.move", {
        comment_id: other.threadId,
        held: entry.held,
      });
    },
    [write],
  );

  /** Handed to an agent in one prompt: they become its open threads. */
  const release = useCallback(
    async (ids: readonly string[], handed: boolean) => {
      await Promise.all(
        ids.flatMap((id) => {
          const entry = heldRef.current.find((each) => each.threadId === id);
          return entry
            ? [
                write(entry, "review.thread.release", {
                  comment_id: entry.threadId,
                  handed,
                }),
              ]
            : [];
        }),
      );
    },
    [write],
  );

  const annotations: ReviewAnnotation[] = useMemo(
    () =>
      held.map(({ annotation, threadId }) =>
        edits.has(threadId)
          ? { ...annotation, comment: edits.get(threadId)! }
          : annotation,
      ),
    [held, edits],
  );

  return {
    annotations,
    has: (id: string) => find(id) !== undefined,
    snapshot: (id: string) => find(id)?.snapshot,
    edit,
    remove,
    move,
    release,
  };
}
