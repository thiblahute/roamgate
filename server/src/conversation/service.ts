import { randomUUID } from "node:crypto";
import type {
  AgentChatApiKeyChoice,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatHandoverResult,
  AgentChatInterrupted,
  AgentChatModelNotice,
  AgentChatModelResult,
  AgentChatModels,
  AgentChatQueued,
  AgentChatState,
  AgentChatStatus,
} from "../../../shared/agentChat";
import type { AgentPromptAnswer } from "../../../shared/review";
import { type AutoStartDeps, createAutoStarter } from "./auto-start";
import { conversationDriver } from "./drivers";
import { createHandover, type HandoverDeps } from "./handover";
import type { SpawnHeadless } from "./headless";
import type { ConversationHerdr } from "./herdr";
import { createHolderRegistry } from "./holder";
import { idleStopRefusal } from "./idle-stop";
import type { LeaseStore } from "./lease";
import {
  type AgentCommand,
  describeCommand,
  type LaunchSpec,
  withoutModel,
} from "../profiles/profiles";
import {
  isModelName,
  mergeModels,
  modelRefusalText,
  modelSwitchText,
  parseModelCommand,
} from "../../../shared/agentModels";
import type { StartOptions } from "./drivers/types";
import { createApiKeyQuestions } from "./service-api-key";
import { createSwitches } from "./service-handover";
import { createHolderSide, releasingLeases } from "./service-holders";
import { createIdleStop } from "./service-idle";
import { createRecovery } from "./service-recover";
import { createServiceRewind } from "./service-rewind";
import { createChatShells } from "./service-shells";
import { guardedSpawn, HolderMissing } from "./service-start";
import { createStuckWatch } from "./service-stuck";
import {
  type ConversationImage,
  type ConversationPrompt,
  type ConversationSession,
  type ConversationSessionOptions,
  createConversationSession,
} from "./session";
import { isSpokenStop } from "./session-voice";
import {
  createSuspendedStore,
  foregroundCommand,
  shellName,
  type SuspendedConversation,
} from "./suspended";
import type { ShellRunner } from "./shell";

export { createSlots } from "./service-recover";

export type ConversationServiceOptions<Ws> = {
  connectionId: string;
  herdr: ConversationHerdr;
  leases: LeaseStore;
  /**
   * Starts (or reads) the headless claude. By default the pane's holder
   * runs it; tests give fakes.
   */
  spawn?: SpawnHeadless;
  /** The browser's permission card (review prompts); null denies. */
  ask: (
    paneId: string,
    prompt: ConversationPrompt,
  ) => Promise<AgentPromptAnswer | null>;
  readImage: (path: string) => Promise<ConversationImage>;
  /** Runs a chat's `!` lines on the pane's host; none: they are refused. */
  runShell?: ShellRunner;
  /**
   * The transcript of the pane's Claude session (null: unknown), for what
   * a rewind would restore of the code.
   */
  readTranscript?: (
    paneId: string,
  ) => Promise<string | Record<string, unknown>[] | null>;
  /** Sends one event to one subscribed browser. */
  send: (ws: Ws, envelope: AgentChatEventEnvelope) => void;
  holderCommand: (sessionId: string) => string;
  /** What is typed into a bare shell to resume the session in claude. */
  resumeCommand?: (sessionId: string, args?: string[]) => string;
  /**
   * The command a session's agent starts with (its profile); none: plain
   * claude. Throws when the profile cannot be used (a secret file).
   */
  commandFor?: (sessionId: string) => AgentCommand;
  /**
   * What is typed into the pane to start the agent of a profile that is
   * not plain claude (roamgate-hold fetches it with a one-use token).
   */
  launchCommand?: (paneId: string, spec: LaunchSpec) => string;
  /**
   * /model's list and memory: what the session's profile offers, the
   * model its transcript last answered with, and the choice its next
   * starts use until it answered with it (SessionProfiles). None: the
   * running agent's list only, and a switch lasts as long as its process.
   */
  models?: {
    offered: (
      sessionId: string,
    ) => Promise<{ models: string[]; error?: string }>;
    lastAnswered?: (paneId: string) => Promise<string | null>;
    chosen: (sessionId: string) => string | null;
    choose: (sessionId: string, model: string, resolved: string | null) => void;
  };
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Overrides for tests: timings and the handover's clock. */
  session?: Partial<
    Pick<
      ConversationSessionOptions,
      | "coalesceMs"
      | "permissionTimeoutMs"
      | "questionTimeoutMs"
      | "interruptWaitMs"
      | "stopWaitMs"
      | "rewindWaitMs"
    >
  >;
  handover?: Partial<
    Pick<
      HandoverDeps,
      | "sleep"
      | "now"
      | "exitTimeoutMs"
      | "holderTimeoutMs"
      | "confirmTimeoutMs"
      | "lateExitMs"
      | "pollMs"
      | "terminalTasks"
      | "exitSwallowed"
      | "exactStatus"
      | "settleMs"
    >
  >;
  /** Timings of taking a claude the user just started (tests). */
  autoStart?: Partial<
    Pick<
      AutoStartDeps,
      | "sleep"
      | "now"
      | "firstDelayMs"
      | "retryMs"
      | "startingMs"
      | "busyRetryMs"
      | "busyMs"
    >
  >;
  /** How long a holder's poll is held before it polls again. */
  holdPollMs?: number;
  /**
   * How often the panes conversation mode owns are checked for a holder
   * gone while this runtime ran (killed, or turned into claude): the
   * terminal then has the session again. 0: never.
   */
  holderWatchMs?: number;
  /**
   * How long after start the sessions a runtime before this one owned are
   * read again (their holders run their processes on), and what they had
   * queued is sent.
   */
  carriedQueueDelayMs?: number;
  /** How many conversations are read again at once after a restart. */
  reattachLimit?: number;
  /** How often what was read of a holder's log is saved on its lease. */
  holderSaveMs?: number;
  /** A pane's lease changed (owner, or the session after /clear). */
  onLeaseChanged?: (paneId: string) => void;
  /**
   * Where the conversations stopped as shell jobs (Ctrl+Z) are kept, so a
   * restart still shows them; none keeps them in memory.
   */
  suspendedFile?: string | null;
  /**
   * How often the stopped conversations are checked for a holder gone
   * (the job killed, the pane closed). 0: never.
   */
  suspendedWatchMs?: number;
  /**
   * How long a recover waits, past a holder's poll, for the holder to say
   * its child ended.
   */
  recoverWaitMs?: number;
  /**
   * When a recover restarts Claude through the terminal: how often, and
   * how many times, it tries to take the session over again while Claude
   * cannot hand it over yet.
   */
  recoverRetryMs?: number;
  recoverAttempts?: number;
  /**
   * A turn with nothing from Claude (no output, its transcript unchanged)
   * this long seems stuck; longer while a tool runs (a long build prints
   * nothing until it ends). Checked every `stuckCheckMs` (0: never).
   */
  stuckAfterMs?: number;
  stuckToolAfterMs?: number;
  stuckCheckMs?: number;
  /** How long Stop waits for Claude to answer before the chat says so. */
  stopAnswerMs?: number;
  /** When the pane session's transcript last changed; null: unknown. */
  transcriptStat?: (paneId: string) => Promise<{ mtimeMs: number } | null>;
  /**
   * Idle stop (idle-stop.ts): minutes a session sits idle before its
   * process stops (0: never), read at each check; none: never.
   */
  idleStopMinutes?: () => number | Promise<number>;
  /** How often sessions are checked for idle stop (0: never). */
  idleCheckMs?: number;
  /** No idle stop this long after another session's message. */
  peerQuietMs?: number;
  /** Why a pane's process must stay up now (a voice call...); null: none. */
  keepAwake?: (paneId: string) => string | null;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HERDR_STATE: Record<
  AgentChatStatus,
  "idle" | "working" | "blocked" | null
> = {
  stopped: "idle",
  starting: null,
  idle: "idle",
  working: "working",
  blocked: "blocked",
};

/**
 * Why a profile switch cannot restart the conversation now, for the user:
 * said of the agent, whatever profile (model) runs it.
 */
export function restartRefusal(refusal: string): string {
  switch (refusal) {
    case "it works":
      return "The agent is working; switch once its turn ends, or stop it first";
    case "it asks the user something":
      return "The agent is waiting for your answer; answer it, then switch";
    case "the API key question waits":
      return "The agent waits for the API key question; answer it, then switch";
    case "messages wait in its queue":
      return "Messages wait in the agent's queue; switch once they are sent, or take them back";
    case "background work runs":
      return "The agent runs background tasks that a restart would stop; switch once they end, or stop them";
    case "a shell line runs":
      return "A shell line still runs; switch once it ends";
    default:
      return `The agent cannot switch now: ${refusal}`;
  }
}

/**
 * Conversation mode on one connection: the sessions it owns (each with its
 * headless claude), the handovers to and from the panes' terminals, the
 * panes' holders, and the browsers watching each pane. The parts live in
 * service-*.ts; this wires them and answers the RPCs.
 */
export function createConversationService<Ws>(
  options: ConversationServiceOptions<Ws>,
) {
  const log = options.log ?? (() => {});
  let disposed = false;
  // Once disposed, this service changes no lease: a runtime replacing it
  // (a reconnect) owns them, and a handover still running here stops.
  const closed = () => disposed;
  const { leases, released } = releasingLeases(options.leases, closed);
  const holders = createHolderRegistry({ now: options.handover?.now });
  const handover = createHandover({
    herdr: options.herdr,
    leases,
    holders,
    holderCommand: options.holderCommand,
    ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
    resumeProfile: (sessionId) => resumeProfile(sessionId),
    ...(options.launchCommand ? { launchCommand: options.launchCommand } : {}),
    // Each phase reaches the browsers as it happens: while a takeover runs
    // nothing may be typed into the pane.
    onLease: (paneId) => emitLease(paneId),
    closed,
    onPaneGone: (paneId) => paneClosed(paneId),
    onExitDialog: (paneId, work) =>
      log("claude asked before exiting; answered Stay", {
        pane: paneId,
        ...(work ? { work } : {}),
      }),
    ...options.handover,
  });
  // A claude the user starts in a pane, taken by conversation mode as soon
  // as it can be (Roamgate's claude start setting).
  const autoStarter = createAutoStarter({
    toConversation: (paneId, sessionId) => toConversation(paneId, sessionId),
    owned: (paneId) => !!leases.get(paneId),
    closed: () => disposed,
    log,
    ...options.autoStart,
  });
  // A claude started in a pane this soon after its session was handed back
  // (or a takeover gave up) is the one coming back: it stays.
  const handedBackMs = 60_000;
  const sessions = new Map<string, ConversationSession>();
  const subscribers = new Map<string, Set<Ws>>();
  const holdPollMs = options.holdPollMs ?? 25_000;
  // What the last /model did, said in the chat until the next message.
  const modelNotices = new Map<string, AgentChatModelNotice>();

  // The conversations stopped as shell jobs (Ctrl+Z): their holders wait
  // in the panes' shells, and `fg` there brings them back.
  const suspended = createSuspendedStore({
    connectionId: options.connectionId,
    file: options.suspendedFile ?? null,
  });
  /** One gone (its job killed, its pane closed): the browsers are told. */
  function dropSuspended(paneId: string, why: string) {
    if (!suspended.delete(paneId)) return;
    log("stopped conversation gone", { pane: paneId, why });
    options.onLeaseChanged?.(paneId);
  }
  const suspendedWatchMs = options.suspendedWatchMs ?? 30_000;
  const suspendedWatch =
    suspendedWatchMs > 0
      ? setInterval(() => {
          for (const entry of suspended.all())
            void checkSuspended(entry).catch(() => undefined);
        }, suspendedWatchMs)
      : null;
  if (
    suspendedWatch &&
    typeof suspendedWatch === "object" &&
    "unref" in suspendedWatch
  )
    suspendedWatch.unref();
  async function checkSuspended(entry: SuspendedConversation) {
    if (disposed) return;
    if ((await options.herdr.paneExists(entry.pane_id)) === false)
      return dropSuspended(entry.pane_id, "pane closed");
    if (
      entry.holder_pid &&
      !(await options.herdr.pidAlive(entry.holder_pid)) &&
      suspended.get(entry.pane_id) === entry
    )
      dropSuspended(entry.pane_id, "holder gone");
  }

  const apiKeys = createApiKeyQuestions({ emit, log });
  const { ask: askApiKey, settle: settleApiKey } = apiKeys;
  const holderSide = createHolderSide({
    leases,
    released,
    holders,
    herdr: options.herdr,
    holdPollMs,
    holderSaveMs: options.holderSaveMs ?? 1000,
    ownSpawn: !!options.spawn,
    closed,
    log,
    driverOf,
    resumeState: (paneId) => sessions.get(paneId)?.resumeState(),
    settleApiKey: (paneId) => settleApiKey(paneId, null),
    unread: (paneId) => recovery.unread(paneId),
    reattach: (paneId) => recovery.reattach(paneId),
    toTerminal: (paneId, handoverOptions) =>
      toTerminal(paneId, handoverOptions),
    fromSuspended: (paneId, spec, attach) =>
      fromSuspended(paneId, spec, attach),
    confirmMapping: (paneId, sessionId) =>
      handover.confirmMapping(paneId, sessionId),
    resumeProfile: (sessionId) => resumeProfile(sessionId),
    profileOf: (sessionId) => profileOf(sessionId),
  });
  const { dropChannel } = holderSide;
  const stuck = createStuckWatch({
    sessions,
    owned: (paneId) => leases.get(paneId)?.phase === "conversation",
    closed,
    emit,
    log,
    ...(options.transcriptStat
      ? { transcriptStat: options.transcriptStat }
      : {}),
    stuckAfterMs: options.stuckAfterMs ?? 10 * 60_000,
    stuckToolAfterMs: options.stuckToolAfterMs ?? 45 * 60_000,
    stuckCheckMs: options.stuckCheckMs ?? 60_000,
    stopAnswerMs: options.stopAnswerMs ?? 10_000,
  });
  const { clear: clearStuck, interrupt } = stuck;
  const shells = createChatShells({
    ...(options.runShell ? { runShell: options.runShell } : {}),
    cwdOf: (paneId) => {
      sessionFor(paneId);
      return leases.get(paneId)!.cwd;
    },
    emit,
    log,
  });
  const idle = createIdleStop({
    sessions,
    leases,
    ...(options.idleStopMinutes
      ? { idleStopMinutes: options.idleStopMinutes }
      : {}),
    ...(options.idleCheckMs !== undefined
      ? { idleCheckMs: options.idleCheckMs }
      : {}),
    ...(options.peerQuietMs !== undefined
      ? { peerQuietMs: options.peerQuietMs }
      : {}),
    ...(options.keepAwake ? { keepAwake: options.keepAwake } : {}),
    handingOver: (paneId) => handover.running(paneId),
    shellRunning: shells.running,
    apiKeyQuestion: apiKeys.has,
    closed,
    emit,
    log,
  });
  const { check: checkIdle, setAsleep } = idle;

  // A handover cut short (a Roamgate restart, or the runtime replaced).
  // Handing back resumes conversation mode (the holder still waits, and
  // still runs its process); handing over had started nothing headless,
  // so the terminal owns it.
  for (const lease of leases.all()) {
    if (lease.phase === "to_terminal")
      leases.set({ ...lease, phase: "conversation" });
    else if (lease.phase === "to_conversation") leases.delete(lease.pane_id);
  }
  const recovery = createRecovery({
    leases,
    sessions,
    holders,
    herdr: options.herdr,
    handingOver: (paneId) => handover.running(paneId),
    holderSide,
    sessionFor: (paneId) => sessionFor(paneId),
    emit,
    emitLease: (paneId) => emitLease(paneId),
    markTurn: (paneId, mark) => markTurn(paneId, mark),
    clearStuck,
    toConversation: (paneId) => toConversation(paneId),
    closed,
    log,
    holdPollMs,
    holderWatchMs: options.holderWatchMs ?? 30_000,
    recoverWaitMs: options.recoverWaitMs ?? 15_000,
    recoverRetryMs: options.recoverRetryMs ?? 5000,
    recoverAttempts: options.recoverAttempts ?? 12,
    carriedQueueDelayMs: options.carriedQueueDelayMs ?? 3000,
    reattachLimit: options.reattachLimit ?? 8,
    resumeProfile: (sessionId) => resumeProfile(sessionId),
  });
  const { setLost, clearLost, recoverLater, recover, startAgain } = recovery;

  const spawnHeadless = options.spawn ?? holderSide.holderSpawn;
  const startDeps = {
    leases,
    holders,
    herdr: options.herdr,
    waitForHolder: (paneId: string) => handover.waitForHolder(paneId),
    channel: holderSide.channel,
    spawnHeadless,
    askApiKey,
    setLost,
    clearLost,
    recoverLater,
    emitLease: (paneId: string) => emitLease(paneId),
    closed,
    log,
  };
  const { toConversation, toTerminal, fromSuspended } = createSwitches({
    handover,
    leases,
    sessions,
    holders,
    channel: holderSide.channel,
    sessionFor: (paneId) => sessionFor(paneId),
    suspended,
    emitLease: (paneId) => emitLease(paneId),
    carryParked: recovery.carryParked,
    report: (paneId, status) => report(paneId, status),
    warm: (paneId) => warm(paneId),
    settleApiKey,
    recoverLater,
    closed,
    log,
  });
  const rewinds = createServiceRewind({
    leases,
    sessions,
    sessionFor: (paneId) => sessionFor(paneId),
    driverOf,
    ...(options.readTranscript
      ? { readTranscript: options.readTranscript }
      : {}),
    clearInterrupted: (paneId) => clearInterrupted(paneId),
    closed,
  });

  function emit(paneId: string, event: AgentChatEvent) {
    const watchers = subscribers.get(paneId);
    if (!watchers?.size) return;
    const envelope = {
      event: `agent_chat.${event.type}`,
      data: {
        ...event,
        pane_id: paneId,
        session_id: leases.get(paneId)?.session_id ?? null,
      },
    } as AgentChatEventEnvelope;
    for (const ws of watchers) options.send(ws, envelope);
  }

  function emitLease(paneId: string) {
    options.onLeaseChanged?.(paneId);
    const lease = leases.get(paneId);
    // The terminal has the session again: nothing headless is kept for it.
    const stale = sessions.get(paneId);
    if (!lease && stale) {
      sessions.delete(paneId);
      stale.dispose();
    }
    if (!lease) {
      dropChannel(paneId);
      recovery.forgetLost(paneId);
      modelNotices.delete(paneId);
    }
    emit(paneId, {
      type: "lease",
      owner: lease?.owner ?? "terminal",
      phase: lease?.phase ?? "terminal",
      session_id: lease?.session_id ?? null,
    });
  }

  /**
   * Records whether a turn runs on the pane's lease (a restart finds it),
   * or that one was cut short: the chat shows that until the next turn.
   */
  function markTurn(
    paneId: string,
    mark: "running" | "ended" | AgentChatInterrupted["reason"],
  ) {
    if (disposed) return;
    const current = leases.get(paneId);
    if (!current || current.phase !== "conversation") return;
    if (mark === "ended" && !current.turn_started_at) return;
    if (mark === "running" && current.turn_started_at && !current.interrupted)
      return;
    if (mark === "process_exited" && !current.turn_started_at) return;
    const next = { ...current };
    delete next.turn_started_at;
    delete next.interrupted;
    if (mark === "running") next.turn_started_at = new Date().toISOString();
    else if (mark !== "ended")
      next.interrupted = { at: new Date().toISOString(), reason: mark };
    leases.set(next);
    if (next.interrupted || current.interrupted)
      emit(paneId, {
        type: "interrupted",
        interrupted: next.interrupted ?? null,
      });
  }

  /**
   * The session's profile, for a start: its program and environment.
   * Plain claude (or no resolver) adds nothing, as before profiles. A
   * profile that cannot be read (a missing secret file) refuses the start.
   */
  function profileOf(sessionId: string): Pick<StartOptions, "profile"> {
    const command = options.commandFor?.(sessionId);
    if (!command || command.plain) return {};
    log("the conversation process starts with a profile", {
      session: sessionId,
      ...describeCommand(command),
    });
    return {
      profile: {
        program: command.program,
        env: command.env,
        unset: command.unset,
      },
    };
  }

  /**
   * The profile a session resumes with in the terminal. One that cannot
   * be used (a secret file gone) resumes plain claude: the session never
   * stays without its TUI.
   */
  function resumeProfile(sessionId: string): AgentCommand | undefined {
    try {
      return options.commandFor?.(sessionId);
    } catch (error) {
      log("the session's profile cannot be used; claude resumes plain", {
        session: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Why the pane's process cannot be ended for a restart (another profile
   * or session) now, as idle stop would end it; null: it can. A process
   * that is not running (stopped for being idle, or gone) has no turn to
   * cut: its "stopped" is no work, whatever else still holds it back (a
   * message on its way, the queue, a shell line).
   */
  function restartRefusalOf(
    paneId: string,
    session: ConversationSession,
  ): string | null {
    const live = session.state();
    return idleStopRefusal({
      limitMs: 1,
      now: Number.POSITIVE_INFINITY,
      idleSince: 0,
      lastPeerAt: null,
      conversation: true,
      alive: true,
      status: live.status === "stopped" ? "idle" : live.status,
      busy: session.busy(),
      queued: live.queue.length,
      backgroundTasks: session.backgroundTasks(),
      shellRunning: shells.running(paneId),
      apiKeyQuestion: apiKeys.has(paneId),
      keptAwake: null,
    });
  }

  /** What the last /model did, to the chat (null: the notice goes). */
  function setModelNotice(paneId: string, notice: AgentChatModelNotice | null) {
    if (disposed) return;
    if (!notice) {
      if (!modelNotices.delete(paneId)) return;
    } else modelNotices.set(paneId, notice);
    emit(paneId, {
      type: "model_notice",
      model_notice: notice ? { ...notice } : null,
    });
  }

  /**
   * Switches the session's model (/model): the running agent first, which
   * says whether it has it; then kept for the session's next starts, until
   * it answered with it. The chat says what came of it either way.
   */
  async function setModel(
    paneId: string,
    value: string,
  ): Promise<AgentChatModelResult> {
    const requested = value.trim();
    const lease = leases.get(paneId);
    if (disposed || !lease || lease.phase !== "conversation")
      return {
        ok: false,
        reason: lease
          ? "This session is being handed over; try again shortly"
          : "The terminal owns this session",
      };
    const at = new Date().toISOString();
    const refused = (reason: string): AgentChatModelResult => {
      setModelNotice(paneId, {
        at,
        ok: false,
        requested,
        model: null,
        text: modelRefusalText(requested, reason),
      });
      log("conversation model switch refused", { pane: paneId, reason });
      return { ok: false, reason };
    };
    if (!isModelName(requested)) return refused("that is not a model name");
    const session = sessionFor(paneId);
    const result = await session.setModel(requested);
    if (!result.ok) return refused(result.reason);
    // A process started before the session answered with it would resume
    // on the model it last answered with: the next starts are told.
    options.models?.choose(session.sessionId(), requested, result.model);
    // The model the pane's agent was started with (`claude --model haiku`)
    // gives way to the user's choice, here and in the terminal.
    const current = leases.get(paneId);
    if (
      current?.terminal_args?.some(
        (arg) => arg === "--model" || arg.startsWith("--model="),
      )
    )
      leases.set({
        ...current,
        terminal_args: withoutModel(current.terminal_args),
      });
    setModelNotice(paneId, {
      at,
      ok: true,
      requested,
      model: result.model,
      text: modelSwitchText(requested, result.model, {
        nextTurn: result.nextTurn,
      }),
    });
    log("conversation model switched", {
      pane: paneId,
      model: requested,
      ...(result.model ? { resolved: result.model } : {}),
    });
    return { ok: true, model: result.model };
  }

  /**
   * What /model offers: the running agent's own list, with what the
   * session's profile offers besides, and which one it runs. Nothing is
   * started for it.
   */
  async function listModels(paneId: string): Promise<AgentChatModels> {
    const lease = leases.get(paneId);
    if (disposed || !lease || lease.phase !== "conversation")
      throw new Error(
        lease
          ? "This session is being handed over; try again shortly"
          : "The terminal owns this session",
      );
    const protocol = driverOf(paneId).protocol;
    if (!protocol.models)
      throw new Error(`${protocol.displayName} cannot switch models`);
    const session = sessions.get(paneId);
    const sessionId = lease.session_id;
    const known = session?.model() ?? null;
    const [agent, offered, last] = await Promise.all([
      session ? session.listModels() : Promise.resolve(null),
      options.models
        ? options.models.offered(sessionId).catch((error: unknown) => ({
            models: [],
            error: errorText(error),
          }))
        : Promise.resolve(null),
      known || !options.models?.lastAnswered
        ? Promise.resolve(null)
        : options.models.lastAnswered(paneId).catch(() => null),
    ]);
    const models = mergeModels(agent, offered?.models ?? []);
    return {
      models,
      current: known ?? last,
      chosen:
        session?.chosenModel() ?? options.models?.chosen(sessionId) ?? null,
      source: agent?.length
        ? models.length > agent.length
          ? "both"
          : "agent"
        : "profile",
      ...(offered?.error ? { error: offered.error } : {}),
    };
  }

  /** The notice of a turn cut short goes (a new turn, or a dismiss). */
  function clearInterrupted(paneId: string) {
    if (disposed) return;
    const current = leases.get(paneId);
    if (!current?.interrupted) return;
    const next = { ...current };
    delete next.interrupted;
    leases.set(next);
    emit(paneId, { type: "interrupted", interrupted: null });
  }

  function report(paneId: string, status: AgentChatStatus) {
    const lease = leases.get(paneId);
    const state = HERDR_STATE[status];
    if (!lease || lease.phase !== "conversation" || !state) return;
    void options.herdr
      .reportAgent({
        paneId,
        state,
        sessionId: lease.session_id,
        message: "conversation mode",
        agent: conversationDriver(lease.agent).terminal.herdrAgent,
      })
      .catch((error) =>
        log("could not report the conversation to Herdr", {
          pane: paneId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  function sessionFor(paneId: string): ConversationSession {
    if (disposed) throw new Error("The connection is closing");
    const lease = leases.get(paneId);
    if (!lease || lease.phase !== "conversation")
      throw new Error(
        lease
          ? "This session is being handed over; try again shortly"
          : "The terminal owns this session; show the chat to take it over",
      );
    let session = sessions.get(paneId);
    if (session) return session;
    // Messages a runtime before this one had queued: this session has them.
    const carried = lease.queue ?? [];
    if (carried.length) {
      const rest = { ...lease };
      delete rest.queue;
      leases.set(rest);
    }
    session = createConversationSession({
      paneId,
      driver: conversationDriver(lease.agent).protocol,
      sessionId: lease.session_id,
      cwd: lease.cwd,
      spawn: guardedSpawn(startDeps, paneId),
      emit: (event) => emit(paneId, event),
      ask: (prompt) => options.ask(paneId, prompt),
      readImage: options.readImage,
      prelude: () => shells.take(paneId),
      ...(options.readTranscript
        ? { readTranscript: () => options.readTranscript!(paneId) }
        : {}),
      onSessionId: (sessionId) => {
        if (disposed) return;
        const current = leases.get(paneId);
        if (!current) return;
        leases.set({ ...current, session_id: sessionId });
        // The holder resumes the new session; Herdr maps the pane to it.
        holders.send(paneId, { action: "hold", session_id: sessionId });
        report(paneId, "idle");
        emitLease(paneId);
      },
      onStatus: (status) => {
        // Over (or waiting on the user): whatever hung is not any more.
        if (status !== "working") clearStuck(paneId);
        report(paneId, status);
      },
      onOutput: () => stuck.output(paneId),
      asleep: !!lease.asleep_at,
      onAsleep: (asleep) => setAsleep(paneId, asleep),
      onPeer: () => idle.notePeer(paneId),
      onTurn: (running) => markTurn(paneId, running ? "running" : "ended"),
      onProcess: (pid, resumed) => {
        if (disposed) return;
        // It exited in the middle of a turn: what was left of it is gone.
        if (pid === null) markTurn(paneId, "process_exited");
        const current = leases.get(paneId);
        if (!current || current.phase !== "conversation") return;
        const next = { ...current };
        if (pid === null) delete next.headless_pid;
        else next.headless_pid = pid;
        // Kept after it exits: over SSH only the client is known to be gone.
        if (resumed)
          next.headless_session_ids = [
            ...(current.headless_session_ids ?? []).filter(
              (id) => id !== resumed,
            ),
            resumed,
          ].slice(-4);
        leases.set(next);
      },
      log,
      queue: carried,
      ...options.session,
    });
    sessions.set(paneId, session);
    return session;
  }

  /** The pane's driver pair: its lease's agent (absent: claude). */
  function driverOf(paneId: string) {
    return conversationDriver(leases.get(paneId)?.agent);
  }

  function state(paneId: string): AgentChatState {
    const lease = leases.get(paneId);
    const session = sessions.get(paneId);
    const live = session?.state();
    const protocol = lease ? conversationDriver(lease.agent).protocol : null;
    const lost = recovery.lost(paneId);
    const stuckNow = stuck.get(paneId);
    const apiKeyQuestion = apiKeys.question(paneId);
    const shellList = shells.list(paneId);
    return {
      pane_id: paneId,
      owner: lease?.owner ?? "terminal",
      phase: lease?.phase ?? "terminal",
      session_id: lease?.session_id ?? null,
      cwd: lease?.cwd ?? null,
      status: live?.status ?? "stopped",
      ...(protocol
        ? {
            agent: protocol.agent,
            capabilities: structuredClone(protocol.capabilities),
          }
        : {}),
      tools_running: live?.tools_running ?? false,
      activity: live?.activity ?? null,
      queue: live?.queue ?? lease?.queue ?? recovery.parked(paneId) ?? [],
      interrupted: lease?.interrupted ?? null,
      ...(lease && lost ? { lost } : {}),
      ...(lease && stuckNow ? { stuck: stuckNow } : {}),
      ...(lease?.asleep_at ? { asleep: { since: lease.asleep_at } } : {}),
      ...(apiKeyQuestion ? { api_key_question: apiKeyQuestion } : {}),
      ...(live?.next_prompt ? { next_prompt: live.next_prompt } : {}),
      ...(lease && modelNotices.has(paneId)
        ? { model_notice: { ...modelNotices.get(paneId)! } }
        : {}),
      ...(shellList.length ? { shells: shellList } : {}),
    };
  }

  /** Warms the process for the next turn; a failure shows on that turn. */
  function warm(paneId: string) {
    if (disposed) return;
    void Promise.resolve()
      .then(() => sessionFor(paneId).warm())
      .catch((error) =>
        log("conversation process did not start", {
          pane: paneId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /**
   * The pane is gone (closed, or its tab or workspace): its lease goes, and
   * the headless process with it (nothing can hand it back any more, and it
   * must not write next to a claude resumed elsewhere).
   */
  function paneClosed(paneId: string) {
    if (disposed) return;
    autoStarter.cancel(paneId);
    idle.forget(paneId);
    const session = sessions.get(paneId);
    sessions.delete(paneId);
    session?.dispose();
    holders.forget(paneId);
    dropChannel(paneId);
    clearStuck(paneId);
    dropSuspended(paneId, "pane closed");
    if (!leases.get(paneId)) return;
    log("the pane of a conversation closed; its lease goes", { pane: paneId });
    leases.delete(paneId);
    emitLease(paneId);
  }

  return {
    state,
    lease: (paneId: string) => leases.get(paneId),
    /**
     * Why nothing may be typed into the pane now, if so: a handover runs
     * (Claude is exiting, or the holder starting) and text would land in
     * the dying TUI or the bare shell.
     */
    /**
     * Puts another Claude session in a conversation-mode pane (a review
     * workspace's Claude moving to another request's session): its idle
     * process stops as idle stop stops it, the lease and the holder take
     * the new session, and a process starts on it (resumed, or new when it
     * was never written). Only when nothing runs, waits or is queued; a
     * busy turn is never interrupted.
     */
    async switchSession(
      paneId: string,
      sessionId: string,
    ): Promise<{ ok: true } | { ok: false; busy: boolean; reason: string }> {
      const lease = leases.get(paneId);
      if (!lease || lease.phase !== "conversation" || handover.running(paneId))
        return {
          ok: false,
          busy: false,
          reason: "conversation mode does not own this pane",
        };
      if (lease.session_id === sessionId) return { ok: true };
      const session = sessions.get(paneId);
      if (session) {
        const refusal = restartRefusalOf(paneId, session);
        if (refusal) return { ok: false, busy: true, reason: refusal };
        if (session.alive() && !session.asleep() && !(await session.sleep()))
          return { ok: false, busy: true, reason: "it is not idle" };
        sessions.delete(paneId);
        session.dispose();
      }
      dropChannel(paneId);
      clearLost(paneId);
      clearStuck(paneId);
      const current = leases.get(paneId);
      if (!current) return { ok: false, busy: false, reason: "the lease went" };
      const next = { ...current, session_id: sessionId };
      delete next.asleep_at;
      leases.set(next);
      log("conversation session switched", { pane: paneId });
      // The holder resumes the new session; Herdr maps the pane to it.
      holders.send(paneId, { action: "hold", session_id: sessionId });
      report(paneId, "idle");
      emitLease(paneId);
      const started = await startAgain(paneId);
      return started.ok
        ? { ok: true }
        : { ok: false, busy: false, reason: started.reason };
    },
    /**
     * Starts the pane's conversation process again on the same session,
     * with what the session's profile says now (a switch of profile). Only
     * when nothing runs, waits or is queued, as a session switch.
     */
    async restartProcess(
      paneId: string,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
      const lease = leases.get(paneId);
      if (!lease || lease.phase !== "conversation" || handover.running(paneId))
        return {
          ok: false,
          reason: "Conversation mode does not own this session",
        };
      const session = sessions.get(paneId);
      if (session) {
        const refusal = restartRefusalOf(paneId, session);
        if (refusal) return { ok: false, reason: restartRefusal(refusal) };
        if (session.alive() && !session.asleep() && !(await session.sleep()))
          return {
            ok: false,
            reason: "The agent is not idle; try again in a moment",
          };
        sessions.delete(paneId);
        session.dispose();
      }
      clearLost(paneId);
      clearStuck(paneId);
      const current = leases.get(paneId);
      if (current?.asleep_at) {
        const next = { ...current };
        delete next.asleep_at;
        leases.set(next);
      }
      log("conversation process restarts with the session's profile", {
        pane: paneId,
      });
      // What a /model said is the old profile's.
      setModelNotice(paneId, null);
      emitLease(paneId);
      return startAgain(paneId);
    },
    /** A terminal pane's TUI exits and resumes with the session's profile. */
    restartTerminal(paneId: string, sessionId?: string) {
      return handover.restartTerminal(paneId, sessionId);
    },
    inputRefusal(paneId: string): string | null {
      const phase = leases.get(paneId)?.phase;
      return handover.running(paneId) ||
        phase === "to_conversation" ||
        phase === "to_terminal"
        ? "The session is being handed over; try again in a moment"
        : null;
    },
    /** The model the pane's running agent last named; null: not known. */
    model(paneId: string): string | null {
      return sessions.get(paneId)?.model() ?? null;
    },
    /** The session conversation mode owns in a pane, for the resolver. */
    ownedSession(paneId: string): { session_id: string; cwd: string } | null {
      const lease = leases.get(paneId);
      return lease && lease.owner === "conversation"
        ? { session_id: lease.session_id, cwd: lease.cwd }
        : null;
    },

    subscribe(ws: Ws, paneId: string): AgentChatState {
      let watchers = subscribers.get(paneId);
      if (!watchers) {
        watchers = new Set();
        subscribers.set(paneId, watchers);
      }
      watchers.add(ws);
      const streamed = sessions.get(paneId)?.streamed() ?? [];
      return streamed.length ? { ...state(paneId), streamed } : state(paneId);
    },
    unsubscribe(ws: Ws, paneId: string) {
      const watchers = subscribers.get(paneId);
      watchers?.delete(ws);
      if (watchers && !watchers.size) subscribers.delete(paneId);
    },
    cleanupWs(ws: Ws) {
      for (const [paneId, watchers] of subscribers) {
        watchers.delete(ws);
        if (!watchers.size) subscribers.delete(paneId);
      }
    },

    send(
      paneId: string,
      input: { text: string; images?: string[]; uuid?: string },
    ): Promise<{ status: "sent" | "queued"; id: string }> {
      const session = sessionFor(paneId);
      // `/model <name>`: the session switches now, a turn or not, rather
      // than the agent's own command waiting for its turn (and lasting
      // only as long as its process). The chat says what came of it.
      const command = input.images?.length
        ? null
        : parseModelCommand(input.text);
      if (command?.model && driverOf(paneId).protocol.models)
        return setModel(paneId, command.model).then(() => ({
          status: "sent" as const,
          id: input.uuid ?? randomUUID(),
        }));
      // Whatever is sent next answers the turn cut short.
      clearInterrupted(paneId);
      setModelNotice(paneId, null);
      return session.send(input).catch(async (error: unknown) => {
        // The holder is gone: the message waits for conversation mode to
        // have the session again (never typed into the terminal).
        if (!(error instanceof HolderMissing) || !(await recoverLater(paneId)))
          throw error;
        const item: AgentChatQueued = {
          id: input.uuid ?? randomUUID(),
          text: input.text.trim(),
          images: input.images ?? [],
          queued_at: new Date().toISOString(),
        };
        if (leases.get(paneId)?.phase === "conversation") {
          // Taken over again already: it goes with the new process.
          return sessionFor(paneId).send({ ...input, uuid: item.id });
        }
        recovery.park(paneId, item);
        return { status: "queued" as const, id: item.id };
      });
    },
    /**
     * Text for the agent from Roamgate itself (review and chat comments,
     * voice errands, Ranger): a message when conversation mode holds the
     * pane, where typing would only reach the holder. False when the
     * terminal owns the session: type it into the pane then.
     */
    async prompt(
      paneId: string,
      text: string,
      beforeSend?: () => void,
      /** `peer`: another agent session's message (no idle stop a while). */
      promptOptions: { peer?: boolean } = {},
    ): Promise<boolean> {
      const lease = leases.get(paneId);
      if (!lease || lease.phase === "terminal") return false;
      if (promptOptions.peer) idle.notePeer(paneId);
      const session = sessionFor(paneId);
      beforeSend?.();
      clearInterrupted(paneId);
      setModelNotice(paneId, null);
      await session.send({ text });
      return true;
    },
    voice(
      paneId: string,
      input: { text: string; stop?: boolean; uuid?: string },
    ) {
      const session = sessionFor(paneId);
      if (!input.stop && !isSpokenStop(input.text)) {
        clearInterrupted(paneId);
        setModelNotice(paneId, null);
      }
      return session.voice(input);
    },
    /** The user dismissed the notice of a turn cut short. */
    dismissInterrupted: clearInterrupted,
    /** What /model offers in the pane's session, and which one it runs. */
    models: listModels,
    /** /model: switches the pane's session to another model. */
    setModel,
    /** The user dismissed what the chat said of the last /model. */
    dismissModelNotice: (paneId: string) => setModelNotice(paneId, null),
    /** Recover, on a chat whose conversation process is lost. */
    recover,
    /**
     * The user's answer to the API key question: the start that waits on
     * it goes on, and the holder files it where Claude Code keeps it.
     */
    answerApiKey(
      paneId: string,
      use: AgentChatApiKeyChoice,
    ): { ok: true } | { ok: false; reason: string } {
      return settleApiKey(paneId, use === "api_key" ? "approve" : "reject")
        ? { ok: true }
        : { ok: false, reason: "No question about the API key waits here" };
    },
    /** A `!` line typed in the chat: runs it (service-shells.ts). */
    shell: shells.run,
    /** Stops a `!` line that runs; false when it is not running. */
    stopShell: shells.stop,
    /** Rewinds the session conversation mode owns (service-rewind.ts). */
    rewind: rewinds.rewind,
    /** What a rewind to before a message could do to the code. */
    rewindCheck: rewinds.rewindCheck,
    interrupt,
    editQueued(paneId: string, id: string, text: string) {
      const session = sessions.get(paneId);
      if (session) return session.editQueued(id, text);
      return recovery.editParked(paneId, id, text);
    },
    removeQueued(paneId: string, id: string) {
      const session = sessions.get(paneId);
      if (session) return session.removeQueued(id);
      return recovery.removeParked(paneId, id);
    },

    /**
     * The user's own switch, asked by a browser: the only way a session
     * changes mode, the safety checks aside. An automatic request (an older
     * page that still hands the session over as its view changes) is
     * refused: what a browser shows never moves the session.
     */
    handover(
      paneId: string,
      to: "conversation" | "terminal",
      handoverOptions: {
        interrupt?: boolean;
        session_id?: string;
        auto?: boolean;
        /**
         * The other pane whose idle claude runs the session too, which
         * the user chose to quit before the switch.
         */
        quit_writer?: string;
        /**
         * To the terminal stopped as a shell job (the chat's Ctrl+Z), with
         * the conversation's title for its line there.
         */
        suspend?: { title?: string };
      } = {},
    ): Promise<AgentChatHandoverResult> {
      if (disposed)
        return Promise.resolve({
          ok: false,
          reason: "The connection is closing",
        });
      if (handoverOptions.auto) {
        log("automatic handover refused", { pane: paneId, to });
        return Promise.resolve({
          ok: false,
          reason: "Only the user's switch changes the mode; reload the page",
        });
      }
      return to === "conversation"
        ? toConversation(paneId, handoverOptions.session_id, {
            quitWriter: handoverOptions.quit_writer,
          })
        : toTerminal(paneId, {
            interrupt: handoverOptions.interrupt,
            ...(handoverOptions.suspend
              ? { suspend: handoverOptions.suspend }
              : {}),
          });
    },

    /**
     * The user's fg from the page (the terminal's banner, a phone): the
     * pane's shell is asked to bring the stopped holder back, as typing
     * `fg` there would; the holder then asks for its session itself. Only
     * while the shell is at its prompt, and only for the stopped
     * conversation's own job (named, never the shell's current job).
     */
    async foreground(
      paneId: string,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
      const entry = suspended.get(paneId);
      if (!entry)
        return { ok: false, reason: "No conversation is stopped in this pane" };
      let info: Awaited<ReturnType<ConversationHerdr["processInfo"]>>;
      try {
        info = await options.herdr.processInfo(paneId);
      } catch (error) {
        return {
          ok: false,
          reason: `Herdr did not list the pane's processes: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (
        info.shell_pid === undefined ||
        info.foreground_process_group_id !== info.shell_pid
      )
        return {
          ok: false,
          reason:
            "Something runs in the pane's terminal; once its shell is back at the prompt, type fg there",
        };
      const shell = info.foreground_processes.find(
        (process) => process.pid === info.shell_pid,
      );
      try {
        await options.herdr.sendText(
          paneId,
          foregroundCommand(entry, shellName(shell)),
        );
      } catch (error) {
        return {
          ok: false,
          reason: `Could not type fg into the pane: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      log("fg typed for a stopped conversation", { pane: paneId });
      return { ok: true };
    },

    /** The panes whose conversation is stopped as a shell job (Ctrl+Z). */
    suspendedPanes(): SuspendedConversation[] {
      return suspended.all();
    },

    /**
     * The user cancelled their switch to conversation mode: a TUI asked to
     * exit that did not is no longer waited for, so the next switch asks
     * again instead of being refused.
     */
    cancelHandover(paneId: string): { ok: true; cleared: boolean } {
      const cleared = handover.cancelExit(paneId);
      if (cleared)
        log("switch cancelled; exit no longer waited for", { pane: paneId });
      return { ok: true, cleared };
    },

    /**
     * A claude the user just started in the pane (its SessionStart hook,
     * with the claude start setting on conversation): conversation mode
     * takes it once it is up, with the usual handover. Answers at once;
     * the takeover goes on in the background.
     */
    autoStart(
      paneId: string,
      sessionId: string,
    ): { ok: true } | { ok: false; reason: string } {
      if (disposed) return { ok: false, reason: "The connection is closing" };
      if (leases.get(paneId))
        return {
          ok: false,
          reason: "Conversation mode already has this pane",
        };
      const was = released.get(paneId);
      if (was && Date.now() - was.at < handedBackMs)
        return {
          ok: false,
          reason: "This pane's session just went back to the terminal",
        };
      log("claude started in the pane; conversation mode will take it", {
        pane: paneId,
        session: sessionId,
      });
      void autoStarter.start(paneId, sessionId);
      return { ok: true };
    },

    /** roamgate-hold's requests, from the review socket. */
    holder: holderSide.endpoints,

    paneClosed,
    /** Drops the leases whose pane is gone (a tab or workspace closed). */
    async sweep() {
      for (const lease of leases.all()) {
        const exists = await options.herdr
          .paneExists(lease.pane_id)
          .catch(() => true);
        if (!exists) paneClosed(lease.pane_id);
        // Its holder gone (a host restart): the terminal has it again.
        else if (
          lease.phase === "conversation" &&
          !holders.connected(lease.pane_id)
        )
          await recoverLater(lease.pane_id);
      }
    },
    /** Runs the idle stop check now (tests; it runs on its own). */
    checkIdle,
    /** Whether a handover is under way in any pane (input may be refused). */
    handingOver(): boolean {
      return leases
        .all()
        .some(
          (lease) =>
            handover.running(lease.pane_id) ||
            lease.phase === "to_conversation" ||
            lease.phase === "to_terminal",
        );
    },
    /**
     * The panes conversation mode holds (or is taking or giving), with
     * the session and what Herdr would say of the agent: Herdr knows no
     * agent in a pane its holder occupies (at most the holder's child,
     * with no session).
     */
    ownedPanes(): {
      pane_id: string;
      session_id: string;
      cwd: string;
      phase: string;
      agent_status: "idle" | "working" | "blocked";
      /** Herdr's name of the agent conversation mode drives there. */
      agent: string;
    }[] {
      return leases.all().map((lease) => {
        const status = sessions.get(lease.pane_id)?.state().status;
        return {
          pane_id: lease.pane_id,
          session_id: lease.session_id,
          cwd: lease.cwd,
          phase: lease.phase,
          agent: conversationDriver(lease.agent).terminal.herdrAgent,
          agent_status:
            lease.phase !== "conversation" ||
            status === "working" ||
            status === "starting"
              ? "working"
              : status === "blocked"
                ? "blocked"
                : "idle",
        };
      });
    },

    /**
     * Kills the processes; leases stay (the holders keep the panes), with
     * what was queued, for the runtime after this one.
     */
    dispose() {
      if (suspendedWatch) clearInterval(suspendedWatch);
      recovery.dispose();
      stuck.dispose();
      idle.dispose();
      autoStarter.dispose();
      if (disposed) return;
      for (const [paneId, session] of sessions) {
        const queued: AgentChatQueued[] = session.takeQueue();
        const lease = leases.get(paneId);
        if (queued.length && lease)
          leases.set({ ...lease, queue: [...(lease.queue ?? []), ...queued] });
      }
      // Where each holder's log was read to, and what it was not sent yet:
      // the runtime after this one reads on from there.
      holderSide.saveAll();
      disposed = true;
      // The connection closes: its `!` lines end with it.
      shells.dispose();
      // The holders run the processes on.
      for (const session of sessions.values())
        session.dispose({ detach: true });
      sessions.clear();
      holderSide.dropAll();
      subscribers.clear();
      // Their next poll reaches the runtime after this one.
      holders.releaseAll((paneId) => ({
        action: "hold",
        session_id: leases.get(paneId)?.session_id ?? "",
      }));
    },
  };
}

export type ConversationService<Ws = unknown> = ReturnType<
  typeof createConversationService<Ws>
>;
