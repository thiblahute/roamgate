/*
 * Reviewed chunks and files in Changes, on the rows of the cursor's model.
 * Changes draws a path once per entry (staged, unstaged), so a path's chunks
 * are the entries' chunks in order: a chunk keeps its mark through staging,
 * because its id hashes the path and the changed lines only (hunkIds), never
 * the entry.
 *
 * The marks themselves are the review's (`session.reviewed`, reviewNavigation
 * and reviewToggle); this module only reads Changes' rows as those see
 * files and chunks, and tells each chunk's staged state.
 */
import type { DiffCursorModel } from "./diffCursor";
import type { GitLineRanges } from "./types";
import {
  type HunkUnit,
  hunkIds,
  type ReviewedFile,
  type ReviewedState,
} from "./reviewNavigation";
import { fileFingerprint } from "./reviewToggle";

/** The review view the checkout's worktree review keeps its marks in. */
export const CHANGES_REVIEW_VIEW = "all";

/** One chunk of the rows: its entry, its place in it and its path. */
export type ChangesChunk = {
  /** The entry's section key (`kind:path`). */
  key: string;
  path: string;
  /** The chunk's index in its entry, as the cursor's rows count. */
  hunk: number;
  /** The path's chunk index among all its entries' chunks. */
  index: number;
  /** The chunk's id (hunkIds). */
  id: string;
  /** The first and last row. */
  start: number;
  end: number;
};

export type ChangesReviewedLayout = {
  /** Each path as the reviewed marks see it, in the diff's order. */
  files: ReviewedFile[];
  /** Each path's chunks. */
  chunks: ChangesChunk[][];
  /** Each row's chunk (`file` is the path's index), null when none. */
  units: HunkUnit[];
};

type Lines = { kind: "+" | "-" | " "; text: string }[];

/** Changes' rows read as the reviewed marks see them. */
export function reviewedLayout(model: DiffCursorModel): ChangesReviewedLayout {
  const pathIndex = new Map<string, number>();
  const chunks: ChangesChunk[][] = [];
  const lines: Lines[][] = [];
  const units: HunkUnit[] = [];
  model.rows.forEach((row, at) => {
    let file = pathIndex.get(row.path);
    if (file === undefined) {
      file = chunks.length;
      pathIndex.set(row.path, file);
      chunks.push([]);
      lines.push([]);
    }
    const own = chunks[file]!;
    let chunk = own.find(
      (each) => each.key === row.key && each.hunk === row.hunk,
    );
    if (!chunk) {
      chunk = {
        key: row.key,
        path: row.path,
        hunk: row.hunk,
        index: own.length,
        id: "",
        start: at,
        end: at,
      };
      own.push(chunk);
      lines[file]!.push([]);
    }
    chunk.end = at;
    lines[file]![chunk.index]!.push({ kind: row.kind, text: row.text });
    units.push({ file, hunk: chunk.index });
  });
  const files = [...pathIndex.keys()].map((path, file) => {
    const ids = hunkIds(
      path,
      lines[file]!.map((own) => ({ lines: own })),
    );
    chunks[file]!.forEach((chunk, index) => {
      chunk.id = ids[index]!;
    });
    return {
      path,
      fingerprint: fileFingerprint({
        hunks: lines[file]!.map((own) => ({ lines: own })),
      }),
      hunks: ids,
    };
  });
  return { files, chunks, units };
}

/**
 * The view a review's marks are kept in: the commit shown (its sha), else all
 * the changes (`all`). A commit's message and its files are that commit's:
 * marked in one commit, the others keep their own marks.
 */
export function changesReviewView(commit: string | null | undefined): string {
  return commit || CHANGES_REVIEW_VIEW;
}

/** What the index holds of a chunk: the marker each chunk carries. */
export type ChunkStage = "staged" | "unstaged" | "partly";

const baseId = (id: string) => id.replace(/~\d+$/, "");

/** A chunk's key in `chunkStages`. */
export const chunkStageKey = (key: string, hunk: number) => `${key}\n${hunk}`;

/** The changed lines the index holds of a combined diff (git.diff_file). */
export type StagedLines = { old: GitLineRanges; new: GitLineRanges };

const inRanges = (ranges: GitLineRanges, line: number) =>
  ranges.some(([first, last]) => line >= first && line <= last);

/**
 * A combined diff's chunk's staged state, exactly, from the server's
 * staged lines: staged when the index holds every changed line of it,
 * unstaged when none, partly staged otherwise. Unknown (an untracked file,
 * a conflict, a cut patch): unstaged.
 */
export function combinedChunkStage(
  rows: readonly {
    kind: "+" | "-" | " ";
    old: number | null;
    new: number | null;
  }[],
  staged: StagedLines | undefined,
): ChunkStage {
  if (!staged) return "unstaged";
  let some = false;
  let all = true;
  for (const row of rows) {
    if (row.kind === " ") continue;
    const held =
      row.kind === "-"
        ? row.old !== null && inRanges(staged.old, row.old)
        : row.new !== null && inRanges(staged.new, row.new);
    some ||= held;
    all &&= held;
  }
  return some ? (all ? "staged" : "partly") : "unstaged";
}

/**
 * Each chunk's staged state. A combined diff's chunk (the review in
 * Changes, `combined:` sections) is told exactly from the server's staged
 * lines (`staged`, by section key). An entry's own kind says where its
 * chunk lives; an unstaged chunk whose changed lines (same id) the path's
 * staged entry holds too is partly staged.
 */
export function chunkStages(
  layout: ChangesReviewedLayout,
  model?: DiffCursorModel,
  stagedLines?: ReadonlyMap<string, StagedLines | undefined>,
): Map<string, ChunkStage> {
  const stages = new Map<string, ChunkStage>();
  for (const own of layout.chunks) {
    const staged = new Set(
      own
        .filter((chunk) => chunk.key.startsWith("staged:"))
        .map((chunk) => baseId(chunk.id)),
    );
    for (const chunk of own) {
      if (chunk.key.startsWith("combined:")) {
        stages.set(
          chunkStageKey(chunk.key, chunk.hunk),
          combinedChunkStage(
            model?.rows.slice(chunk.start, chunk.end + 1) ?? [],
            stagedLines?.get(chunk.key),
          ),
        );
        continue;
      }
      const here = chunk.key.startsWith("staged:") ? "staged" : "unstaged";
      stages.set(
        chunkStageKey(chunk.key, chunk.hunk),
        here === "unstaged" && staged.has(baseId(chunk.id)) ? "partly" : here,
      );
    }
  }
  return stages;
}

/** A chunk as the lines Pierre draws it: its marker, for `markChunks`. */
export type ChunkSpan = {
  /** The chunk's new-side and old-side line ranges (null: no such lines). */
  added: [number, number] | null;
  removed: [number, number] | null;
  stage: ChunkStage;
  reviewed: boolean;
  /** The chunk's id (hunkIds) and its first and last row of the model. */
  id: string;
  rows: [number, number];
  /** Reviewed and folded away to one line (no thread on it, not peeked). */
  folded?: boolean;
};

/**
 * Every entry's chunks as spans: from the layout's rows (`model`), each
 * chunk's staged state and whether the review has it reviewed.
 */
export function chunkSpans(
  model: DiffCursorModel,
  layout: ChangesReviewedLayout,
  state: ReviewedState,
  /** A combined section's staged lines, by its key (git.diff_file). */
  stagedLines?: ReadonlyMap<string, StagedLines | undefined>,
): Map<string, ChunkSpan[]> {
  const stages = chunkStages(layout, model, stagedLines);
  const spans = new Map<string, ChunkSpan[]>();
  layout.chunks.forEach((own, file) => {
    for (const chunk of own) {
      let added: [number, number] | null = null;
      let removed: [number, number] | null = null;
      for (let at = chunk.start; at <= chunk.end; at++) {
        const row = model.rows[at]!;
        if (row.new !== null)
          added = added
            ? [Math.min(added[0], row.new), Math.max(added[1], row.new)]
            : [row.new, row.new];
        if (row.old !== null)
          removed = removed
            ? [Math.min(removed[0], row.old), Math.max(removed[1], row.old)]
            : [row.old, row.old];
      }
      const list = spans.get(chunk.key) ?? [];
      list.push({
        added,
        removed,
        stage: stages.get(chunkStageKey(chunk.key, chunk.hunk)) ?? "unstaged",
        reviewed: state.hunks[file]?.has(chunk.index) ?? false,
        id: chunk.id,
        rows: [chunk.start, chunk.end],
      });
      spans.set(chunk.key, list);
    }
  });
  return spans;
}

const STAGE_TITLE: Record<ChunkStage, string> = {
  staged: "Staged chunk",
  unstaged: "Unstaged chunk",
  partly: "Partly staged chunk",
};

/**
 * Marks the drawn lines of a file with their chunk's state, for the
 * stylesheet (data-chunk-stage on a line and its number, data-chunk-reviewed
 * on a reviewed one). Called after each of Pierre's renders.
 */
export function markChunks(root: ParentNode, spans: readonly ChunkSpan[]) {
  // A folded chunk keeps its first line in each column, as its placeholder.
  const heads = new Map<Element | null, Set<ChunkSpan>>();
  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-line][data-line-type], [data-column-number]",
  )) {
    const number = Number(
      element.getAttribute("data-line") ??
        element.getAttribute("data-column-number"),
    );
    const type = element.getAttribute("data-line-type") ?? "";
    const deletions =
      type === "change-deletion" ||
      element.closest("[data-deletions]") !== null;
    const span = spans.find((each) => {
      const range = deletions ? each.removed : each.added;
      return !!range && number >= range[0] && number <= range[1];
    });
    element.removeAttribute("data-chunk-folded");
    element.removeAttribute("data-chunk-fold-head");
    element.removeAttribute("data-chunk-fold-label");
    if (!span) {
      element.removeAttribute("data-chunk-stage");
      element.removeAttribute("data-chunk-reviewed");
      continue;
    }
    element.setAttribute("data-chunk-stage", span.stage);
    if (span.reviewed) element.setAttribute("data-chunk-reviewed", "");
    else element.removeAttribute("data-chunk-reviewed");
    if (element.hasAttribute("data-column-number"))
      element.setAttribute("title", STAGE_TITLE[span.stage]);
    if (span.folded) {
      element.setAttribute("data-chunk-folded", "");
      const column = element.parentElement;
      const shown = heads.get(column) ?? new Set<ChunkSpan>();
      heads.set(column, shown);
      if (!shown.has(span)) {
        shown.add(span);
        element.setAttribute("data-chunk-fold-head", "");
        element.setAttribute("data-chunk-fold-label", foldLabel(span));
      }
    }
  }
  // Side by side, the filler rows of a folded chunk fold with it.
  for (const buffer of root.querySelectorAll<HTMLElement>(
    "[data-gutter-buffer], [data-content-buffer]",
  )) {
    const before = buffer.previousElementSibling;
    const after = buffer.nextElementSibling;
    const folded =
      !!before?.hasAttribute("data-chunk-folded") &&
      (!after || after.hasAttribute("data-chunk-folded"));
    if (folded) buffer.setAttribute("data-chunk-folded", "");
    else buffer.removeAttribute("data-chunk-folded");
  }
}

/** A folded chunk's line: what it holds and how to see it. */
export function foldLabel(span: ChunkSpan): string {
  const added = span.added ? span.added[1] - span.added[0] + 1 : 0;
  const removed = span.removed ? span.removed[1] - span.removed[0] + 1 : 0;
  return `✓ reviewed: ${Math.max(added, removed)} lines, za shows them`;
}
