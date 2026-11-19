import type { AgentChatLease } from "../../../shared/agentChat";
import { conversationDriver } from "./drivers";

/** What roamgate-hold is told: keep holding, or resume claude now. */
export type HolderReply =
  | { action: "hold"; session_id: string }
  | {
      action: "resume";
      session_id: string;
      cwd: string;
      /**
       * The TUI's command line, program first (`claude ... --resume <id>`):
       * what a holder that knows it execs.
       */
      argv?: string[];
      /** claude's arguments, `--resume <id>` included: older holders. */
      args?: string[];
    }
  | { action: "refused"; reason: string }
  | SuspendReply;

/**
 * What a holder is told to stop as a shell job (the chat's Ctrl+Z): its
 * child ended, it stops with the shell prompt back, and `fg` there brings
 * the conversation back. It keeps what the lease said of the session and
 * gives it back with its `fg` (Roamgate keeps no lease meanwhile).
 */
export type SuspendReply = {
  action: "suspend";
  session_id: string;
  cwd: string;
  /** The conversation's title, for the stopped job's line. */
  title?: string;
  agent?: string;
  terminal_args?: string[];
};

/** What a lease's holder is told to stop as a shell job. */
export function suspendReply(
  lease: AgentChatLease,
  title?: string,
): SuspendReply {
  return {
    action: "suspend",
    session_id: lease.session_id,
    cwd: lease.cwd,
    ...(title ? { title } : {}),
    ...(lease.agent ? { agent: lease.agent } : {}),
    ...(lease.terminal_args?.length
      ? { terminal_args: lease.terminal_args }
      : {}),
  };
}

/**
 * What a holder is told to resume a lease's session in its TUI: the full
 * command line, and claude's arguments alone for a holder from before
 * drivers (it always runs claude).
 */
export function resumeReply(lease: AgentChatLease): HolderReply {
  const argv = conversationDriver(lease.agent).terminal.resumeArgv(
    lease.session_id,
    lease.terminal_args ?? [],
  );
  return {
    action: "resume",
    session_id: lease.session_id,
    cwd: lease.cwd,
    argv,
    args: argv.slice(1),
  };
}

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
      /**
       * Whether it can stop as a shell job (it runs as its own job in an
       * interactive shell): a holder from before says nothing.
       */
      jobControl: boolean;
      /** Its pid on the pane's host, when it says. */
      pid: number | null;
      /** The session id it was started with: a word of its job's command. */
      job: string | null;
    }
  >();

  function entry(paneId: string) {
    let found = panes.get(paneId);
    if (!found) {
      found = {
        waiters: new Set(),
        seen: 0,
        started: 0,
        sessionId: null,
        jobControl: false,
        pid: null,
        job: null,
      };
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
    /** What the pane's holder said of itself and its shell as it polled. */
    noteShell(
      paneId: string,
      shell: { jobControl: boolean; pid?: number; job?: string },
    ) {
      const pane = entry(paneId);
      pane.jobControl = shell.jobControl;
      pane.pid = shell.pid ?? null;
      pane.job = shell.job ?? null;
    },
    /** Whether the pane's holder can stop as a shell job (Ctrl+Z). */
    jobControl(paneId: string): boolean {
      return panes.get(paneId)?.jobControl ?? false;
    },
    /** The pane's holder's pid and job word, if it said. */
    shell(paneId: string): { pid: number | null; job: string | null } {
      const pane = panes.get(paneId);
      return { pid: pane?.pid ?? null, job: pane?.job ?? null };
    },
    /** The session the pane's holder says it holds, if one polled. */
    session(paneId: string): string | null {
      return panes.get(paneId)?.sessionId ?? null;
    },
    /**
     * Answers every holder waiting in the pane. Told to resume, the holder
     * becomes claude, and told to suspend it stops as a shell job: it no
     * longer counts as there.
     */
    send(paneId: string, reply: HolderReply) {
      const pane = panes.get(paneId);
      if (!pane) return;
      for (const finish of [...pane.waiters]) finish(reply);
      if (reply.action === "resume" || reply.action === "suspend")
        panes.delete(paneId);
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
