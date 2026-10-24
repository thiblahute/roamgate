import type { HistoryEntry } from "./agentHistory";

/**
 * Messages sent from an agent chat that its session file does not show yet.
 * The chat is drawn from the transcript, which records a prompt only once
 * the agent takes it (or queues it): until then the message is shown on its
 * way, then replaced by the transcript's own entry.
 */
export type OutboxMessage = {
  id: string;
  paneId: string;
  text: string;
  sentAtMs: number;
  /** The user messages the history had when it was sent: never its own. */
  before: ReadonlySet<string>;
  /** Sending to the pane, sent and awaited in the transcript, or neither. */
  state: "sending" | "sent" | "failed";
  /** Why it failed. */
  reason?: string;
};

/** How long a sent message may take to show in the transcript. */
export const OUTBOX_TIMEOUT_MS = 90_000;

let counter = 0;

export function newOutboxMessage(
  paneId: string,
  text: string,
  entries: readonly HistoryEntry[],
  nowMs: number,
): OutboxMessage {
  return {
    id: `outbox-${nowMs}-${++counter}`,
    paneId,
    text,
    sentAtMs: nowMs,
    before: new Set(entries.filter(isUserMessage).map((entry) => entry.id)),
    state: "sending",
  };
}

function isUserMessage(entry: HistoryEntry) {
  return (
    entry.kind === "message" && entry.role === "user" && !entry.compact_summary
  );
}

/** Whitespace as the transcript may rewrite it: runs folded, ends trimmed. */
export function normalizedMessageText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function sameMessage(sent: string, recorded: string) {
  const a = normalizedMessageText(sent);
  const b = normalizedMessageText(recorded);
  if (a === b) return true;
  // The agent may add to it (attached images) or show part of a long one.
  const shorter = a.length < b.length ? a : b;
  return shorter.length >= 8 && (a.includes(b) || b.includes(a));
}

/**
 * Drops the messages the history now shows and fails those it has not shown
 * in time. Each message, oldest first, takes the oldest user message that
 * appeared since it was sent and says the same, and no other message takes
 * that one: messages sent with the same words keep their order.
 */
export function settleOutbox(
  outbox: readonly OutboxMessage[],
  entries: readonly HistoryEntry[],
  nowMs: number,
  timeoutMs = OUTBOX_TIMEOUT_MS,
): OutboxMessage[] {
  const users = entries.filter(isUserMessage);
  const taken = new Set<string>();
  const next: OutboxMessage[] = [];
  for (const message of [...outbox].sort((a, b) => a.sentAtMs - b.sentAtMs)) {
    const match = users.find(
      (entry) =>
        !taken.has(entry.id) &&
        !message.before.has(entry.id) &&
        sameMessage(message.text, entry.text),
    );
    if (match) {
      taken.add(match.id);
      continue;
    }
    next.push(
      message.state === "sent" && nowMs - message.sentAtMs >= timeoutMs
        ? {
            ...message,
            state: "failed",
            reason: "The agent's session does not show it",
          }
        : message,
    );
  }
  const unchanged =
    next.length === outbox.length &&
    next.every((message, index) => message === outbox[index]);
  return unchanged ? (outbox as OutboxMessage[]) : next;
}

/** When the next sent message runs out of time, if one is waiting. */
export function nextOutboxDeadline(
  outbox: readonly OutboxMessage[],
  timeoutMs = OUTBOX_TIMEOUT_MS,
): number | null {
  const waiting = outbox
    .filter((message) => message.state === "sent")
    .map((message) => message.sentAtMs + timeoutMs);
  return waiting.length ? Math.min(...waiting) : null;
}
