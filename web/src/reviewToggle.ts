import type { ReviewDiff } from "../../shared/review";
import {
  type HunkUnit,
  type ReviewedFile,
  reviewedChanges,
} from "./reviewNavigation";

/*
 * Marking a review's chunks and files reviewed, and unmarking them: which
 * hunks r takes (the cursor's, or those a selection covers), the marks
 * that changes, and what is said of it. Writing the marks, folding and
 * moving the cursor on are the view's.
 */

/** A short fingerprint of a file's diff: reviewed until it changes. */
export function fileFingerprint(file: ReviewDiff["files"][number]): string {
  let hash = 5381;
  for (const hunk of file.hunks)
    for (const line of hunk.lines) {
      const text = `${line.kind}${line.text}\n`;
      for (let i = 0; i < text.length; i++)
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
  return `${file.hunks.length}:${(hash >>> 0).toString(36)}`;
}

/** Hunks picked, by file. */
export type PickedHunks = Map<number, Set<number>>;

/**
 * The hunks r acts on: the cursor's (or the nearest, on context revealed),
 * or every hunk a selection from `selection` to `cursor` covers.
 */
export function pickHunks(
  units: readonly HunkUnit[],
  cursor: number,
  selection: number | null,
  near: (at: number) => HunkUnit,
): PickedHunks {
  const picked: PickedHunks = new Map();
  const pick = (unit: HunkUnit) => {
    if (!unit) return;
    picked.set(unit.file, (picked.get(unit.file) ?? new Set()).add(unit.hunk));
  };
  if (selection === null) pick(near(cursor));
  else
    for (
      let at = Math.min(selection, cursor);
      at <= Math.max(selection, cursor);
      at++
    )
      pick(units[at] ?? null);
  return picked;
}

/** What marking or unmarking picked hunks does. */
export type HunkToggle = {
  /** Marking (some picked hunk was not reviewed), else unmarking. */
  marking: boolean;
  /** The marks to write (see reviewedChanges). */
  changes: Record<string, string | null>;
  /** Files whose marks change: reviewed ones fold again once marked. */
  files: number[];
  /** A file got its last hunk marked. */
  fileDone: boolean;
  /** "2/3": the last file's reviewed hunks once written. */
  chunks: string;
  /** How many hunks were picked. */
  count: number;
};

/**
 * Marks the picked hunks reviewed, or unmarks them when every one already
 * is; each file's marks as reviewedChanges writes them.
 */
export function hunkToggle(
  picked: PickedHunks,
  files: readonly ReviewedFile[],
  reviewedHunks: readonly (ReadonlySet<number> | undefined)[],
  view: string,
  marks: Readonly<Record<string, string>>,
): HunkToggle {
  const marking = [...picked].some(([file, hunks]) =>
    [...hunks].some((hunk) => !(reviewedHunks[file]?.has(hunk) ?? false)),
  );
  const changes: Record<string, string | null> = {};
  const touched: number[] = [];
  let fileDone = false;
  let chunks = "";
  for (const [file, hunks] of picked) {
    const info = files[file];
    if (!info) continue;
    touched.push(file);
    const want = new Set(reviewedHunks[file]);
    for (const hunk of hunks) {
      if (marking) want.add(hunk);
      else want.delete(hunk);
    }
    if (marking && want.size === info.hunks.length) fileDone = true;
    chunks = `${want.size}/${info.hunks.length}`;
    Object.assign(changes, reviewedChanges(info, want, view, marks));
  }
  const count = [...picked.values()].reduce((sum, h) => sum + h.size, 0);
  return { marking, changes, files: touched, fileDone, chunks, count };
}

/** What is said once hunks are marked or unmarked. */
export function hunkToggleNotice(
  toggle: Pick<HunkToggle, "marking" | "fileDone" | "chunks" | "count">,
  reviewedCount: number,
  fileCount: number,
): string {
  const what = toggle.count === 1 ? "Chunk" : `${toggle.count} chunks`;
  return !toggle.marking
    ? `${what} no longer reviewed (${toggle.chunks} in the file)`
    : toggle.fileDone
      ? `${what} reviewed: the file is (${reviewedCount + 1}/${fileCount})`
      : `${what} reviewed (${toggle.chunks} in the file)`;
}

/** The marks of a whole file marked reviewed (every hunk) or unmarked. */
export function fileToggleChanges(
  info: ReviewedFile,
  marking: boolean,
  view: string,
  marks: Readonly<Record<string, string>>,
): Record<string, string | null> {
  const want = new Set(marking ? info.hunks.map((_, hunk) => hunk) : []);
  return reviewedChanges(info, want, view, marks, marking);
}

/** What is said once a whole file is marked or unmarked. */
export function fileToggleNotice(
  marking: boolean,
  reviewedCount: number,
  fileCount: number,
): string {
  return marking
    ? `Reviewed (${reviewedCount + 1}/${fileCount})`
    : "No longer reviewed, nor its chunks";
}
