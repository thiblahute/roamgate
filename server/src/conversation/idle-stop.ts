import type { AgentChatStatus } from "../../../shared/agentChat";

/**
 * Idle stop: a conversation-mode session that sat idle long enough gets its
 * headless process stopped (its holder keeps the pane), and the next
 * message of any kind starts it again. These are the rules of when; the
 * service checks every session against them once a minute.
 */

/** No idle stop this long after another session's message reached it. */
export const PEER_QUIET_MS = 10 * 60_000;

export type IdleStopFacts = {
  /** The setting, in ms; 0: off. */
  limitMs: number;
  now: number;
  /** When the process last said something, or a turn was written. */
  idleSince: number;
  /** When another session's message last reached it; null: never. */
  lastPeerAt: number | null;
  peerQuietMs?: number;
  /** The conversation owns the session (not a handover). */
  conversation: boolean;
  /** A process runs (or starts). */
  alive: boolean;
  status: AgentChatStatus;
  /** A turn runs, a prompt waits, or a message is on its way. */
  busy: boolean;
  queued: number;
  backgroundTasks: number;
  /** A `!` line from the chat runs. */
  shellRunning: boolean;
  /** The API key question waits for the user. */
  apiKeyQuestion: boolean;
  /** Why it must stay up meanwhile (a voice call, a companion job). */
  keptAwake: string | null;
};

/** Why the session is not stopped now; null: stop it. */
export function idleStopRefusal(facts: IdleStopFacts): string | null {
  if (facts.limitMs <= 0) return "idle stop is off";
  if (!facts.conversation) return "not in conversation mode";
  if (!facts.alive) return "no process runs";
  if (facts.status === "blocked") return "it asks the user something";
  if (facts.apiKeyQuestion) return "the API key question waits";
  if (facts.busy || facts.status !== "idle") return "it works";
  if (facts.queued) return "messages wait in its queue";
  if (facts.backgroundTasks) return "background work runs";
  if (facts.shellRunning) return "a shell line runs";
  if (facts.keptAwake) return facts.keptAwake;
  if (
    facts.lastPeerAt !== null &&
    facts.now - facts.lastPeerAt < (facts.peerQuietMs ?? PEER_QUIET_MS)
  )
    return "another session messaged it lately";
  if (facts.now - facts.idleSince < facts.limitMs)
    return "not idle long enough";
  return null;
}
