import { randomUUID } from "node:crypto";
import type {
  AgentChatApiKeyChoice,
  AgentChatApiKeyQuestion,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatHandoverResult,
  AgentChatInterrupted,
  AgentChatLease,
  AgentChatLost,
  AgentChatQueued,
  AgentChatRewindCheck,
  AgentChatRewindMode,
  AgentChatRewindResult,
  AgentChatShell,
  AgentChatState,
  AgentChatStatus,
  AgentChatStuck,
} from "../../../shared/agentChat";
import type { AgentPromptAnswer } from "../../../shared/review";
import type { ApiKeyAnswer } from "./env";
import { createHandover, type HandoverDeps } from "./handover";
import { conversationDriver } from "./drivers";
import type { ConversationHerdr } from "./herdr";
import type { SpawnHeadless } from "./headless";
import { createHolderRegistry, type HolderReply } from "./holder";
import { idleStopRefusal } from "./idle-stop";
import type { LeaseStore } from "./lease";
import { resumeReply } from "./holder";
import {
  createHolderChannel,
  type HolderChannel,
  HolderChildStuck,
  type HolderCommand,
  type HolderStatus,
} from "./pane-child";
import {
  type ConversationImage,
  type ConversationPrompt,
  type ConversationSession,
  type ConversationSessionOptions,
  createConversationSession,
} from "./session";
import { isSpokenStop } from "./session-voice";
import type { ShellRun, ShellRunner } from "./shell";
import {
  BASH_OUTPUT_LIMIT,
  bashModeTexts,
  truncateBashOutput,
} from "../../../shared/bashMode";

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
  readTranscript?: (paneId: string) => Promise<string | null>;
  /** Sends one event to one subscribed browser. */
  send: (ws: Ws, envelope: AgentChatEventEnvelope) => void;
  holderCommand: (sessionId: string) => string;
  /** What is typed into a bare shell to resume the session in claude. */
  resumeCommand?: (sessionId: string, args?: string[]) => string;
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

function refuse(reason: string): AgentChatHandoverResult {
  return { ok: false, reason };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** No holder answered for a pane conversation mode owns. */
class HolderMissing extends Error {}

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
 * Conversation mode on one connection: the sessions it owns (each with its
 * headless claude), the handovers to and from the panes' terminals, the
 * panes' holders, and the browsers watching each pane.
 */
/**
 * At most `limit` at once: each waits for a slot, in order, and gives it
 * back (once) with the function it gets.
 */
export function createSlots(limit: number): () => Promise<() => void> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return () =>
    new Promise((resolve) => {
      const start = () => {
        running += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          running -= 1;
          waiting.shift()?.();
        });
      };
      if (running < limit) start();
      else waiting.push(start);
    });
}

export function createConversationService<Ws>(
  options: ConversationServiceOptions<Ws>,
) {
  const log = options.log ?? (() => {});
  let disposed = false;
  // Once disposed, this service changes no lease: a runtime replacing it
  // (a reconnect) owns them, and a handover still running here stops.
  // The panes whose lease this runtime dropped, lately: a holder still
  // polling there missed its resume, and gets it. A holder this runtime
  // never knew (another Roamgate on the same host socket, a lease file
  // from elsewhere) is not told to resume: that would end its process and
  // put claude in a pane some other Roamgate holds.
  const released = new Map<
    string,
    { session_id: string; cwd: string; at: number }
  >();
  const releasedMs = 10 * 60_000;
  // Unknown holders already logged.
  const strangers = new Set<string>();
  const leases: LeaseStore = {
    ...options.leases,
    set(lease) {
      if (disposed) throw new Error("The connection is closing");
      released.delete(lease.pane_id);
      return options.leases.set(lease);
    },
    delete(paneId) {
      if (disposed) throw new Error("The connection is closing");
      const lease = options.leases.get(paneId);
      if (lease)
        released.set(paneId, {
          session_id: lease.session_id,
          cwd: lease.cwd,
          at: Date.now(),
        });
      options.leases.delete(paneId);
    },
  };
  const holders = createHolderRegistry({ now: options.handover?.now });
  const handover = createHandover({
    herdr: options.herdr,
    leases,
    holders,
    holderCommand: options.holderCommand,
    ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
    // Each phase reaches the browsers as it happens: while a takeover runs
    // nothing may be typed into the pane.
    onLease: (paneId) => emitLease(paneId),
    closed: () => disposed,
    onPaneGone: (paneId) => paneClosed(paneId),
    onExitDialog: (paneId, work) =>
      log("claude asked before exiting; answered Stay", {
        pane: paneId,
        ...(work ? { work } : {}),
      }),
    ...options.handover,
  });
  const sessions = new Map<string, ConversationSession>();
  const subscribers = new Map<string, Set<Ws>>();
  const holdPollMs = options.holdPollMs ?? 25_000;
  const holderWatchMs = options.holderWatchMs ?? 30_000;
  // A holder that stops polling with no word (the pane's process gone, or
  // claude in its place) leaves a turn that never ends: what read its
  // process gives up, and the terminal has the session (recoverHolderGone,
  // which checks the pane first).
  const holderWatch =
    holderWatchMs > 0
      ? setInterval(() => {
          if (disposed) return;
          for (const lease of leases.all())
            if (
              lease.phase === "conversation" &&
              !handover.running(lease.pane_id) &&
              !holders.connected(lease.pane_id, holdPollMs + 10_000)
            )
              void recoverLater(lease.pane_id);
        }, holderWatchMs)
      : null;
  (holderWatch as { unref?: () => void } | null)?.unref?.();
  const holderSaveMs = options.holderSaveMs ?? 1000;
  // Each pane holder's end here: its commands, its log, its children.
  const channels = new Map<string, HolderChannel>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Messages sent to a conversation whose holder was gone (the host
  // restarted): kept while the terminal has the session, never typed into
  // it, and sent once conversation mode has it again.
  const parked = new Map<string, AgentChatQueued[]>();
  const recovering = new Map<string, Promise<boolean>>();
  // Panes whose conversation process cannot be read (its holder runs, its
  // log does not come through): the chat says so, with Recover.
  const lost = new Map<string, AgentChatLost>();
  // The `!` lines of each pane that Claude has not read yet, and the runs
  // of those still running.
  const shells = new Map<string, AgentChatShell[]>();
  const shellRuns = new Map<string, ShellRun>();
  const shellTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // What each one printed, a little past the cap: what Claude reads is cut
  // from it, saying how many lines were left out.
  const shellOutput = new Map<string, { stdout: string; stderr: string }>();
  const recoverWaitMs = options.recoverWaitMs ?? 15_000;
  const recoverRetryMs = options.recoverRetryMs ?? 5000;
  const recoverAttempts = options.recoverAttempts ?? 12;
  const stuckAfterMs = options.stuckAfterMs ?? 10 * 60_000;
  const stuckToolAfterMs = options.stuckToolAfterMs ?? 45 * 60_000;
  const stuckCheckMs = options.stuckCheckMs ?? 60_000;
  const stopAnswerMs = options.stopAnswerMs ?? 10_000;
  // Turns that seem to hang, and the Stops waiting for an answer.
  const stuck = new Map<string, AgentChatStuck>();
  // Starts waiting for the user's answer about the pane's API key (Claude
  // Code has none filed for it): the chat asks the TUI's question.
  const apiKeyQuestions = new Map<
    string,
    {
      question: AgentChatApiKeyQuestion;
      waiters: Set<{
        settle: (answer: ApiKeyAnswer | null) => void;
        fail: (error: Error) => void;
      }>;
    }
  >();
  const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // A handover cut short (a Roamgate restart, or the runtime replaced).
  // Handing back resumes conversation mode (the holder still waits, and
  // still runs its process); handing over had started nothing headless,
  // so the terminal owns it.
  for (const lease of leases.all()) {
    if (lease.phase === "to_terminal")
      leases.set({ ...lease, phase: "conversation" });
    else if (lease.phase === "to_conversation") leases.delete(lease.pane_id);
  }
  // The sessions the runtime before this one owned: their holders run
  // their processes on, so they are read again once this one is up (a
  // moment, for Herdr and the holders to come back), with what they had
  // queued. A turn whose process is gone (or whose holder is) was cut
  // short; the chat says so.
  // Until read again: a holder that comes back later (a slow SSH link)
  // triggers it with its first poll.
  const unread = new Set(
    leases
      .all()
      .filter((lease) => lease.phase === "conversation")
      .map((lease) => lease.pane_id),
  );
  const reattaching = new Set<string>();
  const carriedTimer = unread.size
    ? setTimeout(() => {
        for (const paneId of unread) reattach(paneId);
      }, options.carriedQueueDelayMs ?? 3000)
    : null;

  /** Saves on the lease how far the holder's log was read. */
  function saveHolder(paneId: string) {
    const timer = saveTimers.get(paneId);
    if (timer) clearTimeout(timer);
    saveTimers.delete(paneId);
    const saved = channels.get(paneId)?.save();
    const lease = leases.get(paneId);
    if (!saved || !lease || lease.phase !== "conversation") return;
    // Where the conversation's lines were handled to, and its state there.
    // Not known yet (not attached, or replaying): an earlier one still holds.
    let resume: NonNullable<AgentChatLease["holder"]>["resume"] | null =
      sessions.get(paneId)?.resumeState();
    if (resume === undefined)
      resume =
        lease.holder?.id === saved.id ? (lease.holder.resume ?? null) : null;
    leases.set({
      ...lease,
      holder: { ...saved, ...(resume ? { resume } : {}) },
    });
  }

  function channelFor(paneId: string): HolderChannel {
    let channel = channels.get(paneId);
    if (channel) return channel;
    const saved = leases.get(paneId)?.holder;
    channel = createHolderChannel({
      paneId,
      inputKind: (line) => driverOf(paneId).protocol.inputKind(line),
      saved: saved
        ? {
            id: saved.id,
            offset: saved.offset,
            ...(saved.pending
              ? { pending: saved.pending as HolderCommand[] }
              : {}),
            ...(saved.resume ? { resume: saved.resume } : {}),
          }
        : null,
      onWork: () => {
        const lease = leases.get(paneId);
        if (lease)
          holders.send(paneId, {
            action: "hold",
            session_id: lease.session_id,
          });
      },
      // Unconfirmed commands (a message on its way) are saved at once: a
      // Roamgate that dies before the holder confirms them loses none.
      onPending: () => {
        if (!disposed) saveHolder(paneId);
      },
      onOffset: () => {
        if (disposed || saveTimers.has(paneId)) return;
        saveTimers.set(
          paneId,
          setTimeout(() => {
            if (!disposed) saveHolder(paneId);
          }, holderSaveMs),
        );
      },
      log,
    });
    channels.set(paneId, channel);
    return channel;
  }

  function dropChannel(paneId: string) {
    const timer = saveTimers.get(paneId);
    if (timer) clearTimeout(timer);
    saveTimers.delete(paneId);
    channels.get(paneId)?.detach();
    channels.delete(paneId);
  }

  /**
   * Waits for the user's answer about the pane's API key; null when it
   * came from elsewhere (a terminal on the host answered Claude Code's own
   * question meanwhile). The question shows while a start waits on it.
   */
  function askApiKey(
    paneId: string,
    signal?: AbortSignal,
  ): Promise<ApiKeyAnswer | null> {
    let entry = apiKeyQuestions.get(paneId);
    if (!entry) {
      entry = {
        question: { asked_at: new Date().toISOString() },
        waiters: new Set(),
      };
      apiKeyQuestions.set(paneId, entry);
      log("Claude waits for the user's answer about the pane's API key", {
        pane: paneId,
      });
      emit(paneId, {
        type: "api_key_question",
        api_key_question: { ...entry.question },
      });
    }
    const asked = entry;
    return new Promise((resolve, reject) => {
      const waiter = {
        settle: (answer: ApiKeyAnswer | null) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
        fail: (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        asked.waiters.delete(waiter);
        // Nothing waits on it any more: the question goes too.
        if (!asked.waiters.size && apiKeyQuestions.get(paneId) === asked)
          settleApiKey(paneId, null);
        waiter.fail(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Gave up waiting for the API key answer"),
        );
      };
      asked.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /**
   * The API key question is answered (or moot: null), or with `error` the
   * starts waiting on it give up; false if none waits.
   */
  function settleApiKey(
    paneId: string,
    answer: ApiKeyAnswer | null,
    error?: Error,
  ) {
    const entry = apiKeyQuestions.get(paneId);
    if (!entry) return false;
    apiKeyQuestions.delete(paneId);
    if (answer)
      log("the user answered the API key question", { pane: paneId, answer });
    for (const waiter of [...entry.waiters])
      if (error) waiter.fail(error);
      else waiter.settle(answer);
    emit(paneId, { type: "api_key_question", api_key_question: null });
    return true;
  }

  /** The pane holder runs the headless claude; Roamgate reads and writes. */
  const holderSpawn: SpawnHeadless = async (spawn) => {
    const channel = channels.get(spawn.paneId);
    if (!channel?.holderId())
      throw new Error(
        holders.connected(spawn.paneId)
          ? "The pane holder is from an older Roamgate; show the terminal, then the chat, to restart it"
          : "The pane holder is not connected",
      );
    return channel.spawn({
      command: driverOf(spawn.paneId).protocol.startCommand(spawn),
      ...(spawn.attachOnly ? { attachOnly: true } : {}),
      ...(spawn.signal ? { signal: spawn.signal } : {}),
    });
  };
  const spawnHeadless = options.spawn ?? holderSpawn;

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
      lost.delete(paneId);
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

  /** The chat says the conversation process cannot be read, and why. */
  function setLost(paneId: string, reason: string) {
    if (disposed || leases.get(paneId)?.phase !== "conversation") return;
    if (lost.get(paneId)?.reason === reason) return;
    const next = {
      at: lost.get(paneId)?.at ?? new Date().toISOString(),
      reason,
    };
    lost.set(paneId, next);
    log("the conversation process is lost", { pane: paneId, reason });
    emit(paneId, { type: "lost", lost: { ...next } });
  }

  function clearLost(paneId: string) {
    if (!lost.delete(paneId)) return;
    emit(paneId, { type: "lost", lost: null });
  }

  /** The chat says the turn seems to hang, since when, and why. */
  function setStuck(paneId: string, next: AgentChatStuck) {
    if (disposed || leases.get(paneId)?.phase !== "conversation") return;
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
    if (disposed || checkingStuck) return;
    checkingStuck = true;
    try {
      for (const [paneId, session] of [...sessions]) {
        if (stuck.get(paneId)?.reason === "stop_unanswered") continue;
        const activity = session.activity();
        if (!activity.running || leases.get(paneId)?.phase !== "conversation") {
          clearStuck(paneId);
          continue;
        }
        const limit = activity.tools ? stuckToolAfterMs : stuckAfterMs;
        let since = activity.since;
        if (Date.now() - since < limit) continue;
        const stat = options.transcriptStat
          ? await options.transcriptStat(paneId).catch(() => null)
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
    stuckCheckMs > 0
      ? setInterval(() => void checkStuck(), stuckCheckMs)
      : null;
  (stuckWatch as { unref?: () => void } | null)?.unref?.();

  // When another session's message last reached each pane (idle stop
  // leaves those alone a while).
  const lastPeer = new Map<string, number>();
  /**
   * Idle stop: the processes of the sessions idle past the setting stop;
   * their holders keep the panes, and the next message starts them again.
   */
  let checkingIdle = false;
  async function checkIdle() {
    if (disposed || checkingIdle || !options.idleStopMinutes) return;
    checkingIdle = true;
    try {
      const minutes = await options.idleStopMinutes();
      if (!(minutes > 0)) return;
      for (const [paneId, session] of [...sessions]) {
        const lease = leases.get(paneId);
        const live = session.state();
        const refusal = idleStopRefusal({
          limitMs: minutes * 60_000,
          now: Date.now(),
          idleSince: session.idleSince(),
          lastPeerAt: lastPeer.get(paneId) ?? null,
          ...(options.peerQuietMs !== undefined
            ? { peerQuietMs: options.peerQuietMs }
            : {}),
          conversation:
            lease?.phase === "conversation" && !handover.running(paneId),
          alive: session.alive() && !session.asleep(),
          status: live.status,
          busy: session.busy(),
          queued: live.queue.length,
          backgroundTasks: session.backgroundTasks(),
          shellRunning: (shells.get(paneId) ?? []).some(
            (shell) => shell.status === "running",
          ),
          apiKeyQuestion: apiKeyQuestions.has(paneId),
          keptAwake: options.keepAwake?.(paneId) ?? null,
        });
        if (refusal) continue;
        log("idle conversation stopped; its next message wakes it", {
          pane: paneId,
          idle_minutes: Math.round((Date.now() - session.idleSince()) / 60_000),
        });
        void session.sleep();
      }
    } catch (error) {
      log("idle stop check failed", { error: errorText(error) });
    } finally {
      checkingIdle = false;
    }
  }
  const idleCheckMs = options.idleCheckMs ?? 60_000;
  const idleWatch =
    idleCheckMs > 0 && options.idleStopMinutes
      ? setInterval(() => void checkIdle(), idleCheckMs)
      : null;
  (idleWatch as { unref?: () => void } | null)?.unref?.();

  /** Its process was stopped while idle (true), or started again. */
  function setAsleep(paneId: string, asleep: boolean) {
    if (disposed) return;
    const current = leases.get(paneId);
    if (!current || !!current.asleep_at === asleep) return;
    const next = { ...current };
    if (asleep) next.asleep_at = new Date().toISOString();
    else delete next.asleep_at;
    leases.set(next);
    emit(paneId, {
      type: "asleep",
      asleep: next.asleep_at ? { since: next.asleep_at } : null,
    });
  }

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
    if (ok || disposed || !session.activity().running) return ok;
    const previous = stopTimers.get(paneId);
    if (previous) clearTimeout(previous);
    stopTimers.set(
      paneId,
      setTimeout(
        () => {
          stopTimers.delete(paneId);
          if (disposed || sessions.get(paneId) !== session) return;
          const activity = session.activity();
          if (!activity.running || activity.since > asked) return;
          setStuck(paneId, {
            since: new Date(activity.since).toISOString(),
            reason: "stop_unanswered",
          });
        },
        Math.max(0, stopAnswerMs - (Date.now() - asked)),
      ),
    );
    return ok;
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

  /**
   * Starts the headless process only while conversation mode owns the
   * session, its holder keeps the pane (and holds this session), no claude
   * runs in the pane or anywhere else on the session, and no headless one
   * is still at work on it (left by a Roamgate that died, or by an SSH
   * client that went away while the host's claude went on).
   */
  const guardedSpawn =
    (paneId: string): SpawnHeadless =>
    async (spawn) => {
      const lease = leases.get(paneId);
      if (!lease || lease.phase !== "conversation")
        throw new Error("Conversation mode does not own this session");
      // A pane with no holder is a bare shell (the holder died, or the
      // pane id now names another pane): claude could be typed there.
      const held = await handover.waitForHolder(paneId).catch(() => false);
      if (!held) {
        // Gone for good (the host restarted, say), the terminal gets the
        // session back. Checked once the caller is done with this start.
        void recoverLater(paneId);
        throw new HolderMissing(
          "The pane holder is not running; show the terminal to take the session back",
        );
      }
      // What the holder runs already (or ran while nobody read) comes
      // first: it is the session's one writer.
      let attached: Awaited<ReturnType<SpawnHeadless>>;
      try {
        attached = await spawnHeadless({ ...spawn, attachOnly: true });
      } catch (error) {
        // Its holder is there, yet what it runs cannot be read: nothing
        // is delivered until it is recovered.
        if (holders.connected(paneId) && !spawn.signal?.aborted)
          setLost(
            paneId,
            error instanceof Error ? error.message : String(error),
          );
        throw error;
      }
      clearLost(paneId);
      if (attached || spawn.attachOnly) return attached;
      // The pane has an API key Claude Code has no answer for: claude -p
      // would use it without asking, so nothing starts until the user
      // says (what is sent meanwhile waits in the queue).
      const apiKeyAnswer =
        channels.get(paneId)?.status()?.apiKey === "new"
          ? await askApiKey(paneId, spawn.signal)
          : null;
      const ids = [
        ...new Set([
          lease.session_id,
          spawn.sessionId,
          ...(lease.headless_session_ids ?? []),
        ]),
      ];
      const info = await options.herdr.processInfo(paneId);
      const running = await options.herdr.headlessRunning(ids);
      if (
        info.foreground_processes.some(
          conversationDriver(lease.agent).terminal.isAgentProcess,
        )
      ) {
        // The holder resumed claude by itself (Roamgate was away): the
        // terminal has the session now.
        if (!running && leases.get(paneId) === lease) {
          log("claude runs in a held pane; the terminal has the session", {
            pane: paneId,
          });
          leases.delete(paneId);
          queueMicrotask(() => emitLease(paneId));
        }
        throw new Error(
          "Claude runs in the pane's terminal; conversation mode will not start a second one",
        );
      }
      if (running)
        throw new Error(
          "An earlier conversation process still works on this session; try again once it has finished",
        );
      const elsewhere = await options.herdr.writerElsewhere(paneId, ids);
      if (elsewhere)
        throw new Error(
          `${elsewhere.text}; conversation mode will not start a second writer`,
        );
      const holderSession = holders.session(paneId);
      if (holderSession && !ids.includes(holderSession))
        throw new Error("The pane holder holds another session");
      const current = leases.get(paneId);
      if (!current || current.phase !== "conversation" || disposed)
        throw new Error("Conversation mode does not own this session");
      return spawnHeadless(apiKeyAnswer ? { ...spawn, apiKeyAnswer } : spawn);
    };

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
      spawn: guardedSpawn(paneId),
      emit: (event) => emit(paneId, event),
      ask: (prompt) => options.ask(paneId, prompt),
      readImage: options.readImage,
      prelude: () => takeShells(paneId),
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
      onOutput: () => {
        if (stuck.has(paneId) || stopTimers.has(paneId)) clearStuck(paneId);
      },
      asleep: !!lease.asleep_at,
      onAsleep: (asleep) => setAsleep(paneId, asleep),
      onPeer: () => lastPeer.set(paneId, Date.now()),
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
      queue:
        live?.queue ??
        lease?.queue ??
        (parked.get(paneId) ?? []).map((item) => ({ ...item })),
      interrupted: lease?.interrupted ?? null,
      ...(lease && lost.has(paneId) ? { lost: { ...lost.get(paneId)! } } : {}),
      ...(lease && stuck.has(paneId)
        ? { stuck: { ...stuck.get(paneId)! } }
        : {}),
      ...(lease?.asleep_at ? { asleep: { since: lease.asleep_at } } : {}),
      ...(apiKeyQuestions.has(paneId)
        ? {
            api_key_question: { ...apiKeyQuestions.get(paneId)!.question },
          }
        : {}),
      ...(live?.next_prompt ? { next_prompt: live.next_prompt } : {}),
      ...(shells.get(paneId)?.length
        ? { shells: shells.get(paneId)!.map((each) => ({ ...each })) }
        : {}),
    };
  }

  /** A `!` line's progress to the browsers: output at most every 100 ms. */
  function emitShell(paneId: string, shell: AgentChatShell, now = false) {
    const timer = shellTimers.get(shell.id);
    if (!now) {
      if (timer) return;
      shellTimers.set(
        shell.id,
        setTimeout(() => {
          shellTimers.delete(shell.id);
          emit(paneId, { type: "shell", shell: { ...shell } });
        }, 100),
      );
      return;
    }
    if (timer) clearTimeout(timer);
    shellTimers.delete(shell.id);
    emit(paneId, { type: "shell", shell: { ...shell } });
  }

  /**
   * The `!` lines done since the last message, for the next one, as Claude
   * Code's bash mode gives them to Claude: each stream cut at its cap.
   */
  function takeShells(paneId: string) {
    const done = (shells.get(paneId) ?? []).filter(
      (each) => each.status !== "running",
    );
    if (!done.length) return null;
    return {
      texts: done.flatMap((each) => {
        const printed = shellOutput.get(each.id) ?? each;
        return bashModeTexts({
          command: each.command,
          stdout: truncateBashOutput(printed.stdout).text,
          stderr: truncateBashOutput(
            each.error ? `${printed.stderr}${each.error}` : printed.stderr,
          ).text,
        });
      }),
      commit() {
        const sent = new Set(done.map((each) => each.id));
        for (const id of sent) shellOutput.delete(id);
        shells.set(
          paneId,
          (shells.get(paneId) ?? []).filter((each) => !sent.has(each.id)),
        );
        for (const each of done)
          emitShell(paneId, { ...each, delivered: true }, true);
      },
    };
  }

  const MAX_SHELLS = 20;

  /**
   * Runs a `!` line typed in the chat (Claude Code's bash mode) on the
   * pane's host, in the session's directory: its output streams to the
   * chat, and Claude reads it with the next message.
   */
  function runShell(paneId: string, input: { command: string; id?: string }) {
    if (!options.runShell)
      throw new Error("Shell lines are unavailable on this connection");
    sessionFor(paneId);
    const cwd = leases.get(paneId)!.cwd;
    const list = shells.get(paneId) ?? [];
    if (input.id && list.some((each) => each.id === input.id))
      return { id: input.id };
    if (list.length >= MAX_SHELLS)
      throw new Error(
        `${MAX_SHELLS} commands wait for Claude: send a message first`,
      );
    const shell: AgentChatShell = {
      id: input.id ?? randomUUID(),
      command: input.command,
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      exit_code: null,
      cwd,
      started_at: new Date().toISOString(),
    };
    shells.set(paneId, [...list, shell]);
    emitShell(paneId, shell, true);
    let run: ShellRun;
    try {
      run = options.runShell({
        cwd,
        command: input.command,
        onOutput: (output) => {
          shellOutput.set(shell.id, {
            stdout: output.stdout,
            stderr: output.stderr,
          });
          shell.stdout = output.stdout.slice(0, BASH_OUTPUT_LIMIT);
          shell.stderr = output.stderr.slice(0, BASH_OUTPUT_LIMIT);
          shell.truncated =
            output.truncated ||
            output.stdout.length > BASH_OUTPUT_LIMIT ||
            output.stderr.length > BASH_OUTPUT_LIMIT;
          emitShell(paneId, shell);
        },
      });
    } catch (error) {
      finishShell(paneId, shell, "failed", null, error);
      return { id: shell.id };
    }
    shellRuns.set(shell.id, run);
    void run.done.then(
      ({ code, stopped }) =>
        finishShell(paneId, shell, stopped ? "stopped" : "done", code),
      (error: unknown) => finishShell(paneId, shell, "failed", null, error),
    );
    return { id: shell.id };
  }

  function finishShell(
    paneId: string,
    shell: AgentChatShell,
    status: AgentChatShell["status"],
    code: number | null,
    error?: unknown,
  ) {
    shellRuns.delete(shell.id);
    shell.status = status;
    shell.exit_code = code;
    shell.finished_at = new Date().toISOString();
    if (error !== undefined)
      shell.error =
        error instanceof Error ? error.message : "The command could not run";
    log("shell line ended", { pane: paneId, status, code });
    emitShell(paneId, shell, true);
  }

  function stopShell(paneId: string, id: string) {
    const run = shellRuns.get(id);
    if (!run || !shells.get(paneId)?.some((each) => each.id === id))
      return false;
    run.stop();
    return true;
  }

  async function toConversation(
    paneId: string,
    sessionId?: string,
    handoverOptions: { quitWriter?: string } = {},
  ): Promise<AgentChatHandoverResult> {
    if (handoverOptions.quitWriter)
      log("quitting the other claude on the session first", {
        pane: paneId,
        other: handoverOptions.quitWriter,
      });
    const result = await handover.toConversation(
      paneId,
      sessionId,
      handoverOptions,
    );
    emitLease(paneId);
    if (!result.ok) {
      log("conversation mode refused", { pane: paneId, reason: result.reason });
      return result;
    }
    if (disposed) return refuse("The connection is closing");
    carryParked(paneId);
    report(paneId, "idle");
    warm(paneId);
    return result;
  }

  /** What waited while the terminal had the session goes out now. */
  function carryParked(paneId: string) {
    const waiting = parked.get(paneId);
    const lease = leases.get(paneId);
    if (!waiting?.length || lease?.phase !== "conversation") return;
    parked.delete(paneId);
    const session = sessions.get(paneId);
    if (session) {
      // Not expected (a fresh takeover has no session yet): sent as typed.
      for (const item of waiting)
        void session
          .send({ text: item.text, images: item.images, uuid: item.id })
          .catch(() => undefined);
      return;
    }
    leases.set({ ...lease, queue: [...(lease.queue ?? []), ...waiting] });
  }

  function emitParked(paneId: string) {
    emit(paneId, {
      type: "queue",
      queue: (parked.get(paneId) ?? []).map((item) => ({ ...item })),
    });
  }

  /**
   * Once the current call is done with the pane (its queue back in place),
   * checks whether the holder is gone, and recovers if so.
   */
  function recoverLater(paneId: string): Promise<boolean> {
    let pending = recovering.get(paneId);
    if (pending) return pending;
    pending = new Promise((resolve) => setTimeout(resolve, 0))
      .then(() => recoverHolderGone(paneId))
      .catch(() => false)
      .finally(() => recovering.delete(paneId));
    recovering.set(paneId, pending);
    return pending;
  }

  /**
   * The pane holder is gone and nothing headless works on the session (the
   * host restarted, and Herdr restored the pane with claude, or a shell):
   * nothing writes for conversation mode, so the lease falls back to the
   * terminal, with what was queued kept aside. A chat still shown then
   * takes the session over again, through the usual handover (/exit, the
   * holder), so the two writers never overlap.
   */
  async function recoverHolderGone(paneId: string): Promise<boolean> {
    const lease = leases.get(paneId);
    if (disposed || !lease || lease.phase !== "conversation") return false;
    // A process the holder ran counts for nothing once the holder is gone
    // (it took its child with it); one started here without a holder does.
    const unheld = () =>
      sessions.get(paneId)?.alive() === true && !channels.has(paneId);
    if (handover.running(paneId) || unheld()) return false;
    if (!(await holderGone(paneId))) return false;
    const ids = [
      ...new Set([lease.session_id, ...(lease.headless_session_ids ?? [])]),
    ];
    // Unsure (the host did not answer): the lease stays.
    if (await options.herdr.headlessRunning(ids).catch(() => true))
      return false;
    if (
      disposed ||
      leases.get(paneId) !== lease ||
      handover.running(paneId) ||
      holders.connected(paneId) ||
      unheld()
    )
      return false;
    const queued = [
      ...(parked.get(paneId) ?? []),
      ...(lease.queue ?? []),
      ...(sessions.get(paneId)?.takeQueue() ?? []),
    ];
    // What read the holder's process goes with it: the turn it showed
    // (a question waiting, say) ended when the holder did.
    const orphan = sessions.get(paneId);
    if (orphan) {
      sessions.delete(paneId);
      orphan.dispose({ detach: true });
    }
    dropChannel(paneId);
    clearStuck(paneId);
    log("the pane holder is gone; the terminal has the session", {
      pane: paneId,
      queued: queued.length,
    });
    unread.delete(paneId);
    leases.delete(paneId);
    if (queued.length) parked.set(paneId, queued);
    emitLease(paneId);
    if (queued.length) emitParked(paneId);
    return true;
  }

  /**
   * Recovers a conversation whose process cannot be read: a holder that is
   * gone hands the session to the terminal (recoverHolderGone); one that
   * runs ends its process, its log is read on from its end, and a new
   * process resumes the session with what was queued. What the ended one
   * was doing is cut short; the transcript keeps what it wrote.
   */
  async function recover(
    paneId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const lease = leases.get(paneId);
    if (!lease || lease.phase !== "conversation")
      return {
        ok: false,
        reason: "Conversation mode does not own this session",
      };
    if (handover.running(paneId))
      return { ok: false, reason: "The session is being handed over" };
    if (!holders.connected(paneId)) {
      if (await recoverLater(paneId)) return { ok: true };
      return {
        ok: false,
        reason: "The pane holder is not connected; try again once it is",
      };
    }
    const channel = channels.get(paneId);
    if (!channel?.holderId())
      return { ok: false, reason: "The pane holder is not connected" };
    log("recovering the conversation process", {
      pane: paneId,
      ...(lost.get(paneId) ? { reason: lost.get(paneId)!.reason } : {}),
    });
    try {
      await channel.abandon({ timeoutMs: holdPollMs + recoverWaitMs });
    } catch (error) {
      if (error instanceof HolderChildStuck)
        return restartThroughTerminal(paneId, error.message);
      const reason = errorText(error);
      setLost(paneId, reason);
      return { ok: false, reason };
    }
    if (disposed || leases.get(paneId)?.phase !== "conversation")
      return {
        ok: false,
        reason: "Conversation mode does not own this session",
      };
    unread.delete(paneId);
    clearLost(paneId);
    clearStuck(paneId);
    if (leases.get(paneId)?.turn_started_at) markTurn(paneId, "restart");
    return startAgain(paneId);
  }

  /**
   * Starts the process a recover ends with: it runs, with the queue on its
   * way, or the chat says why not (never a chat that waits on nothing).
   */
  async function startAgain(
    paneId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await sessionFor(paneId).warm();
      return { ok: true };
    } catch (error) {
      const reason = `Claude did not start again: ${errorText(error)}`;
      log("conversation process did not start", { pane: paneId, reason });
      setLost(paneId, reason);
      return { ok: false, reason };
    }
  }

  /**
   * The holder cannot end its child (it says it runs, for good): it is told
   * to resume claude in the terminal, which clears it, and conversation
   * mode takes the session over again, through a new holder, with what was
   * queued. Only when nothing runs on the session on the host: one still
   * running would be a second writer.
   */
  async function restartThroughTerminal(
    paneId: string,
    why: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const lease = leases.get(paneId);
    if (!lease || lease.phase !== "conversation")
      return {
        ok: false,
        reason: "Conversation mode does not own this session",
      };
    const ids = [
      ...new Set([lease.session_id, ...(lease.headless_session_ids ?? [])]),
    ];
    if (await options.herdr.headlessRunning(ids).catch(() => true)) {
      const reason = `${why}, and a conversation process still runs on the session; end it on the host, then recover again`;
      setLost(paneId, reason);
      return { ok: false, reason };
    }
    if (disposed || leases.get(paneId) !== lease || handover.running(paneId))
      return {
        ok: false,
        reason: "The session changed meanwhile; try again",
      };
    const queued = [
      ...(parked.get(paneId) ?? []),
      ...(lease.queue ?? []),
      ...(sessions.get(paneId)?.takeQueue() ?? []),
    ];
    log("the pane holder cannot end its process; Claude restarts", {
      pane: paneId,
      queued: queued.length,
    });
    const orphan = sessions.get(paneId);
    if (orphan) {
      sessions.delete(paneId);
      orphan.dispose({ detach: true });
    }
    dropChannel(paneId);
    unread.delete(paneId);
    clearLost(paneId);
    clearStuck(paneId);
    leases.delete(paneId);
    if (queued.length) parked.set(paneId, queued);
    else parked.delete(paneId);
    emitLease(paneId);
    emitParked(paneId);
    // Its next poll is told so too (no lease): it ends its child, which
    // reaps it, and becomes claude --resume.
    holders.send(paneId, resumeReply(lease));
    let reason = "Claude did not come back in the terminal";
    for (let left = recoverAttempts; left > 0 && !disposed; left--) {
      await new Promise((resolve) => setTimeout(resolve, recoverRetryMs));
      if (disposed) break;
      if (leases.get(paneId)?.phase === "conversation")
        return startAgain(paneId);
      const result = await toConversation(paneId).catch((error: unknown) =>
        refuse(errorText(error)),
      );
      if (result.ok) return startAgain(paneId);
      reason = result.reason;
    }
    const waiting = parked.get(paneId)?.length ?? 0;
    return {
      ok: false,
      reason: `Claude restarted in the terminal, but the chat could not take it over again (${reason})${waiting ? "; the queued messages wait for it" : ""}`,
    };
  }

  /**
   * Reads again what the holder runs for a session a runtime before this
   * one owned. Nothing runs: a turn it had was cut short, and what was
   * queued starts one.
   */
  function reattach(paneId: string) {
    if (disposed || reattaching.has(paneId)) return;
    reattaching.add(paneId);
    const cutShort = () => {
      if (sessions.get(paneId)?.alive()) return;
      if (leases.get(paneId)?.turn_started_at) markTurn(paneId, "restart");
    };
    let release = () => {};
    void reattachSlot()
      .then(async (done) => {
        release = done;
        if (disposed) return;
        const session = sessionFor(paneId);
        const attached = await session.attach();
        unread.delete(paneId);
        clearLost(paneId);
        if (attached) return;
        // The holder's log, read to its end, shows no child at work.
        cutShort();
        if (session.queueLength()) await session.warm();
      })
      .catch(async (error) => {
        log("conversation process not read again", {
          pane: paneId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Its holder may only be slow to come back (an SSH link): its
        // next poll tries again. One that is gone ran nothing on, and the
        // terminal gets the session back.
        if (!leases.get(paneId) || (await holderGone(paneId))) {
          unread.delete(paneId);
          cutShort();
          void recoverLater(paneId);
        } else if (holders.connected(paneId))
          // Its holder is there, but what it runs cannot be read: the chat
          // says so (Recover), rather than an idle chat that never sends.
          setLost(
            paneId,
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        release();
        reattaching.delete(paneId);
      });
  }

  /**
   * A turn to read a conversation again. After a restart every holder
   * polls at once; most read on from a saved state (a few lines each), but
   * one read again from its child's start parses its whole log: a few at a
   * time, so they do not all load the bridge together.
   */
  const reattachSlot = createSlots(options.reattachLimit ?? 8);

  /** Whether Herdr shows the pane without its holder (a bare shell, say). */
  async function holderGone(paneId: string): Promise<boolean> {
    if (holders.connected(paneId)) return false;
    const info = await options.herdr.processInfo(paneId).catch(() => null);
    if (!info) return false;
    // The shell itself in the foreground: nothing runs in the pane.
    if (
      info.shell_pid !== undefined &&
      info.foreground_process_group_id === info.shell_pid
    )
      return true;
    if (!info.foreground_processes.length) return false;
    return !info.foreground_processes.some((process) =>
      [process.argv0 ?? "", ...(process.argv ?? []), process.cmdline ?? ""]
        .join(" ")
        .includes("roamgate-hold"),
    );
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
    lastPeer.delete(paneId);
    const session = sessions.get(paneId);
    sessions.delete(paneId);
    session?.dispose();
    holders.forget(paneId);
    dropChannel(paneId);
    clearStuck(paneId);
    if (!leases.get(paneId)) return;
    log("the pane of a conversation closed; its lease goes", { pane: paneId });
    leases.delete(paneId);
    emitLease(paneId);
  }

  async function toTerminal(
    paneId: string,
    handoverOptions: { interrupt?: boolean; confirm?: boolean } = {},
  ): Promise<AgentChatHandoverResult> {
    // A start waiting for the API key answer gives up: the terminal asks
    // its own question.
    settleApiKey(
      paneId,
      null,
      new Error("The session went back to the terminal"),
    );
    // Its holder gone (claude in the pane already): the turn it showed is
    // over, and the terminal has the session, whatever was running.
    const held = leases.get(paneId);
    if (
      held?.phase === "conversation" &&
      !holders.connected(paneId) &&
      (await recoverLater(paneId))
    )
      return { ok: true, owner: "terminal", session_id: held.session_id };
    let session = sessions.get(paneId) ?? null;
    // A process the holder runs from before (a restart) is read first: its
    // turn, queue and tasks decide, and stopping it ends it.
    if (!session && leases.get(paneId)?.phase === "conversation")
      try {
        session = sessionFor(paneId);
      } catch {
        session = null;
      }
    const attached = await session?.attach().then(
      () => true,
      () => false,
    );
    // Its state unknown, the holder's child would be ended blind (in the
    // middle of a turn, say).
    if (
      !attached &&
      holders.connected(paneId) &&
      channels.get(paneId)?.childAlive()
    )
      return refuse(
        "Roamgate is still reading the conversation process the pane runs; try again in a moment",
      );
    const result = await handover.toTerminal(paneId, session, handoverOptions);
    if (result.ok && session && !leases.get(paneId)) {
      sessions.delete(paneId);
      session.dispose();
    }
    emitLease(paneId);
    if (!result.ok)
      log("hand back refused", { pane: paneId, reason: result.reason });
    return result;
  }

  return {
    state,
    lease: (paneId: string) => leases.get(paneId),
    /**
     * Why nothing may be typed into the pane now, if so: a handover runs
     * (Claude is exiting, or the holder starting) and text would land in
     * the dying TUI or the bare shell.
     */
    inputRefusal(paneId: string): string | null {
      const phase = leases.get(paneId)?.phase;
      return handover.running(paneId) ||
        phase === "to_conversation" ||
        phase === "to_terminal"
        ? "The session is being handed over; try again in a moment"
        : null;
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
    ) {
      const session = sessionFor(paneId);
      // Whatever is sent next answers the turn cut short.
      clearInterrupted(paneId);
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
        parked.set(paneId, [...(parked.get(paneId) ?? []), item]);
        emitParked(paneId);
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
      if (promptOptions.peer) lastPeer.set(paneId, Date.now());
      const session = sessionFor(paneId);
      beforeSend?.();
      clearInterrupted(paneId);
      await session.send({ text });
      return true;
    },
    voice(
      paneId: string,
      input: { text: string; stop?: boolean; uuid?: string },
    ) {
      const session = sessionFor(paneId);
      if (!input.stop && !isSpokenStop(input.text)) clearInterrupted(paneId);
      return session.voice(input);
    },
    /** The user dismissed the notice of a turn cut short. */
    dismissInterrupted: clearInterrupted,
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
    /** A `!` line typed in the chat: runs it (runShell). */
    shell: runShell,
    /** Stops a `!` line that runs; false when it is not running. */
    stopShell,
    /**
     * Rewinds the session conversation mode owns to before one of the
     * user's messages (ConversationSession.rewind); the terminal does its
     * own.
     */
    async rewind(
      paneId: string,
      input: {
        uuid: string;
        lastSeen?: string;
        mode: AgentChatRewindMode;
        interrupt?: boolean;
      },
    ): Promise<AgentChatRewindResult> {
      const lease = leases.get(paneId);
      if (disposed || !lease || lease.phase !== "conversation")
        return {
          ok: false,
          reason: lease
            ? "This session is being handed over; try again shortly"
            : "The terminal owns this session",
        };
      const result = await sessionFor(paneId).rewind(input);
      // What was cut short is rewound away, or restored.
      if (result.ok && input.mode !== "code") clearInterrupted(paneId);
      return result;
    },
    /**
     * What a rewind to before `uuid` could do to the code, from the pane's
     * transcript: for the sheet, before the user picks. The terminal's
     * session is read the same way.
     */
    async rewindCheck(
      paneId: string,
      uuid: string,
    ): Promise<AgentChatRewindCheck> {
      const session = sessions.get(paneId);
      if (session) return session.rewindCheck(uuid);
      if (disposed || !options.readTranscript) return { code: "unknown" };
      try {
        const rewind = driverOf(paneId).protocol.rewind;
        if (!rewind) return { code: "unknown" };
        const transcript = await options.readTranscript(paneId);
        // Without a session: the terminal's transcript, read the same way.
        return rewind.checkTranscript(transcript, uuid);
      } catch {
        return { code: "unknown" };
      }
    },
    interrupt,
    editQueued(paneId: string, id: string, text: string) {
      const session = sessions.get(paneId);
      if (session) return session.editQueued(id, text);
      const item = parked.get(paneId)?.find((each) => each.id === id);
      if (!item) return false;
      item.text = text.trim();
      emitParked(paneId);
      return true;
    },
    removeQueued(paneId: string, id: string) {
      const session = sessions.get(paneId);
      if (session) return session.removeQueued(id);
      const waiting = parked.get(paneId) ?? [];
      const item = waiting.find((each) => each.id === id) ?? null;
      if (!item) return null;
      const rest = waiting.filter((each) => each !== item);
      if (rest.length) parked.set(paneId, rest);
      else parked.delete(paneId);
      emitParked(paneId);
      return item;
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
        : toTerminal(paneId, { interrupt: handoverOptions.interrupt });
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

    /** roamgate-hold's requests, from the review socket. */
    holder: {
      async hold(input: {
        paneId: string;
        sessionId: string;
        signal: AbortSignal;
        /** What a holder that runs the headless claude says of it. */
        status?: HolderStatus | null;
      }): Promise<HolderReply> {
        const lease = leases.get(input.paneId);
        if (lease?.phase === "terminal")
          // Nothing headless runs on the session: claude may resume.
          return {
            action: "resume",
            session_id: lease.session_id,
            cwd: lease.cwd,
          };
        if (!lease) {
          const was = released.get(input.paneId);
          if (was && Date.now() - was.at < releasedMs)
            // Handed back here: it missed the reply that said so.
            return {
              action: "resume",
              session_id: was.session_id,
              cwd: was.cwd,
            };
          // Unknown here: it keeps holding (Enter in the pane still asks
          // for the session back), polling at the usual pace.
          if (!strangers.has(input.paneId)) {
            strangers.add(input.paneId);
            log(
              "a holder this runtime does not know polled; it keeps holding",
              {
                pane: input.paneId,
              },
            );
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, holdPollMs);
            input.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          return { action: "hold", session_id: input.sessionId };
        }
        const channel = input.status ? channelFor(input.paneId) : null;
        if (channel && input.status) channel.update(input.status);
        // Answered elsewhere meanwhile (Claude Code's own question, in a
        // terminal on the host): the start goes on with that answer.
        if (input.status && input.status.apiKey !== "new")
          settleApiKey(input.paneId, null);
        // A holder back after the runtime before this one went: what it
        // runs is read again now.
        if (
          (channel || options.spawn) &&
          lease.phase === "conversation" &&
          unread.has(input.paneId)
        )
          reattach(input.paneId);
        if (channel?.hasWork()) {
          holders.touch(input.paneId, input.sessionId);
          return {
            action: "hold",
            session_id: lease.session_id,
            ...channel.work(),
          };
        }
        const reply = await holders.wait(
          input.paneId,
          { action: "hold", session_id: lease.session_id },
          holdPollMs,
          input.signal,
          input.sessionId,
        );
        // The commands that woke it (or that wait), and where the log is
        // read from.
        return reply.action === "hold" && channel
          ? { ...reply, ...channel.work() }
          : reply;
      },
      /** A holder sending its log: what Roamgate takes, once. */
      output(input: {
        paneId: string;
        holderId: string;
        offset: number;
        end: number;
        data: string;
      }): { offset?: number } {
        const channel = channels.get(input.paneId);
        return channel ? channel.receive(input) : {};
      },
      async handback(input: { paneId: string }): Promise<HolderReply> {
        const lease = leases.get(input.paneId);
        if (!lease) return { action: "resume", session_id: "", cwd: "" };
        const result = await toTerminal(input.paneId, { confirm: false });
        if (!result.ok) return { action: "refused", reason: result.reason };
        // Herdr maps the pane again once claude starts; checked meanwhile.
        void handover
          .confirmMapping(input.paneId, lease.session_id)
          .then((confirmed) => {
            if (!confirmed)
              log("Herdr did not map the pane to its session again", {
                pane: input.paneId,
              });
          });
        return resumeReply(lease);
      },
    },

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
      if (holderWatch) clearInterval(holderWatch);
      if (stuckWatch) clearInterval(stuckWatch);
      if (idleWatch) clearInterval(idleWatch);
      for (const timer of stopTimers.values()) clearTimeout(timer);
      stopTimers.clear();
      if (disposed) return;
      for (const [paneId, session] of sessions) {
        const queued: AgentChatQueued[] = session.takeQueue();
        const lease = leases.get(paneId);
        if (queued.length && lease)
          leases.set({ ...lease, queue: [...(lease.queue ?? []), ...queued] });
      }
      // Where each holder's log was read to, and what it was not sent yet:
      // the runtime after this one reads on from there.
      for (const paneId of channels.keys()) saveHolder(paneId);
      disposed = true;
      // The connection closes: its `!` lines end with it.
      for (const run of shellRuns.values()) run.stop();
      for (const timer of shellTimers.values()) clearTimeout(timer);
      if (carriedTimer) clearTimeout(carriedTimer);
      // The holders run the processes on.
      for (const session of sessions.values())
        session.dispose({ detach: true });
      sessions.clear();
      for (const paneId of [...channels.keys()]) dropChannel(paneId);
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
