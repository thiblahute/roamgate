import type {
  AgentChatEvent,
  AgentChatHandoverResult,
  AgentChatInterrupted,
  AgentChatLost,
  AgentChatQueued,
} from "../../../shared/agentChat";
import type { ConversationHerdr } from "./herdr";
import { type HolderRegistry, resumeReply } from "./holder";
import type { LeaseStore } from "./lease";
import type { AgentCommand } from "../profiles/profiles";
import { type HolderChannel, HolderChildStuck } from "./pane-child";
import type { ConversationSession } from "./session";

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Recovered = { ok: true } | { ok: false; reason: string };

/** What recovering conversations needs of its runtime. */
export type RecoveryDeps = {
  leases: LeaseStore;
  sessions: Map<string, ConversationSession>;
  holders: HolderRegistry;
  herdr: ConversationHerdr;
  /** Whether a handover runs in the pane. */
  handingOver: (paneId: string) => boolean;
  /** The pane holder's side (service-holders.ts). */
  holderSide: {
    channel: (paneId: string) => HolderChannel | undefined;
    hasChannel: (paneId: string) => boolean;
    dropChannel: (paneId: string) => void;
    holderGone: (paneId: string) => Promise<boolean>;
  };
  sessionFor: (paneId: string) => ConversationSession;
  emit: (paneId: string, event: AgentChatEvent) => void;
  emitLease: (paneId: string) => void;
  markTurn: (
    paneId: string,
    mark: "running" | "ended" | AgentChatInterrupted["reason"],
  ) => void;
  clearStuck: (paneId: string) => void;
  toConversation: (paneId: string) => Promise<AgentChatHandoverResult>;
  closed: () => boolean;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** How long a holder's poll is held before it polls again. */
  holdPollMs: number;
  /** How often owned panes are checked for a holder gone (0: never). */
  holderWatchMs: number;
  /** How long a recover waits, past a poll, for the holder's child. */
  recoverWaitMs: number;
  /** How often, and how many times, a restart takes the session again. */
  recoverRetryMs: number;
  recoverAttempts: number;
  /** How long after start the sessions owned before are read again. */
  carriedQueueDelayMs: number;
  /** How many conversations are read again at once after a restart. */
  reattachLimit: number;
  /** The profile a session resumes with in the terminal. */
  resumeProfile: (sessionId: string) => AgentCommand | undefined;
};

/**
 * The conversations whose process cannot be read or whose holder is gone:
 * what was queued meanwhile, kept aside; reading again those a runtime
 * before this one owned; and Recover, which starts a process again or
 * gives the session back to the terminal.
 */
export function createRecovery(deps: RecoveryDeps) {
  const { leases, sessions, holders, holderSide, emit, log } = deps;
  // Messages sent to a conversation whose holder was gone (the host
  // restarted): kept while the terminal has the session, never typed into
  // it, and sent once conversation mode has it again.
  const parked = new Map<string, AgentChatQueued[]>();
  const recovering = new Map<string, Promise<boolean>>();
  // Panes whose conversation process cannot be read (its holder runs, its
  // log does not come through): the chat says so, with Recover.
  const lost = new Map<string, AgentChatLost>();

  // A holder that stops polling with no word (the pane's process gone, or
  // claude in its place) leaves a turn that never ends: what read its
  // process gives up, and the terminal has the session (recoverHolderGone,
  // which checks the pane first).
  const holderWatch =
    deps.holderWatchMs > 0
      ? setInterval(() => {
          if (deps.closed()) return;
          for (const lease of leases.all())
            if (
              lease.phase === "conversation" &&
              !deps.handingOver(lease.pane_id) &&
              !holders.connected(lease.pane_id, deps.holdPollMs + 10_000)
            )
              void recoverLater(lease.pane_id);
        }, deps.holderWatchMs)
      : null;
  (holderWatch as { unref?: () => void } | null)?.unref?.();

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
      }, deps.carriedQueueDelayMs)
    : null;

  /** The chat says the conversation process cannot be read, and why. */
  function setLost(paneId: string, reason: string) {
    if (deps.closed() || leases.get(paneId)?.phase !== "conversation") return;
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
    if (deps.closed() || !lease || lease.phase !== "conversation") return false;
    // A process the holder ran counts for nothing once the holder is gone
    // (it took its child with it); one started here without a holder does.
    const unheld = () =>
      sessions.get(paneId)?.alive() === true && !holderSide.hasChannel(paneId);
    if (deps.handingOver(paneId) || unheld()) return false;
    if (!(await holderSide.holderGone(paneId))) return false;
    const ids = [
      ...new Set([lease.session_id, ...(lease.headless_session_ids ?? [])]),
    ];
    // Unsure (the host did not answer): the lease stays.
    if (await deps.herdr.headlessRunning(ids).catch(() => true)) return false;
    if (
      deps.closed() ||
      leases.get(paneId) !== lease ||
      deps.handingOver(paneId) ||
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
    holderSide.dropChannel(paneId);
    deps.clearStuck(paneId);
    log("the pane holder is gone; the terminal has the session", {
      pane: paneId,
      queued: queued.length,
    });
    unread.delete(paneId);
    leases.delete(paneId);
    if (queued.length) parked.set(paneId, queued);
    deps.emitLease(paneId);
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
  async function recover(paneId: string): Promise<Recovered> {
    const lease = leases.get(paneId);
    if (!lease || lease.phase !== "conversation")
      return {
        ok: false,
        reason: "Conversation mode does not own this session",
      };
    if (deps.handingOver(paneId))
      return { ok: false, reason: "The session is being handed over" };
    if (!holders.connected(paneId)) {
      if (await recoverLater(paneId)) return { ok: true };
      return {
        ok: false,
        reason: "The pane holder is not connected; try again once it is",
      };
    }
    const channel = holderSide.channel(paneId);
    if (!channel?.holderId())
      return { ok: false, reason: "The pane holder is not connected" };
    log("recovering the conversation process", {
      pane: paneId,
      ...(lost.get(paneId) ? { reason: lost.get(paneId)!.reason } : {}),
    });
    try {
      await channel.abandon({
        timeoutMs: deps.holdPollMs + deps.recoverWaitMs,
      });
    } catch (error) {
      if (error instanceof HolderChildStuck)
        return restartThroughTerminal(paneId, error.message);
      const reason = errorText(error);
      setLost(paneId, reason);
      return { ok: false, reason };
    }
    if (deps.closed() || leases.get(paneId)?.phase !== "conversation")
      return {
        ok: false,
        reason: "Conversation mode does not own this session",
      };
    unread.delete(paneId);
    clearLost(paneId);
    deps.clearStuck(paneId);
    if (leases.get(paneId)?.turn_started_at) deps.markTurn(paneId, "restart");
    return startAgain(paneId);
  }

  /**
   * Starts the process a recover ends with: it runs, with the queue on its
   * way, or the chat says why not (never a chat that waits on nothing).
   */
  async function startAgain(paneId: string): Promise<Recovered> {
    try {
      await deps.sessionFor(paneId).warm();
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
  ): Promise<Recovered> {
    const lease = leases.get(paneId);
    if (!lease || lease.phase !== "conversation")
      return {
        ok: false,
        reason: "Conversation mode does not own this session",
      };
    const ids = [
      ...new Set([lease.session_id, ...(lease.headless_session_ids ?? [])]),
    ];
    if (await deps.herdr.headlessRunning(ids).catch(() => true)) {
      const reason = `${why}, and a conversation process still runs on the session; end it on the host, then recover again`;
      setLost(paneId, reason);
      return { ok: false, reason };
    }
    if (
      deps.closed() ||
      leases.get(paneId) !== lease ||
      deps.handingOver(paneId)
    )
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
    holderSide.dropChannel(paneId);
    unread.delete(paneId);
    clearLost(paneId);
    deps.clearStuck(paneId);
    leases.delete(paneId);
    if (queued.length) parked.set(paneId, queued);
    else parked.delete(paneId);
    deps.emitLease(paneId);
    emitParked(paneId);
    // Its next poll is told so too (no lease): it ends its child, which
    // reaps it, and becomes claude --resume.
    holders.send(
      paneId,
      resumeReply(lease, deps.resumeProfile(lease.session_id)),
    );
    let reason = "Claude did not come back in the terminal";
    for (let left = deps.recoverAttempts; left > 0 && !deps.closed(); left--) {
      await new Promise((resolve) => setTimeout(resolve, deps.recoverRetryMs));
      if (deps.closed()) break;
      if (leases.get(paneId)?.phase === "conversation")
        return startAgain(paneId);
      const result = await deps.toConversation(paneId).catch(
        (error: unknown): AgentChatHandoverResult => ({
          ok: false,
          reason: errorText(error),
        }),
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
   * A turn to read a conversation again. After a restart every holder
   * polls at once; most read on from a saved state (a few lines each), but
   * one read again from its child's start parses its whole log: a few at a
   * time, so they do not all load the bridge together.
   */
  const reattachSlot = createSlots(deps.reattachLimit);

  /**
   * Reads again what the holder runs for a session a runtime before this
   * one owned. Nothing runs: a turn it had was cut short, and what was
   * queued starts one.
   */
  function reattach(paneId: string) {
    if (deps.closed() || reattaching.has(paneId)) return;
    reattaching.add(paneId);
    const cutShort = () => {
      if (sessions.get(paneId)?.alive()) return;
      if (leases.get(paneId)?.turn_started_at) deps.markTurn(paneId, "restart");
    };
    let release = () => {};
    void reattachSlot()
      .then(async (done) => {
        release = done;
        if (deps.closed()) return;
        const session = deps.sessionFor(paneId);
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
        if (!leases.get(paneId) || (await holderSide.holderGone(paneId))) {
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

  return {
    setLost,
    clearLost,
    /** Why the pane's process cannot be read, a copy; null: it can. */
    lost: (paneId: string): AgentChatLost | null => {
      const current = lost.get(paneId);
      return current ? { ...current } : null;
    },
    /** The pane's lease went: nothing is lost there any more. */
    forgetLost: (paneId: string) => lost.delete(paneId),
    /** The messages kept while the terminal has the session, copies. */
    parked: (paneId: string): AgentChatQueued[] | null => {
      const waiting = parked.get(paneId);
      return waiting ? waiting.map((item) => ({ ...item })) : null;
    },
    /** Keeps a message for when conversation mode has the session again. */
    park(paneId: string, item: AgentChatQueued) {
      parked.set(paneId, [...(parked.get(paneId) ?? []), item]);
      emitParked(paneId);
    },
    editParked(paneId: string, id: string, text: string): boolean {
      const item = parked.get(paneId)?.find((each) => each.id === id);
      if (!item) return false;
      item.text = text.trim();
      emitParked(paneId);
      return true;
    },
    removeParked(paneId: string, id: string): AgentChatQueued | null {
      const waiting = parked.get(paneId) ?? [];
      const item = waiting.find((each) => each.id === id) ?? null;
      if (!item) return null;
      const rest = waiting.filter((each) => each !== item);
      if (rest.length) parked.set(paneId, rest);
      else parked.delete(paneId);
      emitParked(paneId);
      return item;
    },
    carryParked,
    recoverLater,
    recover,
    startAgain,
    /** Whether what the pane's holder runs is still to be read again. */
    unread: (paneId: string) => unread.has(paneId),
    reattach,
    dispose() {
      if (holderWatch) clearInterval(holderWatch);
      if (carriedTimer) clearTimeout(carriedTimer);
    },
  };
}
