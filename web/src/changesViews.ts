import type {
  ReviewCommit,
  ReviewDiff,
  ReviewDiffFile,
} from "../../shared/review";
import { commitMessageFile } from "./reviewModel";
import type { GitDiffEntry, GitDiffFile } from "./types";

/*
 * A review's views in Changes (plan: review into the inspector, phase 6):
 * all the changes, or one commit at a time, as the review pane's commit bar
 * steps through them. Pure: a review diff as Changes' entries and patches,
 * and what the bar says.
 */

/** A review diff's file as git would print its patch, for Pierre. */
export function reviewFilePatch(file: ReviewDiffFile): string {
  const added = file.hunks.length > 0 && file.hunks.every(startsAtZero("-"));
  const removed = file.hunks.length > 0 && file.hunks.every(startsAtZero("+"));
  const lines = [`diff --git a/${file.oldPath} b/${file.path}`];
  if (added) lines.push("new file mode 100644", "--- /dev/null");
  else if (removed) lines.push("deleted file mode 100644");
  if (!added && file.oldPath !== file.path)
    lines.push(`rename from ${file.oldPath}`, `rename to ${file.path}`);
  if (!added) lines.push(`--- a/${file.oldPath}`);
  lines.push(removed ? "+++ /dev/null" : `+++ b/${file.path}`);
  for (const hunk of file.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines)
      lines.push(`${line.kind === " " ? " " : line.kind}${line.text}`);
  }
  return `${lines.join("\n")}\n`;
}

function startsAtZero(side: "-" | "+") {
  const pattern = side === "-" ? /^@@ -0,0 / : /^@@ -\d+(?:,\d+)? \+0,0 @@/;
  return (hunk: { header: string }) => pattern.test(hunk.header);
}

function fileStatus(file: ReviewDiffFile): string {
  if (file.hunks.length && file.hunks.every(startsAtZero("-"))) return "Added";
  if (file.hunks.length && file.hunks.every(startsAtZero("+")))
    return "Deleted";
  if (file.oldPath !== file.path) return "Renamed";
  return "Modified";
}

/**
 * A view's diff as Changes draws it: one `branch` entry per file and its
 * patch; a commit's message first, as a file whose lines take comments.
 */
export function reviewDiffAsChanges(
  diff: ReviewDiff,
  where: { root: string; workspaceId: string },
  commit: ReviewCommit | null,
): { entries: GitDiffEntry[]; files: Record<string, GitDiffFile> } {
  const shown = commit
    ? [commitMessageFile(commit.subject, commit.body), ...diff.files]
    : diff.files;
  const entries: GitDiffEntry[] = [];
  const files: Record<string, GitDiffFile> = {};
  for (const file of shown) {
    const count = (kind: "+" | "-") =>
      file.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((l) => l.kind === kind).length,
        0,
      );
    const entry: GitDiffEntry = {
      path: file.path,
      ...(file.oldPath !== file.path ? { old_path: file.oldPath } : {}),
      kind: "branch",
      status: file.commitMessage ? "Message" : fileStatus(file),
      additions: count("+"),
      deletions: count("-"),
    };
    entries.push(entry);
    files[`branch:${file.path}`] = {
      workspace_id: where.workspaceId,
      root: where.root,
      path: file.path,
      kind: "branch",
      diff: file.binary ? "" : reviewFilePatch(file),
      truncated: false,
    };
  }
  return { entries, files };
}

/** How the bar names a view: "1/2 aaaaaaaa" and the subject. */
export function viewName(
  commits: readonly ReviewCommit[] | null,
  current: ReviewCommit | null,
): { head: string; subject: string } | null {
  if (!commits) return null;
  const index = current
    ? commits.findIndex((commit) => commit.sha === current.sha)
    : -1;
  if (current)
    return {
      head:
        index >= 0
          ? `${index + 1}/${commits.length} ${current.sha.slice(0, 8)}`
          : current.sha.slice(0, 8),
      subject:
        index >= 0
          ? current.subject
          : `${current.subject} (no longer in the review)`,
    };
  return {
    head: "All changes",
    subject: `${commits.length} commit${commits.length === 1 ? "" : "s"}`,
  };
}

/**
 * The view `>` (1) or `<` (-1) goes to: the views wrap around, before all
 * the changes comes the last commit; a branch's history has no all-changes
 * view. Null: the view stays.
 */
export function stepView(
  commits: readonly ReviewCommit[],
  sha: string | null,
  direction: 1 | -1,
): { sha: string | null } | null {
  if (!commits.length) return null;
  const history = commits[0]?.history === true;
  const index = commits.findIndex((commit) => commit.sha === sha);
  const first = history ? 0 : -1;
  const count = commits.length - first;
  const next = ((index - first + direction + count) % count) + first;
  if (next === index) return null;
  return { sha: next < 0 ? null : commits[next]!.sha };
}
