import type { ReviewAnchor } from "./review";

/*
 * Where a thread written on a file (a rendered file's review, a comment on
 * a file's lines in the Files preview) is in the file as it reads now. Its
 * anchor keeps its last line's source (`text`) and the words it quotes
 * (`render.quote`, or its note's quote): it stays while its line still
 * reads as written and holds its words; else it is found again by its
 * line's text (the nearest line reading so, as Changes places a comment
 * on the combined diff), else by its words (the longest run of the quote's
 * first words a line holds, when that is most of them); else it is gone
 * from the file: detached, listed with its words rather than drawn on
 * whatever is on its old lines now. The server moves stored anchors so
 * (server/src/review/service.ts) and the Files preview places threads the
 * same way as it draws them (web/src/components/FileThreads.tsx).
 */

/** A space, or a mark Markdown puts around words: not what a quote says. */
export const NOT_WORDS = /[\s`*_~#>|\\]/;

/** One UTF-16 unit as quotes are compared: lower case, when that keeps it one. */
export function wordUnit(unit: string): string {
  const lower = unit.toLowerCase();
  return lower.length === 1 ? lower : unit;
}

/**
 * The words a quote is found by, as the chat finds a part's words in its
 * message: a link's text without its target, no spaces nor Markdown marks
 * (inline code's backticks, emphasis), lower case. A quote that starts
 * or ends mid-word is found all the same.
 */
export function quoteWords(text: string): string {
  let words = "";
  for (const unit of text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"))
    if (!NOT_WORDS.test(unit)) words += wordUnit(unit);
  return words;
}

/** How many of a quote's first units say where it is (kept, or by text). */
export const QUOTE_HEAD_UNITS = 48;
/** How many of a quote's first words a reworded thread is found by. */
export const QUOTE_HEAD_WORDS = 8;
/** This many of them (rounded up), in their order, must read on a line. */
const HEAD_SHARE = 0.6;
/** A line continues a moved quote when this many of its units are in it. */
const CONTINUES_UNITS = 12;

/** The words of a quote or a line: runs of letters and digits, lower case. */
function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The longest run of `head`'s words read in `tokens` in their order
 * (words between them skipped), and the first token an alignment that
 * long can start on.
 */
function commonRun(
  head: readonly string[],
  tokens: readonly string[],
): { length: number; start: number } {
  const n = head.length;
  const m = tokens.length;
  // longest[i][j]: the run of head[i..] in tokens[j..].
  const longest: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      longest[i]![j] =
        head[i] === tokens[j]
          ? longest[i + 1]![j + 1]! + 1
          : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  const length = longest[0]![0]!;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (head[i] === tokens[j] && longest[i]![j] === longest[i + 1]![j + 1]! + 1)
      return { length, start: j };
    // Skipping a word of the head first: the earliest token that starts it.
    if (longest[i + 1]![j] === longest[i]![j]) i += 1;
    else j += 1;
  }
  return { length, start: m };
}

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
 * The words a thread quotes from the file, when it quotes words: those of
 * a rendered file (not a graphic's region nor a page's element), or of a
 * comment on a file's lines (its note). Undefined when it quotes none.
 */
export function anchorQuote(anchor: ReviewAnchor): string | undefined {
  const { render } = anchor;
  if (render)
    return render.graphic || render.region || render.element || render.selector
      ? undefined
      : render.quote || undefined;
  const note = noteOf(anchor);
  return note?.source === "file" && typeof note.quote === "string"
    ? note.quote || undefined
    : undefined;
}

/** A thread's place in the file as it reads now. */
export type FilePlace = {
  line: number;
  endLine?: number;
  /** Its last line's source, as it reads now. */
  text: string;
  /** The words it quotes: as written, or as its lines read now when found by them. */
  quote?: string;
  /** Kept where it was, found by its line's text elsewhere, or by its words. */
  how: "kept" | "text" | "words";
};

/**
 * The words of some source lines as a Markdown preview shows them, near
 * enough: no list marks, task boxes, heading or quote marks, no inline
 * code or emphasis marks, a link's text alone, one line per source line.
 */
export function renderedWords(lines: readonly string[]): string {
  return lines
    .map((line) =>
      line
        .replace(/^\s*(?:>\s*)*/, "")
        .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/~~(.+?)~~/g, "$1")
        .replace(/(^|[^\w\\])\*([^*\s][^*]*?)\*/g, "$1$2")
        .replace(/(^|[^\w\\])_([^_\s][^_]*?)_(?![\w])/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
        .replace(/\s+$/, ""),
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Where the anchor's thread is in `lines` (the file's, in order): kept
 * where it was while its last line still reads as written (`text`) and its
 * lines hold its quote's first words; else on the nearest line reading as
 * its last line did, its lines holding those words; else on the line
 * where the longest run of the quote's first words (QUOTE_HEAD_WORDS) is
 * read in their order, the nearest among equals, when that is most of
 * them (HEAD_SHARE), the lines after it that still read as the quote's
 * going with it. Null when none does: the words are gone or too changed.
 * A thread with no line, found by its text or words, is placed again.
 */
export function placeInFile(
  anchor: ReviewAnchor,
  lines: readonly string[],
): FilePlace | null {
  const { line, endLine, text } = anchor;
  if (anchor.side === "old") return null;
  const quote = anchorQuote(anchor);
  const all = quote ? quoteWords(quote) : "";
  const head = all.slice(0, QUOTE_HEAD_UNITS);
  const span = line !== undefined && endLine !== undefined ? endLine - line : 0;
  const words = lines.map(quoteWords);
  const spanWords = (start: number, end: number) =>
    words.slice(start - 1, end).join("");
  const target = endLine ?? line;
  if (line !== undefined && target !== undefined) {
    const at = lines[target - 1];
    const reads = text === undefined || at === text;
    const holds = !head || spanWords(line, target).includes(head);
    if (at !== undefined && reads && holds)
      return {
        line,
        ...(endLine !== undefined ? { endLine } : {}),
        text: at,
        ...(quote ? { quote } : {}),
        how: "kept",
      };
  }
  if (text !== undefined) {
    let best: { end: number; distance: number } | null = null;
    lines.forEach((each, index) => {
      if (each !== text) return;
      const end = index + 1;
      const start = end - span;
      if (start < 1 || (head && !spanWords(start, end).includes(head))) return;
      const distance = target === undefined ? end : Math.abs(end - target);
      if (!best || distance < best.distance) best = { end, distance };
    });
    const found = best as { end: number; distance: number } | null;
    if (found)
      return {
        line: found.end - span,
        ...(span ? { endLine: found.end } : {}),
        text,
        ...(quote ? { quote } : {}),
        how: "text",
      };
  }
  if (!head) return null;
  const headWords = tokensOf(quote!).slice(0, QUOTE_HEAD_WORDS);
  if (!headWords.length) return null;
  const needed = Math.ceil(headWords.length * HEAD_SHARE);
  const tokens = lines.map(tokensOf);
  let best: { start: number; matched: number; distance: number } | null = null;
  tokens.forEach((own, index) => {
    if (!own.length) return;
    // Its words may run on to the next lines; the run starts on this one.
    const window = [
      ...own,
      ...(tokens[index + 1] ?? []),
      ...(tokens[index + 2] ?? []),
    ];
    const run = commonRun(headWords, window);
    if (run.length < needed || run.start >= own.length) return;
    const start = index + 1;
    const distance = line === undefined ? start : Math.abs(start - line);
    if (
      !best ||
      run.length > best.matched ||
      (run.length === best.matched && distance < best.distance)
    )
      best = { start, matched: run.length, distance };
  });
  const found = best as { start: number; matched: number } | null;
  if (!found) return null;
  let end = found.start;
  while (end < lines.length) {
    const next = words[end]!;
    if (!next || !all.includes(next.slice(0, CONTINUES_UNITS))) break;
    end += 1;
  }
  // The words quoted, still read there: as written; else as its lines read.
  const verbatim = spanWords(found.start, end).includes(all);
  return {
    line: found.start,
    ...(end > found.start ? { endLine: end } : {}),
    text: lines[end - 1]!,
    quote: verbatim
      ? quote!
      : renderedWords(lines.slice(found.start - 1, end)) || quote!,
    how: "words",
  };
}

/**
 * The anchor at `place`: its lines, its last line's text, its quote (the
 * words as they read now), its note saying the same.
 */
export function anchorAt(anchor: ReviewAnchor, place: FilePlace): ReviewAnchor {
  const next: ReviewAnchor = { ...anchor, line: place.line, text: place.text };
  if (place.endLine !== undefined) next.endLine = place.endLine;
  else delete next.endLine;
  if (place.quote !== undefined && anchor.render?.quote !== undefined)
    next.render = { ...anchor.render, quote: place.quote };
  const note = noteOf(anchor);
  if (note) {
    note.line = place.line;
    if (place.endLine !== undefined) note.endLine = place.endLine;
    else delete note.endLine;
    if (place.quote !== undefined && typeof note.quote === "string")
      note.quote = place.quote;
    next.feedback = JSON.stringify(note);
  }
  return next;
}

/**
 * The anchor off its lines, its text and words kept to find them again:
 * on the file, listed with its words, drawn on no line.
 */
export function anchorDetached(anchor: ReviewAnchor): ReviewAnchor {
  const next: ReviewAnchor = { ...anchor };
  delete next.line;
  delete next.endLine;
  const note = noteOf(anchor);
  if (note) {
    delete note.line;
    delete note.endLine;
    next.feedback = JSON.stringify(note);
  }
  return next;
}

/**
 * Whether the thread was written in the Files preview, on the file as it
 * reads (its note says so): in the checkout's review, among threads on
 * its diff, these follow the file.
 */
export function writtenInFile(anchor: ReviewAnchor): boolean {
  return noteOf(anchor)?.source === "file";
}

/** Whether `anchor` is on the file's lines, or was (text or words kept). */
export function anchoredInFile(anchor: ReviewAnchor): boolean {
  return (
    !!anchor.path &&
    !anchor.message &&
    !anchor.chat &&
    !anchor.effort &&
    !anchor.terminal &&
    anchor.side !== "old" &&
    (anchor.line !== undefined ||
      anchor.text !== undefined ||
      anchorQuote(anchor) !== undefined)
  );
}

/**
 * The anchor as the file reads now: unchanged when kept where it was (and
 * its text known); moved, or detached; null when nothing is to change.
 */
export function anchorInFile(
  anchor: ReviewAnchor,
  lines: readonly string[],
): ReviewAnchor | null {
  if (!anchoredInFile(anchor)) return null;
  const place = placeInFile(anchor, lines);
  if (!place) return anchor.line === undefined ? null : anchorDetached(anchor);
  if (place.how === "kept" && anchor.text === place.text) return null;
  return anchorAt(anchor, place);
}
