import {
  type AgentChatHandoverResult,
  type AgentChatLease,
  type AgentChatOtherWriter,
  otherWriterDoing,
  otherWriterPlace,
} from "../../../shared/agentChat";
import { isRecord } from "../agent/session-utils";
import { conversationDriver, driverForHerdrAgent } from "./drivers";
import { claudeTerminalDriver } from "./drivers/claude-tui";
import type { ConversationDriver, TerminalDriver } from "./drivers/types";
import type {
  ConversationHerdr,
  PaneProcessInfo,
  WriterElsewhere,
} from "./herdr";
import { type HolderRegistry, resumeReply, suspendReply } from "./holder";
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
  /** What is typed into a bare shell to resume the session in its TUI. */
  resumeCommand?: (
    sessionId: string,
    args?: string[],
    terminal?: TerminalDriver,
  ) => string;
  /**
   * The driver of the agent Herdr names in a pane; null when conversation
   * mode cannot drive it. By default every driver's (claude's).
   */
  driverFor?: (herdrAgent: unknown) => ConversationDriver | null;
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
  /** The first wait between two checks; each wait is longer, up to maxPollMs. */
  pollMs?: number;
  maxPollMs?: number;
  /** The same for the late exit watch, which checks less often. */
  latePollMs?: number;
  lateMaxPollMs?: number;
  /**
   * The background commands and monitors the pane's session still runs,
   * from its transcript: asked when Claude's footer cannot say (a pane too
   * narrow for it). Throws or 0 when it does not know.
   */
  terminalTasks?: (paneId: string, herdrAgent?: string) => Promise<number>;
  /** Someone should know (the log): /exit asked first, and was answered Stay. */
  onExitDialog?: (paneId: string, work: string | null) => void;
  /**
   * The pane agent's exact status ("idle", "working", "blocked") when
   * something better than Herdr's screen detection knows it (a Claude mod
   * running inside it); null otherwise, and Herdr's is used.
   */
  exactStatus?: (paneId: string) => string | null;
  /**
   * Whether the pane session's transcript has `command` as an ordinary
   * user message since `sinceMs`: the TUI took the exit as text (typed
   * into a prompt box something else had just reached, or mid-turn).
   */
  exitSwallowed?: (
    paneId: string,
    command: string,
    sinceMs: number,
  ) => Promise<boolean>;
  /**
   * How long the TUI must stay idle at an empty prompt, checked again,
   * before the exit is typed: a paste or a turn starting at that moment
   * shows by then.
   */
  settleMs?: number;
};

/**
 * Whether a transcript tail (JSONL) has `command` sent as an ordinary user
 * message at or after `sinceMs`, alone or after something else in the
 * prompt box ("[Image #2]/exit"). A command the TUI ran is recorded as a
 * `<command-name>` message, which is not one.
 */
export function exitSentAsMessage(
  tail: string,
  command: string,
  sinceMs: number,
): boolean {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "user") continue;
    const at =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    // Older than the exit: nothing before it is either (a second's slack
    // for the two clocks).
    if (Number.isFinite(at) && at < sinceMs - 1000) return false;
    if (record.isMeta === true) continue;
    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                isRecord(part) &&
                part.type === "text" &&
                typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join("")
          : "";
    if (text.includes("<command-name>")) continue;
    if (text.trim().endsWith(command)) return true;
  }
  return false;
}

class HandoverClosed extends Error {}

function refuse(reason: string): AgentChatHandoverResult {
  return { ok: false, reason };
}

/** Refused for now: the switch waits for the agent's background work to end. */
function waitForBackground(
  terminal: TerminalDriver,
  work: string | null,
): AgentChatHandoverResult {
  return {
    ok: false,
    reason: `${terminal.displayName} still runs background work${work ? ` (${work})` : ""} that exiting would stop; it switches once that work is done`,
    waiting: "background_tasks",
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refused while another writer has the session. One in another pane is
 * described (where, whether it is idle), so the user can go there or have
 * it quit; `quitRefusal` says why it did not quit when they asked.
 */
function refuseWriter(
  found: WriterElsewhere,
  quitRefusal?: string,
): AgentChatHandoverResult {
  if (!found.pane) return refuse(`${found.text}; close it there first`);
  const writer: AgentChatOtherWriter = quitRefusal
    ? { ...found.pane, quit_refusal: quitRefusal }
    : found.pane;
  const place = otherWriterPlace(writer);
  const named = place.startsWith("pane ")
    ? place
    : `${place} (pane ${writer.pane_id})`;
  const name = writer.agent_name;
  return {
    ok: false,
    reason: `This session is also open in ${named}${otherWriterDoing(writer)}. Only one ${name} can write a session at a time, so this waits until that one is closed${quitRefusal ? `. It did not quit: ${quitRefusal}` : ""}`,
    writer,
  };
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

function shellInForeground(
  info: PaneProcessInfo,
  terminal: TerminalDriver,
): boolean {
  return (
    info.shell_pid !== undefined &&
    info.foreground_process_group_id === info.shell_pid &&
    !info.foreground_processes.some(terminal.isAgentProcess)
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
  const maxPollMs = deps.maxPollMs ?? 2000;
  const latePollMs = deps.latePollMs ?? 2000;
  const lateMaxPollMs = deps.lateMaxPollMs ?? 15_000;
  const lateExitMs = deps.lateExitMs ?? 120_000;
  const resumeCommand =
    deps.resumeCommand ??
    ((sessionId: string, _args?: string[], terminal = claudeTerminalDriver) =>
      ` ${terminal.resumeArgv(sessionId, []).join(" ")}\r`);
  const driverFor = deps.driverFor ?? driverForHerdrAgent;
  /** A lease's driver: the agent it was taken from (absent: claude). */
  const leaseTerminal = (lease: AgentChatLease) =>
    conversationDriver(lease.agent).terminal;
  const running = new Set<string>();
  const settleMs = deps.settleMs ?? 400;
  /**
   * Panes whose TUI was sent /exit and missed the deadline: it may still
   * exit, and is watched. No second /exit goes to it meanwhile, unless the
   * first one turns out swallowed (taken as a message) or the user
   * cancels: then the watch ends and the pane may be asked again.
   */
  type ExitWatch = {
    command: string;
    sentAt: number;
    /** Ended: the watch resumes nothing, and stops at its next check. */
    over: boolean;
  };
  const exiting = new Map<string, ExitWatch>();
  /** Ends a pane's exit watch; true when there was one. */
  function endExitWatch(paneId: string): boolean {
    const watch = exiting.get(paneId);
    if (!watch) return false;
    watch.over = true;
    exiting.delete(paneId);
    return true;
  }
  /**
   * Whether the exit typed into the pane's TUI was taken as a message: its
   * transcript has it as one, or the TUI started a turn (an exit never
   * does).
   */
  async function exitWasSwallowed(
    paneId: string,
    command: string,
    sentAt: number,
  ): Promise<boolean> {
    if (deps.exactStatus?.(paneId) === "working") return true;
    if (!deps.exitSwallowed) return false;
    return deps.exitSwallowed(paneId, command, sentAt).catch(() => false);
  }
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

  /**
   * Checks until true or the deadline, waiting longer each time (a check
   * may be a command on the pane's host, over SSH).
   */
  async function until(
    check: () => Promise<boolean>,
    timeoutMs: number,
    first = pollMs,
    most = maxPollMs,
  ): Promise<boolean> {
    const deadline = now() + timeoutMs;
    let wait = first;
    for (;;) {
      guard();
      if (await check().catch(() => false)) return true;
      if (now() >= deadline) return false;
      await sleep(Math.min(wait, Math.max(0, deadline - now())));
      wait = Math.min(most, Math.ceil(wait * 1.5));
    }
  }

  /**
   * /exit found background work and asks what to do: Stay is answered
   * (never "Exit and stop tasks", never "Move to background"), and the
   * prompt is waited back. True when the question was there.
   */
  async function answerExitDialog(
    paneId: string,
    terminal: TerminalDriver,
  ): Promise<boolean> {
    const screen = await deps.herdr.readDetection(paneId).catch(() => "");
    const dialog = terminal.exitDialog(screen);
    if (!dialog) return false;
    await deps.herdr.sendKeys(paneId, dialog.stayKey).catch(() => undefined);
    let work: string | null = null;
    await until(async () => {
      const after = await deps.herdr.readDetection(paneId);
      if (terminal.exitDialog(after)) return false;
      work = terminal.backgroundWork(after);
      return true;
    }, 5000);
    deps.onExitDialog?.(paneId, work);
    return true;
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
    terminal: TerminalDriver,
    sessionId: string,
    args?: string[],
  ): Promise<boolean> {
    if (deps.closed?.() || deps.leases.get(paneId)) return false;
    const info = await deps.herdr.processInfo(paneId).catch(() => null);
    if (!info || !shellInForeground(info, terminal)) return false;
    await deps.herdr.sendText(paneId, resumeCommand(sessionId, args, terminal));
    return true;
  }

  /**
   * A TUI that missed the /exit deadline (slow SessionEnd hooks, an /exit
   * queued behind a turn) may still exit: it is watched a while longer and,
   * if it does, claude is resumed in the shell it leaves.
   */
  function watchLateExit(
    paneId: string,
    terminal: TerminalDriver,
    pid: number,
    sessionId: string,
    args: string[],
    resume = true,
    sentAt = now(),
  ) {
    if (exiting.has(paneId)) return;
    const watch: ExitWatch = {
      command: terminal.exitCommand,
      sentAt,
      over: false,
    };
    exiting.set(paneId, watch);
    // Claude asking about background work does not exit: it is answered
    // Stay, and the watch ends. So does an exit taken as a message.
    let stayed = false;
    void until(
      async () => {
        if (watch.over) return true;
        if (await deps.herdr.pidAlive(pid)) {
          stayed = await answerExitDialog(paneId, terminal);
          if (stayed) return true;
          if (await exitWasSwallowed(paneId, watch.command, watch.sentAt)) {
            watch.over = true;
            return true;
          }
          return false;
        }
        return shellInForeground(
          await deps.herdr.processInfo(paneId),
          terminal,
        );
      },
      lateExitMs,
      latePollMs,
      lateMaxPollMs,
    )
      .then((exited) =>
        resume && exited && !stayed && !watch.over && !running.has(paneId)
          ? resumeInShell(paneId, terminal, sessionId, args)
          : false,
      )
      .catch(() => false)
      .finally(() => {
        // Not another watch started since this one was ended.
        if (exiting.get(paneId) === watch) exiting.delete(paneId);
      });
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

  type ExitedAgent = {
    ok: true;
    sessionId: string;
    terminal: TerminalDriver;
    terminalArgs: string[];
    cwd: string;
    agentField: { agent?: TerminalDriver["agent"] };
    tui: PaneProcessInfo["foreground_processes"][number];
  };

  /**
   * Checks the pane's idle TUI may exit (nothing typed, no background
   * work, no other writer), sends it /exit and waits for its shell. The
   * marks run once the TUI is about to be asked (`exiting`) and when it
   * did not exit after all (`failed`).
   *
   * `quitWriter` names the other pane whose idle TUI the user chose to
   * quit, should it be the writer found: it gets /exit the same way, its
   * pane and shell stay, and this pane is checked again from the start.
   * `quitting` is that other pane's own exit: the writer it is quit for
   * is not asked about, and nothing is resumed there if it exits late.
   */
  /** Why the pane's agent cannot be asked to exit now, if so. */
  function notIdle(
    paneId: string,
    agent: Record<string, unknown>,
    name: string,
  ): AgentChatHandoverResult | null {
    // A Claude mod knows exactly; Herdr's screen detection may lag.
    const status = deps.exactStatus?.(paneId) ?? agent.agent_status;
    if (status === "idle" || status === "done") return null;
    return refuse(
      status === "working"
        ? `${name} is working (a turn or a background task); it can switch once it is idle`
        : status === "blocked"
          ? `${name} is waiting for an answer in the terminal`
          : `Herdr cannot tell whether ${name} is idle`,
    );
  }

  /**
   * The pane's TUI looked at again just before the exit is typed: still
   * idle, its prompt box still empty, no background work. Null when so,
   * else the refusal.
   */
  async function idleAtEmptyPrompt(
    paneId: string,
    terminal: TerminalDriver,
  ): Promise<AgentChatHandoverResult | null> {
    const name = terminal.displayName;
    let agent: Record<string, unknown> | null;
    try {
      agent = await deps.herdr.agentGet(paneId);
    } catch (error) {
      return refuse(
        `Herdr did not say what runs in the pane: ${errorText(error)}`,
      );
    }
    if (!agent) return refuse(`${name} is not running in this pane`);
    const busy = notIdle(paneId, agent, name);
    if (busy) return busy;
    let screen: string;
    try {
      screen = await deps.herdr.readDetection(paneId);
    } catch (error) {
      return refuse(`Could not read ${name}'s prompt box: ${errorText(error)}`);
    }
    const ready = terminal.readiness(screen);
    if (ready.background) return waitForBackground(terminal, ready.background);
    return ready.refusal ? refuse(ready.refusal) : null;
  }

  async function exitAgent(
    paneId: string,
    expectedSessionId: string | undefined,
    marks: {
      exiting?: (context: Omit<ExitedAgent, "ok">) => void;
      failed?: () => void;
    } = {},
    options: { quitWriter?: string; quitting?: boolean } = {},
  ): Promise<ExitedAgent | AgentChatHandoverResult> {
    // /exit went already and Claude may still be exiting: never twice,
    // unless it was taken as a message (then nothing is exiting).
    const watch = exiting.get(paneId);
    if (watch) {
      if (!(await exitWasSwallowed(paneId, watch.command, watch.sentAt)))
        return refuse(
          "Claude was already asked to exit and may still be exiting; wait for it, or cancel the switch to ask again",
        );
      endExitWatch(paneId);
    }
    let agent: Record<string, unknown> | null;
    try {
      agent = await deps.herdr.agentGet(paneId);
    } catch (error) {
      return refuse(
        `Herdr did not say what runs in the pane: ${errorText(error)}`,
      );
    }
    const driver = agent ? driverFor(agent.agent) : null;
    if (!agent || !driver) return refuse("Claude is not running in this pane");
    const terminal = driver.terminal;
    const name = terminal.displayName;
    const busy = notIdle(paneId, agent, name);
    if (busy) return busy;
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
      return refuse(`Could not read ${name}'s prompt box: ${errorText(error)}`);
    }
    // Exiting would stop it (or ask first): not idle yet.
    const ready = terminal.readiness(screen);
    if (ready.background) return waitForBackground(terminal, ready.background);
    // A narrow pane cuts the footer short: the transcript says instead.
    if (!ready.backgroundKnown && deps.terminalTasks) {
      const tasks = await deps
        .terminalTasks(paneId, terminal.herdrAgent)
        .catch(() => 0);
      if (tasks > 0)
        return waitForBackground(
          terminal,
          tasks === 1 ? "1 background command" : `${tasks} background commands`,
        );
    }
    if (ready.refusal) return refuse(ready.refusal);
    let info: PaneProcessInfo;
    try {
      info = await deps.herdr.processInfo(paneId);
    } catch (error) {
      return refuse(
        `Herdr did not list the pane's processes: ${errorText(error)}`,
      );
    }
    const tuis = info.foreground_processes.filter(terminal.isAgentProcess);
    if (tuis.length !== 1 || info.shell_pid === undefined)
      return refuse(`Cannot tell which process is ${name} in this pane`);
    const tui = tuis[0]!;
    if (!options.quitting) {
      const writers = () =>
        deps.herdr.writerElsewhere(paneId, [sessionId], [tui.pid]);
      let elsewhere: WriterElsewhere | null;
      try {
        elsewhere = await writers();
      } catch (error) {
        return refuse(
          `Could not check for other writers on the session: ${errorText(error)}`,
        );
      }
      if (elsewhere) {
        const other = elsewhere.pane;
        // Only the one the user chose, and only while idle.
        if (
          !other ||
          other.pane_id !== options.quitWriter ||
          other.status !== "idle"
        )
          return refuseWriter(elsewhere);
        const why = await quitOtherWriter(other.pane_id, sessionId, writers);
        if (why !== null) {
          const still = await writers().catch(() => elsewhere);
          if (still) return refuseWriter(still, why);
        }
        // Checked afresh, from the start: this pane's TUI, other writers.
        return exitAgent(paneId, sessionId, marks);
      }
    }
    const terminalArgs = terminal.keptFlags(tui);
    const cwd =
      tui.cwd ||
      (typeof agent.foreground_cwd === "string" ? agent.foreground_cwd : "");
    if (!options.quitting && !cwd.startsWith("/"))
      return refuse(`Herdr did not report ${name}'s working directory`);
    // Claude's leases name no agent (as before drivers): absent is claude.
    const agentField =
      terminal.agent === "claude" ? {} : { agent: terminal.agent };
    const context = { sessionId, terminal, terminalArgs, cwd, agentField, tui };
    // The exit goes only to a TUI idle at an empty prompt: looked at again
    // a moment later, so a paste or a turn starting just now shows (typed
    // after it, the exit would be sent as a message).
    if (settleMs > 0) {
      await sleep(settleMs);
      guard();
      const changed = await idleAtEmptyPrompt(paneId, terminal);
      if (changed) return changed;
    }
    marks.exiting?.(context);
    const sentAt = now();
    try {
      await deps.herdr.prompt(paneId, terminal.exitCommand);
    } catch (error) {
      marks.failed?.();
      return refuse(
        `${name} did not take ${terminal.exitCommand}: ${errorText(error)}`,
      );
    }
    // Background work the screen did not show: Claude asks before
    // exiting. It is answered Stay, and the switch waits.
    let stayed = false;
    let swallowed = false;
    const exited = await until(async () => {
      if (await deps.herdr.pidAlive(tui.pid)) {
        stayed = await answerExitDialog(paneId, terminal);
        if (stayed) return true;
        swallowed = await exitWasSwallowed(
          paneId,
          terminal.exitCommand,
          sentAt,
        );
        return swallowed;
      }
      return shellInForeground(await deps.herdr.processInfo(paneId), terminal);
    }, exitTimeoutMs);
    if (swallowed) {
      // Nothing exits: the switch may be asked again once it is idle.
      marks.failed?.();
      return refuse(
        `${name} took ${terminal.exitCommand} as a message instead of exiting (something reached its prompt box at the same moment), so the terminal keeps the session; switch again once it is idle`,
      );
    }
    if (stayed) {
      marks.failed?.();
      return waitForBackground(
        terminal,
        terminal.backgroundWork(
          await deps.herdr.readDetection(paneId).catch(() => ""),
        ),
      );
    }
    if (!exited) {
      // The TUI may still run: it keeps the session. Should it exit
      // after all, claude is resumed in the shell it leaves (not in a
      // pane it was quit in for another).
      marks.failed?.();
      watchLateExit(
        paneId,
        terminal,
        tui.pid,
        sessionId,
        terminalArgs,
        !options.quitting,
        sentAt,
      );
      return refuse(
        `${name} did not exit in time; the terminal keeps the session`,
      );
    }
    return { ok: true as const, ...context };
  }

  /**
   * The user chose to quit the idle TUI another pane runs the session in:
   * it is checked and sent /exit as a switch's own would be (never while
   * it works, asks or has something typed), and the pane and its shell
   * stay. Waits until the writer check no longer finds it there. Null once
   * it quit, else why not.
   */
  async function quitOtherWriter(
    otherPane: string,
    sessionId: string,
    writers: () => Promise<WriterElsewhere | null>,
  ): Promise<string | null> {
    if (running.has(otherPane))
      return "a switch of that pane is already running";
    running.add(otherPane);
    try {
      const quit = await exitAgent(
        otherPane,
        sessionId,
        {},
        { quitting: true },
      );
      if (!quit.ok)
        return quit.waiting === "background_tasks"
          ? "it still runs background work that quitting would stop"
          : quit.reason;
      // Herdr may take a moment to see the agent gone.
      await until(
        async () => (await writers())?.pane?.pane_id !== otherPane,
        exitTimeoutMs,
      );
      return null;
    } finally {
      running.delete(otherPane);
    }
  }

  /**
   * Terminal -> conversation: stop the idle TUI, then hold the pane.
   * `quitWriter`: the other pane whose idle TUI runs the session too, which
   * the user chose to quit first.
   */
  function toConversation(
    paneId: string,
    expectedSessionId?: string,
    options: { quitWriter?: string } = {},
  ): Promise<AgentChatHandoverResult & { lease?: AgentChatLease }> {
    return exclusive(paneId, async () => {
      let current = deps.leases.get(paneId);
      if (current?.phase === "conversation") {
        // The holder may have resumed claude by itself while Roamgate was
        // away: then the terminal has the session, and the lease is stale.
        const info = await deps.herdr.processInfo(paneId).catch(() => null);
        const resumed =
          !!info?.foreground_processes.some(
            leaseTerminal(current).isAgentProcess,
          ) &&
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
      let handing: AgentChatLease | null = null;
      const exited = await exitAgent(
        paneId,
        expectedSessionId,
        {
          exiting: (context) => {
            handing = setLease({
              pane_id: paneId,
              session_id: context.sessionId,
              cwd: context.cwd,
              phase: "to_conversation",
              ...context.agentField,
              terminal_pid: context.tui.pid,
              ...(context.terminalArgs.length
                ? { terminal_args: context.terminalArgs }
                : {}),
            });
          },
          failed: () => deleteLease(paneId),
        },
        { quitWriter: options.quitWriter },
      );
      if (!exited.ok || !("terminal" in exited)) return exited;
      const { sessionId, terminal, terminalArgs, cwd, agentField } = exited;
      const name = terminal.displayName;
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
          terminal,
          sessionId,
          terminalArgs,
        ).catch(() => false);
        const why = typed === null ? "" : ` (${errorText(typed)})`;
        return refuse(
          resumed
            ? `The pane holder did not start${why}; ${name} was resumed in the terminal`
            : `The pane holder did not start${why}; run ${terminal.resumeArgv(sessionId, []).join(" ")} there to continue`,
        );
      }
      // Only from here may conversation mode write.
      const lease = setLease({
        pane_id: paneId,
        session_id: sessionId,
        cwd,
        phase: "conversation",
        ...agentField,
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
   * headless process exits first, then the holder resumes claude. With
   * `suspend` (the chat's Ctrl+Z) the holder stops as a shell job instead:
   * the shell's prompt is back, no claude runs, and `fg` there brings the
   * conversation back (fromSuspended).
   */
  function toTerminal(
    paneId: string,
    headless: HeadlessSide | null,
    options: {
      interrupt?: boolean;
      confirm?: boolean;
      suspend?: { title?: string };
    } = {},
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
      const terminal = leaseTerminal(lease);
      // Only a holder that runs as a job of an interactive shell can stop
      // as one (an older holder, or a shell without job control, cannot).
      if (options.suspend && !suspendable(paneId))
        return refuse(
          "The pane's holder cannot stop as a shell job (it is from an older Roamgate, or its shell has no job control); open it in the terminal instead",
        );
      if (headless?.busy()) {
        if (!options.interrupt)
          return refuse(
            `${terminal.displayName} is in the middle of a turn; wait for it to end or stop it`,
          );
        await headless.interrupt();
        await headless.waitForResult(exitTimeoutMs);
        if (headless.busy())
          return refuse(
            `${terminal.displayName} did not stop its turn; the session stays in conversation mode`,
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
        .filter(terminal.isAgentProcess)
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
      let elsewhere: WriterElsewhere | null;
      try {
        elsewhere = await deps.herdr.writerElsewhere(paneId, ids, inPane);
      } catch (error) {
        return refuse(
          `Could not check for other writers on the session: ${errorText(error)}`,
        );
      }
      if (elsewhere) return refuse(`${elsewhere.text}; close it there first`);
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
      await deps.herdr
        .releaseAgent(paneId, terminal.herdrAgent)
        .catch(() => undefined);
      const holder = deps.holders.connected(paneId);
      deleteLease(paneId);
      if (options.suspend && holder) {
        deps.holders.send(paneId, suspendReply(lease, options.suspend.title));
        return {
          ok: true,
          owner: "terminal",
          session_id: lease.session_id,
          suspended: true,
        };
      }
      // A holder gone meanwhile resumes claude when it polls again.
      deps.holders.send(paneId, resumeReply(lease));
      if (!holder)
        return {
          ok: true,
          owner: "terminal",
          session_id: lease.session_id,
          confirmed: false,
          detail: `No holder runs in the pane; run ${terminal.resumeArgv(lease.session_id, []).join(" ")} there`,
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

  /** Whether the pane's holder polls and can stop as a shell job. */
  function suspendable(paneId: string): boolean {
    return deps.holders.connected(paneId) && deps.holders.jobControl(paneId);
  }

  /**
   * A holder stopped as a shell job (the chat's Ctrl+Z) was brought back
   * with `fg`: it holds the pane again, and conversation mode takes the
   * session once nothing else writes it (a claude resumed meanwhile, in
   * this pane's shell or elsewhere, keeps it).
   */
  function fromSuspended(
    paneId: string,
    spec: Pick<
      AgentChatLease,
      "session_id" | "cwd" | "agent" | "terminal_args"
    >,
  ): Promise<AgentChatHandoverResult & { lease?: AgentChatLease }> {
    return exclusive(paneId, async () => {
      const current = deps.leases.get(paneId);
      if (current)
        return current.phase === "conversation" &&
          current.session_id === spec.session_id
          ? { ok: true, owner: "conversation", session_id: spec.session_id }
          : refuse("Conversation mode holds another session in this pane");
      if (await liveOwnerElsewhere(paneId, spec.session_id))
        return refuse(
          "Conversation mode already owns this session in another pane",
        );
      let elsewhere: WriterElsewhere | null;
      try {
        elsewhere = await deps.herdr.writerElsewhere(
          paneId,
          [spec.session_id],
          [],
        );
      } catch (error) {
        return refuse(
          `Could not check for other writers on the session: ${errorText(error)}`,
        );
      }
      if (elsewhere) return refuse(`${elsewhere.text}; close it there first`);
      if (await deps.herdr.headlessRunning([spec.session_id]).catch(() => true))
        return refuse("A conversation process still runs on the session");
      const lease = setLease({
        pane_id: paneId,
        session_id: spec.session_id,
        cwd: spec.cwd,
        phase: "conversation",
        ...(spec.agent ? { agent: spec.agent } : {}),
        ...(spec.terminal_args?.length
          ? { terminal_args: spec.terminal_args }
          : {}),
      });
      return {
        ok: true,
        owner: "conversation",
        session_id: spec.session_id,
        lease,
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
    fromSuspended,
    confirmMapping,
    waitForHolder,
    running: (paneId: string) => running.has(paneId),
    /**
     * The user cancelled the switch: a pane asked to exit that has not
     * is no longer waited for (nothing is resumed by the watch, and the
     * next switch asks again). True when one was.
     */
    cancelExit: (paneId: string) => endExitWatch(paneId),
  };
}

export type Handover = ReturnType<typeof createHandover>;
