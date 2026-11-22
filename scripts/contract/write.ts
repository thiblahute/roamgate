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
