import type {
  AgentChatHandoverResult,
  AgentChatLease,
} from "../../../shared/agentChat";
import type { conversationDriver } from "./drivers";
import type { SpawnHeadless } from "./headless";
import type { ConversationHerdr } from "./herdr";
import { type HolderRegistry, type HolderReply, resumeReply } from "./holder";
import type { LeaseStore } from "./lease";
import {
  createHolderChannel,
  type HolderChannel,
  type HolderCommand,
  type HolderStatus,
} from "./pane-child";

/** A lease this runtime dropped, lately: its holder may have missed it. */
export type ReleasedLease = { session_id: string; cwd: string; at: number };

/**
 * The leases as a runtime changes them: none once it is closing (a
 * runtime replacing it, a reconnect, owns them), and the panes whose lease
 * it dropped lately kept aside. A holder still polling there missed its
 * resume, and gets it. A holder this runtime never knew (another Roamgate
 * on the same host socket, a lease file from elsewhere) is not told to
 * resume: that would end its process and put claude in a pane some other
 * Roamgate holds.
 */
export function releasingLeases(store: LeaseStore, closed: () => boolean) {
  const released = new Map<string, ReleasedLease>();
  const leases: LeaseStore = {
    ...store,
    set(lease) {
      if (closed()) throw new Error("The connection is closing");
      released.delete(lease.pane_id);
      return store.set(lease);
    },
    delete(paneId) {
      if (closed()) throw new Error("The connection is closing");
      const lease = store.get(paneId);
      if (lease)
        released.set(paneId, {
          session_id: lease.session_id,
          cwd: lease.cwd,
          at: Date.now(),
        });
      store.delete(paneId);
    },
  };
  return { leases, released };
}

/** What the holders' side of a runtime needs of it. */
export type HolderSideDeps = {
  leases: LeaseStore;
  released: Map<string, ReleasedLease>;
  holders: HolderRegistry;
  herdr: ConversationHerdr;
  /** How long a holder's poll is held before it polls again. */
  holdPollMs: number;
  /** How often what was read of a holder's log is saved on its lease. */
  holderSaveMs: number;
  /** Tests give their own spawn: a holder then reads nothing. */
  ownSpawn: boolean;
  closed: () => boolean;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** The pane's driver pair: its lease's agent. */
  driverOf: (paneId: string) => ReturnType<typeof conversationDriver>;
  /**
   * Where the pane's session handled its process's lines to
   * (ConversationSession.resumeState); undefined: no session, or not
   * known yet.
   */
  resumeState: (
    paneId: string,
  ) => NonNullable<AgentChatLease["holder"]>["resume"] | null | undefined;
  /** The API key question is moot: answered in a terminal on the host. */
  settleApiKey: (paneId: string) => void;
  /** Whether what the pane's holder runs is still to be read again. */
  unread: (paneId: string) => boolean;
  reattach: (paneId: string) => void;
  toTerminal: (
    paneId: string,
    options: { confirm?: boolean },
  ) => Promise<AgentChatHandoverResult>;
  /** Whether Herdr maps the pane to the session again (Handover). */
  confirmMapping: (paneId: string, sessionId: string) => Promise<boolean>;
};

/**
 * The pane holders (roamgate-hold) as one runtime sees them: each one's
 * channel (its commands, its log, its children), saved on its lease as it
 * is read, their requests from the review socket, and the headless process
 * they run for conversation mode.
 */
export function createHolderSide(deps: HolderSideDeps) {
  const { leases, released, holders, log } = deps;
  const releasedMs = 10 * 60_000;
  // Unknown holders already logged.
  const strangers = new Set<string>();
  // Each pane holder's end here: its commands, its log, its children.
  const channels = new Map<string, HolderChannel>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      deps.resumeState(paneId);
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
      inputKind: (line) => deps.driverOf(paneId).protocol.inputKind(line),
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
        if (!deps.closed()) saveHolder(paneId);
      },
      onOffset: () => {
        if (deps.closed() || saveTimers.has(paneId)) return;
        saveTimers.set(
          paneId,
          setTimeout(() => {
            if (!deps.closed()) saveHolder(paneId);
          }, deps.holderSaveMs),
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
      command: deps.driverOf(spawn.paneId).protocol.startCommand(spawn),
      ...(spawn.attachOnly ? { attachOnly: true } : {}),
      ...(spawn.signal ? { signal: spawn.signal } : {}),
    });
  };

  /** Whether Herdr shows the pane without its holder (a bare shell, say). */
  async function holderGone(paneId: string): Promise<boolean> {
    if (holders.connected(paneId)) return false;
    const info = await deps.herdr.processInfo(paneId).catch(() => null);
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

  /** roamgate-hold's requests, from the review socket. */
  const endpoints = {
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
          log("a holder this runtime does not know polled; it keeps holding", {
            pane: input.paneId,
          });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, deps.holdPollMs);
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
        deps.settleApiKey(input.paneId);
      // A holder back after the runtime before this one went: what it
      // runs is read again now.
      if (
        (channel || deps.ownSpawn) &&
        lease.phase === "conversation" &&
        deps.unread(input.paneId)
      )
        deps.reattach(input.paneId);
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
        deps.holdPollMs,
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
      const result = await deps.toTerminal(input.paneId, { confirm: false });
      if (!result.ok) return { action: "refused", reason: result.reason };
      // Herdr maps the pane again once claude starts; checked meanwhile.
      void deps
        .confirmMapping(input.paneId, lease.session_id)
        .then((confirmed) => {
          if (!confirmed)
            log("Herdr did not map the pane to its session again", {
              pane: input.paneId,
            });
        });
      return resumeReply(lease);
    },
  };

  return {
    /** The pane holder's channel, if it said it runs one. */
    channel: (paneId: string) => channels.get(paneId),
    hasChannel: (paneId: string) => channels.has(paneId),
    saveHolder,
    dropChannel,
    holderSpawn,
    holderGone,
    endpoints,
    /**
     * Where each holder's log was read to, and what it was not sent yet,
     * saved: the runtime after this one reads on from there.
     */
    saveAll() {
      for (const paneId of channels.keys()) saveHolder(paneId);
    },
    dropAll() {
      for (const paneId of [...channels.keys()]) dropChannel(paneId);
    },
  };
}
