import type {
  ReviewDiff,
  ReviewDiffFile,
  ReviewDiffLine,
} from "../../shared/review";
import {
  contextForLine,
  expandDiff,
  type FileExpansion,
  type GapInfo,
  type GapState,
} from "./reviewModel";

/*
 * Context expansion in Changes: Roamgate owns it. The lines revealed in each gap
 * (reviewModel's FileExpansion: the file's new side, a GapState per gap)
 * are written into the file's patch as context, and Pierre draws that
 * patch: it never expands anything itself. The hunks are kept apart, even
 * a gap shown whole (two hunks then touch, drawn as one stretch), so that
 * each row keeps its hunk and the reviewed marks their chunks.
 */

/** A line of a patch, and whether git said it has no newline at its end. */
type PatchLine = ReviewDiffLine & { noNewline?: boolean };

/** A one-file patch read: its header lines, and its hunks. */
export type ParsedPatch = {
  head: string[];
  file: ReviewDiffFile;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Reads a patch of one file (git diff); null when it has no hunk to read. */
export function parsePatch(patch: string): ParsedPatch | null {
  const head: string[] = [];
  const file: ReviewDiffFile = { path: "", oldPath: "", hunks: [] };
  let oldLine = 0;
  let newLine = 0;
  let last: PatchLine | null = null;
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const header = HUNK.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      file.hunks.push({ header: line, lines: [] });
      last = null;
      continue;
    }
    const hunk = file.hunks[file.hunks.length - 1];
    if (!hunk) {
      head.push(line);
      continue;
    }
    if (line.startsWith("\\")) {
      if (last) last.noNewline = true;
      continue;
    }
    const kind = line[0] ?? " ";
    if (kind !== " " && kind !== "+" && kind !== "-") return null;
    last = {
      kind,
      old: kind === "+" ? null : oldLine,
      new: kind === "-" ? null : newLine,
      text: line.slice(1),
    };
    hunk.lines.push(last);
    if (kind !== "+") oldLine += 1;
    if (kind !== "-") newLine += 1;
  }
  return file.hunks.length ? { head, file } : null;
}

/** Where a gap's controls are drawn: under this line (0: above the file). */
export type GapAnchor = { side: "old" | "new"; line: number };

export type ChangesGap = GapInfo & {
  anchor: GapAnchor;
  /**
   * Side by side: under this old-side line, from where the row is drawn
   * across both sides (the hunk above ends on a line of both); null when
   * it cannot be (the hunk ends on added lines).
   */
  across: GapAnchor | null;
};

function range(header: string) {
  const match = HUNK.exec(header);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    rest: match[5] ?? "",
  };
}

function context(
  lines: readonly string[],
  from: number,
  to: number,
  offset: number,
): PatchLine[] {
  const found: PatchLine[] = [];
  for (let at = from; at <= to; at++)
    found.push({
      kind: " ",
      old: at - offset,
      new: at,
      text: lines[at - 1] ?? "",
      expanded: true,
    });
  return found;
}

/**
 * The patch with the lines revealed put back as context, each hunk kept
 * apart, and the gaps still hidden with where their controls go. The
 * patch is the same text when nothing is revealed.
 */
export function expandPatch(
  patch: string,
  expansion: FileExpansion | undefined,
): { patch: string; gaps: ChangesGap[] } {
  const parsed = parsePatch(patch);
  if (!parsed) return { patch, gaps: [] };
  const { file } = parsed;
  const ranges = file.hunks.map((hunk) => range(hunk.header));
  if (ranges.some((each) => !each)) return { patch, gaps: [] };
  // A new file (nothing on the old side) is whole in its patch: nothing
  // around it to show.
  if (ranges.every((each) => each!.oldCount === 0)) return { patch, gaps: [] };
  // What is still hidden, as reviewModel's expandDiff counts it.
  const { gaps } = expandDiff(
    { files: [file], truncated: false } as ReviewDiff,
    expansion ? new Map([[0, expansion]]) : new Map(),
  );
  if (!gaps.size && !expansion) return { patch, gaps: [] };
  const hunks = file.hunks.map((hunk) => ({
    lines: [...hunk.lines] as PatchLine[],
    rest: range(hunk.header)!.rest,
    oldStart: range(hunk.header)!.oldStart,
    newStart: range(hunk.header)!.newStart,
  }));
  if (expansion) {
    let previousNewEnd = 0;
    ranges.forEach((each, index) => {
      const at = each!;
      const offset = at.newStart - at.oldStart;
      const from = index === 0 ? 1 : previousNewEnd + 1;
      const to = at.newStart - 1;
      const size = Math.max(0, to - from + 1);
      const state: GapState = expansion.gaps.get(index) ?? {
        top: 0,
        bottom: 0,
      };
      const top = index === 0 ? 0 : Math.min(state.top, size);
      const bottom =
        state.all || top + state.bottom >= size
          ? size - top
          : Math.min(state.bottom, size - top);
      if (top)
        hunks[index - 1]!.lines.push(
          ...context(expansion.lines, from, from + top - 1, offset),
        );
      if (bottom)
        hunks[index]!.lines.unshift(
          ...context(expansion.lines, to - bottom + 1, to, offset),
        );
      previousNewEnd = at.newCount
        ? at.newStart + at.newCount - 1
        : at.newStart;
    });
    const last = ranges[ranges.length - 1]!;
    const endOffset =
      previousNewEnd -
      (last.oldCount ? last.oldStart + last.oldCount - 1 : last.oldStart);
    const end = expansion.gaps.get(file.hunks.length) ?? { top: 0, bottom: 0 };
    const from = previousNewEnd + 1;
    const remaining = Math.max(0, expansion.lines.length - from + 1);
    const top = end.all ? remaining : Math.min(end.top, remaining);
    const tail = hunks[hunks.length - 1]!;
    // A last line with no newline is the file's end: nothing comes after.
    if (top && !tail.lines[tail.lines.length - 1]?.noNewline)
      tail.lines.push(
        ...context(expansion.lines, from, from + top - 1, endOffset),
      );
  }
  const text: string[] = [...parsed.head];
  for (const hunk of hunks) {
    const olds = hunk.lines.filter((line) => line.old !== null);
    const news = hunk.lines.filter((line) => line.new !== null);
    const oldStart = olds[0]?.old ?? hunk.oldStart;
    const newStart = news[0]?.new ?? hunk.newStart;
    text.push(
      `@@ -${oldStart},${olds.length} +${newStart},${news.length} @@${hunk.rest}`,
    );
    for (const line of hunk.lines) {
      text.push(`${line.kind}${line.text}`);
      if (line.noNewline) text.push("\\ No newline at end of file");
    }
  }
  const shown: ChangesGap[] = [...gaps.values()]
    .sort((a, b) => a.gap - b.gap)
    .map((gap) => {
      if (gap.gap === 0)
        return {
          ...gap,
          anchor: { side: "new", line: 0 },
          across: { side: "old", line: 0 },
        };
      const above = hunks[gap.gap - 1]!.lines;
      const lastNew = [...above].reverse().find((line) => line.new !== null);
      const last = above[above.length - 1];
      return {
        ...gap,
        anchor: lastNew
          ? { side: "new", line: lastNew.new! }
          : { side: "old", line: last?.old ?? 0 },
        across:
          last && last.old !== null ? { side: "old", line: last.old } : null,
      };
    });
  return { patch: `${text.join("\n")}\n`, gaps: shown };
}

/**
 * The gaps to open so that the new-side `line` shows with three lines each
 * side (a thread on unchanged code).
 */
export function revealLine(
  patch: string,
  line: number,
): { gap: number; change: (state: GapState) => GapState } | null {
  const parsed = parsePatch(patch);
  return parsed ? contextForLine(parsed.file, line) : null;
}

/**
 * Whether the file read is the new side the patch shows: every line the
 * patch has on the new side reads the same in it (a staged entry or a
 * branch whose file has other changes in the checkout does not).
 */
export function patchMatches(patch: string, lines: readonly string[]): boolean {
  const parsed = parsePatch(patch);
  if (!parsed) return false;
  return parsed.file.hunks.every((hunk) =>
    hunk.lines.every(
      (each) => each.new === null || lines[each.new - 1] === each.text,
    ),
  );
}

/** Applies gap changes to a file's expansion (its lines read once). */
export function withGaps(
  current: FileExpansion | undefined,
  lines: string[],
  changes: readonly { gap: number; change: (state: GapState) => GapState }[],
): FileExpansion {
  const gaps = new Map(current?.gaps ?? []);
  for (const { gap, change } of changes)
    gaps.set(gap, change(gaps.get(gap) ?? { top: 0, bottom: 0 }));
  return { lines: current?.lines ?? lines, gaps };
}
