import { sshReadCommandArgv } from "../bridge/ssh-command";
import {
  REVIEW_DIFF_FILES_MAX,
  type ReviewDiff,
  type ReviewDiffFile,
  type ReviewFileStatus,
  type ReviewTarget,
} from "../../../shared/review";
import { parseUnifiedDiff } from "../review/patch";
import { GIT_DIFF_MAX_BYTES } from "./file-constants";
import type { RunProcessWithCodeTimeout } from "./file-types";
import { parseGeneratedAttributes } from "./git-diff";
import { gitShellCommandArgv } from "./git-shell";
import {
  DIFF_OPTIONS,
  enterCheckout,
  GIT,
  GIT_ONLY,
  resolveBase,
  reviewScriptError,
  SHAS_MARKER,
  validReviewPath,
} from "./review-patch";

/*
 * A review's diff file by file (plan: review into the inspector, phase 5s):
 * its summary first (each file's path, status and line counts, the two
 * commits it is between), then the files' patches a few at a time against
 * those two commits. Nothing caps the whole change; each file's patch is cut
 * at GIT_DIFF_MAX_BYTES, as Changes' own files are.
 */

const ATTRS_MARKER = "ROAMGATE-REVIEW-ATTRS";
const FILE_MARKER = "ROAMGATE-REVIEW-FILE";
const SUMMARY_TIMEOUT_MS = 30_000;

/** What a review's summary is of: its target, or one of its commits. */
export type ReviewSummaryOf =
  | { target: ReviewTarget; commit?: undefined }
  | { commit: string; target?: undefined };

/** A commit or tree name as git prints it. */
const OBJECT_NAME = /^[0-9a-f]{7,64}$/;

/**
 * Lines that set `$m` and `$h`, the two ends a review's files are read
 * between: a range's merge base (its base, comparing two versions) and head,
 * a step's two snapshots, a commit's first parent (git's empty tree for a
 * root commit) and itself.
 */
function endsScript(of: ReviewSummaryOf, shQuote: (value: string) => string) {
  if (of.commit !== undefined) {
    if (!OBJECT_NAME.test(of.commit)) throw new Error("invalid commit");
    return [
      `h=$(git rev-parse --verify --quiet ${shQuote(`${of.commit}^{commit}`)}) || { echo "unknown commit" >&2; exit 3; }`,
      `m=$(git rev-parse --verify --quiet "$h^1" 2>/dev/null) || m=$(git hash-object -t tree /dev/null)`,
    ];
  }
  const { target } = of;
  if (target.kind === "range")
    return [
      resolveBase(target.base, shQuote),
      `h=$(git rev-parse --verify --quiet ${shQuote(`${target.head}^{commit}`)}) || { echo "unknown revision: ${target.head.replace(/["$`\\]/g, "")}" >&2; exit 3; }`,
      target.compare
        ? `m="$b"`
        : `m=$(git merge-base "$b" "$h" 2>/dev/null) || m="$b"`,
    ];
  if (target.kind === "step")
    return [
      ...[target.before, target.after].map(
        (tree) =>
          `git rev-parse --verify --quiet ${shQuote(`${tree}^{tree}`)} >/dev/null || { echo "unknown revision: ${tree}" >&2; exit 3; }`,
      ),
      `m=${shQuote(target.before)}`,
      `h=${shQuote(target.after)}`,
    ];
  throw new Error("this review has no summary: its files are read whole");
}

/** One script: the two ends, the files changed between them, which are generated. */
export function reviewSummaryScript(
  root: string,
  of: ReviewSummaryOf,
  shQuote: (value: string) => string,
): string {
  const diff = `${GIT} diff --no-color --no-ext-diff --no-textconv --find-renames -z`;
  return [
    enterCheckout(root, shQuote),
    ...endsScript(of, shQuote),
    `printf '${SHAS_MARKER} %s %s\\n' "$m" "$h"`,
    `${diff} --raw --numstat "$m" "$h" || exit 4`,
    `printf '\\0${ATTRS_MARKER}\\0'`,
    `${diff} --name-only "$m" "$h" | git check-attr -z --stdin linguist-generated gitlab-generated 2>/dev/null`,
    "exit 0",
  ].join("\n");
}

const STATUS: Record<string, ReviewFileStatus> = {
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "added",
};

/**
 * `git diff --raw --numstat -z` and the generated attributes, as a summary:
 * one file per raw record, in git's order, with its numstat counts.
 */
export function parseReviewSummary(output: string): ReviewDiff {
  const start = output.startsWith(SHAS_MARKER)
    ? 0
    : output.indexOf(`\n${SHAS_MARKER} `) + 1;
  let text = output.slice(start);
  const end = text.indexOf("\n");
  const [, baseSha, headSha] = (end < 0 ? text : text.slice(0, end)).split(" ");
  text = end < 0 ? "" : text.slice(end + 1);
  const attrsAt = text.indexOf(`\0${ATTRS_MARKER}\0`);
  const diffPart = attrsAt < 0 ? text : text.slice(0, attrsAt);
  const generated = parseGeneratedAttributes(
    attrsAt < 0 ? "" : text.slice(attrsAt + ATTRS_MARKER.length + 2),
  );
  const fields = diffPart.split("\0");
  const files: ReviewDiffFile[] = [];
  const counts: { additions: number; deletions: number; binary: boolean }[] =
    [];
  let index = 0;
  while (index < fields.length) {
    const field = fields[index++]!;
    if (!field) continue;
    if (field.startsWith(":")) {
      // :old-mode new-mode old-sha new-sha STATUS, then one or two paths.
      const letter = field.split(" ").pop()?.[0] ?? "M";
      const two = letter === "R" || letter === "C";
      const oldPath = fields[index++] ?? "";
      const path = two ? (fields[index++] ?? "") : oldPath;
      files.push({
        path,
        oldPath: letter === "C" ? path : oldPath,
        hunks: [],
        status: STATUS[letter] ?? "modified",
      });
      continue;
    }
    // numstat: "added<TAB>deleted<TAB>path", or for a rename an empty path
    // followed by the old and new ones.
    const [added = "", deleted = "", path] = field.split("\t");
    if (path === "") index += 2;
    counts.push({
      additions: added === "-" ? 0 : Number(added) || 0,
      deletions: deleted === "-" ? 0 : Number(deleted) || 0,
      binary: added === "-",
    });
  }
  files.forEach((file, at) => {
    const count = counts[at];
    if (count) {
      file.additions = count.additions;
      file.deletions = count.deletions;
      if (count.binary) file.binary = true;
    }
    const mark = generated.get(file.path);
    if (mark !== undefined) file.generated = mark;
  });
  return {
    files,
    ...(baseSha ? { baseSha } : {}),
    ...(headSha ? { headSha } : {}),
    truncated: false,
    summary: true,
  };
}

async function runReviewScript(
  args: {
    root: string;
    host?: string;
    runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  },
  script: string,
  name: string,
  target?: ReviewTarget,
) {
  const argv = args.host
    ? sshReadCommandArgv(args.host, script, [], name)
    : gitShellCommandArgv(script, undefined, GIT_ONLY);
  const result = await args.runProcessWithCodeTimeout(argv, SUMMARY_TIMEOUT_MS);
  if (result.code !== 0)
    throw reviewScriptError(
      result.stderr,
      "git diff failed",
      args.root,
      target,
    );
  return result.stdout;
}

/** A review's (or one of its commits') files, without their patches. */
export async function readReviewSummary(args: {
  root: string;
  of: ReviewSummaryOf;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewDiff> {
  const output = await runReviewScript(
    args,
    reviewSummaryScript(args.root, args.of, args.shQuote),
    "review.summary",
    args.of.target,
  );
  return parseReviewSummary(output);
}

/** A file to read: its path, and the one it had at the base. */
export type ReviewFileRequest = { path: string; oldPath?: string };

/**
 * One script: each file's patch between two commits (or trees), in the
 * order asked, each cut at `maxBytes`.
 */
export function reviewFilesScript(
  root: string,
  ends: { base: string; head: string },
  files: readonly ReviewFileRequest[],
  shQuote: (value: string) => string,
  maxBytes = GIT_DIFF_MAX_BYTES,
): string {
  if (!OBJECT_NAME.test(ends.base) || !OBJECT_NAME.test(ends.head))
    throw new Error("invalid revision");
  if (!files.length) throw new Error("no files to read");
  if (files.length > REVIEW_DIFF_FILES_MAX)
    throw new Error(`at most ${REVIEW_DIFF_FILES_MAX} files at a time`);
  for (const file of files)
    if (
      !validReviewPath(file.path) ||
      (file.oldPath !== undefined && !validReviewPath(file.oldPath))
    )
      throw new Error("invalid path");
  const diff = `${GIT} --literal-pathspecs diff ${DIFF_OPTIONS} --find-renames`;
  return [
    enterCheckout(root, shQuote),
    ...files.map((file, index) => {
      const paths = [
        ...(file.oldPath && file.oldPath !== file.path ? [file.oldPath] : []),
        file.path,
      ]
        .map((path) => shQuote(path))
        .join(" ");
      return `printf '\\n${FILE_MARKER} ${index}\\n'; ${diff} ${shQuote(ends.base)} ${shQuote(ends.head)} -- ${paths} | head -c ${maxBytes + 1}`;
    }),
    "exit 0",
  ].join("\n");
}

/** The files' patches as the script printed them, each in its place. */
export function parseReviewFiles(
  output: string,
  files: readonly ReviewFileRequest[],
  maxBytes = GIT_DIFF_MAX_BYTES,
): ReviewDiffFile[] {
  const parts = new Map<number, string>();
  const marker = new RegExp(`\\n${FILE_MARKER} (\\d+)\\n`, "g");
  const found = [...output.matchAll(marker)];
  found.forEach((match, at) => {
    const from = match.index! + match[0].length;
    const to = at + 1 < found.length ? found[at + 1]!.index! : output.length;
    parts.set(Number(match[1]), output.slice(from, to));
  });
  return files.map((asked, index) => {
    let text = parts.get(index) ?? "";
    const truncated = Buffer.byteLength(text) > maxBytes;
    if (truncated) {
      // Only whole hunks: the one the cut fell in goes.
      const last = text.lastIndexOf("\n@@ ");
      text = last > 0 ? text.slice(0, last + 1) : "";
    }
    const parsed =
      parseUnifiedDiff(text).find((file) => file.path === asked.path) ??
      parseUnifiedDiff(text)[0];
    const file: ReviewDiffFile = parsed ?? {
      path: asked.path,
      oldPath: asked.oldPath ?? asked.path,
      hunks: [],
    };
    return truncated ? { ...file, truncated: true } : file;
  });
}

/** These files' patches between a summary's two commits. */
export async function readReviewFiles(args: {
  root: string;
  base: string;
  head: string;
  files: readonly ReviewFileRequest[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<ReviewDiffFile[]> {
  const output = await runReviewScript(
    args,
    reviewFilesScript(
      args.root,
      { base: args.base, head: args.head },
      args.files,
      args.shQuote,
    ),
    "review.files",
  );
  return parseReviewFiles(output, args.files);
}
