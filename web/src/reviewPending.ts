import {
  REVIEW_USER,
  type ReviewAnchor,
  type ReviewThread,
  type ReviewThreadKind,
} from "../../shared/review";

/*
 * Comments being written to a review, shown at once in their thread as
 * pending until the review the server sends back has them. Each carries an
 * id made here, once per comment: sent again (a retry, a second press), the
 * server finds it instead of writing the comment twice.
 */

/** A reply, or a new thread, on its way to the server. */
export type PendingWrite = {
  /** The new comment's id (a reply), or the new thread's. */
  id: string;
  sessionId: string;
  /** The thread a reply answers; none for a new thread. */
  replyTo?: string;
  kind: ReviewThreadKind;
  anchor: ReviewAnchor;
  text: string;
  at: string;
  /**
   * A new thread held for the user's Send in the workspace's threads (a
   * question for an agent the review has none of): its place there.
   */
  held?: number;
  /** Why the last try failed; none while it is on its way. */
  error?: string;
};

/** An id shaped as the server's: 16 hexadecimal digits. */
export function newClientId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The parameters that send a pending write, with its id. */
export function pendingWriteCall(write: PendingWrite): {
  method: "review.reply" | "review.thread.add";
  params: Record<string, unknown>;
} {
  return write.replyTo
    ? {
        method: "review.reply",
        params: {
          comment_id: write.replyTo,
          new_comment_id: write.id,
          text: write.text,
        },
      }
    : {
        method: "review.thread.add",
        params: {
          kind: write.kind,
          anchor: write.anchor,
          new_thread_id: write.id,
          text: write.text,
          ...(write.held !== undefined ? { held: write.held } : {}),
        },
      };
}

/** Whether the server's threads have the write. */
export function writeLanded(
  threads: readonly ReviewThread[],
  write: PendingWrite,
): boolean {
  return write.replyTo
    ? threads.some(
        (thread) =>
          thread.id === write.replyTo &&
          thread.comments.some((comment) => comment.id === write.id),
      )
    : threads.some((thread) => thread.id === write.id);
}

/**
 * The threads with the writes not in them yet: a reply at the end of its
 * thread, a new thread as one of its own.
 */
export function withPendingWrites(
  threads: ReviewThread[],
  pending: readonly PendingWrite[],
): ReviewThread[] {
  const waiting = pending.filter((write) => !writeLanded(threads, write));
  if (!waiting.length) return threads;
  const comment = (write: PendingWrite) => ({
    id: write.id,
    author: REVIEW_USER,
    body: write.text,
    createdAt: write.at,
    updatedAt: write.at,
  });
  const merged = threads.map((thread) => {
    const replies = waiting.filter((write) => write.replyTo === thread.id);
    return replies.length
      ? { ...thread, comments: [...thread.comments, ...replies.map(comment)] }
      : thread;
  });
  for (const write of waiting)
    if (!write.replyTo)
      merged.push({
        id: write.id,
        sessionId: write.sessionId,
        kind: write.kind,
        anchor: write.anchor,
        comments: [comment(write)],
        resolved: false,
        createdAt: write.at,
        updatedAt: write.at,
        ...(write.held !== undefined ? { held: write.held } : {}),
      });
  return merged;
}
