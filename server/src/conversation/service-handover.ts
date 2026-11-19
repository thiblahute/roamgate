import type {
  AgentChatHandoverResult,
  AgentChatStatus,
} from "../../../shared/agentChat";
import type { ApiKeyAnswer } from "./env";
import type { Handover } from "./handover";
import type { HolderRegistry } from "./holder";
import type { LeaseStore } from "./lease";
import type { HolderChannel } from "./pane-child";
import type { ConversationSession } from "./session";
import type { SuspendedStore } from "./suspended";

/** What a runtime's switches need of it. */
export type SwitchDeps = {
  handover: Handover;
  leases: LeaseStore;
  sessions: Map<string, ConversationSession>;
  holders: HolderRegistry;
  /** The pane holder's channel, if it said it runs one. */
  channel: (paneId: string) => HolderChannel | undefined;
  sessionFor: (paneId: string) => ConversationSession;
  /** The conversations stopped as shell jobs (Ctrl+Z), per pane. */
  suspended: SuspendedStore;
  emitLease: (paneId: string) => void;
  /** What was parked while the terminal had the session goes now. */
  carryParked: (paneId: string) => void;
  report: (paneId: string, status: AgentChatStatus) => void;
  warm: (paneId: string) => void;
  settleApiKey: (
    paneId: string,
    answer: ApiKeyAnswer | null,
    error?: Error,
  ) => boolean;
  recoverLater: (paneId: string) => Promise<boolean>;
  closed: () => boolean;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * A runtime's switches between a pane's terminal and conversation mode:
 * the handover (handover.ts) with what conversation mode keeps around it.
 */
export function createSwitches(deps: SwitchDeps) {
  const { handover, leases, sessions, holders, log } = deps;

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
    deps.emitLease(paneId);
    if (!result.ok) {
      log("conversation mode refused", { pane: paneId, reason: result.reason });
      return result;
    }
    if (deps.closed())
      return { ok: false, reason: "The connection is closing" };
    deps.carryParked(paneId);
    deps.report(paneId, "idle");
    deps.warm(paneId);
    return result;
  }

  async function toTerminal(
    paneId: string,
    handoverOptions: {
      interrupt?: boolean;
      confirm?: boolean;
      /** Stopped as a shell job (Ctrl+Z), with the conversation's title. */
      suspend?: { title?: string };
    } = {},
  ): Promise<AgentChatHandoverResult> {
    // A start waiting for the API key answer gives up: the terminal asks
    // its own question.
    deps.settleApiKey(
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
      (await deps.recoverLater(paneId))
    )
      return { ok: true, owner: "terminal", session_id: held.session_id };
    let session = sessions.get(paneId) ?? null;
    // A process the holder runs from before (a restart) is read first: its
    // turn, queue and tasks decide, and stopping it ends it.
    if (!session && leases.get(paneId)?.phase === "conversation")
      try {
        session = deps.sessionFor(paneId);
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
      deps.channel(paneId)?.childAlive()
    )
      return {
        ok: false,
        reason:
          "Roamgate is still reading the conversation process the pane runs; try again in a moment",
      };
    // Who the holder is before it is told anything (it is forgotten then).
    const shell = holders.shell(paneId);
    const result = await handover.toTerminal(paneId, session, handoverOptions);
    if (result.ok && session && !leases.get(paneId)) {
      sessions.delete(paneId);
      session.dispose();
    }
    if (result.ok && result.suspended && held) {
      const title = handoverOptions.suspend?.title;
      deps.suspended.set({
        pane_id: paneId,
        session_id: held.session_id,
        ...(title ? { title } : {}),
        ...(held.agent ? { agent: held.agent } : {}),
        suspended_at: new Date().toISOString(),
        ...(shell.pid ? { holder_pid: shell.pid } : {}),
        ...(shell.job ? { job: shell.job } : {}),
      });
      log("conversation stopped as a shell job", { pane: paneId });
    }
    deps.emitLease(paneId);
    if (!result.ok)
      log("hand back refused", { pane: paneId, reason: result.reason });
    return result;
  }

  /**
   * `fg` in the pane's shell brought a stopped holder back: conversation
   * mode takes the session again. `attach` runs once the lease is set,
   * before anything starts (the holder's channel, so its process can).
   */
  async function fromSuspended(
    paneId: string,
    spec: Parameters<Handover["fromSuspended"]>[1],
    attach: () => void,
  ): Promise<AgentChatHandoverResult> {
    const result = await handover.fromSuspended(paneId, spec);
    deps.emitLease(paneId);
    if (!result.ok) {
      log("fg refused", { pane: paneId, reason: result.reason });
      return result;
    }
    if (deps.closed())
      return { ok: false, reason: "The connection is closing" };
    attach();
    if (deps.suspended.get(paneId)?.session_id === spec.session_id)
      deps.suspended.delete(paneId);
    log("conversation back from the shell (fg)", { pane: paneId });
    deps.carryParked(paneId);
    deps.report(paneId, "idle");
    deps.warm(paneId);
    deps.emitLease(paneId);
    return result;
  }

  return { toConversation, toTerminal, fromSuspended };
}
