/**
 * Large transcripts, read without holding them: a history shows the end of
 * a session, so it reads the file backwards from its end until it has a
 * window's worth of entries, then only the bytes appended since. What needs
 * the whole session (tasks, artifacts, title, token usage) comes from a slim
 * index, built once by streaming the file in chunks (or taken from disk,
 * session-index-store.ts) and kept up to date with the appended bytes. No
 * path here reads a whole transcript at once.
 */
import { isRecord } from "./session-utils";

/** From this size on, a transcript is read by its end and an index. */
export const LARGE_SESSION_BYTES = 4 * 1024 * 1024;
/** The first read from the end; each further one doubles. */
const FIRST_TAIL_BYTES = 512 * 1024;
/** The most a history reads back for its window. */
export const MAX_TAIL_BYTES = 64 * 1024 * 1024;
/** One read of the index, forwards. */
const INDEX_CHUNK_BYTES = 4 * 1024 * 1024;
/** Appended bytes past this read the end again instead. */
export const MAX_APPEND_BYTES = 16 * 1024 * 1024;
/** Records nothing reads. */
const UNREAD_TYPES = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
]);
/** Parsing gives the event loop a turn this often. */
const SLICE_MS = 8;

export type RangeReader = (
  path: string,
  start: number,
  end: number,
) => Promise<Uint8Array>;

type SessionRecord = Record<string, unknown>;

export function yieldToLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Gives the event loop a turn when this slice has run long enough. */
export function createSlicer() {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < SLICE_MS) return;
    await yieldToLoop();
    since = performance.now();
  };
}

function parseLine(bytes: Uint8Array, start: number, end: number) {
  if (end <= start) return null;
  const text = Buffer.from(
    bytes.buffer,
    bytes.byteOffset + start,
    end - start,
  ).toString("utf8");
  if (!text.trim()) return null;
  try {
    const record: unknown = JSON.parse(text);
    return isRecord(record) ? record : null;
  } catch {
    // A writer may not have finished its last record yet.
    return null;
  }
}

/**
 * The records of whole lines in bytes that start at a line's start: each
 * line ends with a newline, so an unfinished last line is left for later.
 * `used` is how many bytes those lines take.
 */
export async function parseWholeLines(
  bytes: Uint8Array,
  slice = createSlicer(),
): Promise<{ records: SessionRecord[]; used: number }> {
  const records: SessionRecord[] = [];
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(10, start);
    if (newline < 0) break;
    const record = parseLine(bytes, start, newline);
    if (record) records.push(record);
    start = newline + 1;
    await slice();
  }
  return { records, used: start };
}

/** What the end of a transcript read: its records and where they start. */
export type TailRead = {
  records: SessionRecord[];
  /** The offset of the first record read (a line's start). */
  start: number;
  /** Where the last whole line ends: appends are read from here. */
  end: number;
  /** Bytes read in all. */
  bytesRead: number;
};

/**
 * Reads a transcript backwards from `size`, a chunk at a time, until
 * `enough` says the records cover what is shown, the file's start is
 * reached, or `maxBytes` were read.
 */
export async function readTailRecords(
  read: RangeReader,
  path: string,
  size: number,
  enough: (records: SessionRecord[], atStart: boolean) => boolean,
  options: { firstBytes?: number; maxBytes?: number } = {},
): Promise<TailRead> {
  const maxBytes = options.maxBytes ?? MAX_TAIL_BYTES;
  let chunk = options.firstBytes ?? FIRST_TAIL_BYTES;
  let from = Math.max(0, size - chunk);
  let bytes = await read(path, from, size);
  let bytesRead = bytes.length;
  // The last line may be one a writer has not finished.
  const lastNewline = bytes.lastIndexOf(10);
  if (lastNewline < 0 && from > 0) {
    // No whole line yet: read further back until one ends.
    return readTailRecords(read, path, size, enough, {
      firstBytes: chunk * 2,
      maxBytes,
    });
  }
  const end = from + lastNewline + 1;
  bytes = bytes.subarray(0, lastNewline + 1);
  let records: SessionRecord[] = [];
  // `carry`: the end of a line that started before `from`.
  let carry: Uint8Array;
  for (;;) {
    let lineStart = 0;
    if (from > 0) {
      const newline = bytes.indexOf(10);
      lineStart = newline < 0 ? bytes.length : newline + 1;
    }
    const parsed = await parseWholeLines(bytes.subarray(lineStart));
    records = parsed.records.concat(records);
    carry = bytes.slice(0, lineStart);
    const start = from + lineStart;
    const atStart = from === 0;
    if (atStart || enough(records, false) || bytesRead >= maxBytes)
      return { records, start: atStart ? 0 : start, end, bytesRead };
    chunk *= 2;
    const earlier = Math.max(0, from - chunk);
    const before = await read(path, earlier, from);
    bytesRead += before.length;
    const joined = new Uint8Array(before.length + carry.length);
    joined.set(before, 0);
    joined.set(carry, before.length);
    bytes = joined;
    from = earlier;
  }
}

/** A string's two ends, what the index's pattern reads look at. */
function ends(text: string, each: number) {
  return text.length > 2 * each
    ? `${text.slice(0, each)}\n\u2026\n${text.slice(-each)}`
    : text;
}

// What a notice to the session carries whole: task-notification and
// teammate-message tags (session-tasks.ts).
const NOTICE = /<task-notification>|<teammate-message /;

/**
 * A text: whole when it holds a notice, else its start, longer for what
 * the user's turn holds (a prompt's start tells it from Claude Code's notes,
 * and a queued prompt is matched to its turn by its text).
 */
function slimText(text: string, user: boolean) {
  return NOTICE.test(text) ? text : text.slice(0, user ? 64_000 : 120);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("\n");
}

const TOOL_INPUT_KEYS = [
  "description",
  "name",
  "subagent_type",
  "command",
  "run_in_background",
  "task_id",
  "shell_id",
  "to",
  "action",
  "asset",
  "title",
  "file_path",
  "notebook_path",
];

function slimPart(part: unknown, user: boolean): unknown {
  if (!isRecord(part)) return part;
  if (part.type === "text")
    return {
      type: "text",
      text: typeof part.text === "string" ? slimText(part.text, user) : "",
    };
  if (part.type === "tool_use") {
    const input: Record<string, unknown> = {};
    if (isRecord(part.input))
      for (const key of TOOL_INPUT_KEYS) {
        const value = part.input[key];
        if (value !== undefined)
          input[key] = typeof value === "string" ? value.slice(0, 2000) : value;
      }
    return { type: "tool_use", id: part.id, name: part.name, input };
  }
  if (part.type === "tool_result")
    return {
      type: "tool_result",
      tool_use_id: part.tool_use_id,
      is_error: part.is_error,
      // Ids and paths are near an output's start or its end.
      content: ends(contentText(part.content), 1000),
    };
  return { type: part.type };
}

const RECORD_KEYS = [
  "type",
  "cwd",
  "content",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "isMeta",
  "isCompactSummary",
  "rewound",
  "cutUuid",
  "timestamp",
  "customTitle",
  "aiTitle",
  "usage",
];

/**
 * A Claude record as the index keeps it: what its readers (rewind, tasks,
 * artifacts, title, commands, token usage, turns) read of it, long texts
 * cut. Null for a record none of them reads.
 */
export function slimRecord(record: SessionRecord): SessionRecord | null {
  if (typeof record.type === "string" && UNREAD_TYPES.has(record.type))
    return null;
  // A rewind's checkpoint of the code (rewind-scan.ts): its message only.
  if (record.type === "file-history-snapshot")
    return { type: record.type, messageId: record.messageId };
  const slim: SessionRecord = {};
  for (const key of RECORD_KEYS)
    if (record[key] !== undefined) slim[key] = record[key];
  if (isRecord(record.toolUseResult)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.toolUseResult))
      if (value === null || typeof value !== "object")
        result[key] = typeof value === "string" ? value.slice(0, 600) : value;
    slim.toolUseResult = result;
  }
  const attachment = isRecord(record.attachment) ? record.attachment : null;
  if (attachment?.type === "skill_listing") slim.attachment = attachment;
  else if (attachment?.type === "queued_command")
    slim.attachment = {
      ...attachment,
      prompt: slimText(contentText(attachment.prompt), true),
    };
  else if (attachment) slim.attachment = { type: attachment.type };
  if (isRecord(record.message)) {
    const { content } = record.message;
    const user = record.type === "user";
    slim.message = {
      role: record.message.role,
      id: record.message.id,
      usage: record.message.usage,
      content:
        typeof content === "string"
          ? slimText(content, user)
          : Array.isArray(content)
            ? content.map((part) => slimPart(part, user))
            : content,
    };
  }
  return slim;
}

/**
 * Every record of a transcript, slimmed (`slimRecord`): built once by
 * streaming the file forwards, then only from what was appended.
 */
export function createSlimIndex(read: RangeReader, path: string) {
  const records: SessionRecord[] = [];
  /** Records parsed, the unread kinds included. */
  let parsed = 0;
  let end = 0;
  let carry: Uint8Array = new Uint8Array(0);
  let running: Promise<void> | null = null;
  async function advance(size: number) {
    const slice = createSlicer();
    while (end + carry.length < size) {
      const from = end + carry.length;
      const to = Math.min(size, from + INDEX_CHUNK_BYTES);
      const chunk = await read(path, from, to);
      if (!chunk.length) break;
      const bytes = new Uint8Array(carry.length + chunk.length);
      bytes.set(carry, 0);
      bytes.set(chunk, carry.length);
      const lines = await parseWholeLines(bytes, slice);
      for (const record of lines.records) {
        parsed += 1;
        const slim = slimRecord(record);
        if (slim) records.push(slim);
      }
      end += lines.used;
      carry = bytes.slice(lines.used);
      await slice();
    }
  }
  return {
    records,
    get parsed() {
      return parsed;
    },
    /** Where the last whole line read ends. */
    get end() {
      return end;
    },
    /**
     * Starts from an index saved earlier (session-index-store.ts): only the
     * bytes after `end` are read. Before any update only.
     */
    restore(saved: { records: SessionRecord[]; parsed: number; end: number }) {
      if (running || end || records.length) return;
      for (const record of saved.records) records.push(record);
      parsed = saved.parsed;
      end = saved.end;
    },
    /** Reads on to `size` (one reader at a time). */
    async update(size: number) {
      while (running) await running;
      if (end + carry.length >= size) return;
      running = advance(size).finally(() => {
        running = null;
      });
      await running;
    },
  };
}
export type SlimIndex = ReturnType<typeof createSlimIndex>;

/**
 * The lines holding `needle`, newest first, read from the end of a file a
 * chunk at a time, until `found` takes one. Only those lines are decoded.
 */
export async function findLineFromEnd<T>(
  read: RangeReader,
  path: string,
  size: number,
  needle: string,
  found: (line: string) => T | null,
): Promise<T | null> {
  const pattern = Buffer.from(needle, "utf8");
  let to = size;
  // The start of a line that began before what was read.
  let carry = Buffer.alloc(0);
  let chunk = FIRST_TAIL_BYTES;
  while (to > 0) {
    const from = Math.max(0, to - chunk);
    const bytes = Buffer.concat([
      Buffer.from(await read(path, from, to)),
      carry,
    ]);
    // Whole lines only, but at the file's start.
    const first = from > 0 ? bytes.indexOf(10) + 1 : 0;
    if (from > 0 && first === 0) {
      carry = bytes;
      to = from;
      chunk *= 2;
      continue;
    }
    let at = bytes.lastIndexOf(pattern);
    while (at >= first) {
      const start = bytes.lastIndexOf(10, at) + 1;
      const newline = bytes.indexOf(10, at);
      const end = newline < 0 ? bytes.length : newline;
      const value = found(bytes.toString("utf8", start, end));
      if (value !== null) return value;
      at = start > 0 ? bytes.lastIndexOf(pattern, start - 1) : -1;
    }
    carry = bytes.subarray(0, first);
    to = from;
    chunk = Math.min(chunk * 2, MAX_APPEND_BYTES);
    await yieldToLoop();
  }
  return null;
}
