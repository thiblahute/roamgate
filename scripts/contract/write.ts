/**
 * Writing contract files without churning them: a file whose content is
 * already what would be written (the same JSON or YAML value, the same
 * Markdown up to table padding) is left as it is, with its hand formatting,
 * and YAML is checked to read back as the value it was made from.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deepEquals } from "bun";

function parse(path: string, text: string): unknown {
  return /\.ya?ml$/.test(path) ? Bun.YAML.parse(text) : JSON.parse(text);
}

/** Markdown with table cells' padding and trailing blanks dropped. */
function markdownContent(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.startsWith("|")
        ? line
            .split("|")
            .map((cell) => cell.trim().replace(/^-+$/, "-"))
            .join("|")
        : line.trimEnd(),
    )
    .join("\n")
    .trim();
}

/** Whether `text` says what the file at `path` already says. */
export function sameContent(path: string, old: string, text: string): boolean {
  if (old === text) return true;
  if (/\.(json|ya?ml)$/.test(path)) {
    try {
      return deepEquals(parse(path, old), parse(path, text));
    } catch {
      return false;
    }
  }
  if (path.endsWith(".md"))
    return markdownContent(old) === markdownContent(text);
  return false;
}

/** Writes `text` unless the file already says it; true when written. */
export function writeContractFile(path: string, text: string): boolean {
  if (existsSync(path) && sameContent(path, readFileSync(path, "utf8"), text))
    return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/** YAML for a value, refused when it would not read back as that value. */
export function yamlText(value: unknown): string {
  const text = `${Bun.YAML.stringify(value, null, 2)}\n`;
  if (!deepEquals(Bun.YAML.parse(text), value))
    throw new Error("YAML.stringify gave text that reads back differently");
  return text;
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

type Addition = { path: string[]; key: string; value: unknown };

/** What `next` adds to `old`; null when it changes or removes anything. */
function additions(
  old: unknown,
  next: unknown,
  path: string[],
): Addition[] | null {
  if (isMapping(old) && isMapping(next)) {
    const out: Addition[] = [];
    for (const key of Object.keys(old)) if (!(key in next)) return null;
    for (const [key, value] of Object.entries(next)) {
      if (!(key in old)) {
        out.push({ path, key, value });
        continue;
      }
      const inner = additions(old[key], value, [...path, key]);
      if (!inner) return null;
      out.push(...inner);
    }
    return out;
  }
  return deepEquals(old, next) ? [] : null;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isContent = (line: string) => {
  const text = line.trim();
  return text !== "" && !text.startsWith("#");
};
/** A block mapping's `key:` line: its key and what follows the colon. */
const KEY_LINE =
  /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{}[\],&*!|>%@`-][^:#]*?|-[^\s:][^:#]*?)\s*:(?:\s+(.*))?$/;

/**
 * The lines [start, end) holding the entries of the block mapping at
 * `path`, and their indentation; null when it is not a block mapping.
 */
function blockOf(
  lines: string[],
  path: string[],
): { start: number; end: number; indent: number } | null {
  let start = 0;
  let end = lines.length;
  let parentIndent = -1;
  for (const key of path) {
    const first = lines.slice(start, end).findIndex(isContent);
    if (first < 0) return null;
    const indent = indentOf(lines[start + first]!);
    if (indent <= parentIndent) return null;
    let found = -1;
    for (let index = start; index < end; index++) {
      const line = lines[index]!;
      if (!isContent(line) || indentOf(line) !== indent) continue;
      const match = KEY_LINE.exec(line);
      if (!match) continue;
      let name: unknown;
      try {
        name = Bun.YAML.parse(match[1]!);
      } catch {
        continue;
      }
      if (String(name) !== key) continue;
      // Only a block value can take a new line: `key:` or `key: &anchor`.
      const rest = (match[2] ?? "").replace(/\s+#.*$/, "").trim();
      if (rest !== "" && !/^&\S+$/.test(rest)) return null;
      found = index;
      break;
    }
    if (found < 0) return null;
    let stop = found + 1;
    while (
      stop < end &&
      (!isContent(lines[stop]!) || indentOf(lines[stop]!) > indent)
    )
      stop++;
    start = found + 1;
    end = stop;
    parentIndent = indent;
  }
  const first = lines.slice(start, end).findIndex(isContent);
  if (first < 0) return null;
  const indent = indentOf(lines[start + first]!);
  if (indent <= parentIndent) return null;
  return { start, end, indent };
}

/**
 * `old` (a YAML file's text) with what `value` adds to it written in, the
 * rest of the file as it was: anchors, flow mappings, quoting and comments
 * kept. Null when `value` changes or removes something of it, or adds under
 * a mapping that is not in block style.
 */
export function yamlWithAdditions(old: string, value: unknown): string | null {
  const found = additions(Bun.YAML.parse(old), value, []);
  if (!found) return null;
  let lines = old.replace(/\n$/, "").split("\n");
  for (const { path, key, value: added } of found) {
    const block = blockOf(lines, path);
    if (!block) return null;
    let at = block.end;
    while (at > block.start && !isContent(lines[at - 1]!)) at--;
    const text = yamlText({ [key]: added })
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => (line ? " ".repeat(block.indent) + line : line));
    lines = [...lines.slice(0, at), ...text, ...lines.slice(at)];
  }
  const text = `${lines.join("\n")}\n`;
  return deepEquals(Bun.YAML.parse(text), value) ? text : null;
}

/**
 * A YAML contract file's new text: what `value` adds written into the file
 * as it is (yamlWithAdditions). A value that changes the file in another way
 * is refused, since rewriting the whole file would lose its hand formatting.
 */
export function yamlFileText(path: string, value: unknown): string {
  if (!existsSync(path)) return yamlText(value);
  const old = readFileSync(path, "utf8");
  if (deepEquals(Bun.YAML.parse(old), value)) return old;
  const text = yamlWithAdditions(old, value);
  if (text === null)
    throw new Error(
      `${path}: the change is not only additions under block mappings; make it by hand`,
    );
  return text;
}

/** Each Markdown table of `text` with its columns padded to one width. */
export function alignMarkdownTables(text: string): string {
  const lines = text.split("\n");
  for (let start = 0; start < lines.length; ) {
    if (!lines[start]!.startsWith("|")) {
      start++;
      continue;
    }
    let end = start;
    while (end < lines.length && lines[end]!.startsWith("|")) end++;
    const rows = lines.slice(start, end).map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
    const separator = (cells: string[]) =>
      cells.every((cell) => /^:?-+:?$/.test(cell));
    const widths: number[] = [];
    for (const cells of rows)
      if (!separator(cells))
        cells.forEach((cell, index) => {
          widths[index] = Math.max(widths[index] ?? 3, cell.length);
        });
    for (let index = 0; index < rows.length; index++) {
      const cells = rows[index]!;
      lines[start + index] = `| ${cells
        .map((cell, column) =>
          separator(cells)
            ? "-".repeat(widths[column] ?? 3)
            : cell.padEnd(widths[column] ?? 0),
        )
        .join(" | ")} |`;
    }
    start = end;
  }
  return lines.join("\n");
}

/** JSON as the repository's formatter (biome) writes it. */
export function formattedJson(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const biome = Bun.spawnSync(
    [
      `${import.meta.dir}/../../node_modules/.bin/biome`,
      "format",
      `--stdin-file-path=${path}`,
    ],
    { stdin: Buffer.from(text), stdout: "pipe", stderr: "pipe" },
  );
  if (biome.exitCode !== 0)
    throw new Error(`biome could not format ${path}: ${biome.stderr}`);
  return biome.stdout.toString();
}
