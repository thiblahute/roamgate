import { randomUUID } from "node:crypto";
import type { ReviewDiffFile } from "../../../shared/review";
import { LARGE_DIFF_PATCH_BYTES } from "../../../shared/gitDiffLimits";
import { parseUnifiedDiff } from "../review/patch";
import { GIT_DIFF_MAX_BYTES, GIT_DIFF_TIMEOUT_MS } from "./file-constants";
import { gitShellCommandArgv } from "./git-shell";
import { trimIncompleteUtf8Tail } from "./preview";
import type { RunProcessWithCodeTimeout } from "./file-types";
import { DIFF_OPTIONS, GIT as REVIEW_GIT } from "./review-patch";

/*
 * One file of the working changes as the review reads them (plan: review
 * into the inspector, D8 and phase 5s): the combined `git diff HEAD`
 * (staged and unstaged together; an untracked file as new), the numbering
 * threads anchor on, and which of its changed lines the index holds, told
 * exactly from `git diff --cached` (HEAD to index) and `git diff` (index to
 * working tree).
 */

/**
 * git as the review's patch loader runs it, pathspecs taken literally.
 */
const GIT = `${REVIEW_GIT} --literal-pathspecs`;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Line ranges, first and last, both included. */
export type LineRanges = [number, number][];

/** The changed lines of a combined diff the index holds (staged). */
export type CombinedStaged = {
  /** HEAD's lines the combined diff removes and the index no longer has. */
  old: LineRanges;
  /** The working tree's lines the combined diff adds that the index has. */
  new: LineRanges;
};

export type CombinedDiffFile = {
  diff: string;
  patch_size: number;
  truncated: boolean;
  deferred: boolean;
  /** Not known to git: shown as a new file. */
  untracked: boolean;
  /** Unmerged (a conflict): the index has no single version of it. */
  unmerged: boolean;
  /**
   * Which changed lines are staged; absent when it cannot be told (a
   * conflict, a patch too large or deferred). Every changed line not in
   * it is unstaged.
   */
  staged?: CombinedStaged;
};

function toRanges(lines: Iterable<number>): LineRanges {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: LineRanges = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/**
 * A line of a diff's new side to its old side's line, through the
 * diff's hunks: context lines map as they are, lines outside the hunks by
 * the offset the hunks before them leave. Null: a line the diff added.
 */
function newToOld(
  file: ReviewDiffFile | undefined,
): (line: number) => number | null {
  if (!file) return (line) => line;
  const exact = new Map<number, number | null>();
  // Each hunk's first new-side line and the offset (old - new) after it.
  const spans: { start: number; after: number }[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines)
      if (line.new !== null)
        exact.set(line.new, line.kind === "+" ? null : line.old);
    const header = HUNK_HEADER.exec(hunk.header);
    if (!header) continue;
    // A side with no lines names the line before it.
    const end = (start: string, count: string | undefined) =>
      count === "0" ? Number(start) : Number(start) + Number(count ?? 1) - 1;
    spans.push({
      start: Number(header[3]),
      after: end(header[1]!, header[2]) - end(header[3]!, header[4]),
    });
  }
  return (line) => {
    if (exact.has(line)) return exact.get(line)!;
    let delta = 0;
    for (const span of spans) {
      if (span.start > line) break;
      delta = span.after;
    }
    return line + delta;
  };
}

/**
 * The changed lines of `combined` (HEAD to working tree) that are staged,
 * from `cached` (HEAD to index) and `unstaged` (index to working tree), all
 * of the same file. A removed line is staged when the index no longer has
 * it; an added line when the working tree has it from the index and the
 * index added it.
 */
export function stagedLines(
  combined: ReviewDiffFile | undefined,
  cached: ReviewDiffFile | undefined,
  unstaged: ReviewDiffFile | undefined,
): CombinedStaged {
  const cachedRemoved = new Set<number>();
  const cachedAdded = new Set<number>();
  for (const hunk of cached?.hunks ?? [])
    for (const line of hunk.lines) {
      if (line.kind === "-" && line.old !== null) cachedRemoved.add(line.old);
      if (line.kind === "+" && line.new !== null) cachedAdded.add(line.new);
    }
  const toIndex = newToOld(unstaged);
  const old: number[] = [];
  const added: number[] = [];
  for (const hunk of combined?.hunks ?? [])
    for (const line of hunk.lines) {
      if (line.kind === "-" && line.old !== null && cachedRemoved.has(line.old))
        old.push(line.old);
      if (line.kind === "+" && line.new !== null) {
        const index = toIndex(line.new);
        if (index !== null && cachedAdded.has(index)) added.push(line.new);
      }
    }
  return { old: toRanges(old), new: toRanges(added) };
}

/**
 * The script: the combined patch into a private file (its size first, then
 * the patch, cut), then, marked, the cached and unstaged patches. An
 * untracked path is shown as new only when git lists it as untracked (so
 * never through a link out of the checkout) and it is a file or a link:
 * a FIFO is refused rather than read.
 */
export function combinedDiffScript(
  root: string,
  path: string,
  oldPath: string | undefined,
  marker: string,
  shQuote: (value: string) => string,
  automatic: boolean,
): string {
  const pathspec = [oldPath && oldPath !== path ? oldPath : null, path]
    .filter((each): each is string => !!each)
    .map(shQuote)
    .join(" ");
  const cap = GIT_DIFF_MAX_BYTES + 4;
  return `
cd ${shQuote(root)} 2>/dev/null || { echo "cannot enter the checkout" >&2; exit 2; }
f=${shQuote(path)}
patch_file=$(mktemp "\${TMPDIR:-/tmp}/roamgate-diff.XXXXXX") || exit 1
trap 'rm -f "$patch_file"' 0
trap 'exit 1' HUP INT TERM
base=$(git rev-parse --verify --quiet HEAD) || base=$(git hash-object -t tree /dev/null)
# A path through a link out of the checkout, or a FIFO or device, is not
# read: git would follow the one and block on the other.
top=$(pwd -P)
if real=$(cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd -P); then
  case "$real/" in "$top"/*) ;; *) echo "the file is outside the checkout" >&2; exit 4;; esac
fi
if [ -e "$f" ] && [ ! -f "$f" ] && [ ! -L "$f" ] && [ ! -d "$f" ]; then
  echo "not a regular file of the checkout" >&2; exit 4
fi
untracked=0
u=$(${GIT} ls-files --others --exclude-standard -z -- "$f" | tr -d '\\000')
if [ "$u" = "$f" ]; then
  { [ -f "$f" ] || [ -L "$f" ]; } || { echo "not a regular file of the checkout" >&2; exit 4; }
  untracked=1
  ${GIT} diff ${DIFF_OPTIONS} --no-index -- /dev/null "$f" >"$patch_file"
else
  ${GIT} diff ${DIFF_OPTIONS} --find-renames "$base" -- ${pathspec} >"$patch_file"
fi
git_code=$?
case "$git_code" in 0|1) ;; *) exit "$git_code" ;; esac
unmerged=0
[ -n "$(git ls-files -u -- ${pathspec} 2>/dev/null | head -n 1)" ] && unmerged=1
patch_size=$(wc -c <"$patch_file")
printf '%s %s %s\\n' "$patch_size" "$untracked" "$unmerged"
if [ ${automatic ? "1" : "0"} -eq 0 ] || [ "$patch_size" -lt ${LARGE_DIFF_PATCH_BYTES} ]; then
  head -c ${cap} "$patch_file"
  if [ "$patch_size" -le ${GIT_DIFF_MAX_BYTES} ] && [ "$untracked" = 0 ] && [ "$unmerged" = 0 ]; then
    printf '\\n${marker}\\n'
    ${GIT} diff ${DIFF_OPTIONS} --cached --find-renames -- ${pathspec} | head -c ${cap}
    printf '\\n${marker}\\n'
    ${GIT} diff ${DIFF_OPTIONS} -- "$f" | head -c ${cap}
  fi
fi
exit 0
`;
}

/** The file's own patch among a patch's files (a rename: by either name). */
function fileOf(text: string, path: string): ReviewDiffFile | undefined {
  const files = parseUnifiedDiff(text);
  return (
    files.find((file) => file.path === path) ??
    files.find((file) => file.oldPath === path) ??
    files[0]
  );
}

export function parseCombinedDiffOutput(
  output: string,
  marker: string,
  path: string,
  automatic: boolean,
): CombinedDiffFile {
  const newline = output.indexOf("\n");
  const [size, untracked, unmerged] = output
    .slice(0, newline < 0 ? undefined : newline)
    .trim()
    .split(" ");
  const patchSize = Number(size);
  if (newline < 0 || !Number.isSafeInteger(patchSize) || patchSize < 0)
    throw new Error("invalid Git patch size");
  const rest = output.slice(newline + 1);
  const [patch = "", cached, unstaged] = rest.split(`\n${marker}\n`);
  const truncated = patchSize > GIT_DIFF_MAX_BYTES;
  const deferred = automatic && patchSize >= LARGE_DIFF_PATCH_BYTES;
  const bytes = Buffer.from(patch);
  const diff = truncated
    ? trimIncompleteUtf8Tail(bytes.subarray(0, GIT_DIFF_MAX_BYTES)).toString(
        "utf8",
      )
    : patch;
  const result: CombinedDiffFile = {
    diff: deferred ? "" : diff,
    patch_size: patchSize,
    truncated,
    deferred,
    untracked: untracked === "1",
    unmerged: unmerged === "1",
  };
  if (deferred || truncated || result.unmerged) return result;
  if (result.untracked) return { ...result, staged: { old: [], new: [] } };
  if (cached === undefined || unstaged === undefined) return result;
  // A cut cached or unstaged patch cannot tell the lines exactly.
  if (
    Buffer.byteLength(cached) > GIT_DIFF_MAX_BYTES ||
    Buffer.byteLength(unstaged) > GIT_DIFF_MAX_BYTES
  )
    return result;
  return {
    ...result,
    staged: stagedLines(
      fileOf(diff, path),
      fileOf(cached, path),
      fileOf(unstaged, path),
    ),
  };
}

/** One file's combined working diff and its staged lines. */
export async function readCombinedDiffFile(args: {
  root: string;
  path: string;
  oldPath?: string;
  automatic?: boolean;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<CombinedDiffFile> {
  const marker = `ROAMGATE-COMBINED-${randomUUID()}`;
  const automatic = args.automatic === true;
  const script = combinedDiffScript(
    args.root,
    args.path,
    args.oldPath,
    marker,
    args.shQuote,
    automatic,
  );
  const result = await args.runProcessWithCodeTimeout(
    gitShellCommandArgv(script, args.host),
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0)
    throw new Error(
      (result.stderr || result.stdout || `git diff exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  // Whatever a login profile printed before the script's output goes.
  const start = result.stdout.search(/^\d+ [01] [01]\n/m);
  return parseCombinedDiffOutput(
    start > 0 ? result.stdout.slice(start) : result.stdout,
    marker,
    args.path,
    automatic,
  );
}
