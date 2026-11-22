import { createHash } from "node:crypto";

/**
 * The history repo's file formats (docs/ARCHITECTURE.md, "History"):
 *
 * - structured data: JSON with every object's keys sorted, two-space
 *   indent, one trailing newline, no export timestamps (stableJson);
 * - prose (Work item descriptions, review threads): Markdown, each part
 *   introduced by a one-line JSON header in an HTML comment, invisible when
 *   rendered (renderDoc, parseDoc);
 * - logs: JSONL, one value per line (jsonl).
 */

/** JSON with every object's keys sorted: the same state, the same text. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortedKeys(value), null, 2)}\n`;
}

/** A copy of a value with every object's keys sorted. */
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .flatMap((key) => {
          const each = (value as Record<string, unknown>)[key];
          return each === undefined ? [] : [[key, sortedKeys(each)]];
        }),
    );
  return value;
}

/** Values as JSONL: one compact JSON value per line, a trailing newline. */
export function jsonl(values: readonly unknown[]): string {
  return values.length
    ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
    : "";
}

/** JSONL read back: lines that do not parse are skipped. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line, or a line written by hand.
    }
  }
  return out;
}

/**
 * One part of a prose file: its tag (`item`, `thread`, `comment`), what is
 * not the text as JSON, and the text.
 */
export type DocBlock = {
  tag: string;
  meta: Record<string, unknown>;
  body: string;
};

const MARKER = /^<!-- roamgate:([a-z][a-z0-9-]*) (\{.*\}) -->$/;

/** Whether a line would read as a part's header. */
function looksLikeMarker(line: string): boolean {
  return /^<!-- roamgate:/.test(line);
}

/**
 * A prose file: each block as its header line, then its text, blocks
 * separated by a blank line. A text holding a line that reads as a header
 * goes in its header's `body` instead, so every file parses back to the
 * same blocks (parseDoc).
 */
export function renderDoc(blocks: readonly DocBlock[]): string {
  return `${blocks
    .map(({ tag, meta, body }) => {
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error(`bad tag ${tag}`);
      const inHeader = body.split("\n").some(looksLikeMarker);
      const header = sortedKeys(inHeader ? { ...meta, body } : meta) as Record<
        string,
        unknown
      >;
      // Never an end of comment inside the header: escaped, read back the same.
      const json = JSON.stringify(header).replace(/-->/g, "--\\u003e");
      return `<!-- roamgate:${tag} ${json} -->\n${inHeader ? "" : body}\n`;
    })
    .join("\n")}`;
}

/** A prose file read back into its blocks; throws on a file it did not write. */
export function parseDoc(text: string): DocBlock[] {
  if (!text.endsWith("\n"))
    throw new Error("a history file ends with a newline");
  const lines = text.slice(0, -1).split("\n");
  const blocks: {
    tag: string;
    meta: Record<string, unknown>;
    lines: string[];
  }[] = [];
  for (const line of lines) {
    const marker = MARKER.exec(line);
    if (marker) {
      let meta: unknown;
      try {
        meta = JSON.parse(marker[2]!);
      } catch {
        throw new Error(`bad header: ${line.slice(0, 80)}`);
      }
      if (!meta || typeof meta !== "object" || Array.isArray(meta))
        throw new Error(`bad header: ${line.slice(0, 80)}`);
      blocks.push({
        tag: marker[1]!,
        meta: meta as Record<string, unknown>,
        lines: [],
      });
      continue;
    }
    const current = blocks[blocks.length - 1];
    if (!current) throw new Error("text before the first header");
    current.lines.push(line);
  }
  return blocks.map((block, index) => {
    const bodyLines = block.lines;
    // Every block but the last is followed by the blank separator line.
    if (index < blocks.length - 1) {
      if (bodyLines[bodyLines.length - 1] !== "")
        throw new Error("blocks are separated by a blank line");
      bodyLines.pop();
    }
    const { body: inHeader, ...meta } = block.meta;
    const body = typeof inHeader === "string" ? inHeader : bodyLines.join("\n");
    return { tag: block.tag, meta, body };
  });
}

/**
 * A store's id as a file name: kept when it is plain (letters, digits, dot,
 * dash, underscore, not starting with a dot), else a readable part and a
 * short hash, so two ids never share a name.
 */
export function fileNameOf(id: string): string {
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/.test(id)) return id;
  const plain = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${plain.slice(0, 60) || "id"}-${hash}`;
}
