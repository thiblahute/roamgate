import { useCallback } from "react";
import type { ReviewSnapshot } from "../../shared/review";
import { rememberReviewSnapshot, reviewCall } from "./review";

/*
 * Calls on one review session. The server pushes the new state after a
 * write, but a push can be lost with its socket: after a call that changes
 * the review's threads, its state is read back, so your own comment never
 * goes missing.
 */

/** Calls that change the review's threads: its state is read back after. */
export const REVIEW_WRITES: ReadonlySet<string> = new Set([
  "review.thread.add",
  "review.reply",
  "review.edit",
  "review.delete",
  "review.resolve",
  "review.restore",
  "review.adopt",
]);

/** A call on the review session, its id added to the parameters. */
export type ReviewSessionCall = <T>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

/** Makes a call on the session, reading it back after a write. */
export async function callReviewSession<T>(
  connectionId: string,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const result = await reviewCall<T>(connectionId, method, {
    session_id: sessionId,
    ...params,
  });
  if (REVIEW_WRITES.has(method))
    void reviewCall<ReviewSnapshot>(connectionId, "review.get", {
      session_id: sessionId,
    })
      .then(rememberReviewSnapshot)
      .catch(() => {});
  return result;
}

/** callReviewSession for one session, the same function while it is. */
export function useReviewSessionCall(
  connectionId: string,
  sessionId: string,
): ReviewSessionCall {
  return useCallback(
    <T>(method: string, params: Record<string, unknown> = {}) =>
      callReviewSession<T>(connectionId, sessionId, method, params),
    [connectionId, sessionId],
  );
}
