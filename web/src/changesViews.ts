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

/** Each listed file as Changes last drew it, with what it was drawn from. */
const converted = new WeakMap<
  ReviewDiffFile,
  {
    whereKey: string;
    read: ReviewDiffFile | null;
    entry: GitDiffEntry;
    file: GitDiffFile | null;
  }
>();

const STATUS_NAMES = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  modified: "Modified",
} as const;

/**
 * A view's diff as Changes draws it: one `branch` entry per file and its
 * patch; a commit's message first, as a file whose lines take comments.
 * A summary's files (phase 5s) are listed from the start, each patch drawn
 * once read (`loaded`, by path); `loading` and `errors` say how the others
 * are going.
 */
export function reviewDiffAsChanges(
  diff: ReviewDiff,
  where: { root: string; workspaceId: string },
  commit: ReviewCommit | null,
  loaded?: {
    files: ReadonlyMap<string, ReviewDiffFile>;
    loading?: ReadonlySet<string>;
    errors?: ReadonlyMap<string, string>;
  },
): {
  entries: GitDiffEntry[];
  files: Record<string, GitDiffFile>;
  loadingKeys: string[];
  fileErrors: Record<string, string>;
} {
  const message = commit
    ? commitMessageFile(commit.subject, commit.body)
    : null;
  const shown = message ? [message, ...diff.files] : diff.files;
  const entries: GitDiffEntry[] = [];
  const files: Record<string, GitDiffFile> = {};
  const loadingKeys: string[] = [];
  const fileErrors: Record<string, string> = {};
  const whereKey = `${where.workspaceId}\n${where.root}`;
  for (const listed of shown) {
    const read =
      listed === message || !diff.summary
        ? listed
        : (loaded?.files.get(listed.path) ?? null);
    const key = `branch:${listed.path}`;
    // Each file is converted once: the same objects each time a few more
    // files arrive, so Changes draws only the new ones.
    const known = listed === message ? undefined : converted.get(listed);
    if (known && known.whereKey === whereKey && known.read === read) {
      entries.push(known.entry);
      if (known.file) files[key] = known.file;
      else if (loaded?.loading?.has(listed.path)) loadingKeys.push(key);
      const error = loaded?.errors?.get(listed.path);
      if (error && !read) fileErrors[key] = error;
      continue;
    }
    const count = (kind: "+" | "-") =>
      (read ?? listed).hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((l) => l.kind === kind).length,
        0,
      );
    const entry: GitDiffEntry = {
      path: listed.path,
      ...(listed.oldPath !== listed.path ? { old_path: listed.oldPath } : {}),
      kind: "branch",
      status: listed.commitMessage
        ? "Message"
        : listed.status
          ? STATUS_NAMES[listed.status]
          : fileStatus(listed),
      additions: listed.additions ?? count("+"),
      deletions: listed.deletions ?? count("-"),
      ...(listed.generated ? { generated: true } : {}),
    };
    entries.push(entry);
    const file: GitDiffFile | null = read
      ? {
          workspace_id: where.workspaceId,
          root: where.root,
          path: listed.path,
          kind: "branch",
          diff: read.binary ? "" : reviewFilePatch(read),
          truncated: !!read.truncated,
        }
      : null;
    if (listed !== message)
      converted.set(listed, { whereKey, read, entry, file });
    if (file) files[key] = file;
    else if (loaded?.loading?.has(listed.path)) loadingKeys.push(key);
    const error = loaded?.errors?.get(listed.path);
    if (error && !read) fileErrors[key] = error;
  }
  return { entries, files, loadingKeys, fileErrors };
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
