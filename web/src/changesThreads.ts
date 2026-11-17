import type { ReviewThread } from "../../shared/review";
import type { DiffReviewAnnotation } from "./annotations";
import type { DiffCursorRow } from "./diffCursor";
import { compareKeys, type NavPlace } from "./unresolvedThreads";

/*
 * The review's threads in Changes (plan: review into the inspector, phase
 * 4). Pure: where each thread is drawn among the files' lines, in what
 * order the walk (gn / gN) goes through them, which ones are on the
 * cursor's line.
 *
 * Threads written in Changes before the merge are anchored on each entry's
 * own diff: a staged entry numbers its new side in the index, an unstaged
 * one its old side in the index (plan D8). They are placed again by their
 * line text, as Files places a thread (placedInSource): on their
 * own entry's line while it still reads as written, else on the nearest
 * line of the same path, in any entry, that does; one found nowhere is
 * listed in the Comments panel and not drawn. Placed, never written back
 * here: the server moves stored anchors onto the combined diff (D13,
 * server/src/review/changes-anchors.ts); one it could not place keeps its
 * entry's anchor and is placed here by its text, or listed.
 */

/** A thread's place among the lines drawn. */
export type PlacedThread = {
  thread: ReviewThread;
  /** The section it is drawn in (Changes' `${kind}:${path}`). */
  key: string;
  path: string;
  side: "old" | "new";
  line: number;
  /** Not where it was written: found by its text on another line. */
  moved: boolean;
};

export type ThreadSection = { key: string; path: string };

/** The working changes' per-entry kinds the combined diff stands for. */
const WORKING_KINDS = new Set(["staged", "unstaged", "untracked", "combined"]);

/**
 * The section a thread belongs to: its own entry's, or its file's
 * combined diff when that is what is shown (the review in Changes, D8): a
 * thread written on a staged or unstaged entry not migrated yet (D13) is
 * placed there by its text.
 */
const sectionKeyOf = (
  annotation: DiffReviewAnnotation,
  keys: ReadonlySet<string>,
) => {
  const combined = `combined:${annotation.path}`;
  return WORKING_KINDS.has(annotation.kind) && keys.has(combined)
    ? combined
    : `${annotation.kind}:${annotation.path}`;
};

function lineOf(row: DiffCursorRow, side: "old" | "new"): number | null {
  return side === "old" ? row.old : row.new;
}

/** Whether a row is a line of `side` (a context line is on both). */
function onSide(row: DiffCursorRow, side: "old" | "new"): boolean {
  if (row.kind === " ") return true;
  return side === "old" ? row.kind === "-" : row.kind === "+";
}

/**
 * Where each thread of the diff's annotations is drawn. `rows` are the
 * lines of the files loaded (the cursor's model); a thread whose own file
 * is not loaded stays where it was written. Annotations the threads do not
 * answer (notes kept in this browser) are `notes`, drawn as they were.
 */
export function placeDiffThreads(
  annotations: readonly DiffReviewAnnotation[],
  threads: ReadonlyMap<string, ReviewThread>,
  sections: readonly ThreadSection[],
  rows: readonly DiffCursorRow[],
): { placed: PlacedThread[]; unplaced: ReviewThread[] } {
  const byKey = new Map<string, DiffCursorRow[]>();
  const byPath = new Map<string, DiffCursorRow[]>();
  for (const row of rows) {
    (byKey.get(row.key) ?? byKey.set(row.key, []).get(row.key)!).push(row);
    (byPath.get(row.path) ?? byPath.set(row.path, []).get(row.path)!).push(row);
  }
  const shown = new Set(sections.map((section) => section.path));
  const keys = new Set(sections.map((section) => section.key));
  const placed: PlacedThread[] = [];
  const unplaced: ReviewThread[] = [];
  for (const annotation of annotations) {
    const thread = threads.get(annotation.id);
    if (!thread || !shown.has(annotation.path)) continue;
    const own = sectionKeyOf(annotation, keys);
    const side = annotation.side;
    // Words of a rendered file (Files, D16) are not a source line's: its
    // line is where it is, as Files places it (placedInSource).
    const text = thread.anchor.render ? undefined : thread.anchor.text;
    const ownRows = byKey.get(own);
    const stay: PlacedThread = {
      thread,
      key: own,
      path: annotation.path,
      side,
      line: annotation.line,
      moved: false,
    };
    // Its own file is not loaded (or has no lines): where it was written.
    if (!ownRows?.length && !byPath.get(annotation.path)?.length) {
      placed.push(stay);
      continue;
    }
    const exact = ownRows?.find(
      (row) =>
        onSide(row, side) &&
        lineOf(row, side) === annotation.line &&
        (text === undefined || row.text === text),
    );
    if (exact) {
      placed.push(stay);
      continue;
    }
    // Nothing to find it by but its line, its own section not drawn: on
    // that line of the path where another section shows it.
    if (text === undefined && !ownRows?.length) {
      const found = byPath
        .get(annotation.path)
        ?.find(
          (row) => onSide(row, side) && lineOf(row, side) === annotation.line,
        );
      if (found) {
        placed.push({ ...stay, key: found.key });
        continue;
      }
    }
    if (text !== undefined) {
      let best: { row: DiffCursorRow; distance: number } | null = null;
      for (const row of byPath.get(annotation.path) ?? []) {
        if (row.text !== text) continue;
        // The side it was written on, else the other (a line moved to
        // the other side of the index keeps its words).
        const line =
          lineOf(row, side) ?? lineOf(row, side === "old" ? "new" : "old");
        if (line === null) continue;
        const distance =
          Math.abs(line - annotation.line) +
          (row.key === own ? 0 : 0.5) +
          (onSide(row, side) ? 0 : 0.25);
        if (!best || distance < best.distance) best = { row, distance };
      }
      if (best) {
        const found = best.row;
        const foundSide: "old" | "new" = onSide(found, side)
          ? side
          : side === "old"
            ? "new"
            : "old";
        placed.push({
          thread,
          key: found.key,
          path: annotation.path,
          side: foundSide,
          line: lineOf(found, foundSide) ?? annotation.line,
          moved: true,
        });
        continue;
      }
    }
    // A comment on a file as a whole has no line to be found again.
    if (annotation.line <= 0) {
      placed.push(stay);
      continue;
    }
    // Only when its own file's lines are loaded can it be said to be gone.
    if (ownRows?.length) unplaced.push(thread);
    else placed.push(stay);
  }
  return { placed, unplaced };
}

/** The threads in the order they are read: file by file, then by line. */
export function threadReadingOrder(
  placed: readonly PlacedThread[],
  sections: readonly ThreadSection[],
): PlacedThread[] {
  const order = new Map(sections.map((section, at) => [section.key, at]));
  return [...placed].sort(
    (a, b) =>
      compareKeys(
        [order.get(a.key) ?? Number.MAX_SAFE_INTEGER, a.line, a.side],
        [order.get(b.key) ?? Number.MAX_SAFE_INTEGER, b.line, b.side],
      ) || a.thread.createdAt.localeCompare(b.thread.createdAt),
  );
}

/** What the cursor is on, as threads are placed. */
export type CursorSpot = {
  key: string;
  old: number | null;
  new: number | null;
  /** The side the cursor is on. */
  side: "old" | "new";
};

/** The threads drawn under the cursor's line, in their order. */
export function threadsAtCursor(
  order: readonly PlacedThread[],
  spot: CursorSpot,
): PlacedThread[] {
  return order.filter((each) => {
    if (each.key !== spot.key) return false;
    const line = each.side === "old" ? spot.old : spot.new;
    return line === each.line;
  });
}

/**
 * Where the cursor is among the threads for gn / gN: on one, or before the
 * first one after its line.
 */
export function cursorThreadPlace(
  order: readonly PlacedThread[],
  sections: readonly ThreadSection[],
  spot: CursorSpot,
  direction: 1 | -1,
): NavPlace {
  const here = threadsAtCursor(order, spot);
  const first = here[0];
  if (first) {
    const index = order.indexOf(first);
    // Going back from the last thread on the line, forward from the first.
    return {
      index: direction === 1 ? order.indexOf(here[here.length - 1]!) : index,
      on: true,
    };
  }
  const rank = new Map(sections.map((section, at) => [section.key, at]));
  const line = spot.new ?? spot.old ?? 0;
  const after = order.findIndex(
    (each) =>
      compareKeys(
        [rank.get(each.key) ?? Number.MAX_SAFE_INTEGER, each.line],
        [rank.get(spot.key) ?? Number.MAX_SAFE_INTEGER, line],
      ) > 0,
  );
  return { index: after < 0 ? order.length : after, on: false };
}

/**
 * Marks the lines a thread is on (`data-thread-mark`) among a file's drawn
 * lines, as the review pane marks them in its margin: shown while the
 * comments are hidden too. `marks` are "old:N" / "new:N".
 */
export function markThreadLines(root: ParentNode, marks: ReadonlySet<string>) {
  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-line][data-line-type], [data-column-number]",
  )) {
    const number =
      element.getAttribute("data-line") ??
      element.getAttribute("data-column-number");
    const type = element.getAttribute("data-line-type") ?? "";
    const old =
      type === "change-deletion" ||
      element.closest("[data-deletions]") !== null;
    const own = marks.has(`${old ? "old" : "new"}:${number}`);
    // A line on both sides (unchanged) is marked from either.
    const either =
      !own &&
      (type === "context" || type === "context-expanded") &&
      marks.has(`${old ? "new" : "old"}:${number}`);
    if (own || either) element.setAttribute("data-thread-mark", "");
    else element.removeAttribute("data-thread-mark");
  }
}
