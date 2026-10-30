import type {
  AgentChatHandoverResult,
  AgentChatLease,
} from "../../../shared/agentChat";
import { isRecord } from "../agent/session-utils";
import {
  type ConversationHerdr,
  claudePromptState,
  isClaudeProcess,
  type PaneProcessInfo,
  terminalClaudeArgs,
} from "./herdr";
import type { HolderRegistry } from "./holder";
import type { LeaseStore } from "./lease";

/** What a handover needs of the session's headless side. */
export type HeadlessSide = {
  busy(): boolean;
  /** Tasks that outlive their turn (background commands, subagents). */
  backgroundTasks(): number;
  queueLength(): number;
  interrupt(): Promise<boolean>;
  waitForResult(timeoutMs: number): Promise<boolean>;
  /** Closes stdin and waits; true once no process runs. */
  stop(): Promise<boolean>;
  pid(): number | null;
};

export type HandoverDeps = {
  herdr: ConversationHerdr;
  leases: LeaseStore;
  holders: HolderRegistry;
  holderCommand: (sessionId: string) => string;
  /** What is typed into a bare shell to resume the session in claude. */
  resumeCommand?: (sessionId: string, args?: string[]) => string;
  /** A pane's lease changed (each phase): the browsers are told. */
  onLease?: (paneId: string) => void;
  /**
   * The connection is going away: nothing more is changed (leases, panes,
   * holders); a handover still running gives up where it is.
   */
  closed?: () => boolean;
  /** A lease's pane is gone: its lease and process go too. */
  onPaneGone?: (paneId: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long the TUI or the headless process gets to exit. */
  exitTimeoutMs?: number;
  /** How long the holder gets to show up in the pane. */
  holderTimeoutMs?: number;
  /** How long Herdr gets to map the pane to the session again. */
  confirmTimeoutMs?: number;
  /** How long a TUI that missed the exit deadline is still watched. */
  lateExitMs?: number;
  pollMs?: number;
};

class HandoverClosed extends Error {}

function refuse(reason: string): AgentChatHandoverResult {
  return { ok: false, reason };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sessionOf(agent: Record<string, unknown> | null): string | null {
  const session =
    agent && isRecord(agent.agent_session) ? agent.agent_session : null;
  return session &&
    session.kind === "id" &&
    typeof session.value === "string" &&
    session.value
    ? session.value
    : null;
}

function shellInForeground(info: PaneProcessInfo): boolean {
  return (
    info.shell_pid !== undefined &&
    info.foreground_process_group_id === info.shell_pid &&
    !info.foreground_processes.some(isClaudeProcess)
  );
}

/**
 * The two handovers between a pane's interactive claude and conversation
 * mode's headless one. Each step checks; anything unexpected refuses and
 * leaves the session with the writer it had, so the two never run on one
 * session at the same time.
 */
export function createHandover(deps: HandoverDeps) {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const exitTimeoutMs = deps.exitTimeoutMs ?? 15_000;
  const holderTimeoutMs = deps.holderTimeoutMs ?? 10_000;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 20_000;
  const pollMs = deps.pollMs ?? 200;
  const lateExitMs = deps.lateExitMs ?? 120_000;
  const resumeCommand =
    deps.resumeCommand ??
    ((sessionId: string) => ` claude --resume ${sessionId}\r`);
  const running = new Set<string>();
  const leaseChanged = (paneId: string) => deps.onLease?.(paneId);
  /** Throws once the connection closes: the handover stops there. */
  function guard() {
    if (deps.closed?.()) throw new HandoverClosed();
  }
  function setLease(lease: Parameters<LeaseStore["set"]>[0]) {
    guard();
    const next = deps.leases.set(lease);
    leaseChanged(lease.pane_id);
    return next;
  }
  function deleteLease(paneId: string) {
    guard();
    deps.leases.delete(paneId);
    leaseChanged(paneId);
  }

  async function until(
    check: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = now() + timeoutMs;
    for (;;) {
      guard();
      if (await check().catch(() => false)) return true;
      if (now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  async function exclusive(
    paneId: string,
    run: () => Promise<AgentChatHandoverResult>,
  ): Promise<AgentChatHandoverResult> {
    if (running.has(paneId))
      return refuse("A handover of this pane is already running");
    running.add(paneId);
    try {
      guard();
      return await run();
    } catch (error) {
      if (error instanceof HandoverClosed)
        return refuse("The connection is closing");
      throw error;
    } finally {
      running.delete(paneId);
    }
  }

  /**
   * The pane is a bare shell (claude gone, no holder): claude is resumed
   * there, so the session is never left with no writer and no way back.
   */
  async function resumeInShell(
    paneId: string,
    sessionId: string,
    args?: string[],
  ): Promise<boolean> {
    if (deps.closed?.() || deps.leases.get(paneId)) return false;
    const info = await deps.herdr.processInfo(paneId).catch(() => null);
    if (!info || !shellInForeground(info)) return false;
    await deps.herdr.sendText(paneId, resumeCommand(sessionId, args));
    return true;
  }

  /**
   * A TUI that missed the /exit deadline (slow SessionEnd hooks, an /exit
   * queued behind a turn) may still exit: it is watched a while longer and,
   * if it does, claude is resumed in the shell it leaves.
   */
  function watchLateExit(
    paneId: string,
    pid: number,
    sessionId: string,
    args: string[],
  ) {
    void until(async () => {
      if (await deps.herdr.pidAlive(pid)) return false;
      return shellInForeground(await deps.herdr.processInfo(paneId));
    }, lateExitMs)
      .then((exited) =>
        exited && !running.has(paneId)
          ? resumeInShell(paneId, sessionId, args)
          : false,
      )
      .catch(() => false);
  }

  /** The other pane holding this session in conversation mode, if live. */
  async function liveOwnerElsewhere(
    paneId: string,
    sessionId: string,
  ): Promise<AgentChatLease | null> {
    const other = deps.leases.bySession(sessionId);
    if (!other || other.pane_id === paneId) return null;
    // A pane that was closed leaves its lease behind: it goes now.
    if (
      (await deps.herdr.paneExists(other.pane_id).catch(() => true)) === false
    ) {
      guard();
      deps.onPaneGone?.(other.pane_id);
      return deps.leases.get(other.pane_id) ? other : null;
    }
    return other;
  }

  /** Terminal -> conversation: stop the idle TUI, then hold the pane. */
  function toConversation(
    paneId: string,
    expectedSessionId?: string,
  ): Promise<AgentChatHandoverResult & { lease?: AgentChatLease }> {
    return exclusive(paneId, async () => {
      let current = deps.leases.get(paneId);
      if (current?.phase === "conversation") {
        // The holder may have resumed claude by itself while Roamgate was
        // away: then the terminal has the session, and the lease is stale.
        const info = await deps.herdr.processInfo(paneId).catch(() => null);
        const resumed =
          !!info?.foreground_processes.some(isClaudeProcess) &&
          !(await deps.herdr
            .headlessRunning([
              current.session_id,
              ...(current.headless_session_ids ?? []),
            ])
            .catch(() => true));
        if (!resumed)
          return {
            ok: true,
            owner: "conversation",
            session_id: current.session_id,
          };
        deleteLease(paneId);
        current = null;
      }
      if (current)
        return refuse("This session is being handed over; try again shortly");
      let agent: Record<string, unknown> | null;
      try {
        agent = await deps.herdr.agentGet(paneId);
      } catch (error) {
        return refuse(
          `Herdr did not say what runs in the pane: ${errorText(error)}`,
        );
      }
      if (!agent || agent.agent !== "claude")
        return refuse("Claude is not running in this pane");
      const status = agent.agent_status;
      if (status !== "idle" && status !== "done")
        return refuse(
          status === "working"
            ? "Claude is working (a turn or a background task); it can switch once it is idle"
            : status === "blocked"
              ? "Claude is waiting for an answer in the terminal"
              : "Herdr cannot tell whether Claude is idle",
        );
      const sessionId = sessionOf(agent);
      if (!sessionId) return refuse("Herdr has no session id for this pane");
      if (expectedSessionId && expectedSessionId !== sessionId)
        return refuse("The pane now runs another session");
      if (await liveOwnerElsewhere(paneId, sessionId))
        return refuse(
          "Conversation mode already owns this session in another pane",
        );
      let screen: string;
      try {
        screen = await deps.herdr.readDetection(paneId);
      } catch (error) {
        return refuse(
          `Could not read Claude's prompt box: ${errorText(error)}`,
        );
      }
      const prompt = claudePromptState(screen);
      if (prompt.box === "missing")
        return refuse("Claude's prompt box is not on screen");
      if (prompt.box === "draft")
        return refuse(
          "Something is typed in Claude's prompt box; send or clear it first",
        );
      if (prompt.vim === "normal")
        return refuse(
          "Claude's prompt is in vim normal mode; switch it to insert mode first",
        );
      let info: PaneProcessInfo;
      try {
        info = await deps.herdr.processInfo(paneId);
      } catch (error) {
        return refuse(
          `Herdr did not list the pane's processes: ${errorText(error)}`,
        );
      }
      const claudes = info.foreground_processes.filter(isClaudeProcess);
      if (claudes.length !== 1 || info.shell_pid === undefined)
        return refuse("Cannot tell which process is Claude in this pane");
      const claude = claudes[0]!;
      let elsewhere: string | null;
      try {
        elsewhere = await deps.herdr.writerElsewhere(
          paneId,
          [sessionId],
          [claude.pid],
        );
      } catch (error) {
        return refuse(
          `Could not check for other writers on the session: ${errorText(error)}`,
        );
      }
      if (elsewhere) return refuse(`${elsewhere}; close it there first`);
      const terminalArgs = terminalClaudeArgs(claude);
      const cwd =
        claude.cwd ||
        (typeof agent.foreground_cwd === "string" ? agent.foreground_cwd : "");
      if (!cwd.startsWith("/"))
        return refuse("Herdr did not report Claude's working directory");
      const handing = setLease({
        pane_id: paneId,
        session_id: sessionId,
        cwd,
        phase: "to_conversation",
        terminal_pid: claude.pid,
        ...(terminalArgs.length ? { terminal_args: terminalArgs } : {}),
      });
      try {
        await deps.herdr.prompt(paneId, "/exit");
      } catch (error) {
        deleteLease(paneId);
        return refuse(`Claude did not take /exit: ${errorText(error)}`);
      }
      const exited = await until(async () => {
        if (await deps.herdr.pidAlive(claude.pid)) return false;
        return shellInForeground(await deps.herdr.processInfo(paneId));
      }, exitTimeoutMs);
      if (!exited) {
        // The TUI may still run: it keeps the session. Should it exit
        // after all, claude is resumed in the shell it leaves.
        deleteLease(paneId);
        watchLateExit(paneId, claude.pid, sessionId, terminalArgs);
        return refuse(
          "Claude did not exit in time; the terminal keeps the session",
        );
      }
      // The TUI is gone, and nothing writes until the holder has the pane:
      // the lease stays in to_conversation (no headless process may start)
      // so a holder that never shows up leaves nothing running behind it.
      // Only a holder polling from now on counts: not the one an earlier
      // hand-back just told to resume.
      const typedAt = now();
      let typed: unknown = null;
      try {
        guard();
        await deps.herdr.sendText(paneId, deps.holderCommand(sessionId));
      } catch (error) {
        if (error instanceof HandoverClosed) throw error;
        typed = error;
      }
      const held =
        typed === null &&
        (await until(
          async () => deps.holders.connected(paneId, undefined, typedAt),
          holderTimeoutMs,
        ));
      if (!held || deps.leases.get(paneId) !== handing) {
        // A holder that shows up later is told to resume claude; a shell
        // left bare (the holder could not run) gets claude back at once.
        deleteLease(paneId);
        const resumed = await resumeInShell(
          paneId,
          sessionId,
          terminalArgs,
        ).catch(() => false);
        const why = typed === null ? "" : ` (${errorText(typed)})`;
        return refuse(
          resumed
            ? `The pane holder did not start${why}; Claude was resumed in the terminal`
            : `The pane holder did not start${why}; run claude --resume ${sessionId} there to continue`,
        );
      }
      // Only from here may conversation mode write.
      const lease = setLease({
        pane_id: paneId,
        session_id: sessionId,
        cwd,
        phase: "conversation",
        ...(terminalArgs.length ? { terminal_args: terminalArgs } : {}),
      });
      return {
        ok: true,
        owner: "conversation",
        session_id: sessionId,
        lease,
      };
    });
  }

  /** Waits for Herdr to map the pane to the session again. */
  function confirmMapping(paneId: string, sessionId: string) {
    return until(
      async () => sessionOf(await deps.herdr.agentGet(paneId)) === sessionId,
      confirmTimeoutMs,
    );
  }

  /**
   * Conversation -> terminal: only between turns, with nothing queued; the
   * headless process exits first, then the holder resumes claude.
   */
  function toTerminal(
    paneId: string,
    headless: HeadlessSide | null,
    options: { interrupt?: boolean; confirm?: boolean } = {},
  ): Promise<AgentChatHandoverResult> {
    return exclusive(paneId, async () => {
      const lease = deps.leases.get(paneId);
      if (!lease || lease.phase === "terminal")
        return {
          ok: true,
          owner: "terminal",
          session_id: lease?.session_id ?? "",
        };
      if (lease.phase !== "conversation")
        return refuse("This session is being handed over; try again shortly");
      if (headless?.busy()) {
        if (!options.interrupt)
          return refuse(
            "Claude is in the middle of a turn; wait for it to end or stop it",
          );
        await headless.interrupt();
        await headless.waitForResult(exitTimeoutMs);
        if (headless.busy())
          return refuse(
            "Claude did not stop its turn; the session stays in conversation mode",
          );
      }
      const queued = headless?.queueLength() ?? 0;
      if (queued)
        return refuse(
          `${queued === 1 ? "A message waits" : `${queued} messages wait`} in the queue; send or remove ${queued === 1 ? "it" : "them"} first`,
        );
      const tasks = headless?.backgroundTasks() ?? 0;
      if (tasks)
        return refuse(
          `${tasks === 1 ? "A background task still runs" : `${tasks} background tasks still run`} in conversation mode; it would die with the process`,
        );
      const ids = [
        ...new Set([lease.session_id, ...(lease.headless_session_ids ?? [])]),
      ];
      // The holder resumed claude by itself (Roamgate was away): the
      // terminal has the session already.
      const info = await deps.herdr.processInfo(paneId).catch(() => null);
      const inPane = (info?.foreground_processes ?? [])
        .filter(isClaudeProcess)
        .map((process) => process.pid);
      if (
        inPane.length &&
        !headless?.pid() &&
        !(await deps.herdr.headlessRunning(ids).catch(() => true))
      ) {
        deleteLease(paneId);
        return { ok: true, owner: "terminal", session_id: lease.session_id };
      }
      // Resumed here, claude would be a second writer next to that one.
      let elsewhere: string | null;
      try {
        elsewhere = await deps.herdr.writerElsewhere(paneId, ids, inPane);
      } catch (error) {
        return refuse(
          `Could not check for other writers on the session: ${errorText(error)}`,
        );
      }
      if (elsewhere) return refuse(`${elsewhere}; close it there first`);
      setLease({ ...lease, phase: "to_terminal" });
      if (headless) await headless.stop();
      guard();
      // Whatever stop() says, the host is asked: a process from before a
      // restart, or one an SSH client left behind, has no handle here.
      const stopped = await until(
        async () => !(await deps.herdr.headlessRunning(ids)),
        exitTimeoutMs,
      );
      if (!stopped) {
        setLease({ ...lease, phase: "conversation" });
        return refuse(
          "The conversation process did not stop; the session stays in conversation mode",
        );
      }
      guard();
      await deps.herdr.releaseAgent(paneId).catch(() => undefined);
      const holder = deps.holders.connected(paneId);
      deleteLease(paneId);
      deps.holders.send(paneId, {
        action: "resume",
        session_id: lease.session_id,
        cwd: lease.cwd,
        args: [...(lease.terminal_args ?? []), "--resume", lease.session_id],
      });
      if (!holder)
        return {
          ok: true,
          owner: "terminal",
          session_id: lease.session_id,
          confirmed: false,
          detail: `No holder runs in the pane; run claude --resume ${lease.session_id} there`,
        };
      const confirmed =
        options.confirm === false
          ? undefined
          : await confirmMapping(paneId, lease.session_id);
      return {
        ok: true,
        owner: "terminal",
        session_id: lease.session_id,
        ...(confirmed === undefined ? {} : { confirmed }),
        ...(confirmed === false
          ? { detail: "Herdr has not mapped the pane to the session yet" }
          : {}),
      };
    });
  }

  /** Waits a while for a holder in the pane. */
  function waitForHolder(paneId: string) {
    return until(async () => deps.holders.connected(paneId), holderTimeoutMs);
  }

  return {
    toConversation,
    toTerminal,
    confirmMapping,
    waitForHolder,
    running: (paneId: string) => running.has(paneId),
  };
}

export type Handover = ReturnType<typeof createHandover>;
