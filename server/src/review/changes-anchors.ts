import type {
  ReviewAnchor,
  ReviewDiffFile,
  ReviewDiffLine,
  ReviewSide,
  ReviewThread,
} from "../../../shared/review";

/*
 * Plan D13 (decided: migrate): threads written in Changes before it showed
 * one combined diff per file are anchored on their entry's own diff, a
 * staged entry numbering its new side in the index, an unstaged one its old
 * side in the index. The worktree review's diff is the combined `git diff
 * HEAD`, so agents and GitLab drafts read those anchors on the wrong lines.
 * Each is placed again by its line's text as Changes places it on screen
 * (web changesThreads.ts) and written back: anchor and note (`feedback`)
 * then name the combined diff's line, the note's kind "combined". One
 * whose line cannot be found keeps its anchor and is listed, not drawn, as
 * before.
 */

/** The note kinds of Changes' per-entry working diffs. */
const ENTRY_KINDS = new Set(["staged", "unstaged", "untracked"]);

type Note = {
  source?: unknown;
  kind?: unknown;
  path?: unknown;
  side?: unknown;
  line?: unknown;
  endLine?: unknown;
  endSide?: unknown;
};

function noteOf(anchor: ReviewAnchor): Note | null {
  if (!anchor.feedback) return null;
  try {
    const note = JSON.parse(anchor.feedback) as Note;
    return note && typeof note === "object" ? note : null;
  } catch {
    return null;
  }
}

/** A thread written on a staged, unstaged or untracked entry's own diff. */
export function entryAnchored(thread: ReviewThread): boolean {
  const note = noteOf(thread.anchor);
  return (
    !!note &&
    note.source === "diff" &&
    typeof note.kind === "string" &&
    ENTRY_KINDS.has(note.kind) &&
    typeof thread.anchor.path === "string"
  );
}

function lineOf(row: ReviewDiffLine, side: ReviewSide): number | null {
  return side === "old" ? row.old : row.new;
}

/** Whether a row is a line of `side` (a context line is on both). */
function onSide(row: ReviewDiffLine, side: ReviewSide): boolean {
  if (row.kind === " ") return true;
  return side === "old" ? row.kind === "-" : row.kind === "+";
}

/**
 * The thread's anchor on the combined diff of its file, or null when its
 * line is not found there (it stays as written). A side the entry shares
 * with the combined diff (a staged entry's old side, HEAD; an unstaged or
 * untracked one's new side, the working tree) keeps its line while it
 * still reads as written; any other is found by its text, the nearest.
 */
export function combinedAnchor(
  thread: ReviewThread,
  file: ReviewDiffFile | undefined,
): ReviewAnchor | null {
  const note = noteOf(thread.anchor);
  if (!note || !entryAnchored(thread)) return null;
  const { anchor } = thread;
  const kind = note.kind as string;
  const side: ReviewSide = anchor.side ?? (note.side === "old" ? "old" : "new");
  const line = anchor.line;
  const text = anchor.text;
  const written = (to: { side: ReviewSide; line: number } | null) => {
    const next: ReviewAnchor = { ...anchor };
    const fields: Note = { ...note, kind: "combined" };
    if (to && line !== undefined) {
      next.side = to.side;
      next.line = to.line;
      fields.side = to.side;
      fields.line = to.line;
      if (anchor.endLine !== undefined) {
        next.endLine = to.line + (anchor.endLine - line);
        fields.endLine = next.endLine;
        if (fields.endSide !== undefined) fields.endSide = to.side;
      }
    }
    next.feedback = JSON.stringify(fields);
    return next;
  };
  // On the file and no line: nothing to find again.
  if (line === undefined || line <= 0) return written(null);
  if (!file) return null;
  const rows = file.hunks.flatMap((hunk) => hunk.lines);
  const shared =
    (kind === "staged" && side === "old") ||
    (kind !== "staged" && side === "new");
  if (shared) {
    const exact = rows.find(
      (row) =>
        onSide(row, side) &&
        lineOf(row, side) === line &&
        (text === undefined || row.text === text),
    );
    if (exact || text === undefined) return written({ side, line });
  }
  if (text === undefined) return null;
  let best: { side: ReviewSide; line: number; distance: number } | null = null;
  for (const row of rows) {
    if (row.text !== text) continue;
    // The side it was written on, else the other (a line moved to the
    // other side of the index keeps its words).
    const own = onSide(row, side);
    const foundSide: ReviewSide = own ? side : side === "old" ? "new" : "old";
    const found = lineOf(row, foundSide);
    if (found === null) continue;
    const distance = Math.abs(found - line) + (own ? 0 : 0.25);
    if (!best || distance < best.distance)
      best = { side: foundSide, line: found, distance };
  }
  return best ? written(best) : null;
}
