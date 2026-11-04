import type { AgentChatHandoverResult } from "../../../shared/agentChat";

/**
 * Conversation mode taking a claude the user just started in a pane (the
 * `claude` start setting, told by the claude's SessionStart hook): the
 * usual handover (/exit once idle, then the pane holder), tried again while
 * Claude is still starting, or busy with a prompt it was started with.
 * Anything that says the user is at work in the terminal ends it.
 */

/** What a refusal means for a claude that just started. */
export type AutoStartRetry = "starting" | "busy" | "stop";

const STARTING = [
  // Herdr has not seen it yet, or not its session.
  /^Claude is not running in this pane/,
  /^Herdr has no session id/,
  /^Herdr did not say what runs/,
  /^Herdr cannot tell whether Claude is idle/,
  /^Herdr did not list the pane's processes/,
  // Still drawing its prompt box, or asking first (trust this folder?).
  /^Claude's prompt box is not on screen/,
  /^Could not read Claude's prompt box/,
  /^Claude is waiting for an answer in the terminal/,
  /^Cannot tell which process is Claude/,
  /^A handover of this pane is already running/,
];

const BUSY = [
  // A prompt given on the command line: its turn ends first.
  /^Claude is working/,
  /^Claude still runs background work/,
];

export function autoStartRetry(reason: string): AutoStartRetry {
  if (STARTING.some((pattern) => pattern.test(reason))) return "starting";
  if (BUSY.some((pattern) => pattern.test(reason))) return "busy";
  return "stop";
}

export type AutoStartDeps = {
  toConversation: (
    paneId: string,
    sessionId: string,
  ) => Promise<AgentChatHandoverResult>;
  /** Conversation mode already has the pane (or is taking it). */
  owned: (paneId: string) => boolean;
  /** The connection is going away. */
  closed: () => boolean;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Before the first try: Claude draws its prompt box. */
  firstDelayMs?: number;
  /** Between tries while it starts, and for how long in all. */
  retryMs?: number;
  startingMs?: number;
  /** Between tries while a prompt it started with runs, and how long. */
  busyRetryMs?: number;
  busyMs?: number;
};

export function createAutoStarter(deps: AutoStartDeps) {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const firstDelayMs = deps.firstDelayMs ?? 1000;
  const retryMs = deps.retryMs ?? 1000;
  const startingMs = deps.startingMs ?? 2 * 60_000;
  const busyRetryMs = deps.busyRetryMs ?? 3000;
  const busyMs = deps.busyMs ?? 30 * 60_000;
  const log = deps.log ?? (() => {});
  /** The run going on in each pane: a newer start replaces it. */
  const runs = new Map<string, { sessionId: string }>();

  async function run(
    paneId: string,
    token: { sessionId: string },
  ): Promise<AgentChatHandoverResult> {
    const started = now();
    const current = () =>
      runs.get(paneId) === token && !deps.closed() && !deps.owned(paneId);
    let wait = firstDelayMs;
    let last: AgentChatHandoverResult = {
      ok: false,
      reason: "Stopped before it was tried",
    };
    try {
      for (;;) {
        await sleep(wait);
        if (!current()) return last;
        last = await deps
          .toConversation(paneId, token.sessionId)
          .catch((error) => ({
            ok: false as const,
            reason: error instanceof Error ? error.message : String(error),
          }));
        if (last.ok) {
          log("conversation mode took the claude started in the pane", {
            pane: paneId,
            session: token.sessionId,
          });
          return last;
        }
        const retry = autoStartRetry(last.reason);
        const elapsed = now() - started;
        if (
          retry === "stop" ||
          (retry === "starting" && elapsed >= startingMs) ||
          (retry === "busy" && elapsed >= busyMs)
        ) {
          log("the claude started in the pane stays in the terminal", {
            pane: paneId,
            reason: last.reason,
          });
          return last;
        }
        wait = retry === "busy" ? busyRetryMs : retryMs;
      }
    } finally {
      if (runs.get(paneId) === token) runs.delete(paneId);
    }
  }

  return {
    /** Takes the pane's new claude once it can; resolves with the outcome. */
    start(paneId: string, sessionId: string): Promise<AgentChatHandoverResult> {
      const token = { sessionId };
      runs.set(paneId, token);
      return run(paneId, token);
    },
    /** Whether a start waits on the pane. */
    pending: (paneId: string) => runs.has(paneId),
    cancel(paneId: string) {
      runs.delete(paneId);
    },
    dispose() {
      runs.clear();
    },
  };
}

export type AutoStarter = ReturnType<typeof createAutoStarter>;
