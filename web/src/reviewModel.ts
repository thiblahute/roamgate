import {
  COMMIT_MESSAGE_PATH,
  REVIEW_USER,
  type ReviewAnchor,
  type ReviewCommit,
  type ReviewDiff,
  type ReviewDiffFile,
  type ReviewDiffHunk,
  type ReviewDiffLine,
  type ReviewSide,
  type ReviewSnapshot,
  type ReviewTarget,
  type ReviewThread,
} from "../../shared/review";

export { REVIEW_USER };

/** One diff line with its position in reading order. */
export type ReviewRow = {
  at: number;
  file: number;
  hunk: number;
  line: ReviewDiffLine;
};

export type ReviewLayout = {
  rows: ReviewRow[];
  /** First row of each file (files without hunks have none). */
  fileStart: (number | undefined)[];
};

export function reviewLayout(diff: ReviewDiff | null): ReviewLayout {
  const rows: ReviewRow[] = [];
  const fileStart: (number | undefined)[] = [];
  diff?.files.forEach((file, fileIndex) => {
    fileStart.push(file.hunks.length ? rows.length : undefined);
    file.hunks.forEach((hunk, hunkIndex) => {
      for (const line of hunk.lines)
        rows.push({ at: rows.length, file: fileIndex, hunk: hunkIndex, line });
    });
  });
  return { rows, fileStart };
}

export function sideOf(line: ReviewDiffLine): ReviewSide {
  return line.kind === "-" ? "old" : "new";
}

export function lineNumberOf(line: ReviewDiffLine): number {
  return (line.kind === "-" ? line.old : line.new) ?? 0;
}

export function anchorForRow(
  diff: ReviewDiff,
  row: ReviewRow,
  endRow?: ReviewRow,
): ReviewAnchor {
  const file = diff.files[row.file]!;
  const anchor: ReviewAnchor = {
    path: row.line.kind === "-" ? file.oldPath : file.path,
    line: lineNumberOf(row.line),
    side: sideOf(row.line),
    text: row.line.text,
  };
  // GitLab needs both numbers for an unchanged line, and the old path of a
  // renamed file.
  if (row.line.kind === " " && row.line.old !== null)
    anchor.contextOld = row.line.old;
  if (file.oldPath !== file.path && row.line.kind !== "-")
    anchor.oldPath = file.oldPath;
  if (
    endRow &&
    endRow.file === row.file &&
    sideOf(endRow.line) === anchor.side &&
    lineNumberOf(endRow.line) > anchor.line!
  ) {
    anchor.endLine = lineNumberOf(endRow.line);
    anchor.text = endRow.line.text;
  }
  return anchor;
}

function rowMatches(
  diff: ReviewDiff,
  row: ReviewRow,
  path: string,
  side: ReviewSide,
  line: number,
) {
  const file = diff.files[row.file]!;
  if (side === "new")
    return row.line.kind !== "-" && file.path === path && row.line.new === line;
  return (
    row.line.kind !== "+" && file.oldPath === path && row.line.old === line
  );
}

export type ThreadPlacement = {
  /** Threads shown under a diff row, by row position. */
  byRow: Map<number, ReviewThread[]>;
  /** Threads on a file but no shown line, by file index. */
  byFile: Map<number, ReviewThread[]>;
  /** Review-level threads and those whose code is gone. */
  general: ReviewThread[];
  /** Threads that moved from where they were written, by id. */
  moved: Set<string>;
  outdated: Set<string>;
};

/**
 * Places each thread on the line it was written on. A line anchor shows under
 * its last line; when the remembered code is no longer there, the nearest
 * line in the file that still reads the same takes it (the code moved), and
 * failing that it is outdated and listed with the general comments.
 */
export function placeThreads(
  diff: ReviewDiff | null,
  layout: ReviewLayout,
  threads: readonly ReviewThread[],
): ThreadPlacement {
  const placement: ThreadPlacement = {
    byRow: new Map(),
    byFile: new Map(),
    general: [],
    moved: new Set(),
    outdated: new Set(),
  };
  const put = (
    map: Map<number, ReviewThread[]>,
    key: number,
    t: ReviewThread,
  ) => {
    const list = map.get(key);
    if (list) list.push(t);
    else map.set(key, [t]);
  };
  for (const thread of threads) {
    const { path, line, side = "new", text } = thread.anchor;
    if (!diff || !path) {
      placement.general.push(thread);
      continue;
    }
    const fileIndex = diff.files.findIndex((file) =>
      side === "old" ? file.oldPath === path : file.path === path,
    );
    if (fileIndex === -1) {
      placement.general.push(thread);
      if (line) placement.outdated.add(thread.id);
      continue;
    }
    if (!line) {
      put(placement.byFile, fileIndex, thread);
      continue;
    }
    const target = thread.anchor.endLine ?? line;
    const exact = layout.rows.find((row) =>
      rowMatches(diff, row, path, side, target),
    );
    if (exact && (text === undefined || exact.line.text === text)) {
      put(placement.byRow, exact.at, thread);
      continue;
    }
    if (text !== undefined) {
      let best: ReviewRow | undefined;
      for (const row of layout.rows) {
        if (row.file !== fileIndex || row.line.text !== text) continue;
        if (sideOf(row.line) !== side && row.line.kind !== " ") continue;
        const distance = Math.abs(lineNumberOf(row.line) - target);
        if (!best || distance < Math.abs(lineNumberOf(best.line) - target))
          best = row;
      }
      if (best) {
        put(placement.byRow, best.at, thread);
        placement.moved.add(thread.id);
        continue;
      }
    }
    placement.general.push(thread);
    placement.outdated.add(thread.id);
  }
  return placement;
}

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
  snapshot: ReviewSnapshot;
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
  snapshots: readonly ReviewSnapshot[],
  newCommits: ReadonlySet<string>,
): ReviewListItem[] {
  return snapshots
    .map((snapshot) => {
      const comments = snapshot.threads.filter(
        (thread) => thread.kind === "draft",
      ).length;
      const waiting = snapshot.threads.filter((thread) => {
        if (thread.kind !== "discussion" || thread.resolved) return false;
        const last = thread.comments[thread.comments.length - 1];
        return last !== undefined && last.author !== REVIEW_USER;
      }).length;
      const moved = newCommits.has(snapshot.session.id);
      return {
        snapshot,
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
  if (target.kind === "range") return `${target.base}..${target.head}`;
  if (target.kind === "mr") return target.url.replace(/^https:\/\//, "");
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

/**
 * Repositories matching a search: by name first, then anywhere in name,
 * branch or path, then the name's letters in order (as in fuzzy finders).
 */
export function searchRepos(
  repos: WorkspaceRepo[],
  query: string,
): WorkspaceRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  const scored: { repo: WorkspaceRepo; score: number }[] = [];
  for (const repo of repos) {
    const name = (repo.root.split("/").pop() ?? "").toLowerCase();
    const text = `${name} ${repo.branch ?? ""} ${repo.root}`.toLowerCase();
    let score = name.startsWith(q) ? 0 : text.includes(q) ? 1 : -1;
    if (score < 0) {
      // Letters in order, in the name only: a path matches nearly anything.
      let at = 0;
      for (const char of q) {
        at = name.indexOf(char, at);
        if (at < 0) break;
        at++;
      }
      if (at > 0) score = 2;
    }
    if (score >= 0) scored.push({ repo, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.repo);
}

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
