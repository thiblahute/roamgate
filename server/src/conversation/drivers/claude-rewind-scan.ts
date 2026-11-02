import { withoutRewoundTurns } from "../../agent/session-rewind";
import { isRecord } from "../../agent/session-utils";

/** The tools whose edits Claude Code's file checkpoints track. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * What a transcript says of the code a rewind to before `uuid` would
 * restore: whether the message is there, the files Claude's file tools
 * edited after it, and whether Claude Code took a checkpoint of the code
 * for it. Commands (Bash) may have changed files too: nothing tells which,
 * and no checkpoint restores them.
 */
export type RewindScan = {
  found: boolean;
  edited: string[];
  checkpoint: boolean;
};

/**
 * `transcript`: its text, or its records (a large one's from its slim
 * index, session-tail.ts, which keeps what this reads).
 */
export function scanRewind(
  transcript: string | Record<string, unknown>[],
  uuid: string,
): RewindScan {
  const records: Record<string, unknown>[] =
    typeof transcript === "string" ? [] : transcript;
  if (typeof transcript === "string")
    for (const line of transcript.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (isRecord(record)) records.push(record);
      } catch {
        // A line being written, or not JSON: skipped.
      }
    }
  const checkpoint = records.some(
    (record) =>
      record.type === "file-history-snapshot" && record.messageId === uuid,
  );
  const kept = withoutRewoundTurns(records);
  const at = kept.findIndex((record) => record.uuid === uuid);
  if (at < 0) return { found: false, edited: [], checkpoint };
  const edited = new Set<string>();
  for (const record of kept.slice(at + 1)) {
    if (record.type !== "assistant" || !isRecord(record.message)) continue;
    const content = record.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        !isRecord(block) ||
        block.type !== "tool_use" ||
        typeof block.name !== "string" ||
        !EDIT_TOOLS.has(block.name) ||
        !isRecord(block.input)
      )
        continue;
      const path = block.input.file_path ?? block.input.notebook_path;
      if (typeof path === "string" && path) edited.add(path);
    }
  }
  return { found: true, edited: [...edited], checkpoint };
}
