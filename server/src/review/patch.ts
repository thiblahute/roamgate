import type {
  ReviewDiffFile,
  ReviewDiffHunk,
  ReviewLineKind,
} from "../../../shared/review";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

/** One side of a `diff --git` header: quoted or plain, prefix removed. */
const HEADER_SIDE = String.raw`("(?:[^"\\]|\\.)*"|\S+)`;

/**
 * Reads `diff --git a/x b/y` paths, quoted ones too. A plain name with
 * spaces is ambiguous there; `rename from` / `---` lines, when present,
 * set the paths again.
 */
function gitHeaderPaths(line: string): [string, string] | null {
  const rest = line.slice("diff --git ".length);
  const sides = new RegExp(`^${HEADER_SIDE} ${HEADER_SIDE}$`).exec(rest);
  if (sides) {
    const read = (side: string) =>
      stripPrefix(side.startsWith('"') ? unquote(side.slice(1, -1)) : side);
    return [read(sides[1]!), read(sides[2]!)];
  }
  // Same name on both sides (no rename), possibly with spaces.
  const same = /^a\/(.*) b\/\1$/.exec(rest);
  if (same) return [same[1]!, same[1]!];
  const plain = /^a\/(.*) b\/(.*)$/.exec(rest);
  if (plain) return [plain[1]!, plain[2]!];
  return null;
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
};

/**
 * Undoes git's C quoting: `\t`, `\"`, and octal bytes (`\303\251`) that
 * together are the name's UTF-8.
 */
function unquote(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = value[index + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(value.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `rename from x`, `copy to y`: a path, quoted when git quotes it. */
function namedPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length);
  return value.startsWith('"') && value.endsWith('"')
    ? unquote(value.slice(1, -1))
    : value;
}

function headerPath(line: string): string {
  let value = line.slice(4).replace(/\t.*$/, "");
  if (value.startsWith('"') && value.endsWith('"'))
    value = unquote(value.slice(1, -1));
  return stripPrefix(value);
}

/**
 * Parses unified diff text (from `git diff` or a forge) into files, hunks
 * and numbered lines.
 */
export function parseUnifiedDiff(text: string): ReviewDiffFile[] {
  const files: ReviewDiffFile[] = [];
  let file: ReviewDiffFile | null = null;
  let hunk: ReviewDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Lines still owed by the current hunk, so a "--- " line after it starts a
  // new file instead of reading as a removal.
  let oldLeft = 0;
  let newLeft = 0;

  const startFile = (oldPath: string, path: string) => {
    file = { path, oldPath, hunks: [] };
    files.push(file);
    hunk = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const paths = gitHeaderPaths(line);
      startFile(paths?.[0] ?? "", paths?.[1] ?? "");
      continue;
    }
    if (!hunk && file) {
      const current = file as ReviewDiffFile;
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        current.oldPath = namedPath(
          line,
          line.startsWith("rename") ? "rename from " : "copy from ",
        );
        continue;
      }
      if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        current.path = namedPath(
          line,
          line.startsWith("rename") ? "rename to " : "copy to ",
        );
        continue;
      }
    }
    if (line.startsWith("--- ") && !hunk) {
      const oldPath = headerPath(line);
      // A file that already has hunks is finished: without a "diff --git"
      // header (a mailed patch), "--- " is what starts the next one.
      if (!file || (file as ReviewDiffFile).hunks.length > 0)
        startFile(oldPath, oldPath);
      else if (oldPath !== "/dev/null")
        (file as ReviewDiffFile).oldPath = oldPath;
      continue;
    }
    if (line.startsWith("+++ ") && !hunk && file) {
      const path = headerPath(line);
      const current = file as ReviewDiffFile;
      if (path === "/dev/null") current.path = current.oldPath;
      else current.path = path;
      continue;
    }
    if (line.startsWith("Binary files ") && file) {
      (file as ReviewDiffFile).binary = true;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header && file) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { header: line, lines: [] };
      (file as ReviewDiffFile).hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // An empty context line written without its space (some mailers, or
    // git's diff.suppressBlankEmpty) while the hunk still owes both sides.
    const kind = line === "" && oldLeft > 0 && newLeft > 0 ? " " : line[0];
    if (kind === "\\") continue;
    if (kind !== " " && kind !== "+" && kind !== "-") {
      // A line outside the diff grammar ends the hunk (trailers, signatures).
      if (line === "") continue;
      hunk = null;
      continue;
    }
    const current = hunk as ReviewDiffHunk;
    current.lines.push({
      kind: kind as ReviewLineKind,
      old: kind === "+" ? null : oldLine,
      new: kind === "-" ? null : newLine,
      text: line.slice(1),
    });
    if (kind !== "+") {
      oldLine++;
      oldLeft--;
    }
    if (kind !== "-") {
      newLine++;
      newLeft--;
    }
    if (oldLeft <= 0 && newLeft <= 0) hunk = null;
  }
  for (const entry of files) {
    if (entry.oldPath === "/dev/null") entry.oldPath = entry.path;
  }
  return files;
}
