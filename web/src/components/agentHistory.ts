import type {
  HistoryCursor,
  HistoryEntry,
  HistoryUpdate,
} from "../../../server/src/agent/session-history";
import { historyWindowEntries } from "../../../server/src/agent/session-history-window";
export type { HistoryCursor, HistoryEntry, HistoryUpdate };

export type AgentHistory = {
  status?: "ok" | "missing_session" | "missing_file";
  detail?: string;
  command?: string;
  agent: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  updated_at: string;
  path: string;
  cursor: HistoryCursor;
  messages: HistoryEntry[];
};
export type AgentHistoryResponse = Omit<AgentHistory, "messages" | "cursor"> &
  HistoryUpdate;

export const HISTORY_CATEGORIES = ["user", "agent", "tool"] as const;
export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];
export type HistoryFilters = Record<HistoryCategory, boolean>;
export const ALL_HISTORY_FILTERS: HistoryFilters = {
  user: true,
  agent: true,
  tool: true,
};

// Tool payloads arrive redacted (metadata only) and are fetched on demand;
// an entry is pending until its text is loaded.
export function isToolContentPending(
  entry: Pick<HistoryEntry, "role" | "text" | "text_bytes">,
) {
  return (
    entry.role === "tool" &&
    entry.text.length === 0 &&
    (entry.text_bytes ?? 0) > 0
  );
}

// A payload fetched for a redacted tool entry.
export type ToolTextOverlay = { text: string; bytes: number; hash?: string };

// A fetched payload still belongs to an entry while it matches the entry's
// content hash, which changes even when a rewrite keeps the byte length.
// Bridges that predate hashes fall back to the byte length.
export function toolOverlayMatches(
  overlay: ToolTextOverlay,
  entry: Pick<HistoryEntry, "text_bytes" | "text_hash">,
) {
  if (entry.text_hash !== undefined) return overlay.hash === entry.text_hash;
  return entry.text_bytes === undefined || overlay.bytes === entry.text_bytes;
}

export function historyEntryCategory(entry: HistoryEntry): HistoryCategory {
  return entry.role === "assistant" ? "agent" : entry.role;
}

// Filter only the rendered window, never the synchronized source or cursor.
export function selectHistoryEntries(
  entries: HistoryEntry[],
  filters: HistoryFilters,
  query = "",
) {
  const search = query.trim().toLowerCase();
  const counts: Record<HistoryCategory, number> = {
    user: 0,
    agent: 0,
    tool: 0,
  };
  const visible: HistoryEntry[] = [];
  for (const entry of entries) {
    const category = historyEntryCategory(entry);
    counts[category] += 1;
    if (
      filters[category] &&
      (!search || entry.text.toLowerCase().includes(search))
    )
      visible.push(entry);
  }
  return { visible, counts };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two versions of an entry hold the same thing. */
export function sameHistoryEntry(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof HistoryEntry)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => sameValue(a[key], b[key]));
}

// A refresh hands over new objects even for entries that did not change:
// keep the ones already shown, so memoized bubbles and blocks skip them.
function keepUnchangedEntries(
  previous: readonly HistoryEntry[],
  next: HistoryEntry[],
): HistoryEntry[] {
  if (!previous.length) return next;
  const known = new Map(previous.map((entry) => [entry.id, entry]));
  return next.map((entry) => {
    const old = known.get(entry.id);
    return old && sameHistoryEntry(old, entry) ? old : entry;
  });
}

// The request cursor is required even for snapshots: an older reset response
// must not replace a newer epoch. Connection/pane leases are checked by the caller.
export function mergeAgentHistory(
  current: AgentHistory | null,
  response: AgentHistoryResponse,
  requested: HistoryCursor | null,
): AgentHistory | null {
  const sameCursor = (a: HistoryCursor | null, b: HistoryCursor | null) =>
    a?.epoch === b?.epoch && a?.revision === b?.revision;
  if (!sameCursor(current?.cursor ?? null, requested)) return current;
  if (
    response.history_version !== 2 ||
    !Number.isSafeInteger(response.cursor.revision) ||
    response.cursor.revision < 1
  )
    return current;
  if (
    current?.cursor.epoch === response.cursor.epoch &&
    current.cursor.revision >= response.cursor.revision
  )
    return current;
  let messages: HistoryEntry[];
  if (response.mode === "snapshot") {
    messages = response.entries;
  } else {
    if (
      !current ||
      response.cursor.epoch !== current.cursor.epoch ||
      response.base_revision !== current.cursor.revision
    )
      return current;
    const entries = new Map(current.messages.map((entry) => [entry.id, entry]));
    for (const id of response.removed) entries.delete(id);
    for (const entry of response.upserts) entries.set(entry.id, entry);
    const order = response.order ?? current.messages.map((entry) => entry.id);
    if (
      order.length !== entries.size ||
      new Set(order).size !== order.length ||
      order.some((id) => !entries.has(id))
    )
      return current;
    messages = order.map((id) => entries.get(id)!);
  }
  messages = keepUnchangedEntries(current?.messages ?? [], messages);
  const limit = Math.max(1, Math.min(response.window_limit, 200));
  if (
    !Number.isInteger(limit) ||
    new Set(messages.map((entry) => entry.id)).size !== messages.length
  )
    return current;
  // Never retain transport deltas or full snapshots beside the visible list.
  // The window counts conversation entries only; tool entries ride along.
  return {
    status: response.status,
    detail: response.detail,
    command: response.command,
    agent: response.agent,
    pane_id: response.pane_id,
    workspace_id: response.workspace_id,
    tab_id: response.tab_id,
    updated_at: response.updated_at,
    path: response.path,
    cursor: response.cursor,
    messages: historyWindowEntries(messages, limit),
  };
}

export function historyEntryLabel(entry: HistoryEntry) {
  if (entry.kind === "tool_call")
    return `Tool call: ${entry.tool_name ?? "tool"}`;
  if (entry.kind === "tool_result")
    return `${entry.is_error ? "Tool error" : "Tool output"}: ${entry.tool_name ?? "tool"}`;
  if (entry.kind === "error") return "Assistant error";
  return entry.role === "assistant" ? "Assistant" : "You";
}

/**
 * A history read that timed out is asked once more before it counts as
 * failed: a bridge busy for a while (a restart, a big transcript) still
 * answers, and the chat keeps what it shows meanwhile.
 */
export async function retryOnceOnTimeout<T>(call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("timeout: "))
      throw error;
    return call();
  }
}

/** What the chat says of reads that failed, timeouts in plain words. */
export function historyLoadError(messages: readonly string[]): string {
  const slow = messages.filter((message) => message.startsWith("timeout: "));
  const other = messages.filter((message) => !message.startsWith("timeout: "));
  return [
    ...(slow.length
      ? [
          "The bridge is slow to answer; the chat shows what it had and tries again on the next change.",
        ]
      : []),
    ...other,
  ].join("\n");
}
