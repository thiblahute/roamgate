import type { AgentChatEvent, AgentChatStuck } from "../../../shared/agentChat";
import type { ConversationSession } from "./session";

/** What the watch on turns that hang needs of its runtime. */
export type StuckWatchDeps = {
  sessions: Map<string, ConversationSession>;
  /** Whether conversation mode owns the pane's session now. */
  owned: (paneId: string) => boolean;
  closed: () => boolean;
  emit: (paneId: string, event: AgentChatEvent) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** When the pane session's transcript last changed; null: unknown. */
  transcriptStat?: (paneId: string) => Promise<{ mtimeMs: number } | null>;
  stuckAfterMs: number;
  stuckToolAfterMs: number;
  /** How often turns are checked (0: never). */
  stuckCheckMs: number;
  /** How long Stop waits for Claude to answer before the chat says so. */
  stopAnswerMs: number;
};

/**
 * Turns that seem to hang (nothing from Claude for too long), and Stops
 * that Claude does not answer: the chat says so, since when, and why.
 */
export function createStuckWatch(deps: StuckWatchDeps) {
  const { sessions, emit, log } = deps;
  // Turns that seem to hang, and the Stops waiting for an answer.
  const stuck = new Map<string, AgentChatStuck>();
  const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The chat says the turn seems to hang, since when, and why. */
  function setStuck(paneId: string, next: AgentChatStuck) {
    if (deps.closed() || !deps.owned(paneId)) return;
    const current = stuck.get(paneId);
    if (current?.reason === next.reason && current.since === next.since) return;
    stuck.set(paneId, next);
    log("the turn seems stuck", { pane: paneId, ...next });
    emit(paneId, { type: "stuck", stuck: { ...next } });
  }

  function clearStuck(paneId: string) {
    const timer = stopTimers.get(paneId);
    if (timer) clearTimeout(timer);
    stopTimers.delete(paneId);
    if (!stuck.delete(paneId)) return;
    emit(paneId, { type: "stuck", stuck: null });
  }

  /**
   * The turns nothing came from for too long: neither output nor a change
   * of the transcript (Claude writes it as it goes, a subagent's progress
   * included). A question waiting for the user is no hang.
   */
  let checkingStuck = false;
  async function checkStuck() {
    if (deps.closed() || checkingStuck) return;
    checkingStuck = true;
    try {
      for (const [paneId, session] of [...sessions]) {
        if (stuck.get(paneId)?.reason === "stop_unanswered") continue;
        const activity = session.activity();
        if (!activity.running || !deps.owned(paneId)) {
          clearStuck(paneId);
          continue;
        }
        const limit = activity.tools
          ? deps.stuckToolAfterMs
          : deps.stuckAfterMs;
        let since = activity.since;
        if (Date.now() - since < limit) continue;
        const stat = deps.transcriptStat
          ? await deps.transcriptStat(paneId).catch(() => null)
          : null;
        if (stat && stat.mtimeMs > since) since = stat.mtimeMs;
        if (Date.now() - since < limit) continue;
        if (sessions.get(paneId) !== session || !session.activity().running)
          continue;
        setStuck(paneId, {
          since: new Date(since).toISOString(),
          reason: "silent",
        });
      }
    } finally {
      checkingStuck = false;
    }
  }

  const stuckWatch =
    deps.stuckCheckMs > 0
      ? setInterval(() => void checkStuck(), deps.stuckCheckMs)
      : null;
  (stuckWatch as { unref?: () => void } | null)?.unref?.();

  /**
   * Stop that Claude does not answer (an API request that never ends, a
   * process whose output does not come through): after a while the chat
   * says so, and offers to restart it.
   */
  async function interrupt(paneId: string): Promise<boolean> {
    const session = sessions.get(paneId);
    if (!session) return false;
    const asked = Date.now();
    const ok = await session.interrupt();
    if (ok || deps.closed() || !session.activity().running) return ok;
    const previous = stopTimers.get(paneId);
    if (previous) clearTimeout(previous);
    stopTimers.set(
      paneId,
      setTimeout(
        () => {
          stopTimers.delete(paneId);
          if (deps.closed() || sessions.get(paneId) !== session) return;
          const activity = session.activity();
          if (!activity.running || activity.since > asked) return;
          setStuck(paneId, {
            since: new Date(activity.since).toISOString(),
            reason: "stop_unanswered",
          });
        },
        Math.max(0, deps.stopAnswerMs - (Date.now() - asked)),
      ),
    );
    return ok;
  }

  return {
    set: setStuck,
    clear: clearStuck,
    /** What the chat says of the pane's turn, a copy; null: nothing. */
    get: (paneId: string): AgentChatStuck | null => {
      const current = stuck.get(paneId);
      return current ? { ...current } : null;
    },
    check: checkStuck,
    interrupt,
    /** Claude said something: whatever seemed to hang does not any more. */
    output(paneId: string) {
      if (stuck.has(paneId) || stopTimers.has(paneId)) clearStuck(paneId);
    },
    dispose() {
      if (stuckWatch) clearInterval(stuckWatch);
      for (const timer of stopTimers.values()) clearTimeout(timer);
      stopTimers.clear();
    },
  };
}
