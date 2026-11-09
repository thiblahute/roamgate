import { roamgateLocalStorage } from "../browserStorage";
import type { HistoryEntry } from "./agentHistory";
import { outgoingAgentMessage } from "../../../shared/agentMessage";
import {
  isArgumentObject,
  parseToolArguments,
  toolCallSummary,
} from "../../../shared/toolSummary";

export type AgentHistoryView = "chat" | "timeline";

const VIEW_STORAGE_KEY = "agentHistoryView";

export function readAgentHistoryView(): AgentHistoryView {
  return roamgateLocalStorage.getItem(VIEW_STORAGE_KEY) === "timeline"
    ? "timeline"
    : "chat";
}

export function writeAgentHistoryView(view: AgentHistoryView) {
  try {
    roamgateLocalStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* The choice still applies for this session when storage is full. */
  }
}

export type HistoryChatItem =
  | {
      type: "message";
      entry: HistoryEntry;
      sequence: number;
      /**
       * The same slash command typed this many times in a row ("/exit"
       * eleven times): one chip with a count, the latest one's time.
       */
      repeated?: number;
      /** When the first of them was typed. */
      firstSentAt?: string;
    }
  | { type: "tools"; id: string; entries: HistoryEntry[] };

// Consecutive tool entries collapse into one block so the conversation reads
// as alternating turns instead of a wall of tool chatter. Only message bubbles
// get a sequence: the minimap indexes bubbles, not tool blocks.
export function groupHistoryChatItems(
  entries: readonly HistoryEntry[],
): HistoryChatItem[] {
  const items: HistoryChatItem[] = [];
  const blockIds = new Set<string>();
  let sequence = 0;
  const results = toolResults(entries);
  // Messages sent to other sessions in a tool block: shown after it.
  let sent: HistoryEntry[] = [];
  const flushSent = () => {
    for (const entry of sent) {
      sequence += 1;
      items.push({ type: "message", entry, sequence });
    }
    sent = [];
  };
  for (const entry of entries) {
    if (entry.role !== "tool") flushSent();
    const previous = items[items.length - 1];
    if (
      entry.role === "user" &&
      entry.command &&
      previous?.type === "message" &&
      previous.entry.role === "user" &&
      previous.entry.command?.name === entry.command.name &&
      previous.entry.command.args === entry.command.args
    ) {
      // Kept under the first one's id: the chip stays as more come.
      previous.firstSentAt ??= previous.entry.sent_at;
      previous.repeated = (previous.repeated ?? 1) + 1;
      previous.entry = { ...entry, id: previous.entry.id };
      continue;
    }
    if (entry.role !== "tool") {
      sequence += 1;
      items.push({ type: "message", entry, sequence });
      continue;
    }
    const last = items[items.length - 1];
    if (last?.type === "tools") last.entries.push(entry);
    else
      items.push({
        type: "tools",
        id: toolBlockId(entry, blockIds),
        entries: [entry],
      });
    const message = sentAgentMessage(entry, results);
    if (message) sent.push(message);
  }
  flushSent();
  return items;
}

/**
 * A block is known by its first call: the same whether that call is the
 * one a conversation streams or the transcript's that replaces it, so the
 * block keeps its place, and whether it is open, across the swap.
 */
function toolBlockId(first: HistoryEntry, taken: Set<string>): string {
  const byCall =
    first.kind === "tool_call" && first.source_call_id
      ? `tools:call:${first.source_call_id}`
      : "";
  const id = byCall && !taken.has(byCall) ? byCall : `tools:${first.id}`;
  taken.add(id);
  return id;
}

/** The tool results, by the call they answer. */
function toolResults(
  entries: readonly HistoryEntry[],
): Map<string, HistoryEntry> {
  const results = new Map<string, HistoryEntry>();
  for (const entry of entries)
    if (entry.kind === "tool_result" && entry.source_call_id)
      results.set(entry.source_call_id, entry);
  return results;
}

/**
 * A message the agent sent another session (`roamgate-review message`, a
 * Bash call): shown in its chat as one, "To NAME", beside the call.
 */
export function sentAgentMessage(
  entry: HistoryEntry,
  results: ReadonlyMap<string, HistoryEntry>,
): HistoryEntry | null {
  if (entry.kind !== "tool_call") return null;
  // The bridge reads it from the call (its payload is not sent); a live
  // turn's call still has its text.
  const sent =
    entry.agent_message ?? outgoingAgentMessage(entry.tool_name, entry.text);
  if (!sent) return null;
  const result = entry.source_call_id
    ? results.get(entry.source_call_id)
    : undefined;
  let name = sent.to;
  let failed = result?.is_error === true;
  if (result?.agent_message_result) {
    failed = !result.agent_message_result.sent;
    if (result.agent_message_result.name)
      name = `${result.agent_message_result.name} (${sent.to})`;
  } else if (result?.text) {
    try {
      const answer = JSON.parse(result.text) as {
        sent?: unknown;
        to?: { name?: unknown };
        error?: unknown;
      };
      if (typeof answer?.to?.name === "string" && answer.to.name)
        name = `${answer.to.name} (${sent.to})`;
      if (answer?.error !== undefined) failed = true;
    } catch {
      // Not the client's JSON (an error printed): said as not sent.
      failed ||= /error/i.test(result.text);
    }
  }
  return {
    id: `${entry.id}:sent`,
    role: "assistant",
    kind: "message",
    text: sent.text || "(the message's text is not in the command)",
    sent_at: entry.sent_at,
    injected: {
      kind: "session",
      label: failed ? `Not sent to ${name}` : `To ${name}`,
    },
  };
}

// Identifies one version of a redacted tool payload. Polling can rewrite an
// entry under the same id (e.g. tool arguments updated in place); its content
// hash changes with it, even at the same byte length, so fetch guards keyed
// this way refetch the new payload instead of treating it as already loaded.
// Bridges that predate hashes fall back to the byte length.
export function toolPayloadKey(
  entry: Pick<HistoryEntry, "id" | "text_bytes" | "text_hash">,
) {
  return `${entry.id}:${entry.text_hash ?? entry.text_bytes ?? 0}`;
}

// Picks which queued background fetches to start now, given the requests
// already in flight. Only the newest queued version of each entry is kept,
// and versions already started are dropped. An entry whose id has a request
// in flight (an older version, or a direct load) stays queued and starts once
// that request settles, so a rewritten payload is never discarded.
export function takeQueuedToolLoads(
  queue: readonly HistoryEntry[],
  {
    inFlight,
    limit,
    started,
    loadingIds,
  }: {
    inFlight: number;
    limit: number;
    started: ReadonlySet<string>;
    loadingIds: ReadonlySet<string>;
  },
): { start: HistoryEntry[]; rest: HistoryEntry[] } {
  const newest = new Map<string, string>();
  for (const entry of queue) newest.set(entry.id, toolPayloadKey(entry));
  const start: HistoryEntry[] = [];
  const rest: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of queue) {
    const key = toolPayloadKey(entry);
    if (newest.get(entry.id) !== key || started.has(key) || seen.has(key))
      continue;
    seen.add(key);
    if (inFlight + start.length >= limit || loadingIds.has(entry.id))
      rest.push(entry);
    else start.push(entry);
  }
  return { start, rest };
}

export type ToolStep = {
  id: string;
  name: string;
  call?: HistoryEntry;
  result?: HistoryEntry;
};

// One step per call, with its result attached by call id. When either side
// lacks an id, the result pairs with the earliest unanswered call of the same
// tool. A result with no call in the block (it fell outside the history
// window) stands alone. A step is known by its call's id, the same for the
// call a conversation streams and the transcript's that replaces it.
export function pairToolSteps(entries: readonly HistoryEntry[]): ToolStep[] {
  const steps: ToolStep[] = [];
  const byCallId = new Map<string, ToolStep>();
  for (const entry of entries) {
    const name = entry.tool_name ?? "tool";
    const callId = entry.source_call_id;
    if (entry.kind === "tool_result") {
      const step =
        (callId ? byCallId.get(callId) : undefined) ??
        steps.find(
          (item) =>
            item.call &&
            !item.result &&
            item.name === name &&
            (!callId || !item.call.source_call_id),
        );
      if (step && !step.result) step.result = entry;
      else steps.push({ id: entry.id, name, result: entry });
      continue;
    }
    const step: ToolStep = {
      id: callId && !byCallId.has(callId) ? `call:${callId}` : entry.id,
      name,
      call: entry,
    };
    if (callId) byCallId.set(callId, step);
    steps.push(step);
  }
  return steps;
}

// Chat search: messages match on their own text, while a tool call and its
// result match together, so a hit on either keeps the whole step.
export function searchHistoryChatEntries(
  entries: readonly HistoryEntry[],
  query: string,
): HistoryEntry[] {
  const search = query.trim().toLowerCase();
  if (!search) return entries as HistoryEntry[];
  const matches = (entry: HistoryEntry | undefined) =>
    !!entry && entry.text.toLowerCase().includes(search);
  const kept = new Set<string>();
  let run: HistoryEntry[] = [];
  const flushRun = () => {
    for (const step of pairToolSteps(run)) {
      if (!matches(step.call) && !matches(step.result)) continue;
      if (step.call) kept.add(step.call.id);
      if (step.result) kept.add(step.result.id);
    }
    run = [];
  };
  for (const entry of entries) {
    if (entry.role === "tool") {
      run.push(entry);
      continue;
    }
    flushRun();
    if (matches(entry)) kept.add(entry.id);
  }
  flushRun();
  return entries.filter((entry) => kept.has(entry.id));
}

// Single-line values that still read best as code.
const CODE_KEYS = new Set(["command", "cmd"]);

// A one-line summary of a call's arguments for its collapsed row: what the
// call says it does when it has a description, else its main argument.
export function toolArgumentHeadline(text: string): string {
  return toolCallSummary("", text, {}, Number.POSITIVE_INFINITY);
}

// What a step does in one line: the summary the server kept, which knows the
// whole session (who an agent id is, what a thread is about), else one from
// the arguments and result at hand, as a live turn's calls have.
export function toolStepSummary(step: ToolStep): string {
  const call = step.call;
  if (!call) return "";
  if (call.summary) return call.summary;
  if (call.text.length === 0) return "";
  const result = step.result?.text;
  return toolCallSummary(
    step.name,
    call.text,
    result ? { result } : {},
    Number.POSITIVE_INFINITY,
  );
}

// Finished steps a collapsed group lists besides the running ones.
export const COLLAPSED_FINISHED_STEPS = 3;

// The steps a collapsed tool group lists as progress: every running step
// and the last few finished ones, in order; `earlier` counts the finished
// steps left out.
export function collapsedToolProgress(
  steps: readonly ToolStep[],
  finishedLimit = COLLAPSED_FINISHED_STEPS,
): { visible: ToolStep[]; earlier: number } {
  const finished = steps.filter((step) => step.result);
  const hidden = new Set(
    finished.slice(0, Math.max(0, finished.length - finishedLimit)),
  );
  return {
    visible: steps.filter((step) => !hidden.has(step)),
    earlier: hidden.size,
  };
}

export type ToolArgumentField = { key: string; value: string; code: boolean };

// Arguments as labelled fields: strings verbatim, other values as formatted
// JSON. Text that is not a JSON object becomes a single unlabelled field.
export function toolArgumentFields(text: string): ToolArgumentField[] {
  const parsed = parseToolArguments(text);
  if (!isArgumentObject(parsed)) {
    return text.trim() ? [{ key: "", value: text, code: true }] : [];
  }
  return Object.entries(parsed).map(([key, value]) =>
    typeof value === "string"
      ? { key, value, code: value.includes("\n") || CODE_KEYS.has(key) }
      : { key, value: JSON.stringify(value, null, 2), code: true },
  );
}

// Clip argument fields to one character budget across the whole payload, so
// many short fields cannot add up to an unbounded preview. Keys count toward
// the budget (at least one character per field), which also bounds the
// number of rendered fields.
export function previewToolArgumentFields(
  fields: readonly ToolArgumentField[],
  limit: number,
): { fields: ToolArgumentField[]; truncated: boolean } {
  const preview: ToolArgumentField[] = [];
  let remaining = limit;
  for (const field of fields) {
    const cost = Math.max(1, field.key.length);
    if (remaining < cost) return { fields: preview, truncated: true };
    remaining -= cost;
    if (field.value.length > remaining) {
      preview.push({ ...field, value: field.value.slice(0, remaining) });
      return { fields: preview, truncated: true };
    }
    remaining -= field.value.length;
    preview.push(field);
  }
  return { fields: preview, truncated: false };
}

export type ToolBlockSummary = {
  calls: number;
  errors: number;
  /** Questions or permissions dismissed unanswered (not errors). */
  dismissed: number;
  tools: { name: string; count: number }[];
};

// A collapsed block counts the same paired steps its rows show, so the
// header and the rows always agree. Tools are listed most-used first.
export function summarizeToolSteps(
  steps: readonly ToolStep[],
): ToolBlockSummary {
  const counts = new Map<string, number>();
  for (const step of steps) {
    counts.set(step.name, (counts.get(step.name) ?? 0) + 1);
  }
  return {
    calls: steps.length,
    errors: steps.filter(
      (step) => step.result?.is_error && !step.result.dismissed,
    ).length,
    dismissed: steps.filter((step) => step.result?.dismissed).length,
    tools: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}
