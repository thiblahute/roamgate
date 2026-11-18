import type {
  ReviewAnchor,
  ReviewCommit,
  ReviewDiffFile,
  ReviewDiffLine,
  ReviewSide,
} from "../../../shared/review";

/*
 * A thread written on one commit's diff names that commit (`anchor.commit`,
 * its subject and parent). An amend, a rebase or a replay of the branch
 * leaves it on a commit the review no longer has, where no view draws it.
 * It is moved onto what its commit became (the same change by patch id,
 * else the same subject) and onto its line there, found by its text (and
 * the lines after it, for a range); else onto that line in the whole
 * change. Only when nothing matches is it marked outdated, kept where it
 * was written: Go to it then shows the nearest place.
 */

/** A subject without a rewrite's `fixup!` and `squash!`, case or spacing. */
function normalizedSubject(subject: string): string {
  let text = subject.trim();
  for (;;) {
    const stripped = text.replace(/^(fixup|squash|amend)!\s*/i, "");
    if (stripped === text) break;
    text = stripped;
  }
  return text.replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
}

/** Whether a commit of the list is the one a (possibly short) sha names. */
function names(commit: ReviewCommit, sha: string): boolean {
  return commit.sha === sha || commit.sha.startsWith(sha);
}

/** The anchor's commit is no longer among the review's commits. */
export function rewrittenOut(
  anchor: ReviewAnchor,
  commits: readonly ReviewCommit[],
): boolean {
  const { commit } = anchor;
  return (
    !!commit &&
    commits.length > 0 &&
    !commits.some((each) => names(each, commit))
  );
}

/**
 * What the anchor's commit became among the review's commits: the one
 * with its patch id, else with its subject (as written, then normalized),
 * the nearest to where it was when several do. `bySubject` false: the
 * patch id only (a thread of another branch's review, whose subject may
 * name another commit here). Null when none does.
 */
export function rewrittenCommit(
  anchor: ReviewAnchor,
  commits: readonly ReviewCommit[],
  patchIds: Readonly<Record<string, string>>,
  bySubject = true,
): ReviewCommit | null {
  const { commit } = anchor;
  if (!commit) return null;
  const own = Object.entries(patchIds).find(([sha]) => sha.startsWith(commit));
  if (own) {
    const same = commits.filter((each) => patchIds[each.sha] === own[1]);
    if (same.length) return same[same.length - 1]!;
  }
  if (!bySubject || !anchor.commitSubject) return null;
  const subject = anchor.commitSubject;
  const exact = commits.filter((each) => each.subject === subject);
  if (exact.length) return exact[exact.length - 1]!;
  const normalized = normalizedSubject(subject);
  const similar = commits.filter(
    (each) => normalizedSubject(each.subject) === normalized,
  );
  return similar.length ? similar[similar.length - 1]! : null;
}

/** Whether a row is a line of `side` (a context line is on both). */
function onSide(row: ReviewDiffLine, side: ReviewSide): boolean {
  if (row.kind === " ") return true;
  return side === "old" ? row.kind === "-" : row.kind === "+";
}

function lineOf(row: ReviewDiffLine, side: ReviewSide): number | null {
  return side === "old" ? row.old : row.new;
}

/** The note a Changes comment keeps on its anchor, when it has one. */
type Note = Record<string, unknown>;

function noteOf(anchor: ReviewAnchor): Note | null {
  if (!anchor.feedback) return null;
  try {
    const note = JSON.parse(anchor.feedback) as unknown;
    return note && typeof note === "object" ? (note as Note) : null;
  } catch {
    return null;
  }
}

/**
 * The anchored line in a file's diff: the row on its side reading its text,
 * the one whose next rows read on as the comment's quote does (a range's
 * lines), the nearest to where it was among equals. Null when no row reads
 * so, or the anchor keeps no text.
 */
export function lineInFile(
  anchor: ReviewAnchor,
  file: ReviewDiffFile | undefined,
): { side: ReviewSide; line: number } | null {
  const { text, line } = anchor;
  if (!file || text === undefined || line === undefined) return null;
  const side: ReviewSide = anchor.side ?? "new";
  const rows = file.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((row) => onSide(row, side));
  const quote = noteOf(anchor)?.quote;
  const after =
    typeof quote === "string"
      ? quote.split("\n").slice(1, 6)
      : ([] as string[]);
  let best: { line: number; score: number } | null = null;
  rows.forEach((row, index) => {
    if (row.text !== text) return;
    const found = lineOf(row, side);
    if (found === null) return;
    // The lines after it read as the quote's: the same place, first.
    let context = 0;
    after.forEach((expected, offset) => {
      if (rows[index + 1 + offset]?.text === expected) context += 1;
    });
    const score = Math.abs(found - line) - context * 1_000_000;
    if (!best || score < best.score) best = { line: found, score };
  });
  const found = best as { line: number; score: number } | null;
  return found ? { side, line: found.line } : null;
}

/**
 * The anchor moved: onto `commit` (null: the whole change; undefined: the
 * commit it names) and `to`'s line (none: the lines it had), its note
 * (`feedback`) saying the same, `outdated` when its line was not found.
 */
export function movedAnchor(
  anchor: ReviewAnchor,
  commit: ReviewCommit | null | undefined,
  to: { side: ReviewSide; line: number } | null,
  outdated = false,
): ReviewAnchor {
  const next: ReviewAnchor = { ...anchor };
  const note = noteOf(anchor);
  if (commit === null) {
    delete next.commit;
    delete next.commitSubject;
    delete next.commitParent;
    if (note) delete note.commit;
  } else if (commit) {
    next.commit = commit.sha;
    next.commitSubject = commit.subject;
    if (commit.parent) next.commitParent = commit.parent;
    else delete next.commitParent;
    if (note)
      note.commit = {
        sha: commit.sha,
        subject: commit.subject,
        ...(commit.parent ? { parent: commit.parent } : {}),
      };
  }
  if (to && anchor.line !== undefined) {
    next.side = to.side;
    next.line = to.line;
    if (anchor.endLine !== undefined)
      next.endLine = to.line + (anchor.endLine - anchor.line);
    if (note) {
      note.side = to.side;
      note.line = to.line;
      if (next.endLine !== undefined) note.endLine = next.endLine;
      if (note.endSide !== undefined) note.endSide = to.side;
    }
  }
  if (outdated) next.outdated = true;
  else delete next.outdated;
  if (note) next.feedback = JSON.stringify(note);
  return next;
}
