/** What roamgate-hold is told: keep holding, or resume claude now. */
export type HolderReply =
  | { action: "hold"; session_id: string }
  | {
      action: "resume";
      session_id: string;
      cwd: string;
      /** claude's arguments, `--resume <id>` included. */
      args?: string[];
    }
  | { action: "refused"; reason: string };

/**
 * The holders polling from their panes. A holder is connected while one of
 * its long polls waits here, or just after one ended (it polls again at
 * once).
 */
export function createHolderRegistry(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const panes = new Map<
    string,
    {
      waiters: Set<(reply: HolderReply) => void>;
      seen: number;
      /** When its latest poll started. */
      started: number;
      /** The session the holder says it holds. */
      sessionId: string | null;
    }
  >();

  function entry(paneId: string) {
    let found = panes.get(paneId);
    if (!found) {
      found = { waiters: new Set(), seen: 0, started: 0, sessionId: null };
      panes.set(paneId, found);
    }
    return found;
  }

  return {
    /**
     * A holder's long poll: the next reply sent to the pane, or `idle`
     * after `timeoutMs` (it polls again).
     */
    wait(
      paneId: string,
      idle: HolderReply,
      timeoutMs: number,
      signal?: AbortSignal,
      sessionId?: string,
    ): Promise<HolderReply> {
      const pane = entry(paneId);
      pane.seen = now();
      pane.started = pane.seen;
      if (sessionId) pane.sessionId = sessionId;
      return new Promise((resolve) => {
        const finish = (reply: HolderReply) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          pane.waiters.delete(finish);
          pane.seen = now();
          resolve(reply);
        };
        const onAbort = () => finish(idle);
        const timer = setTimeout(() => finish(idle), timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        pane.waiters.add(finish);
        if (signal?.aborted) finish(idle);
      });
    },
    /** A holder polled and is answered at once (it polls again). */
    touch(paneId: string, sessionId?: string) {
      const pane = entry(paneId);
      pane.seen = now();
      pane.started = pane.seen;
      if (sessionId) pane.sessionId = sessionId;
    },
    /**
     * Whether a holder runs in the pane: one of its polls waits, or one
     * ended moments ago. With `since`, only a holder that polled since then
     * counts (not one that was just told to resume).
     */
    connected(paneId: string, graceMs = 5000, since?: number): boolean {
      const pane = panes.get(paneId);
      if (!pane) return false;
      if (since !== undefined && pane.started < since) return false;
      return pane.waiters.size > 0 || now() - pane.seen < graceMs;
    },
    /** The session the pane's holder says it holds, if one polled. */
    session(paneId: string): string | null {
      return panes.get(paneId)?.sessionId ?? null;
    },
    /**
     * Answers every holder waiting in the pane. Told to resume, the holder
     * becomes claude: it no longer counts as there.
     */
    send(paneId: string, reply: HolderReply) {
      const pane = panes.get(paneId);
      if (!pane) return;
      for (const finish of [...pane.waiters]) finish(reply);
      if (reply.action === "resume") panes.delete(paneId);
    },
    /** Answers every waiting holder (each polls again). */
    releaseAll(reply: (paneId: string) => HolderReply) {
      for (const [paneId, pane] of panes)
        for (const finish of [...pane.waiters]) finish(reply(paneId));
    },
    forget(paneId: string) {
      panes.delete(paneId);
    },
  };
}

export type HolderRegistry = ReturnType<typeof createHolderRegistry>;
