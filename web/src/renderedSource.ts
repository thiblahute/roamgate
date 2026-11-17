import { marked, type Token, type Tokens, type TokensList } from "marked";
import type { ReviewAnchor, ReviewRegion } from "../../shared/review";

/*
 * What a rendered review shows, tied back to its source: Markdown drawn
 * block by block, each block knowing its lines; regions of graphics in
 * fractions of their size.
 */

/** A top-level Markdown block and the source lines it comes from. */
export type MarkdownBlock = {
  /** First and last line, 1-based, inclusive. */
  start: number;
  end: number;
  /** The block's own Markdown, with the document's link definitions. */
  tokens: TokensList;
  type: string;
};

function lineCount(text: string): number {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    count += 1;
  return count;
}

/** The text as Markdown reads it: \r\n and \r as \n. */
export function markdownSource(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/**
 * The document's blocks with their lines. Blank space between blocks is
 * left out; each block keeps the link definitions so its links resolve.
 */
export function markdownBlocks(text: string): MarkdownBlock[] {
  const source = markdownSource(text);
  const tokens = marked.lexer(source, { gfm: true });
  const blocks: MarkdownBlock[] = [];
  let line = 1;
  for (const token of tokens as Token[]) {
    const raw = token.raw ?? "";
    const trimmed = raw.replace(/\n+$/, "");
    const leading = raw.length - raw.trimStart().length;
    const lead = lineCount(raw.slice(0, leading));
    if (token.type !== "space" && token.type !== "def" && trimmed.trim()) {
      const start = line + lead;
      const end = line + lineCount(trimmed);
      const list = Object.assign([token], {
        links: tokens.links,
      }) as unknown as TokensList;
      blocks.push({
        start,
        end: Math.max(start, end),
        tokens: list,
        type: token.type,
      });
    }
    line += lineCount(raw);
  }
  return blocks;
}

/**
 * A list item and its own source lines (not its nested lists'), with the
 * items of each list nested in it.
 */
export type SourceItem = { line: number; end: number; lists: SourceItem[][] };

/** The items of a list starting on `start`, with their lines. */
export function listItemLines(list: Tokens.List, start: number): SourceItem[] {
  const items: SourceItem[] = [];
  let line = start;
  for (const item of list.items) {
    const lists: SourceItem[][] = [];
    let own: number | null = null;
    // The item's tokens follow its text line for line, nested lists too.
    let before = "";
    for (const token of item.tokens) {
      if (token.type === "list") {
        const at = line + lineCount(before);
        if (own === null)
          own = Math.max(line, line + lineCount(before.replace(/\n+$/, "")));
        lists.push(listItemLines(token as Tokens.List, at));
      }
      before += token.raw ?? "";
    }
    const end = own ?? line + lineCount(item.raw.replace(/\n+$/, ""));
    items.push({ line, end: Math.max(line, end), lists });
    line += lineCount(item.raw);
  }
  return items;
}

/** A stop of a source-lined Markdown preview: a block, an item, a cell. */
export type SourceStop = {
  key: string;
  line: number;
  end: number;
  /** What it reads. */
  text: string;
};

/** A space, or a mark Markdown puts around words: not what a quote says. */
const NOT_WORDS = /[\s`*_~#>|\\]/;

/** One UTF-16 unit as quotes are compared: lower case, when that keeps it one. */
function wordUnit(unit: string): string {
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

/** A quote's first line with words: what a stop of its line is found by. */
function firstWords(quote: string): string {
  return quoteWords(quote.split("\n").find((line) => line.trim()) ?? "");
}

/**
 * The stop a thread on `line` quoting `quote` goes to: the narrowest one
 * holding the line (a cell rather than its row's others when the quote is
 * its words, in part or across its inline code), else the one before the
 * line.
 */
export function sourceStopOf(
  stops: readonly SourceStop[],
  line: number,
  quote?: string,
): string | undefined {
  const holding = stops.filter((stop) => stop.line <= line && line <= stop.end);
  if (!holding.length) {
    const before = stops.filter((stop) => stop.line <= line);
    return (before[before.length - 1] ?? stops[0])?.key;
  }
  const width = Math.min(...holding.map((stop) => stop.end - stop.line));
  const narrowest = holding.filter((stop) => stop.end - stop.line === width);
  const words = quote ? firstWords(quote) : "";
  const found = words
    ? (narrowest.find((stop) => quoteWords(stop.text) === words) ??
      narrowest.find((stop) => quoteWords(stop.text).includes(words)) ??
      narrowest.find((stop) => {
        const text = quoteWords(stop.text);
        return !!text && words.includes(text);
      }))
    : undefined;
  return (found ?? narrowest[0])?.key;
}

/**
 * Where a quote starts in what a stop reads, to order its threads: -1
 * when it cannot be found there.
 */
export function quoteOffset(text: string, quote: string): number {
  const words = firstWords(quote);
  return words ? quoteWords(text).indexOf(words) : -1;
}

/**
 * Which of a stop's repeats of a quote a thread is on, by the line it
 * was written on: the times it is said on the stop's lines before that
 * one (0 on a stop of one line).
 */
export function quoteOccurrence(
  lines: readonly string[],
  stopLine: number,
  line: number,
  quote: string,
): number {
  const words = quoteWords(quote);
  if (!words || line <= stopLine) return 0;
  const before = quoteWords(lines.slice(stopLine - 1, line - 1).join("\n"));
  let count = 0;
  for (
    let at = before.indexOf(words);
    at !== -1;
    at = before.indexOf(words, at + words.length)
  )
    count += 1;
  return count;
}

/**
 * The quote's words in what `root` shows (not the threads drawn in it),
 * as a range to highlight: its `occurrence`-th repeat, else its first; a
 * quote that runs past `root` by its first line, or all of `root` when
 * the quote holds all it says.
 */
export function quoteRange(
  root: Node,
  quote: string,
  occurrence = 0,
): Range | null {
  const units: { node: Text; offset: number }[] = [];
  let words = "";
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(".md-thread-slot")) continue;
    const data = (node as Text).data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const unit = data[offset]!;
      if (NOT_WORDS.test(unit)) continue;
      words += wordUnit(unit);
      units.push({ node: node as Text, offset });
    }
  }
  if (!words) return null;
  const range = (at: number, length: number) => {
    const from = units[at]!;
    const to = units[at + length - 1]!;
    const made = doc.createRange();
    made.setStart(from.node, from.offset);
    made.setEnd(to.node, to.offset + 1);
    return made;
  };
  for (const needle of [quoteWords(quote), firstWords(quote)]) {
    if (!needle) continue;
    const found: number[] = [];
    for (
      let at = words.indexOf(needle);
      at !== -1;
      at = words.indexOf(needle, at + needle.length)
    )
      found.push(at);
    if (found.length)
      return range(found[occurrence] ?? found[0]!, needle.length);
  }
  return quoteWords(quote).includes(words) ? range(0, words.length) : null;
}

/** A column of a table's row, where it is from the row's left edge. */
export type SlotColumn = { left: number; width: number };

/**
 * Where a cell's threads go under its row: in its column when a card fits
 * there (`minWidth`), else under the row from the cell's column (or one
 * before it, enough for a card) to the row's end, `pointer` pixels from
 * that start being the cell's middle.
 */
export function cellPlacement(
  columns: readonly SlotColumn[],
  column: number,
  minWidth: number,
): { start: number; end: number; under: boolean; pointer: number } {
  const last = columns.length;
  const at = Math.min(Math.max(0, column), last - 1);
  const cell = columns[at]!;
  if (cell.width >= minWidth)
    return { start: at, end: at + 1, under: false, pointer: cell.width / 2 };
  const right = (from: number) =>
    columns[last - 1]!.left + columns[last - 1]!.width - columns[from]!.left;
  let start = at;
  while (start > 0 && right(start) < minWidth) start -= 1;
  return {
    start,
    end: last,
    under: true,
    pointer: cell.left + cell.width / 2 - columns[start]!.left,
  };
}

/** Markdown punctuation and spaces dropped, lower case: to find words. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|[\]()\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The lines of a block a quote is on: those holding its first and last
 * words, when they can be found; else the whole block.
 */
export function narrowLines(
  lines: readonly string[],
  start: number,
  end: number,
  quote: string,
): { line: number; endLine: number } {
  const whole = { line: start, endLine: end };
  const parts = quote
    .split("\n")
    .map(plain)
    .filter((part) => part.length > 0);
  if (!parts.length) return whole;
  const head = parts[0]!.slice(0, 40);
  const tail = parts[parts.length - 1]!.slice(-40);
  const find = (needle: string, from: number) => {
    for (let at = from; at <= end; at += 1)
      if (plain(lines[at - 1] ?? "").includes(needle)) return at;
    return 0;
  };
  const first = find(head, start);
  if (!first) return whole;
  const last = find(tail, first) || first;
  return { line: first, endLine: last };
}

/** A region between two points, in fractions of the graphic's box. */
export function regionOf(
  from: { x: number; y: number },
  to: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
): ReviewRegion | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x1 = clamp((Math.min(from.x, to.x) - box.left) / box.width);
  const y1 = clamp((Math.min(from.y, to.y) - box.top) / box.height);
  const x2 = clamp((Math.max(from.x, to.x) - box.left) / box.width);
  const y2 = clamp((Math.max(from.y, to.y) - box.top) / box.height);
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  // A small drag is a click: a point.
  const point = Math.abs(to.x - from.x) < 6 && Math.abs(to.y - from.y) < 6;
  return point
    ? { x: round(x1), y: round(y1), w: 0, h: 0 }
    : {
        x: round(x1),
        y: round(y1),
        w: round(Math.min(x2 - x1, 1 - round(x1))),
        h: round(Math.min(y2 - y1, 1 - round(y1))),
      };
}

/** An SVG that moves: SMIL or CSS animations. */
export function isAnimatedSvg(markup: string): boolean {
  return /<(animate|animateTransform|animateMotion|set)\b|@keyframes/i.test(
    markup,
  );
}

/** A point at a graphic, said in words where a quote would go. */
export function pointQuote(
  graphic: string,
  region: ReviewRegion,
  element?: string,
) {
  const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;
  const where =
    region.w || region.h
      ? `region x ${pct(region.x)} y ${pct(region.y)} w ${pct(region.w)} h ${pct(region.h)}`
      : `point x ${pct(region.x)} y ${pct(region.y)}`;
  return `[${graphic}, ${where}${element ? `, ${element}` : ""}]`;
}

/** A thread's place, said briefly for the list. */
export function renderedWhere(anchor: ReviewAnchor): string {
  const render = anchor.render;
  const lines = anchor.line
    ? `:${anchor.line}${anchor.endLine ? `-${anchor.endLine}` : ""}`
    : "";
  const place = render?.url ?? (anchor.path ? `${anchor.path}${lines}` : "");
  const what = render?.graphic
    ? `${render.graphic}${render.element ? ` (${render.element})` : ""}`
    : render?.quote
      ? `"${render.quote.length > 60 ? `${render.quote.slice(0, 60)}...` : render.quote}"`
      : render?.selector
        ? render.selector
        : "";
  return [place || "The whole page", what].filter(Boolean).join(" · ");
}
