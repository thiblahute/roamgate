import { marked, type Tokens } from "marked";

/**
 * A message's blocks, the parts one can comment on: paragraphs, list items,
 * each line of a code block, a suggestion. Blank lines beyond the one that
 * separates blocks are kept as empty lines (Markdown would fold them).
 */
export type MessageBlock =
  | { kind: "markdown"; source: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "suggestion"; range: string; code: string }
  | { kind: "blank"; lines: number };

export function messageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const token of marked.lexer(text.trim(), { gfm: true, breaks: true })) {
    if (token.type === "space") {
      // One blank line is the usual gap between blocks; more are kept.
      const lines = token.raw.split("\n").length - 3;
      if (lines > 0) blocks.push({ kind: "blank", lines });
    } else if (token.type === "code" && token.codeBlockStyle !== "indented") {
      const info = (token.lang ?? "").trim();
      const suggestion = /^suggestion(?::(\S+))?$/.exec(info);
      if (suggestion)
        blocks.push({
          kind: "suggestion",
          range: suggestion[1] ?? "-0+0",
          code: token.text,
        });
      else
        blocks.push({
          kind: "code",
          lang: info.split(/\s+/)[0] ?? "",
          lines: token.text.split("\n"),
        });
    } else if (token.type === "list") {
      const list = token as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      list.items.forEach((item, index) =>
        blocks.push({
          kind: "markdown",
          // An item alone, numbered as in its list.
          // Without the blank line after it: alone, it is a tight item.
          source: (list.ordered
            ? item.raw.replace(/^(\s*)\d+([.)])/, `$1${start + index}$2`)
            : item.raw
          ).trimEnd(),
        }),
      );
    } else blocks.push({ kind: "markdown", source: token.raw });
  }
  return blocks;
}

/** How many parts of a message one can comment on (code: one per line). */
export function messageBlockCount(blocks: readonly MessageBlock[]): number {
  let count = 0;
  for (const block of blocks)
    if (block.kind === "code") count += block.lines.length;
    else if (block.kind !== "blank") count++;
  return count;
}

/** Text compared loosely: quotes are found again in rendered text. */
export function looseText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
