import { marked, type Tokens } from "marked";
import {
  type DiagramLanguage,
  diagramLanguage,
  fenceClosed,
  rawSvgMarkup,
} from "./diagramSource";

/**
 * A message's blocks, the parts one can comment on: paragraphs, list items
 * (nested ones too, each on its own, as deep as it was), each cell of a
 * table, each line of a code block, a suggestion, a diagram (a ```mermaid
 * or ```svg block once closed, or a message of SVG markup alone). Blank
 * lines beyond the one that separates blocks are kept as empty lines
 * (Markdown would fold them). The Files preview's Markdown has the same
 * stops (useThreadKeys).
 */
export type MessageBlock =
  | {
      kind: "markdown";
      source: string;
      /** A list item's depth: 1 is an item of a list in an item. */
      depth?: number;
    }
  | {
      kind: "table";
      /** The header's cells, then each row's, in Markdown. */
      header: string[];
      rows: string[][];
      align: ("left" | "center" | "right" | null)[];
    }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "suggestion"; range: string; code: string }
  | { kind: "diagram"; lang: DiagramLanguage; code: string }
  | { kind: "blank"; lines: number };

export function messageBlocks(text: string): MessageBlock[] {
  const svg = rawSvgMarkup(text);
  if (svg) return [{ kind: "diagram", lang: "svg", code: svg }];
  const blocks: MessageBlock[] = [];
  for (const token of marked.lexer(text.trim(), { gfm: true, breaks: true })) {
    if (token.type === "space") {
      // One blank line is the usual gap between blocks; more are kept.
      const lines = token.raw.split("\n").length - 3;
      if (lines > 0) blocks.push({ kind: "blank", lines });
    } else if (token.type === "code" && token.codeBlockStyle !== "indented") {
      const info = (token.lang ?? "").trim();
      const suggestion = /^suggestion(?::(\S+))?$/.exec(info);
      const diagram = diagramLanguage(info);
      if (diagram && fenceClosed(token.raw))
        blocks.push({ kind: "diagram", lang: diagram, code: token.text });
      else if (suggestion)
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
    } else if (token.type === "list")
      listItems(token as Tokens.List, 0, blocks);
    else if (token.type === "table") {
      const table = token as Tokens.Table;
      blocks.push({
        kind: "table",
        header: table.header.map((cell) => cell.text),
        rows: table.rows.map((row) => row.map((cell) => cell.text)),
        align: table.align,
      });
    } else blocks.push({ kind: "markdown", source: token.raw });
  }
  return blocks;
}

/**
 * A list's items, each a part alone (numbered as in its list), then its
 * nested lists' items, one deeper.
 */
function listItems(list: Tokens.List, depth: number, blocks: MessageBlock[]) {
  const start = typeof list.start === "number" ? list.start : 1;
  list.items.forEach((item, index) => {
    const marker = list.ordered
      ? (/^\s*\d+([.)])/.exec(item.raw)?.[1] ?? ".")
      : (/^\s*([-*+])/.exec(item.raw)?.[1] ?? "-");
    const lead = list.ordered ? `${start + index}${marker} ` : `${marker} `;
    const nested = item.tokens.filter(
      (token): token is Tokens.List => token.type === "list",
    );
    // Its own words: without its nested lists, nor the blank line after
    // it (alone, it is a tight item).
    const own = nested.length
      ? item.tokens
          .filter((token) => token.type !== "list")
          .map((token) => token.raw)
          .join("")
          .trim()
          .replace(/\n/g, `\n${" ".repeat(lead.length)}`)
      : null;
    blocks.push({
      kind: "markdown",
      source:
        own !== null
          ? `${lead}${own}`
          : (list.ordered
              ? item.raw.replace(/^(\s*)\d+([.)])/, `$1${start + index}$2`)
              : item.raw
            ).trimEnd(),
      ...(depth ? { depth } : {}),
    });
    for (const inner of nested) listItems(inner, depth + 1, blocks);
  });
}

/** A table's cells, header first, row by row. */
export function tableCells(block: {
  header: readonly string[];
  rows: readonly (readonly string[])[];
}): string[] {
  return [...block.header, ...block.rows.flat()];
}

/**
 * How many parts of a message one can comment on (code: one per line, a
 * table one per cell, a diagram is one).
 */
export function messageBlockCount(blocks: readonly MessageBlock[]): number {
  let count = 0;
  for (const block of blocks)
    if (block.kind === "code") count += block.lines.length;
    else if (block.kind === "table") count += tableCells(block).length;
    else if (block.kind !== "blank") count++;
  return count;
}

/** Text compared loosely: quotes are found again in rendered text. */
export function looseText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
