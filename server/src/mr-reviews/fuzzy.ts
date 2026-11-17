import type { MrMatchProposal } from "../../../shared/mrReviews";

/**
 * Fuzzy matches of an effort's commits against the upstream commits since
 * their merge base (D14): scored locally, no model. As the session
 * archive ranks its search (word matches weighted by how rare the word
 * is), subject words count by their inverse frequency among the
 * candidates; touched paths, the author and the size of the change on the
 * shared files add to it. Only candidates sharing a file, a directory or
 * a rare word are scored, so 880 commits against thousands stay quick.
 */

export const MATCH_THRESHOLD = 0.42;
export const MATCH_TOP = 3;

export type MatchCommit = {
  key: string;
  subject: string;
  author: string;
  files: string[];
  /** Lines changed per file, aligned with files (0 when unknown). */
  sizes?: number[];
};

export type UpstreamCandidate = {
  sha: string;
  subject: string;
  author: string;
  at: number;
  files: string[];
  sizes: number[];
};

const STOP = new Set(
  "a an and the of to in on for with from by at is be it as or not no this that into when add fix use make update remove more less don't do".split(
    " ",
  ),
);

/** A subject's words: lower case, no prefix markers, no stop words. */
export function subjectWords(subject: string): string[] {
  return [
    ...new Set(
      subject
        .replace(/^(?:fixup|squash|amend)! /, "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((word) => word.length >= 2 && !STOP.has(word)),
    ),
  ];
}

const dirOf = (file: string) =>
  file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";

function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const each of a) if (b.has(each)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Scores one pair: 0 to 1, with what made it close. */
export function scorePair(
  commit: MatchCommit,
  candidate: UpstreamCandidate,
  idf: (word: string) => number,
): { score: number; why: string[] } {
  const why: string[] = [];
  const files = new Set(commit.files);
  const theirs = new Set(candidate.files);
  const fileScore = jaccard(files, theirs);
  const dirScore = jaccard(
    new Set(commit.files.map(dirOf)),
    new Set(candidate.files.map(dirOf)),
  );
  const paths = Math.max(fileScore, dirScore * 0.5);
  if (fileScore >= 0.5) why.push("same files");
  else if (fileScore > 0) why.push("some files");
  else if (dirScore > 0) why.push("same directories");
  // Words weighted by rarity, as a ranked search weighs terms.
  const mine = subjectWords(commit.subject);
  const other = new Set(subjectWords(candidate.subject));
  let shared = 0;
  let all = 0;
  for (const word of new Set([...mine, ...other])) {
    const weight = idf(word);
    all += weight;
    if (other.has(word) && mine.includes(word)) shared += weight;
  }
  const words = all ? shared / all : 0;
  if (words >= 0.5) why.push("subject");
  else if (words > 0.2) why.push("subject words");
  const author =
    commit.author.trim().toLowerCase() === candidate.author.trim().toLowerCase()
      ? 1
      : 0;
  if (author) why.push("author");
  // How alike the change is on the files both touch.
  let size = 0;
  let counted = 0;
  commit.files.forEach((file, index) => {
    const at = candidate.files.indexOf(file);
    if (at < 0) return;
    const a = commit.sizes?.[index] ?? 0;
    const b = candidate.sizes[at] ?? 0;
    counted++;
    size += a || b ? 1 - Math.abs(a - b) / Math.max(a, b) : 1;
  });
  const sizes = counted ? size / counted : 0;
  if (sizes >= 0.8) why.push("size");
  return {
    score: 0.35 * paths + 0.35 * words + 0.1 * author + 0.2 * sizes,
    why,
  };
}

/**
 * The best candidates of each commit above the threshold, best first;
 * candidates a person rejected for a commit never come back.
 */
export function proposeMatches(
  commits: MatchCommit[],
  candidates: UpstreamCandidate[],
  rejected: (key: string) => readonly string[] = () => [],
  options: { threshold?: number; top?: number } = {},
): Record<string, MrMatchProposal[]> {
  const threshold = options.threshold ?? MATCH_THRESHOLD;
  const top = options.top ?? MATCH_TOP;
  const out: Record<string, MrMatchProposal[]> = {};
  if (!commits.length || !candidates.length) return out;
  const df = new Map<string, number>();
  const byWord = new Map<string, number[]>();
  const byFile = new Map<string, number[]>();
  const byDir = new Map<string, number[]>();
  const index = (map: Map<string, number[]>, key: string, at: number) => {
    const list = map.get(key);
    if (list) list.push(at);
    else map.set(key, [at]);
  };
  candidates.forEach((candidate, at) => {
    for (const word of subjectWords(candidate.subject)) {
      df.set(word, (df.get(word) ?? 0) + 1);
      index(byWord, word, at);
    }
    for (const file of new Set(candidate.files)) index(byFile, file, at);
    for (const dir of new Set(candidate.files.map(dirOf)))
      index(byDir, dir, at);
  });
  const total = candidates.length;
  const idf = (word: string) => Math.log(1 + total / (1 + (df.get(word) ?? 0)));
  // A word in more than a tenth of the candidates does not find any.
  const rare = Math.max(5, total / 10);
  for (const commit of commits) {
    const pool = new Set<number>();
    for (const file of commit.files)
      for (const at of byFile.get(file) ?? []) pool.add(at);
    for (const dir of new Set(commit.files.map(dirOf)))
      for (const at of (byDir.get(dir) ?? []).slice(0, 2000)) pool.add(at);
    for (const word of subjectWords(commit.subject))
      if ((df.get(word) ?? 0) <= rare)
        for (const at of byWord.get(word) ?? []) pool.add(at);
    const no = new Set(rejected(commit.key));
    const scored: MrMatchProposal[] = [];
    for (const at of pool) {
      const candidate = candidates[at]!;
      if (no.has(candidate.sha)) continue;
      const { score, why } = scorePair(commit, candidate, idf);
      if (score >= threshold)
        scored.push({
          sha: candidate.sha,
          subject: candidate.subject,
          author: candidate.author,
          score: Math.round(score * 100) / 100,
          why: why.join(", "),
        });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length) out[commit.key] = scored.slice(0, top);
  }
  return out;
}

/** `git log --numstat` lines: `C sha at author subject`, then `add del path`. */
export function parseUpstreamCandidates(stdout: string): {
  commits: UpstreamCandidate[];
  exact: Set<string>;
} {
  const commits: UpstreamCandidate[] = [];
  const exact = new Set<string>();
  let current: UpstreamCandidate | null = null;
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] === "C" && parts.length >= 5) {
      current = {
        sha: parts[1]!,
        at: Number(parts[2]) || 0,
        author: parts[3]!,
        subject: parts.slice(4).join("\t"),
        files: [],
        sizes: [],
      };
      commits.push(current);
    } else if (parts[0] === "Q" && parts.length === 2) {
      exact.add(parts[1]!);
      current = null;
    } else if (current && parts.length === 3 && /^(\d+|-)$/.test(parts[0]!)) {
      if (current.files.length < 20) {
        current.files.push(parts[2]!);
        current.sizes.push((Number(parts[0]) || 0) + (Number(parts[1]) || 0));
      }
    }
  }
  return { commits: commits.filter((c) => !exact.has(c.sha)), exact };
}

/** Upstream commits since the merge base, at most `max`, and those already matched exactly. */
export function upstreamCandidatesScript(
  dir: string,
  source: string,
  target: string,
  mergeBase: string,
  max = 3000,
  shQuote: (value: string) => string,
): string {
  const range = `${mergeBase}..${target}`;
  return [
    `d=${shQuote(dir)}`,
    `git -C "$d" log --no-merges -n ${max} --format='C%x09%H%x09%at%x09%an%x09%s' --numstat ${shQuote(range)}`,
    // Upstream commits holding a change of the source exactly.
    `git -C "$d" cherry ${shQuote(source)} ${shQuote(target)} ${shQuote(mergeBase)} | awk '$1 == "-" { print "Q\\t" $2 }'`,
    "exit 0",
  ].join("\n");
}
