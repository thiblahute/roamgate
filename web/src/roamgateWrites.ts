import type { ReviewSummary } from "../../shared/review";
import {
  firstLine,
  isThreadWrite,
  type RoamgateWrite,
} from "../../shared/toolSummary";
import { getReviewSummary, requestReviewShown } from "./review";
import { store } from "./store";
import { openWork } from "./workOpen";

/** What opening a write's thread needs: overridden in tests. */
export type RoamgateWriteOpeners = {
  /** The connection the chat's session is on. */
  connectionId: () => string | null;
  /** Shows a review where it lives: Changes, a chat's pane, its view. */
  showReview: (connectionId: string, review: string) => void;
  /** Opens the Work board on an item. */
  showItem: (item: string) => void;
};

const OPENERS: RoamgateWriteOpeners = {
  connectionId: () => store.get().activeConnectionId,
  showReview: requestReviewShown,
  showItem: (item) => openWork(item),
};

/** Whether a write's row can open what it wrote in. */
export function canOpenRoamgateWrite(write: RoamgateWrite): boolean {
  return !!(write.item || write.review);
}

/**
 * Opens what a call wrote in (a chat tool row's link): a Work item's card
 * on the board, else the thread's review where that review lives (a Work
 * item's on the board too). False when the call did not say where.
 */
export function openRoamgateWrite(
  write: RoamgateWrite,
  openers: RoamgateWriteOpeners = OPENERS,
): boolean {
  if (write.item) {
    openers.showItem(write.item);
    return true;
  }
  const connectionId = openers.connectionId();
  if (!write.review || !connectionId) return false;
  openers.showReview(connectionId, write.review);
  return true;
}

const VERBS: Partial<Record<RoamgateWrite["action"], string>> = {
  reply: "Replied",
  comment: "Commented",
  draft: "Drafted a review comment",
  edit: "Edited a comment",
};

/** The first words of what was written, for a row's line. */
function firstWords(text: string, limit = 60) {
  const line = firstLine(text);
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/**
 * A write's row line: the call's description, else, for a thread of a
 * Work item, "Replied on Work: <its title> · <first words>" (the review
 * says whose it is), else the call's summary.
 */
export function roamgateWriteHeadline(
  write: RoamgateWrite,
  summary: string,
  review: (id: string) => Pick<ReviewSummary, "session"> | undefined = (id) =>
    getReviewSummary(id),
): string {
  if (write.description) return write.description;
  if (!isThreadWrite(write) || !write.review) return summary;
  const session = review(write.review)?.session;
  const verb = VERBS[write.action];
  if (session?.target?.kind !== "work" || !session.title || !verb)
    return summary;
  return `${verb} on ${session.title}${write.text ? ` · ${firstWords(write.text)}` : ""}`;
}
