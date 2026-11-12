import { normalizeSearchText } from "./searchText";

/**
 * fzf-style matching: a word matches when its letters appear in order in one
 * field, and scores higher when they run together and start words, path
 * segments or camelCase humps. The scores follow fzf's algorithm (v2) closely
 * enough that a query ranks as it would there.
 */

export const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_PATH = 9;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
/**
 * Letters scattered with no word start to anchor them (`video` across
 * `/var/home/.../devel/...`) are noise: a match that is not a plain
 * substring must score at least a consecutive letter's worth per letter.
 */
const MIN_SCATTERED_SCORE_PER_LETTER = SCORE_MATCH + BONUS_CONSECUTIVE;

/** The words of a query: each must match, in any order. */
export function searchTokens(query: string): string[] {
  return normalizeSearchText(query).split(" ").filter(Boolean);
}

type Prepared = { lower: string[]; bonus: Int8Array };

// Labels and directories repeat on every keystroke: keep their bonuses.
const preparedCache = new Map<string, Prepared>();
const PREPARED_CACHE_LIMIT = 4000;

function isWordChar(char: string) {
  return /[\p{L}\p{N}]/u.test(char);
}

function prepare(text: string): Prepared {
  const cached = preparedCache.get(text);
  if (cached) return cached;
  const lower: string[] = [];
  const bonus = new Int8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    lower.push(char.toLowerCase());
    const previous = index > 0 ? text[index - 1]! : "";
    if (!isWordChar(char)) bonus[index] = 0;
    else if (previous === "/" || previous === "\\") bonus[index] = BONUS_PATH;
    else if (!previous || !isWordChar(previous)) bonus[index] = BONUS_BOUNDARY;
    else if (
      (previous === previous.toLowerCase() &&
        previous !== previous.toUpperCase() &&
        char !== char.toLowerCase()) ||
      (/\p{N}/u.test(char) && !/\p{N}/u.test(previous))
    )
      bonus[index] = BONUS_CAMEL;
  }
  const prepared = { lower, bonus };
  if (preparedCache.size >= PREPARED_CACHE_LIMIT) preparedCache.clear();
  preparedCache.set(text, prepared);
  return prepared;
}

export type FuzzyMatch = { score: number; positions: number[] };

/**
 * The best placement of `token` (lower case) in `text`, or null when its
 * letters do not all appear there in order.
 */
export function fuzzyMatch(token: string, text: string): FuzzyMatch | null {
  const m = token.length;
  const n = text.length;
  if (m === 0 || m > n) return null;
  const { lower, bonus } = prepare(text);
  // Quick rejection, and the window the match can lie in.
  let first = -1;
  let found = 0;
  for (let i = 0; i < n && found < m; i++) {
    if (lower[i] !== token[found]) continue;
    if (found === 0) first = i;
    found++;
  }
  if (found < m) return null;

  const NONE = Number.NEGATIVE_INFINITY;
  const score = Array.from({ length: m }, () => new Float64Array(n).fill(NONE));
  const chunkBonus = Array.from({ length: m }, () => new Int8Array(n));
  const from = Array.from({ length: m }, () => new Int32Array(n).fill(-1));
  for (let j = 0; j < m; j++) {
    const char = token[j]!;
    const previousRow = j > 0 ? score[j - 1]! : null;
    let gapBest = NONE;
    let gapFrom = -1;
    for (let i = first + j; i < n; i++) {
      if (previousRow && i >= 2) {
        // Extend the best earlier placement of the previous letter by one gap.
        const opened = previousRow[i - 2]! + SCORE_GAP_START;
        const extended = gapBest + SCORE_GAP_EXTENSION;
        if (opened >= extended) {
          gapBest = opened;
          gapFrom = i - 2;
        } else gapBest = extended;
      }
      if (lower[i] !== char) continue;
      const here = bonus[i]!;
      if (!previousRow) {
        score[j]![i] = SCORE_MATCH + here * BONUS_FIRST_CHAR_MULTIPLIER;
        chunkBonus[j]![i] = here;
        continue;
      }
      let best = NONE;
      let bestFrom = -1;
      let bestChunk = here;
      if (i >= 1 && previousRow[i - 1]! > NONE) {
        const chunk = Math.max(chunkBonus[j - 1]![i - 1]!, here);
        best =
          previousRow[i - 1]! +
          SCORE_MATCH +
          Math.max(chunk, BONUS_CONSECUTIVE);
        bestFrom = i - 1;
        bestChunk = here >= BONUS_BOUNDARY ? here : chunk;
      }
      if (gapBest > NONE) {
        const gapped = gapBest + SCORE_MATCH + here;
        if (gapped > best) {
          best = gapped;
          bestFrom = gapFrom;
          bestChunk = here;
        }
      }
      if (best > NONE) {
        score[j]![i] = best;
        from[j]![i] = bestFrom;
        chunkBonus[j]![i] = bestChunk;
      }
    }
  }
  const lastRow = score[m - 1]!;
  let end = -1;
  for (let i = 0; i < n; i++)
    if (lastRow[i]! > NONE && (end < 0 || lastRow[i]! > lastRow[end]!)) end = i;
  if (end < 0) return null;
  const positions = new Array<number>(m);
  for (let j = m - 1, i = end; j >= 0; j--) {
    positions[j] = i;
    i = from[j]![i]!;
  }
  const best = lastRow[end]!;
  if (
    best >= m * MIN_SCATTERED_SCORE_PER_LETTER ||
    positions[m - 1]! - positions[0]! === m - 1
  )
    return { score: best, positions };
  // A plain substring always matches, as it did before letters could scatter.
  const at = lower.join("").indexOf(token);
  if (at < 0) return null;
  const run = Array.from({ length: m }, (_, offset) => at + offset);
  let runScore = 0;
  run.forEach((index, offset) => {
    runScore +=
      SCORE_MATCH +
      (offset === 0
        ? bonus[index]! * BONUS_FIRST_CHAR_MULTIPLIER
        : Math.max(bonus[index]!, BONUS_CONSECUTIVE));
  });
  return { score: runScore, positions: run };
}

/**
 * How well a query matches an entry, compared by `tier` first: the higher
 * tiers match the name itself (exactly, as its start, at word starts, inside
 * it, then letter by letter), and those where every word matches the name
 * come before those where some words match other fields. `score` orders
 * entries within a tier; `highlights` holds each field's matched characters.
 */
export type SearchMatch = {
  tier: number;
  score: number;
  highlights: (number[] | undefined)[];
};

/** Name tiers, from the weakest match in the name to the exact name. */
const TIER_FUZZY = 1;
const TIER_SUBSTRING = 2;
const TIER_WORD_START = 3;
const TIER_PREFIX = 4;
const TIER_EXACT = 5;
/** Added when every word of the query matches the name. */
const TIER_WHOLE_QUERY = 10;
/** Weighs a word matched in the name above the same match elsewhere. */
const NAME_BONUS = SCORE_MATCH * 2;

function nameTier(name: string, tokens: string[], fuzzy: boolean): number {
  const normalized = normalizeSearchText(name);
  const query = tokens.join(" ");
  if (normalized === query) return TIER_EXACT;
  if (normalized.startsWith(query)) return TIER_PREFIX;
  const words = ` ${normalized}`;
  if (tokens.every((token) => words.includes(` ${token}`)))
    return TIER_WORD_START;
  if (tokens.every((token) => normalized.includes(token)))
    return TIER_SUBSTRING;
  return fuzzy ? TIER_FUZZY : 0;
}

/**
 * Matches every word of a query against an entry's fields, the first being
 * its name. Null when some word matches no field.
 */
export function matchSearch(
  tokens: readonly string[],
  fields: readonly (string | undefined)[],
): SearchMatch | null {
  const highlights: (number[] | undefined)[] = fields.map(() => undefined);
  const inName: string[] = [];
  let score = 0;
  for (const token of tokens) {
    let best: { field: number; match: FuzzyMatch; score: number } | null = null;
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index];
      const match = field ? fuzzyMatch(token, field) : null;
      if (!match) continue;
      const weighted = match.score + (index === 0 ? NAME_BONUS : 0);
      if (!best || weighted > best.score)
        best = { field: index, match, score: weighted };
    }
    if (!best) return null;
    const { field, match, score: weighted } = best;
    score += weighted;
    highlights[field] = [...(highlights[field] ?? []), ...match.positions];
    if (field === 0) inName.push(token);
  }
  const name = fields[0] ?? "";
  const tier = inName.length
    ? nameTier(name, inName, true) +
      (inName.length === tokens.length ? TIER_WHOLE_QUERY : 0)
    : 0;
  return {
    tier,
    score,
    highlights: highlights.map((positions) =>
      positions ? [...new Set(positions)].sort((a, b) => a - b) : undefined,
    ),
  };
}

/**
 * Orders two matches: by tier, then by score in steps of one matched letter
 * so near-equal scores keep the caller's order (recency, tree order).
 */
export function compareSearchMatches(
  left: Pick<SearchMatch, "tier" | "score"> | undefined,
  right: Pick<SearchMatch, "tier" | "score"> | undefined,
): number {
  if (!left || !right) return 0;
  return (
    right.tier - left.tier ||
    Math.floor(right.score / SCORE_MATCH) - Math.floor(left.score / SCORE_MATCH)
  );
}

/** Splits text into runs, marking the characters at `positions`. */
export function highlightRuns(
  text: string,
  positions: readonly number[] | undefined,
): { text: string; matched: boolean }[] {
  if (!positions?.length) return [{ text, matched: false }];
  const marked = new Set(positions);
  const runs: { text: string; matched: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const matched = marked.has(index);
    const last = runs[runs.length - 1];
    if (last && last.matched === matched) last.text += text[index];
    else runs.push({ text: text[index]!, matched });
  }
  return runs;
}
