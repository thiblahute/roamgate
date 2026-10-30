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

/** Reads `diff --git a/x b/y` paths, including quoted ones. */
function gitHeaderPaths(line: string): [string, string] | null {
  const rest = line.slice("diff --git ".length);
  const quoted = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) return [unquote(quoted[1]!), unquote(quoted[2]!)];
  const plain = /^a\/(.*) b\/(.*)$/.exec(rest);
  if (plain) return [plain[1]!, plain[2]!];
  return null;
}

function unquote(value: string): string {
  return value.replace(/\\(.)/g, (_, char: string) =>
    char === "t" ? "\t" : char === "n" ? "\n" : char,
  );
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
    const kind = line[0];
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
