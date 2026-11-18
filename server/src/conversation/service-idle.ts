import type { AgentChatEvent } from "../../../shared/agentChat";
import { idleStopRefusal } from "./idle-stop";
import type { LeaseStore } from "./lease";
import type { ConversationSession } from "./session";

/** What idle stop needs of its runtime. */
export type IdleStopDeps = {
  sessions: Map<string, ConversationSession>;
  leases: LeaseStore;
  /**
   * Minutes a session sits idle before its process stops (0: never), read
   * at each check; none: never.
   */
  idleStopMinutes?: () => number | Promise<number>;
  /** How often sessions are checked (0: never). */
  idleCheckMs?: number;
  /** No idle stop this long after another session's message. */
  peerQuietMs?: number;
  /** Why a pane's process must stay up now; null: none. */
  keepAwake?: (paneId: string) => string | null;
  /** Whether a handover runs in the pane. */
  handingOver: (paneId: string) => boolean;
  /** Whether one of the pane's `!` lines still runs. */
  shellRunning: (paneId: string) => boolean;
  /** Whether the pane's API key question waits for an answer. */
  apiKeyQuestion: (paneId: string) => boolean;
  closed: () => boolean;
  emit: (paneId: string, event: AgentChatEvent) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Idle stop: the processes of the sessions idle past the setting stop;
 * their holders keep the panes, and the next message starts them again.
 */
export function createIdleStop(deps: IdleStopDeps) {
  const { sessions, leases, log } = deps;
  // When another session's message last reached each pane (idle stop
  // leaves those alone a while).
  const lastPeer = new Map<string, number>();

  let checkingIdle = false;
  async function checkIdle() {
    if (deps.closed() || checkingIdle || !deps.idleStopMinutes) return;
    checkingIdle = true;
    try {
      const minutes = await deps.idleStopMinutes();
      if (!(minutes > 0)) return;
      for (const [paneId, session] of [...sessions]) {
        const lease = leases.get(paneId);
        const live = session.state();
        const refusal = idleStopRefusal({
          limitMs: minutes * 60_000,
          now: Date.now(),
          idleSince: session.idleSince(),
          lastPeerAt: lastPeer.get(paneId) ?? null,
          ...(deps.peerQuietMs !== undefined
            ? { peerQuietMs: deps.peerQuietMs }
            : {}),
          conversation:
            lease?.phase === "conversation" && !deps.handingOver(paneId),
          alive: session.alive() && !session.asleep(),
          status: live.status,
          busy: session.busy(),
          queued: live.queue.length,
          backgroundTasks: session.backgroundTasks(),
          shellRunning: deps.shellRunning(paneId),
          apiKeyQuestion: deps.apiKeyQuestion(paneId),
          keptAwake: deps.keepAwake?.(paneId) ?? null,
        });
        if (refusal) continue;
        log("idle conversation stopped; its next message wakes it", {
          pane: paneId,
          idle_minutes: Math.round((Date.now() - session.idleSince()) / 60_000),
        });
        void session.sleep();
      }
    } catch (error) {
      log("idle stop check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      checkingIdle = false;
    }
  }
  const idleCheckMs = deps.idleCheckMs ?? 60_000;
  const idleWatch =
    idleCheckMs > 0 && deps.idleStopMinutes
      ? setInterval(() => void checkIdle(), idleCheckMs)
      : null;
  (idleWatch as { unref?: () => void } | null)?.unref?.();

  /** Its process was stopped while idle (true), or started again. */
  function setAsleep(paneId: string, asleep: boolean) {
    if (deps.closed()) return;
    const current = leases.get(paneId);
    if (!current || !!current.asleep_at === asleep) return;
    const next = { ...current };
    if (asleep) next.asleep_at = new Date().toISOString();
    else delete next.asleep_at;
    leases.set(next);
    deps.emit(paneId, {
      type: "asleep",
      asleep: next.asleep_at ? { since: next.asleep_at } : null,
    });
  }

  return {
    check: checkIdle,
    setAsleep,
    /** Another session's message reached the pane's agent. */
    notePeer: (paneId: string) => lastPeer.set(paneId, Date.now()),
    /** The pane is gone. */
    forget: (paneId: string) => lastPeer.delete(paneId),
    dispose() {
      if (idleWatch) clearInterval(idleWatch);
    },
  };
}
