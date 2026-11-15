/*
 * Reviewed chunks and files in Changes (plan: review into the inspector,
 * phase 5), on the rows of the cursor's model. Changes draws a path once
 * per entry (staged, unstaged), so a path's chunks are the entries' chunks
 * in order: a chunk keeps its mark through staging, because its id hashes
 * the path and the changed lines only (hunkIds), never the entry.
 *
 * The marks themselves are the review's (`session.reviewed`, reviewNavigation
 * and reviewToggle); this module only reads Changes' rows as those see
 * files and chunks, and tells each chunk's staged state (D8).
 */
import type { DiffCursorModel } from "./diffCursor";
import {
  type HunkUnit,
  hunkIds,
  type ReviewedFile,
  type ReviewedState,
  reviewedState,
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
        path,
        oldPath: path,
        hunks: lines[file]!.map((own) => ({
          header: "",
          lines: own.map((line) => ({
            kind: line.kind,
            old: null,
            new: null,
            text: line.text,
          })),
        })),
      } as Parameters<typeof fileFingerprint>[0]),
      hunks: ids,
    };
  });
  return { files, chunks, units };
}

/** The reviewed files and chunks of Changes' rows, from the review's marks. */
export function changesReviewed(
  layout: ChangesReviewedLayout,
  marks: Readonly<Record<string, string>>,
): ReviewedState {
  return reviewedState(layout.files, CHANGES_REVIEW_VIEW, marks);
}

/** "3/7": a path's chunks reviewed, or null for a path with none. */
export function chunkProgress(
  layout: ChangesReviewedLayout,
  state: ReviewedState,
  path: string,
): string | null {
  const file = layout.files.findIndex((each) => each.path === path);
  if (file < 0 || !layout.files[file]!.hunks.length) return null;
  return `${state.hunks[file]?.size ?? 0}/${layout.files[file]!.hunks.length}`;
}

/** What the index holds of a chunk (D8): the marker each chunk carries. */
export type ChunkStage = "staged" | "unstaged" | "partly";

const baseId = (id: string) => id.replace(/~\d+$/, "");

/** A chunk's key in `chunkStages`. */
export const chunkStageKey = (key: string, hunk: number) => `${key}\n${hunk}`;

/**
 * Each chunk's staged state. An entry's own kind says where its chunk
 * lives; an unstaged chunk whose changed lines (same id) the path's staged
 * entry holds too is partly staged. Told exactly once the server serves
 * the combined `git diff HEAD` (phase 5s); until then this is the entries'.
 */
export function chunkStages(
  layout: ChangesReviewedLayout,
): Map<string, ChunkStage> {
  const stages = new Map<string, ChunkStage>();
  for (const own of layout.chunks) {
    const staged = new Set(
      own
        .filter((chunk) => chunk.key.startsWith("staged:"))
        .map((chunk) => baseId(chunk.id)),
    );
    for (const chunk of own) {
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
};

/**
 * Every entry's chunks as spans: from the layout's rows (`model`), each
 * chunk's staged state and whether the review has it reviewed.
 */
export function chunkSpans(
  model: DiffCursorModel,
  layout: ChangesReviewedLayout,
  state: ReviewedState,
): Map<string, ChunkSpan[]> {
  const stages = chunkStages(layout);
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
  }
}
