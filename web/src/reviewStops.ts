import type { ReviewComment, ReviewThread } from "../../shared/review";
import { messageLayout, quotedPart } from "./components/ReviewNoteBody";

/*
 * Where n / N and j / k stop in a review's comments: every message on a
 * line, in the order they are drawn, and each part of a message of
 * several, followed by the comments on that part.
 */

/** Where the comments on the whole review sit: above the first line. */
export const GENERAL_AT = -1;

/** A message under a line, or one part of it: where j / k and n / N stop. */
export type CommentStop = {
  /** Its line, or GENERAL_AT above the diff (review-level comments). */
  at: number;
  thread: ReviewThread;
  comment: ReviewComment;
  /** The part of the message (see messageBlocks); none on GitLab's. */
  part?: number;
};

/** The threads as drawn: above the diff, and under each row. */
export type StopPlacement = {
  general: readonly ReviewThread[];
  byRow: ReadonlyMap<number, readonly ReviewThread[]>;
};

/**
 * Every message on a line, in the order they are drawn: n / N stops. A
 * message of several parts is a stop as a whole (n / N land there), then
 * one per part (j / k step into them), each followed by the comments on
 * that part. A folded thread is one stop, its summary line. Above the
 * diff, the open forge discussions come first, then yours; under a row,
 * the forge's first.
 */
export function commentStops(
  placement: StopPlacement,
  commentRows: readonly number[],
  folded: (thread: ReviewThread) => boolean,
  partNotes: (commentId: string) => readonly ReviewThread[],
): CommentStop[] {
  const stops: CommentStop[] = [];
  const pushThread = (at: number, thread: ReviewThread) => {
    // A folded thread is one stop: its summary line.
    if (folded(thread)) {
      const first = thread.comments[0];
      if (first) stops.push({ at, thread, comment: first });
      return;
    }
    for (const comment of thread.comments) {
      if (thread.kind === "merge-request") {
        stops.push({ at, thread, comment });
        continue;
      }
      const layout = messageLayout(comment.body);
      const notes = new Map<number, ReviewThread[]>();
      for (const note of partNotes(comment.id)) {
        const part = quotedPart(layout, note.anchor.message?.quote ?? "");
        notes.set(part, [...(notes.get(part) ?? []), note]);
      }
      stops.push({ at, thread, comment });
      const parts = layout.quotes.length > 1 ? layout.quotes.length : 0;
      for (let part = 0; part < Math.max(1, parts); part++) {
        if (parts) stops.push({ at, thread, comment, part });
        for (const note of notes.get(part) ?? []) pushThread(at, note);
      }
    }
  };
  // Above the diff, as drawn: the open GitLab discussions, then yours.
  for (const thread of placement.general)
    if (thread.kind === "merge-request" && !thread.resolved)
      pushThread(GENERAL_AT, thread);
  for (const thread of placement.general)
    if (thread.kind !== "merge-request") pushThread(GENERAL_AT, thread);
  for (const at of commentRows) {
    const list = placement.byRow.get(at) ?? [];
    for (const thread of [
      ...list.filter((t) => t.kind === "merge-request"),
      ...list.filter((t) => t.kind !== "merge-request"),
    ])
      pushThread(at, thread);
  }
  return stops;
}

/**
 * The stops under a drawn line (`rows`: its rows, both halves side by
 * side), or above the diff for GENERAL_AT; none while comments are hidden.
 */
export function stopsOn(
  stops: readonly CommentStop[],
  at: number,
  rows: readonly number[],
  hidden: boolean,
): CommentStop[] {
  const own = at === GENERAL_AT ? [GENERAL_AT] : rows;
  return hidden ? [] : stops.filter((stop) => own.includes(stop.at));
}
