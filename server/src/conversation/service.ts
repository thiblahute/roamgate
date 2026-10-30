import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatHandoverResult,
  AgentChatInterrupted,
  AgentChatQueued,
  AgentChatState,
  AgentChatStatus,
} from "../../../shared/agentChat";
import type { AgentPromptAnswer } from "../../../shared/review";
import { createHandover, type HandoverDeps } from "./handover";
import { type ConversationHerdr, isClaudeProcess } from "./herdr";
import { holderStartCommand, type SpawnHeadless } from "./headless";
import { createHolderRegistry, type HolderReply } from "./holder";
import type { LeaseStore } from "./lease";
import {
  createHolderChannel,
  type HolderChannel,
  type HolderCommand,
  type HolderStatus,
} from "./pane-child";
import {
  type ConversationImage,
  type ConversationPrompt,
  type ConversationSession,
  type ConversationSessionOptions,
  createConversationSession,
  isSpokenStop,
} from "./session";

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
    >
  >;
  /** How long a holder's poll is held before it polls again. */
  holdPollMs?: number;
  /**
   * How long after start the sessions a runtime before this one owned are
   * read again (their holders run their processes on), and what they had
   * queued is sent.
   */
  carriedQueueDelayMs?: number;
  /** How often what was read of a holder's log is saved on its lease. */
  holderSaveMs?: number;
  /** A pane's lease changed (owner, or the session after /clear). */
  onLeaseChanged?: (paneId: string) => void;
};

export type AgentChatView = "chat" | "terminal";

function refuse(reason: string): AgentChatHandoverResult {
  return { ok: false, reason };
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
 * Conversation mode on one connection: the sessions it owns (each with its
 * headless claude), the handovers to and from the panes' terminals, the
 * panes' holders, and the browsers watching each pane.
 */
export function createConversationService<Ws>(
  options: ConversationServiceOptions<Ws>,
) {
  const log = options.log ?? (() => {});
  let disposed = false;
  // Once disposed, this service changes no lease: a runtime replacing it
  // (a reconnect) owns them, and a handover still running here stops.
  const leases: LeaseStore = {
    ...options.leases,
    set(lease) {
      if (disposed) throw new Error("The connection is closing");
      return options.leases.set(lease);
    },
    delete(paneId) {
      if (disposed) throw new Error("The connection is closing");
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
    ...options.handover,
  });
  const sessions = new Map<string, ConversationSession>();
  const subscribers = new Map<string, Set<Ws>>();
  // What each browser shows of a pane right now (visible only): the chat
  // or the terminal. Automatic handovers go by it (see handover below).
  const views = new Map<string, Map<Ws, AgentChatView>>();
  const holdPollMs = options.holdPollMs ?? 25_000;
  const holderSaveMs = options.holderSaveMs ?? 1000;
  // Each pane holder's end here: its commands, its log, its children.
  const channels = new Map<string, HolderChannel>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    leases.set({ ...lease, holder: saved });
  }

  function channelFor(paneId: string): HolderChannel {
    let channel = channels.get(paneId);
    if (channel) return channel;
    const saved = leases.get(paneId)?.holder;
    channel = createHolderChannel({
      paneId,
      saved: saved
        ? {
            id: saved.id,
            offset: saved.offset,
            ...(saved.pending
              ? { pending: saved.pending as HolderCommand[] }
              : {}),
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
      command: holderStartCommand(spawn),
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
    if (!lease) dropChannel(paneId);
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
      if (!held)
        throw new Error(
          "The pane holder is not running; show the terminal to take the session back",
        );
      // What the holder runs already (or ran while nobody read) comes
      // first: it is the session's one writer.
      const attached = await spawnHeadless({ ...spawn, attachOnly: true });
      if (attached || spawn.attachOnly) return attached;
      const ids = [
        ...new Set([
          lease.session_id,
          spawn.sessionId,
          ...(lease.headless_session_ids ?? []),
        ]),
      ];
      const info = await options.herdr.processInfo(paneId);
      const running = await options.herdr.headlessRunning(ids);
      if (info.foreground_processes.some(isClaudeProcess)) {
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
          `${elsewhere}; conversation mode will not start a second writer`,
        );
      const holderSession = holders.session(paneId);
      if (holderSession && !ids.includes(holderSession))
        throw new Error("The pane holder holds another session");
      const current = leases.get(paneId);
      if (!current || current.phase !== "conversation" || disposed)
        throw new Error("Conversation mode does not own this session");
      return spawnHeadless(spawn);
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
      sessionId: lease.session_id,
      cwd: lease.cwd,
      spawn: guardedSpawn(paneId),
      emit: (event) => emit(paneId, event),
      ask: (prompt) => options.ask(paneId, prompt),
      readImage: options.readImage,
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
      onStatus: (status) => report(paneId, status),
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

  function state(paneId: string): AgentChatState {
    const lease = leases.get(paneId);
    const session = sessions.get(paneId);
    const live = session?.state();
    return {
      pane_id: paneId,
      owner: lease?.owner ?? "terminal",
      phase: lease?.phase ?? "terminal",
      session_id: lease?.session_id ?? null,
      cwd: lease?.cwd ?? null,
      status: live?.status ?? "stopped",
      tools_running: live?.tools_running ?? false,
      activity: live?.activity ?? null,
      queue: live?.queue ?? lease?.queue ?? [],
      interrupted: lease?.interrupted ?? null,
    };
  }

  async function toConversation(
    paneId: string,
    sessionId?: string,
  ): Promise<AgentChatHandoverResult> {
    const result = await handover.toConversation(paneId, sessionId);
    emitLease(paneId);
    if (!result.ok) {
      log("conversation mode refused", { pane: paneId, reason: result.reason });
      return result;
    }
    if (disposed) return refuse("The connection is closing");
    report(paneId, "idle");
    warm(paneId);
    return result;
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
    void Promise.resolve()
      .then(async () => {
        const session = sessionFor(paneId);
        const attached = await session.attach();
        unread.delete(paneId);
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
        // next poll tries again. One that is gone ran nothing on.
        if (!leases.get(paneId) || (await holderGone(paneId))) {
          unread.delete(paneId);
          cutShort();
        }
      })
      .finally(() => reattaching.delete(paneId));
  }

  /** Whether Herdr shows the pane without its holder (a bare shell, say). */
  async function holderGone(paneId: string): Promise<boolean> {
    if (holders.connected(paneId)) return false;
    const info = await options.herdr.processInfo(paneId).catch(() => null);
    if (!info?.foreground_processes.length) return false;
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
    const session = sessions.get(paneId);
    sessions.delete(paneId);
    session?.dispose();
    holders.forget(paneId);
    dropChannel(paneId);
    if (!leases.get(paneId)) return;
    log("the pane of a conversation closed; its lease goes", { pane: paneId });
    leases.delete(paneId);
    emitLease(paneId);
  }

  async function toTerminal(
    paneId: string,
    handoverOptions: { interrupt?: boolean; confirm?: boolean } = {},
  ): Promise<AgentChatHandoverResult> {
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

  function setView(ws: Ws, paneId: string, view: AgentChatView | null) {
    let shown = views.get(paneId);
    if (view) {
      if (!shown) {
        shown = new Map();
        views.set(paneId, shown);
      }
      shown.set(ws, view);
      return;
    }
    shown?.delete(ws);
    if (shown && !shown.size) views.delete(paneId);
  }

  /**
   * Why an automatic handover asked by `ws` may not go ahead: another
   * browser shows the pane in the view that keeps the session where it is.
   * The server arbitrates, so two devices never hand it back and forth.
   */
  function shownElsewhere(
    paneId: string,
    ws: Ws | undefined,
    to: "conversation" | "terminal",
  ): string | null {
    const keeps: AgentChatView = to === "conversation" ? "terminal" : "chat";
    for (const [other, view] of views.get(paneId) ?? [])
      if (other !== ws && view === keeps)
        return keeps === "terminal"
          ? "It is shown as a terminal on another device; switch from here to take it over anyway"
          : "It is shown as a chat on another device; switch from here to take it back anyway";
    return null;
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

    subscribe(
      ws: Ws,
      paneId: string,
      view?: AgentChatView | null,
    ): AgentChatState {
      let watchers = subscribers.get(paneId);
      if (!watchers) {
        watchers = new Set();
        subscribers.set(paneId, watchers);
      }
      watchers.add(ws);
      if (view !== undefined) setView(ws, paneId, view);
      const streamed = sessions.get(paneId)?.streamed() ?? [];
      return streamed.length ? { ...state(paneId), streamed } : state(paneId);
    },
    /** What this browser shows of the pane now; null: nothing visible. */
    view(ws: Ws, paneId: string, view: AgentChatView | null) {
      setView(ws, paneId, view);
    },
    unsubscribe(ws: Ws, paneId: string) {
      const watchers = subscribers.get(paneId);
      watchers?.delete(ws);
      if (watchers && !watchers.size) subscribers.delete(paneId);
      setView(ws, paneId, null);
    },
    cleanupWs(ws: Ws) {
      for (const [paneId, watchers] of subscribers) {
        watchers.delete(ws);
        if (!watchers.size) subscribers.delete(paneId);
      }
      for (const paneId of [...views.keys()]) setView(ws, paneId, null);
    },

    send(
      paneId: string,
      input: { text: string; images?: string[]; uuid?: string },
    ) {
      const session = sessionFor(paneId);
      // Whatever is sent next answers the turn cut short.
      clearInterrupted(paneId);
      return session.send(input);
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
    interrupt: (paneId: string) =>
      sessions.get(paneId)?.interrupt() ?? Promise.resolve(false),
    editQueued(paneId: string, id: string, text: string) {
      return sessions.get(paneId)?.editQueued(id, text) ?? false;
    },
    removeQueued(paneId: string, id: string) {
      return sessions.get(paneId)?.removeQueued(id) ?? null;
    },

    /**
     * Asked by a browser. An automatic one (it follows the view shown) goes
     * ahead only when no other browser shows the pane in the other view;
     * an explicit one (the user's switch) always does, the safety checks
     * aside.
     */
    handover(
      paneId: string,
      to: "conversation" | "terminal",
      handoverOptions: {
        interrupt?: boolean;
        session_id?: string;
        auto?: boolean;
        ws?: Ws;
      } = {},
    ): Promise<AgentChatHandoverResult> {
      if (disposed)
        return Promise.resolve({
          ok: false,
          reason: "The connection is closing",
        });
      if (handoverOptions.auto) {
        const reason = shownElsewhere(paneId, handoverOptions.ws, to);
        if (reason) {
          log("automatic handover refused", { pane: paneId, to, reason });
          return Promise.resolve({ ok: false, reason });
        }
      }
      return to === "conversation"
        ? toConversation(paneId, handoverOptions.session_id)
        : toTerminal(paneId, { interrupt: handoverOptions.interrupt });
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
        if (!lease || lease.phase === "terminal")
          // Nothing headless runs on the session: claude may resume.
          return {
            action: "resume",
            session_id: lease?.session_id ?? input.sessionId,
            cwd: lease?.cwd ?? "",
          };
        const channel = input.status ? channelFor(input.paneId) : null;
        if (channel && input.status) channel.update(input.status);
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
        return {
          action: "resume",
          session_id: lease.session_id,
          cwd: lease.cwd,
          args: [...(lease.terminal_args ?? []), "--resume", lease.session_id],
        };
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
      }
    },
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
    }[] {
      return leases.all().map((lease) => {
        const status = sessions.get(lease.pane_id)?.state().status;
        return {
          pane_id: lease.pane_id,
          session_id: lease.session_id,
          cwd: lease.cwd,
          phase: lease.phase,
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
