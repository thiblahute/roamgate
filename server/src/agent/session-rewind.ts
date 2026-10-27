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
 * A rewind Claude Code records at once (a `last-prompt` record marked
 * `rewound`, naming the message cut) takes that message and all that came
 * of it out before anything is sent: a rewind from conversation mode, made
 * over its control protocol, leaves it.
 *
 * Other records off the line stay: the results of tool calls run side by
 * side hang from the same record without being prompts, and records with
 * no parent known, such as before a compaction, are left as they are.
 */
export function withoutRewoundTurns(records: SessionRecord[]): SessionRecord[] {
  const undone = rewoundRecordIds(records);
  return undone.size
    ? records.filter(
        (record) => typeof record.uuid !== "string" || !undone.has(record.uuid),
      )
    : records;
}

/**
 * What stands for a prompt of the user's a rewind cut: its words and when
 * they were sent, with no uuid, so nothing takes it for the conversation's.
 * The history counts the turns Claude Code took from its queue by their
 * prompts: a cut prompt still answers its dequeue, or the next message
 * would answer it and leave another message shown as queued.
 */
export const REWOUND_PROMPT = "rewound-prompt";

/**
 * The records without those a rewind undid (`rewoundRecordIds`): each of
 * the user's prompts among them kept as a `REWOUND_PROMPT` stand-in, so the
 * history can offer the words back and keep its queue right.
 */
export function keptRecords(
  records: SessionRecord[],
  rewound: ReadonlySet<string> | null,
): SessionRecord[] {
  if (!rewound?.size) return records;
  const kept: SessionRecord[] = [];
  for (const record of records) {
    if (typeof record.uuid !== "string" || !rewound.has(record.uuid)) {
      kept.push(record);
      continue;
    }
    if (!isPrompt(record)) continue;
    const message = isRecord(record.message) ? record.message : {};
    kept.push({
      type: REWOUND_PROMPT,
      content: message.content,
      timestamp: record.timestamp,
      cutUuid: record.uuid,
    });
  }
  return kept;
}

/** The ids of the records `withoutRewoundTurns` leaves out. */
export function rewoundRecordIds(records: SessionRecord[]): Set<string> {
  const byId = new Map<string, SessionRecord>();
  const children = new Map<string, SessionRecord[]>();
  let leaf: string | null = null;
  const cuts: string[] = [];
  for (const record of records) {
    if (
      record.type === "last-prompt" &&
      record.rewound === true &&
      typeof record.cutUuid === "string"
    )
      cuts.push(record.cutUuid);
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
  for (const cut of cuts) {
    const record = byId.get(cut);
    if (record) drop(record);
  }
  for (const parent of line) {
    const siblings = children.get(parent) ?? [];
    const kept = siblings.find((record) => line.has(record.uuid as string));
    if (!isPrompt(kept)) continue;
    for (const record of siblings)
      if (record !== kept && isPrompt(record)) drop(record);
  }
  return undone;
}
