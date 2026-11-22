/**
 * Whether an agent session was compacted since a time, from the end of its
 * transcript: Claude's compaction summary (`isCompactSummary`), Codex's
 * `compacted` record and Pi's `compaction` entry. What an agent was told
 * before a compaction is gone from its context; Roamgate explains its
 * deliveries again after one (review/service.ts, explainsFirst).
 */

/** How much of a transcript's end is read: a compaction is recent. */
export const COMPACTION_TAIL_BYTES = 512 * 1024;

function isCompaction(record: Record<string, unknown>): boolean {
  if (record.isCompactSummary === true) return true;
  if (record.type === "compacted" || record.type === "compaction") return true;
  // Claude's stream and transcript mark the boundary too.
  return record.type === "system" && record.subtype === "compact_boundary";
}

/**
 * Whether the transcript's end (whole JSONL lines, the first maybe cut)
 * holds a compaction stamped after `since` (ISO). Lines are read from the
 * end and stop at the first one older than `since`.
 */
export function compactedSince(tail: string, since: string): boolean {
  const lines = tail.split("\n");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]!.trim();
    if (!line.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const fields = record as Record<string, unknown>;
    const stamp = typeof fields.timestamp === "string" ? fields.timestamp : "";
    if (stamp && Date.parse(stamp) <= Date.parse(since)) return false;
    if (isCompaction(fields) && stamp) return true;
  }
  return false;
}
