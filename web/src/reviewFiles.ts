import type { ReviewThread } from "../../shared/review";
import type { ReviewAnnotation } from "./annotations";
import { parsePatch } from "./changesExpand";
import { CHANGES_REVIEW_VIEW } from "./changesReviewed";
import {
  hunkIds,
  type ReviewedFile,
  reviewedChanges,
  reviewedState,
} from "./reviewNavigation";
import { fileFingerprint } from "./reviewToggle";

/*
 * One review across Files and Changes. A comment written on a file in Files
 * is a thread of the checkout's worktree review, as a comment written in
 * Changes is; the reviewed tick on a file is that review's mark in both
 * views. A file with no change joins the review when it is commented on or
 * marked reviewed (never by being opened): it is one of the review's "Other
 * files", listed under the changed files with its threads and its tick, until
 * it is unmarked and its threads are resolved or deleted.
 */

/**
 * The reviewed mark of a file with no change (`all:path`): a tick only.
 * Not a diff's fingerprint, so a file that changes since is no longer
 * reviewed, as a changed file whose diff changes is not.
 */
export const OTHER_FILE_MARK = "unchanged";

/** Where a file's whole-file mark is kept in the worktree review. */
export function fileMarkKey(path: string): string {
  return `${CHANGES_REVIEW_VIEW}:${path}`;
}

const isSite = (path: string) => /^https?:\/\//i.test(path);

/**
 * A comment written in Files, read as a comment on its file's combined
 * diff in Changes: on the new side at the source line it is on (its
 * thread's anchor, where the review stores it), or on the file as a whole
 * when it has no line (words of a rendered file not found in the source).
 * Any other note is given back as it is.
 */
export function fileNoteAsDiff(
  note: ReviewAnnotation,
  thread?: ReviewThread,
): ReviewAnnotation {
  if (note.source !== "file" || isSite(note.path)) return note;
  const path = thread?.anchor.path ?? note.path;
  if (!path || isSite(path)) return note;
  const line = thread ? thread.anchor.line : note.line;
  const endLine = thread ? thread.anchor.endLine : note.endLine;
  return {
    id: note.id,
    source: "diff",
    kind: "combined",
    path,
    side: "new",
    line: line ?? 0,
    ...(line !== undefined && endLine !== undefined && endLine > line
      ? { endLine }
      : {}),
    hunk: "",
    quote: note.quote,
    comment: note.comment,
    createdAt: note.createdAt,
    ...(note.stale ? { stale: true } : {}),
  };
}

/** A file of the review with no change: its threads and its tick. */
export type OtherFile = {
  path: string;
  reviewed: boolean;
  /** Its open threads (resolved ones no longer keep it in the review). */
  threads: ReviewThread[];
};

/**
 * The review's files with no change: those marked reviewed as such, and
 * those with an open thread, in path order. `changed` are the paths the
 * review's diff shows; `threads` the checkout's threads (each with its
 * path relative to the repository), `marks` the worktree review's.
 */
export function otherReviewFiles(
  threads: readonly ReviewThread[],
  marks: Readonly<Record<string, string>>,
  changed: ReadonlySet<string>,
): OtherFile[] {
  const files = new Map<string, OtherFile>();
  const fileOf = (path: string) => {
    let file = files.get(path);
    if (!file) {
      file = { path, reviewed: false, threads: [] };
      files.set(path, file);
    }
    return file;
  };
  const prefix = `${CHANGES_REVIEW_VIEW}:`;
  for (const [key, value] of Object.entries(marks)) {
    if (value !== OTHER_FILE_MARK || key.includes("\n")) continue;
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    if (path && !changed.has(path)) fileOf(path).reviewed = true;
  }
  for (const thread of threads) {
    const { path } = thread.anchor;
    if (
      !path ||
      isSite(path) ||
      changed.has(path) ||
      thread.resolved ||
      thread.kind === "merge-request" ||
      thread.anchor.message
    )
      continue;
    fileOf(path).threads.push(thread);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The marks to write to tick an unchanged file, or untick it. */
export function otherFileMarks(
  path: string,
  reviewed: boolean,
): Record<string, string | null> {
  return { [fileMarkKey(path)]: reviewed ? OTHER_FILE_MARK : null };
}

/**
 * A changed file as the reviewed marks see it, from its combined diff
 * (git.diff_file kind "combined"): Changes reads the same lines, so both
 * views agree on its tick. Null when the patch has no hunk.
 */
export function reviewedFileOf(
  path: string,
  patch: string,
): ReviewedFile | null {
  const parsed = parsePatch(patch);
  if (!parsed?.file.hunks.length) return null;
  const hunks = parsed.file.hunks;
  return {
    path,
    fingerprint: fileFingerprint(parsed.file),
    hunks: hunkIds(path, hunks),
  };
}

/** Whether a changed file is reviewed: whole, or every chunk of it. */
export function changedFileReviewed(
  file: ReviewedFile,
  marks: Readonly<Record<string, string>>,
): boolean {
  return reviewedState([file], CHANGES_REVIEW_VIEW, marks).files.has(0);
}

/** The marks to write to tick a changed file whole, or untick it. */
export function changedFileMarks(
  file: ReviewedFile,
  reviewed: boolean,
  marks: Readonly<Record<string, string>>,
): Record<string, string | null> {
  return reviewedChanges(
    file,
    new Set(reviewed ? file.hunks.map((_, index) => index) : []),
    CHANGES_REVIEW_VIEW,
    marks,
  );
}

/** Whether a changed file may have a reviewed mark: worth reading its diff. */
export function hasFileMarks(
  path: string,
  marks: Readonly<Record<string, string>>,
): boolean {
  // A mark of another view counts too (reviewedState), so any view's.
  return Object.entries(marks).some(([key, value]) => {
    const rest = key.slice(key.indexOf(":") + 1);
    return !!value && (rest === path || rest.startsWith(`${path}\n`));
  });
}
