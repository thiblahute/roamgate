import { isRecord } from "./session-utils";

type SessionRecord = Record<string, unknown>;

/** What the user typed: not a tool's result, nor a note Claude Code wrote. */
function isPrompt(record: SessionRecord | undefined) {
  if (!record || record.type !== "user" || record.isMeta === true) return false;
  const content = isRecord(record.message) ? record.message.content : null;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  const parts = content.filter(isRecord);
  return (
    parts.some((part) => part.type === "text") &&
    !parts.some((part) => part.type === "tool_result")
  );
}

function parentOf(record: SessionRecord) {
  // A compaction starts over with no parent, and names the one it follows.
  const parent = record.parentUuid ?? record.logicalParentUuid;
  return typeof parent === "string" ? parent : null;
}

/**
 * A Claude Code transcript without the turns a rewind left behind. Each
 * record names its parent: the conversation is the line from the last
 * record back. A rewind leaves the records it undid in the file, and the
 * next message the user sends hangs from an earlier record, beside the
 * message the rewind went back to. That message, and all that came of it,
 * is gone from the conversation.
 *
 * Other records off the line stay: the results of tool calls run side by
 * side hang from the same record without being prompts, and records with
 * no parent known, such as before a compaction, are left as they are.
 */
export function withoutRewoundTurns(records: SessionRecord[]): SessionRecord[] {
  const byId = new Map<string, SessionRecord>();
  const children = new Map<string, SessionRecord[]>();
  let leaf: string | null = null;
  for (const record of records) {
    if (typeof record.uuid !== "string") continue;
    byId.set(record.uuid, record);
    leaf = record.uuid;
    const parent = parentOf(record);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), record]);
  }
  const line = new Set<string>();
  for (let at = leaf; at && !line.has(at); ) {
    line.add(at);
    const record = byId.get(at);
    at = record ? parentOf(record) : null;
  }
  const undone = new Set<string>();
  const drop = (record: SessionRecord) => {
    const id = record.uuid as string;
    if (undone.has(id)) return;
    undone.add(id);
    for (const child of children.get(id) ?? []) drop(child);
  };
  for (const parent of line) {
    const siblings = children.get(parent) ?? [];
    const kept = siblings.find((record) => line.has(record.uuid as string));
    if (!isPrompt(kept)) continue;
    for (const record of siblings)
      if (record !== kept && isPrompt(record)) drop(record);
  }
  return undone.size
    ? records.filter(
        (record) => typeof record.uuid !== "string" || !undone.has(record.uuid),
      )
    : records;
}
