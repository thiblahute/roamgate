import {
  COMMIT_MESSAGE_PATH,
  describeStepTarget,
  REVIEW_USER,
  type ReviewAnchor,
  type ReviewCommit,
  type ReviewDiff,
  type ReviewDiffFile,
  type ReviewDiffHunk,
  type ReviewDiffLine,
  type ReviewSummary,
  type ReviewTarget,
  type ReviewThread,
} from "../../shared/review";

export { REVIEW_USER };

export function locationLabel(anchor: ReviewAnchor): string {
  if (!anchor.path) return "Whole review";
  if (anchor.path === COMMIT_MESSAGE_PATH)
    return `Commit message${anchor.commitSubject ? ` of "${anchor.commitSubject}"` : ""}${anchor.line ? `, line ${anchor.line}` : ""}`;
  if (!anchor.line) return anchor.path;
  const lines = anchor.endLine
    ? `${anchor.line}-${anchor.endLine}`
    : `${anchor.line}`;
  return `${anchor.path}:${lines}${anchor.side === "old" ? " (old)" : ""}`;
}

/**
 * The draft review as Markdown, as maildesk writes it for GitLab: each
 * comment under its location and the line it is about, the summary first.
 */
export function reviewAsMarkdown(
  summary: string,
  threads: readonly ReviewThread[],
): string {
  const parts: string[] = [];
  if (summary.trim()) parts.push(summary.trim());
  const drafts = threads
    .filter((thread) => thread.kind === "draft" && thread.comments.length)
    .sort(
      (a, b) =>
        (a.anchor.path ?? "").localeCompare(b.anchor.path ?? "") ||
        (a.anchor.line ?? 0) - (b.anchor.line ?? 0),
    );
  for (const thread of drafts) {
    const body = thread.comments
      .map((comment) => comment.body.trim())
      .join("\n\n");
    if (!thread.anchor.path) {
      parts.push(body);
      continue;
    }
    const lines = [`**\`${locationLabel(thread.anchor)}\`**`];
    if (thread.anchor.text !== undefined)
      lines.push("```", thread.anchor.text, "```");
    lines.push(body);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

export function authorLabel(author: string): string {
  return author === REVIEW_USER ? "You" : author;
}

/** Lines revealed in one gap: just below the hunk above, just above the next. */
export type GapState = { top: number; bottom: number; all?: boolean };

export type FileExpansion = {
  /** The new side of the file, one entry per line. */
  lines: string[];
  /** By gap index: 0 above the first hunk, hunks.length after the last. */
  gaps: Map<number, GapState>;
};

export type GapInfo = {
  file: number;
  /** Gap index in the original file's hunks. */
  gap: number;
  /** Hidden lines, or null when the end of the file is not known yet. */
  hidden: number | null;
  canDown: boolean;
  canUp: boolean;
};

const HUNK_RANGE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function hunkRange(header: string) {
  const match = HUNK_RANGE.exec(header);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  return { oldStart, oldCount, newStart, newCount };
}

export function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function contextLines(
  lines: string[] | undefined,
  from: number,
  to: number,
  offset: number,
): ReviewDiffLine[] {
  const result: ReviewDiffLine[] = [];
  for (let number = from; number <= to; number++)
    result.push({
      kind: " ",
      old: number - offset,
      new: number,
      text: lines?.[number - 1] ?? "",
      expanded: true,
    });
  return result;
}

/**
 * The diff with the revealed context put back, as maildesk shows it: lines
 * revealed in a gap join the hunk next to them, and a fully shown gap merges
 * the two hunks (its header goes). Returns where each remaining gap sits,
 * keyed `file:hunk` (before that hunk of the result) or `file:end`.
 */
export function expandDiff(
  diff: ReviewDiff,
  expansions: ReadonlyMap<number, FileExpansion>,
): { diff: ReviewDiff; gaps: Map<string, GapInfo> } {
  const gaps = new Map<string, GapInfo>();
  const files = diff.files.map((file, fileIndex) => {
    const ranges = file.hunks.map((hunk) => hunkRange(hunk.header));
    const deleted = file.hunks.every((hunk) =>
      hunk.lines.every((line) => line.kind === "-"),
    );
    if (
      file.binary ||
      file.commitMessage ||
      !file.hunks.length ||
      deleted ||
      ranges.some((r) => !r)
    )
      return file;
    const expansion = expansions.get(fileIndex);
    const total = expansion?.lines.length;
    const hunks: ReviewDiffHunk[] = [];
    let previousNewEnd = 0;
    file.hunks.forEach((hunk, index) => {
      const range = ranges[index]!;
      const offset = range.newStart - range.oldStart;
      const from = index === 0 ? 1 : previousNewEnd + 1;
      const to = range.newStart - 1;
      const size = Math.max(0, to - from + 1);
      const state = expansion?.gaps.get(index) ?? { top: 0, bottom: 0 };
      const top = index === 0 ? 0 : Math.min(state.top, size);
      const bottom = Math.min(state.bottom, size - top);
      const showAll = expansion && (state.all || top + bottom >= size);
      const previous = hunks[hunks.length - 1];
      const lines = [...hunk.lines];
      if (size > 0 && showAll) {
        const revealed = contextLines(expansion.lines, from, to, offset);
        if (previous) {
          previous.lines.push(...revealed, ...lines);
        } else {
          hunks.push({ header: hunk.header, lines: [...revealed, ...lines] });
        }
      } else {
        if (size > 0) {
          if (previous && top)
            previous.lines.push(
              ...contextLines(expansion?.lines, from, from + top - 1, offset),
            );
          gaps.set(`${fileIndex}:${hunks.length}`, {
            file: fileIndex,
            gap: index,
            hidden: size - top - bottom,
            canDown: index > 0,
            canUp: true,
          });
        }
        hunks.push({
          header: hunk.header,
          lines: [
            ...(bottom
              ? contextLines(expansion?.lines, to - bottom + 1, to, offset)
              : []),
            ...lines,
          ],
        });
      }
      previousNewEnd = range.newCount
        ? range.newStart + range.newCount - 1
        : range.newStart;
    });
    const lastRange = ranges[ranges.length - 1]!;
    const endOffset =
      previousNewEnd -
      (lastRange.oldCount
        ? lastRange.oldStart + lastRange.oldCount - 1
        : lastRange.oldStart);
    const endGap = file.hunks.length;
    const endState = expansion?.gaps.get(endGap) ?? { top: 0, bottom: 0 };
    const from = previousNewEnd + 1;
    const remaining =
      total === undefined ? null : Math.max(0, total - from + 1);
    const top =
      remaining === null
        ? 0
        : endState.all
          ? remaining
          : Math.min(endState.top, remaining);
    if (top > 0)
      hunks[hunks.length - 1]!.lines.push(
        ...contextLines(expansion?.lines, from, from + top - 1, endOffset),
      );
    if (remaining === null || remaining - top > 0)
      gaps.set(`${fileIndex}:end`, {
        file: fileIndex,
        gap: endGap,
        hidden: remaining === null ? null : remaining - top,
        canDown: true,
        canUp: false,
      });
    return { ...file, hunks };
  });
  return { diff: { ...diff, files }, gaps };
}

export type ReviewListItem = {
  snapshot: ReviewSummary;
  comments: number;
  waiting: number;
  newCommits: boolean;
  rank: number;
};

/**
 * Reviews in progress, the ones needing you first (as maildesk ranks MR
 * activity and new mail): new commits on the branch or discussions waiting
 * on your answer, then the rest, most recently worked on first.
 */
export function rankReviews(
  summaries: readonly ReviewSummary[],
  newCommits: ReadonlySet<string>,
): ReviewListItem[] {
  return summaries
    .map((summary) => {
      const { drafts: comments, waiting } = summary.counts;
      const moved = newCommits.has(summary.session.id);
      return {
        snapshot: summary,
        comments,
        waiting,
        newCommits: moved,
        rank: moved || waiting > 0 ? 0 : 1,
      };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.snapshot.session.updatedAt.localeCompare(
          a.snapshot.session.updatedAt,
        ),
    );
}

export function describeReviewTarget(target: ReviewTarget) {
  if (target.kind === "range")
    return target.compare
      ? `${target.base} vs ${target.head}`
      : `${target.base}..${target.head}`;
  if (target.kind === "mr") return target.url.replace(/^https:\/\//, "");
  if (target.kind === "step") return describeStepTarget(target);
  return "working tree";
}

/** The gap (as `expandDiff` numbers them) holding a new-side line, if any. */
export function gapForLine(file: ReviewDiffFile, line: number): number | null {
  let previousEnd = 0;
  for (let index = 0; index < file.hunks.length; index++) {
    const range = hunkRange(file.hunks[index]!.header);
    if (!range) return null;
    if (line > previousEnd && line < range.newStart) return index;
    previousEnd = range.newCount
      ? range.newStart + range.newCount - 1
      : range.newStart;
    if (line <= previousEnd) return null;
  }
  return line > previousEnd ? file.hunks.length : null;
}

/**
 * What to reveal of a gap so that new-side `line` shows with `around`
 * lines of context each side: the end nearer to it grows (the first gap
 * only from below, the last only from above). Null when the line is in a
 * hunk already, the hunks cannot be read, or it would take more than
 * `limit` lines (a line far into a gap: shown only when asked for).
 */
export function contextForLine(
  file: ReviewDiffFile,
  line: number,
  around = 3,
  limit = Number.POSITIVE_INFINITY,
): { gap: number; change: (state: GapState) => GapState } | null {
  const gap = gapForLine(file, line);
  if (gap === null) return null;
  const previous = gap > 0 ? hunkRange(file.hunks[gap - 1]!.header) : null;
  const next =
    gap < file.hunks.length ? hunkRange(file.hunks[gap]!.header) : null;
  const from = previous
    ? previous.newCount
      ? previous.newStart + previous.newCount
      : previous.newStart + 1
    : 1;
  // Through the next hunk's line before, or as far as the line needs.
  const to = next ? next.newStart - 1 : line + around;
  const fromAbove = gap > 0 ? Math.min(line + around, to) - from + 1 : null;
  const fromBelow = next ? to - Math.max(line - around, from) + 1 : null;
  const fewest = Math.min(
    fromAbove ?? Number.POSITIVE_INFINITY,
    fromBelow ?? Number.POSITIVE_INFINITY,
  );
  if (fewest > limit) return null;
  if (fromBelow !== null && (fromAbove === null || fromBelow <= fromAbove))
    return {
      gap,
      change: (state) => ({
        ...state,
        bottom: Math.max(state.bottom, fromBelow),
      }),
    };
  if (fromAbove === null) return null;
  return {
    gap,
    change: (state) => ({ ...state, top: Math.max(state.top, fromAbove) }),
  };
}

/**
 * maildesk's way of putting an older GitLab thread on today's code: find the
 * line it was written on in the file at its commit, look for that text in
 * the current file, and prefer the candidate whose neighbours (three each
 * side) still match, then the closest. Gives up on short lines and on
 * ambiguous matches rather than guess.
 */
export function relocateLine(
  oldLines: readonly string[],
  line: number,
  currentLines: readonly string[],
): number | null {
  const wanted = oldLines[line - 1]?.trim();
  if (!wanted || wanted.length < 3) return null;
  const candidates: { index: number; score: number; distance: number }[] = [];
  currentLines.forEach((text, index) => {
    if (text.trim() !== wanted) return;
    let score = 0;
    for (const offset of [-3, -2, -1, 1, 2, 3]) {
      const before = oldLines[line - 1 + offset]?.trim();
      if (
        before !== undefined &&
        before === currentLines[index + offset]?.trim()
      )
        score++;
    }
    candidates.push({ index, score, distance: Math.abs(index + 1 - line) });
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const [best, second] = candidates;
  if (candidates.length > 1 && best!.score === 0) return null;
  if (second && second.score === best!.score && best!.score < 2) return null;
  return best!.index + 1;
}

/** A commit's message as a file of context lines, to comment like code. */
export function commitMessageFile(
  subject: string,
  body: string,
): ReviewDiffFile {
  const text = body ? `${subject}\n\n${body}` : subject;
  const lines = text.split("\n");
  return {
    path: COMMIT_MESSAGE_PATH,
    oldPath: COMMIT_MESSAGE_PATH,
    commitMessage: true,
    hunks: [
      {
        header: `@@ -1,${lines.length} +1,${lines.length} @@`,
        lines: lines.map((line, index) => ({
          kind: " ",
          old: index + 1,
          new: index + 1,
          text: line,
        })),
      },
    ],
  };
}

/** A repository of the review's workspace, for the repository menu. */
export type WorkspaceRepo = {
  root: string;
  branch?: string;
  ahead?: number;
  dirty?: boolean;
  /** Comments in its review, when it has one. */
  comments?: number;
};

/** A view of the commit picker: all the changes (no commit) or a commit. */
export type CommitChoice = {
  /** null for all the changes. */
  sha: string | null;
  /** Its place in the review from 1; 0 for all changes or a commit gone. */
  position: number;
  commit: ReviewCommit | null;
};

/**
 * The views a review steps through, in the picker's order: all the changes
 * first (not for a branch's history, which is not one change), then each
 * commit, then the commit shown when a rebase took it out of the review.
 */
export function commitChoices(
  commits: readonly ReviewCommit[],
  all: boolean,
  gone: ReviewCommit | null = null,
): CommitChoice[] {
  const choices: CommitChoice[] = all
    ? [{ sha: null, position: 0, commit: null }]
    : [];
  commits.forEach((commit, index) =>
    choices.push({ sha: commit.sha, position: index + 1, commit }),
  );
  if (gone && !commits.some((commit) => commit.sha === gone.sha))
    choices.push({ sha: gone.sha, position: 0, commit: gone });
  return choices;
}

function plainText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** How well one typed word matches a view; -1 when it does not. */
function commitWordScore(choice: CommitChoice, word: string): number {
  if (choice.sha && /^[0-9a-f]+$/.test(word) && choice.sha.startsWith(word))
    return 0;
  if (choice.position > 0 && String(choice.position) === word) return 0;
  const subject = plainText(choice.commit?.subject ?? "all changes");
  const text = `${subject} ${plainText(choice.commit?.author ?? "")}`;
  const at = text.indexOf(word);
  if (at >= 0) return at === 0 || /[^a-z0-9]/.test(text[at - 1]!) ? 1 : 2;
  // The word's letters in order in the subject, as in fuzzy finders.
  let from = 0;
  for (const char of word) {
    from = subject.indexOf(char, from);
    if (from < 0) return -1;
    from++;
  }
  return 3;
}

/**
 * The views matching a search: every word, case and accents ignored, is a
 * sha prefix, the commit's number, a word of its subject or author (from
 * its start first), or the subject's letters in order. Best first, then in
 * the review's order.
 */
export function searchCommits(
  choices: readonly CommitChoice[],
  query: string,
): CommitChoice[] {
  const words = plainText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...choices];
  const scored: { choice: CommitChoice; score: number }[] = [];
  for (const choice of choices) {
    let score = 0;
    for (const word of words) {
      const own = commitWordScore(choice, word);
      if (own < 0) {
        score = -1;
        break;
      }
      score += own;
    }
    if (score >= 0) scored.push({ choice, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.choice);
}
