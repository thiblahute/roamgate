/**
 * What a file-editing tool call did (Claude Code's Edit, MultiEdit, Write,
 * NotebookEdit), as the chat shows it: the file, its line counts, and its
 * diff in hunks of unified-diff lines ("+added", "-removed", " context").
 * Taken from Claude Code's own patch of the result when the transcript has
 * it (with line numbers and context, as its terminal shows), else from the
 * call's arguments. Bounded: a chat entry carries it even when the call's
 * payload is withheld from the wire.
 */

export type FileEditHunk = {
  /** Where the hunk starts in the old and new file; absent: not known. */
  old_start?: number;
  new_start?: number;
  lines: string[];
};

export type FileEdit = {
  path: string;
  /** A file the call created (a Write of a new file). */
  created?: boolean;
  added: number;
  removed: number;
  hunks: FileEditHunk[];
  /** Lines past what is carried were left out (the counts are whole). */
  truncated?: boolean;
};

/** The tools whose calls change a file. */
export const FILE_EDIT_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

/** The most lines an edit carries, and the most of one line. */
const MAX_LINES = 160;
const MAX_LINE_CHARS = 400;
/** Past this many lines a side, the arguments' diff is not worked out. */
const MAX_DIFF_LINES = 600;

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  // A final newline ends the last line; it starts none.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Counts and bounds a set of hunks. */
function finish(
  path: string,
  hunks: FileEditHunk[],
  created?: boolean,
): FileEdit {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  let left = MAX_LINES;
  let truncated = false;
  const kept: FileEditHunk[] = [];
  for (const hunk of hunks) {
    if (left <= 0) {
      truncated = true;
      break;
    }
    const lines = hunk.lines
      .slice(0, left)
      .map((line) =>
        line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line,
      );
    if (lines.length < hunk.lines.length) truncated = true;
    left -= lines.length;
    kept.push({ ...hunk, lines });
  }
  return {
    path,
    ...(created ? { created: true } : {}),
    added,
    removed,
    hunks: kept,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * The lines of a change from `before` to `after`, as a unified diff's body
 * (common lines kept as context): the longest common subsequence of their
 * lines. Too long to work out: all removed, then all added.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES)
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  // Common lines at both ends need no table.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const rows = x.length + 1;
  const cols = y.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = x.length - 1; i >= 0; i -= 1)
    for (let j = y.length - 1; j >= 0; j -= 1)
      table[i * cols + j] =
        x[i] === y[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
  const middle: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      middle.push(` ${x[i]}`);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      middle.push(`-${x[i]}`);
      i += 1;
    } else {
      middle.push(`+${y[j]}`);
      j += 1;
    }
  }
  while (i < x.length) middle.push(`-${x[i++]}`);
  while (j < y.length) middle.push(`+${y[j++]}`);
  return [
    ...a.slice(0, head).map((line) => ` ${line}`),
    ...middle,
    ...a.slice(a.length - tail).map((line) => ` ${line}`),
  ];
}

/**
 * From Claude Code's result of the call (the transcript's toolUseResult):
 * its patch, or a new file's content. Null when it says neither.
 */
export function fileEditFromResult(result: unknown): FileEdit | null {
  if (!isRecord(result)) return null;
  const path = text(result.filePath) ?? text(result.notebook_path);
  if (!path) return null;
  if (result.type === "create" && typeof result.content === "string")
    return finish(
      path,
      [
        {
          old_start: 0,
          new_start: 1,
          lines: splitLines(result.content).map((line) => `+${line}`),
        },
      ],
      true,
    );
  if (!Array.isArray(result.structuredPatch) || !result.structuredPatch.length)
    return null;
  const hunks = result.structuredPatch.flatMap((hunk): FileEditHunk[] => {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return [];
    return [
      {
        ...(typeof hunk.oldStart === "number"
          ? { old_start: hunk.oldStart }
          : {}),
        ...(typeof hunk.newStart === "number"
          ? { new_start: hunk.newStart }
          : {}),
        lines: hunk.lines.filter(
          (line): line is string =>
            typeof line === "string" && !line.startsWith("\\"),
        ),
      },
    ];
  });
  return hunks.length ? finish(path, hunks) : null;
}

/**
 * From the call's arguments, before (or without) its result: what it asks
 * to change, without line numbers. Null for another tool, or arguments
 * that say no file.
 */
export function fileEditFromArguments(
  tool: string | undefined,
  args: unknown,
): FileEdit | null {
  if (!tool || !FILE_EDIT_TOOLS.has(tool) || !isRecord(args)) return null;
  const path = text(args.file_path) ?? text(args.notebook_path);
  if (!path) return null;
  switch (tool) {
    case "Edit": {
      const before = text(args.old_string);
      const after = text(args.new_string);
      if (before === null || after === null) return null;
      return finish(path, [{ lines: lineDiff(before, after) }]);
    }
    case "MultiEdit": {
      if (!Array.isArray(args.edits)) return null;
      const hunks = args.edits.flatMap((edit): FileEditHunk[] => {
        if (!isRecord(edit)) return [];
        const before = text(edit.old_string);
        const after = text(edit.new_string);
        return before === null || after === null
          ? []
          : [{ lines: lineDiff(before, after) }];
      });
      return hunks.length ? finish(path, hunks) : null;
    }
    case "Write": {
      const content = text(args.content);
      if (content === null) return null;
      return finish(path, [
        { lines: splitLines(content).map((line) => `+${line}`) },
      ]);
    }
    case "NotebookEdit": {
      const source = text(args.new_source);
      if (source === null) return null;
      return finish(path, [
        {
          lines:
            args.edit_mode === "delete"
              ? []
              : splitLines(source).map((line) => `+${line}`),
        },
      ]);
    }
    default:
      return null;
  }
}

/** The arguments of a call as the chat has them (JSON text); null if not. */
export function fileEditFromArgumentText(
  tool: string | undefined,
  argumentText: string,
): FileEdit | null {
  if (!tool || !FILE_EDIT_TOOLS.has(tool) || !argumentText) return null;
  try {
    return fileEditFromArguments(tool, JSON.parse(argumentText));
  } catch {
    // Still being written (a call streaming in), or not JSON.
    return null;
  }
}
