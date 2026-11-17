import type { FileDiffMetadata } from "@pierre/diffs";
import {
  type Cursor,
  findMatches,
  type Match,
  searchRegExp,
  type SplitLine,
  splitStep,
  wordMotion,
} from "./reviewNavigation";

/*
 * The review's cursor rows, read from what Pierre draws (its parsed hunks):
 * one row per line of every file shown, in Pierre's unified order (a
 * change's removed lines, then its added ones), the side by side pairing of
 * its split view, the hunks and files the keys go through. The Vim cursor
 * of Changes moves on these rows, never on the DOM: rows off screen are not
 * drawn under virtualization. Pure: no DOM, no React.
 */

/** One line of a file's diff, as the cursor goes through it. */
export type DiffCursorRow = {
  /** The file's section (Changes' `${kind}:${path}`). */
  key: string;
  path: string;
  /** The file's index among the model's files. */
  file: number;
  /** The hunk's index in its file. */
  hunk: number;
  /** "+" added, "-" removed, " " unchanged. */
  kind: "+" | "-" | " ";
  old: number | null;
  new: number | null;
  /** The line's text, without its sign or line end. */
  text: string;
};

export type DiffCursorFile = {
  key: string;
  path: string;
  /** Its first row, and the row after its last. */
  start: number;
  end: number;
};

export type DiffCursorModel = {
  rows: DiffCursorRow[];
  files: DiffCursorFile[];
  /** Side by side: each drawn line, with the rows of its two halves. */
  splitLines: SplitLine[];
  /** Each path's new lines by number, for suggestions on them. */
  newLinesByPath: Map<string, Map<number, string>>;
};

/** A file of what is shown: its section, path and Pierre's parsed patch. */
export type DiffCursorSource = {
  key: string;
  path: string;
  diff: Pick<FileDiffMetadata, "hunks" | "additionLines" | "deletionLines">;
};

const lineText = (line: string | undefined) =>
  (line ?? "").replace(/\r?\n$/, "");

export function diffCursorModel(
  sources: readonly DiffCursorSource[],
): DiffCursorModel {
  const rows: DiffCursorRow[] = [];
  const files: DiffCursorFile[] = [];
  const splitLines: SplitLine[] = [];
  const newLinesByPath = new Map<string, Map<number, string>>();
  sources.forEach(({ key, path, diff }, file) => {
    const start = rows.length;
    const newLines = newLinesByPath.get(path) ?? new Map<number, string>();
    newLinesByPath.set(path, newLines);
    diff.hunks.forEach((hunk, hunkIndex) => {
      let old = hunk.deletionStart;
      let added = hunk.additionStart;
      const push = (
        row: Omit<DiffCursorRow, "key" | "path" | "file" | "hunk">,
      ) => rows.push({ key, path, file, hunk: hunkIndex, ...row }) - 1;
      for (const content of hunk.hunkContent) {
        if (content.type === "context") {
          for (let index = 0; index < content.lines; index++) {
            const text = lineText(
              diff.additionLines[content.additionLineIndex + index],
            );
            newLines.set(added, text);
            const at = push({ kind: " ", old: old++, new: added++, text });
            splitLines.push({ left: at, right: at });
          }
          continue;
        }
        const removed: number[] = [];
        for (let index = 0; index < content.deletions; index++)
          removed.push(
            push({
              kind: "-",
              old: old++,
              new: null,
              text: lineText(
                diff.deletionLines[content.deletionLineIndex + index],
              ),
            }),
          );
        const addedRows: number[] = [];
        for (let index = 0; index < content.additions; index++) {
          const text = lineText(
            diff.additionLines[content.additionLineIndex + index],
          );
          newLines.set(added, text);
          addedRows.push(push({ kind: "+", old: null, new: added++, text }));
        }
        for (
          let index = 0;
          index < Math.max(removed.length, addedRows.length);
          index++
        )
          splitLines.push({
            left: removed[index] ?? null,
            right: addedRows[index] ?? null,
          });
      }
    });
    files.push({ key, path, start, end: rows.length });
  });
  return { rows, files, splitLines, newLinesByPath };
}

/** Where Pierre draws a row: its line number on a side of the diff. */
export function rowLine(
  row: DiffCursorRow,
  side: "left" | "right" = "right",
): { line: number; side: "deletions" | "additions" } {
  if (row.kind === "-") return { line: row.old!, side: "deletions" };
  if (row.kind === "+") return { line: row.new!, side: "additions" };
  return side === "left"
    ? { line: row.old!, side: "deletions" }
    : { line: row.new!, side: "additions" };
}

/** The row Pierre draws at a line number of a side of a file, or -1. */
export function rowAt(
  model: DiffCursorModel,
  key: string,
  line: number,
  side: "deletions" | "additions",
): number {
  const file = model.files.find((each) => each.key === key);
  if (!file) return -1;
  for (let at = file.start; at < file.end; at++) {
    const row = model.rows[at]!;
    if (side === "deletions" ? row.old === line : row.new === line)
      if (row.kind !== (side === "deletions" ? "+" : "-")) return at;
  }
  return -1;
}

/**
 * j / k: `delta` lines down or up from `at`. Side by side, drawn lines on
 * one side (the other's where that line has none there).
 */
export function stepRows(
  model: DiffCursorModel,
  at: number,
  delta: number,
  side: "left" | "right" | null,
): number {
  const last = model.rows.length - 1;
  if (last < 0) return 0;
  if (side) {
    const next = splitStep(model.splitLines, at, delta, side);
    if (next !== null) return next;
  }
  return Math.max(0, Math.min(last, at + delta));
}

/** `}` / `{`: the first row of the next or previous hunk, `count` times. */
export function hunkStep(
  model: DiffCursorModel,
  at: number,
  direction: 1 | -1,
  count: number,
): number {
  const { rows } = model;
  const same = (a: number, b: number) =>
    rows[a]!.hunk === rows[b]!.hunk && rows[a]!.file === rows[b]!.file;
  for (let step = 0; step < count; step++) {
    if (direction === 1) {
      let next = at + 1;
      while (next < rows.length && same(next, at)) next++;
      if (next >= rows.length) break;
      at = next;
    } else {
      let start = at;
      while (start > 0 && same(start - 1, at)) start--;
      if (start < at) at = start;
      else if (start > 0) {
        let previous = start - 1;
        while (previous > 0 && same(previous - 1, start - 1)) previous--;
        at = previous;
      }
    }
  }
  return at;
}

/** `]` / `[`: the first row of the file `delta` files away, or null. */
export function fileStep(
  model: DiffCursorModel,
  at: number,
  delta: number,
): number | null {
  const current = model.rows[at]?.file ?? 0;
  const file = model.files[current + delta];
  return file && file.end > file.start ? file.start : null;
}

/**
 * A row inside the file of `anchor` (a Visual selection stays in the file
 * it started in), else the row clamped to the model.
 */
export function clampRow(
  model: DiffCursorModel,
  at: number,
  anchor: number | null,
): number {
  const { rows } = model;
  if (!rows.length) return 0;
  let target = Math.max(0, Math.min(rows.length - 1, at));
  if (anchor !== null && rows[anchor]) {
    const file = rows[anchor]!.file;
    while (rows[target]!.file !== file) target += target > anchor ? -1 : 1;
  }
  return target;
}

/** `w`, `b`, `e` (and `W`, `B`, `E`) `count` times from the cursor. */
export function wordStep(
  model: DiffCursorModel,
  cursor: Cursor,
  motion: "w" | "b" | "e",
  count: number,
): Cursor {
  const texts = model.rows.map((row) => row.text);
  let next = cursor;
  for (let step = 0; step < count; step++)
    next = wordMotion(texts, next, motion);
  return next;
}

/**
 * The search's hits: the lines that match, and the files whose path does
 * (at their first line), in the rows' order.
 */
export function searchHits(
  model: DiffCursorModel,
  pattern: string,
  wholeWord: boolean,
): Match[] {
  const found = findMatches(
    model.rows.map((row) => row.text),
    pattern,
    wholeWord,
  );
  const regexp = searchRegExp(pattern, wholeWord);
  if (!regexp) return found;
  for (const file of model.files) {
    regexp.lastIndex = 0;
    if (
      file.end <= file.start ||
      !regexp.test(file.path) ||
      found.some((match) => match.at === file.start && match.start === 0)
    )
      continue;
    found.push({ at: file.start, start: 0, end: 0 });
  }
  return found.sort((a, b) => a.at - b.at || a.start - b.start);
}

/** How the screen follows the cursor: see `scrollTarget`. */
export type ScrollMode = "center" | "start" | "end" | "nearest" | "reveal";

/**
 * Where the scroller goes (its new scrollTop) to show a row, or null when
 * it stays. `inset` is the height of what stays stuck atop the scroller
 * over the row (its file's header): the row goes below it, never under.
 * "reveal" (a search's hit) keeps `margin` around the row; a row further
 * than half a screen away is centred, as Vim's search does.
 */
export function scrollTarget(
  place: { top: number; height: number },
  view: { top: number; height: number },
  mode: ScrollMode,
  inset = 0,
  margin = 0,
): number | null {
  const { top, height } = view;
  const room = Math.max(place.height, height - inset);
  const center = place.top - inset - (room - place.height) / 2;
  let next = top;
  if (mode === "start") next = place.top - inset;
  else if (mode === "end") next = place.top + place.height - height;
  else if (mode === "center") next = center;
  else {
    const pad =
      mode === "reveal" ? Math.min(margin, (room - place.height) / 2) : 0;
    const first = top + inset + pad;
    const last = top + height - pad;
    if (place.top < first) next = place.top - inset - pad;
    else if (place.top + place.height > last)
      next = place.top + place.height - height + pad;
    if (
      mode === "reveal" &&
      (first - place.top > room / 2 ||
        place.top + place.height - last > room / 2)
    )
      next = center;
  }
  next = Math.max(0, next);
  return Math.abs(next - top) < 1 ? null : next;
}

/**
 * The height of what sticks atop a diff's scroller over a file's rows: the
 * stuck elements of the file's section (its header) and of the scroller
 * outside every section, each its `top` plus its height.
 */
export function stickyInset(
  scroller: HTMLElement,
  section: HTMLElement | null,
): number {
  const candidates: Element[] = [];
  if (section) candidates.push(...section.children);
  for (const child of scroller.children) {
    if (child.hasAttribute("data-diff-entry-key")) continue;
    candidates.push(child);
    for (const inner of child.children)
      if (!inner.hasAttribute("data-diff-entry-key")) candidates.push(inner);
  }
  const view = scroller.ownerDocument.defaultView;
  let inset = 0;
  for (const element of candidates) {
    if (!(element instanceof (view?.HTMLElement ?? HTMLElement))) continue;
    const style = view?.getComputedStyle(element);
    if (style?.position !== "sticky") continue;
    const stuck = Number.parseFloat(style.top);
    if (!Number.isFinite(stuck)) continue;
    inset = Math.max(inset, stuck + element.offsetHeight);
  }
  return inset;
}

/** The paths of the files with a hit, for the tree to mark. */
export function filesWithHits(
  model: DiffCursorModel,
  hits: readonly Match[],
): string[] {
  const paths = new Set<string>();
  for (const hit of hits) {
    const row = model.rows[hit.at];
    if (row) paths.add(row.path);
  }
  return [...paths];
}

/**
 * H / M / L: of the rows on the screen (top to bottom), the `count`th from
 * the top, the middle one, the `count`th from the bottom.
 */
export function screenRow(
  visible: readonly number[],
  key: "H" | "M" | "L",
  count: number,
): number | null {
  if (!visible.length) return null;
  if (key === "H") return visible[Math.min(visible.length - 1, count - 1)]!;
  if (key === "L") return visible[Math.max(0, visible.length - count)]!;
  return visible[Math.floor(visible.length / 2)]!;
}
