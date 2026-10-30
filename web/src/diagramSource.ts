import { marked, type Token } from "marked";

/**
 * Diagrams written in comments and chat messages: ```mermaid and ```svg
 * blocks, and a message that is nothing but SVG markup. These helpers only
 * find them; drawing them (components/DiagramBlock) loads when one shows.
 */

export type DiagramLanguage = "mermaid" | "svg";

/** The diagram a fenced block's info string names, if any. */
export function diagramLanguage(
  info: string | null | undefined,
): DiagramLanguage | null {
  const word = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (word === "mermaid") return "mermaid";
  if (word === "svg") return "svg";
  return null;
}

/** A prolog, comments and a doctype may come before the <svg> element. */
const SVG_PREAMBLE =
  /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*/i;

/** A message that is nothing but SVG markup: that markup, else null. */
export function rawSvgMarkup(text: string): string | null {
  const trimmed = text.trim();
  const preamble = SVG_PREAMBLE.exec(trimmed)?.[0] ?? "";
  const rest = trimmed.slice(preamble.length);
  return /^<svg[\s>]/i.test(rest) && /<\/svg>$/i.test(rest) ? trimmed : null;
}

/** SVG markup still being written: it starts as one, it is not closed. */
function rawSvgStart(text: string): boolean {
  const trimmed = text.trimStart();
  const preamble = SVG_PREAMBLE.exec(trimmed)?.[0] ?? "";
  return /^<svg[\s>]/i.test(trimmed.slice(preamble.length));
}

/** A fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((run) => run[0].length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Markdown for a message: SVG markup alone becomes an ```svg block (drawn
 * as one), and while it is still being written an open one (shown as code
 * until it is whole). Any other text is left as it is.
 */
export function diagramMarkdown(text: string): string {
  const svg = rawSvgMarkup(text);
  if (svg) {
    const fence = fenceFor(svg);
    return `${fence}svg\n${svg}\n${fence}`;
  }
  if (rawSvgStart(text)) return `${fenceFor(text)}svg\n${text.trim()}`;
  return text;
}

/**
 * Whether a fenced code block's source (a code token's raw) has its closing
 * fence. A block still being streamed runs to the end of the text without
 * one; indented code has no fence to wait for.
 */
export function fenceClosed(raw: string): boolean {
  const lines = raw.replace(/\s+$/, "").split("\n");
  const open = /^\s*(`{3,}|~{3,})/.exec(lines[0] ?? "");
  if (!open) return true;
  if (lines.length < 2) return false;
  const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1] ?? "");
  return (
    !!close &&
    close[1]![0] === open[1]![0] &&
    close[1]!.length >= open[1]!.length
  );
}

/**
 * Whether the text ends inside a fenced block not closed yet: a streamed
 * message's last block. Only the last block can be open (it runs to the
 * end), so it is the last code block drawn.
 */
export function endsInOpenFence(text: string): boolean {
  if (!/(`{3,}|~{3,})/.test(text)) return false;
  let last: Token | null = null;
  marked.walkTokens(marked.lexer(text, { gfm: true }), (token) => {
    if (token.type === "code") last = token;
  });
  const code = last as Token | null;
  return !!code && code.type === "code" && !fenceClosed(code.raw);
}
