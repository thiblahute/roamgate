/**
 * Where a review goes back to after a reload: the commit it was on, or the
 * one that commit became when the branch was rebased or amended, and the
 * line it was on.
 */

/** The commit a review was on before a reload. */
export type FollowedCommit = {
  sha: string;
  subject?: string;
  /** Its place in the review's commits, from 0. */
  index?: number;
  /** How many commits the review had. */
  count?: number;
};

/** How the commit shown after a reload was found. */
export type FollowHow =
  | "same"
  | "patch"
  | "subject"
  | "similar-subject"
  | "position"
  | "nearest";

export type FollowResult = { sha: string; index: number; how: FollowHow };

/**
 * A subject with what a rewrite adds or changes in passing taken out:
 * `fixup!` / `squash!` / `amend!` prefixes, case, spacing, a final period.
 */
export function normalizedSubject(subject: string): string {
  let text = subject.trim();
  for (;;) {
    const stripped = text.replace(/^(fixup|squash|amend)!\s*/i, "");
    if (stripped === text) break;
    text = stripped;
  }
  return text.replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
}

/**
 * The commit to show after a reload, in order: the same sha; the commit
 * with the same patch id (`git patch-id`: a rebase or reword kept its
 * change); the same subject; the same subject once normalized; the same
 * place when the review has as many commits as before; else the nearest
 * place. Several matches: the one nearest to where it was. Null when the
 * review has no commits.
 */
export function followCommit(
  was: FollowedCommit,
  commits: readonly { sha: string; subject: string }[],
  patchIds?: Readonly<Record<string, string>>,
): FollowResult | null {
  if (!commits.length) return null;
  const same = commits.findIndex((commit) => commit.sha === was.sha);
  if (same >= 0) return { sha: was.sha, index: same, how: "same" };
  const nearest = (indexes: number[]) => {
    if (!indexes.length) return -1;
    const at = was.index ?? 0;
    return indexes.reduce((best, index) =>
      Math.abs(index - at) < Math.abs(best - at) ? index : best,
    );
  };
  const pick = (how: FollowHow, test: (index: number) => boolean) => {
    const index = nearest(
      commits.flatMap((_, candidate) => (test(candidate) ? [candidate] : [])),
    );
    return index >= 0 ? { sha: commits[index]!.sha, index, how } : null;
  };
  const patchId = patchIds?.[was.sha];
  const subject = was.subject;
  const normalized =
    subject !== undefined ? normalizedSubject(subject) : undefined;
  const found =
    (patchId
      ? pick("patch", (index) => patchIds?.[commits[index]!.sha] === patchId)
      : null) ??
    (subject !== undefined
      ? (pick("subject", (index) => commits[index]!.subject === subject) ??
        pick(
          "similar-subject",
          (index) => normalizedSubject(commits[index]!.subject) === normalized,
        ))
      : null);
  if (found) return found;
  if (
    was.index !== undefined &&
    was.index >= 0 &&
    was.count === commits.length &&
    was.index < commits.length
  )
    return {
      sha: commits[was.index]!.sha,
      index: was.index,
      how: "position",
    };
  const index = Math.max(0, Math.min(was.index ?? 0, commits.length - 1));
  return { sha: commits[index]!.sha, index, how: "nearest" };
}

/** A line of a view, as the cursor stands on it. */
export type PlacedLine = { old: number | null; new: number | null };

/**
 * The row to stand on in a file after a reload: the same line, else the
 * nearest one on the side the line had (new first), else the file's first.
 * -1 when the file has no lines.
 */
export function nearestLine(
  lines: readonly PlacedLine[],
  want: { old?: number | null; new?: number | null },
): number {
  if (!lines.length) return -1;
  const exact = lines.findIndex(
    (line) =>
      line.old === (want.old ?? null) && line.new === (want.new ?? null),
  );
  if (exact >= 0) return exact;
  const side: "new" | "old" | null =
    want.new != null ? "new" : want.old != null ? "old" : null;
  if (!side) return 0;
  const target = want[side]!;
  let best = -1;
  let distance = Infinity;
  lines.forEach((line, index) => {
    const number = line[side];
    if (number === null) return;
    const gap = Math.abs(number - target);
    if (gap < distance) {
      best = index;
      distance = gap;
    }
  });
  return best >= 0 ? best : 0;
}
