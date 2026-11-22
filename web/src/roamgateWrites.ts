import type { RoamgateWrite } from "../../shared/toolSummary";
import { requestReviewShown } from "./review";
import { store } from "./store";

/** What opening a write's thread needs: overridden in tests. */
export type RoamgateWriteOpeners = {
  /** The connection the chat's session is on. */
  connectionId: () => string | null;
  /** Shows a review where it lives: Changes, a chat's pane, its view. */
  showReview: (connectionId: string, review: string) => void;
};

const OPENERS: RoamgateWriteOpeners = {
  connectionId: () => store.get().activeConnectionId,
  showReview: requestReviewShown,
};

/** Whether a write's row can open what it wrote in. */
export function canOpenRoamgateWrite(write: RoamgateWrite): boolean {
  return !!write.review;
}

/**
 * Opens the thread a call wrote in (a chat tool row's link): its review,
 * where that review lives. False when the call did not say where.
 */
export function openRoamgateWrite(
  write: RoamgateWrite,
  openers: RoamgateWriteOpeners = OPENERS,
): boolean {
  const connectionId = openers.connectionId();
  if (!write.review || !connectionId) return false;
  openers.showReview(connectionId, write.review);
  return true;
}
