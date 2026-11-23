import type { AgentChatLease } from "../../../shared/agentChat";
import type { ConversationService } from "./service";
import type { SuspendedConversation } from "./suspended";

/**
 * What the Rust core's conversation service shows the front's synchronous
 * readers (contract/wire/core-channel.md, The conversation family): sent
 * after each change of a lease or a status, and before each answer.
 */
export type ConversationMirror = {
  leases: Record<string, AgentChatLease>;
  owned_panes: ReturnType<ConversationService["ownedPanes"]>;
  suspended: SuspendedConversation[];
  status: Record<string, string>;
  models: Record<string, string>;
  refusals: Record<string, string>;
  handing_over: boolean;
};

export function emptyConversationMirror(): ConversationMirror {
  return {
    leases: {},
    owned_panes: [],
    suspended: [],
    status: {},
    models: {},
    refusals: {},
    handing_over: false,
  };
}

/** What a connection's front needs of the core while it owns the family. */
export type ConversationCore = {
  /** Whether the core runs conversation mode now. */
  onCore: () => boolean;
  /** `internal.conversation.<op>` with this connection's id. */
  call: (
    op: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  mirror: () => ConversationMirror;
};

/**
 * A connection's conversation mode as its callers see it: Bun's own
 * service while Bun owns the family, the core's (its mirror for the
 * synchronous reads, internal calls for the rest) while the core does.
 */
export function conversationFront<Ws>(
  local: () => ConversationService<Ws> | null,
  core: ConversationCore,
): ConversationService<Ws> {
  const remote = {
    lease: (paneId: string) => core.mirror().leases[paneId],
    state: (paneId: string) => ({
      pane_id: paneId,
      status: core.mirror().status[paneId] ?? "stopped",
    }),
    ownedPanes: () => core.mirror().owned_panes.map((pane) => ({ ...pane })),
    ownedSession: (paneId: string) => {
      const lease = core.mirror().leases[paneId];
      return lease && lease.owner === "conversation"
        ? { session_id: lease.session_id, cwd: lease.cwd }
        : null;
    },
    model: (paneId: string) => core.mirror().models[paneId] ?? null,
    inputRefusal: (paneId: string) => core.mirror().refusals[paneId] ?? null,
    handingOver: () => core.mirror().handing_over,
    suspendedPanes: () => core.mirror().suspended.map((each) => ({ ...each })),
    async prompt(
      paneId: string,
      text: string,
      beforeSend?: () => void,
      options: { peer?: boolean } = {},
    ) {
      const lease = core.mirror().leases[paneId];
      if (!lease || lease.phase === "terminal") return false;
      beforeSend?.();
      return (await core.call("prompt", {
        pane_id: paneId,
        text,
        peer: options.peer === true,
      })) as boolean;
    },
    send: (paneId: string, input: { text: string }) =>
      core.call("send", { pane_id: paneId, text: input.text }),
    switchSession: (paneId: string, sessionId: string) =>
      core.call("switch_session", { pane_id: paneId, session_id: sessionId }),
    restartProcess: (paneId: string) =>
      core.call("restart_process", { pane_id: paneId }),
    restartTerminal: (paneId: string, sessionId?: string) =>
      core.call("restart_terminal", {
        pane_id: paneId,
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    autoStart: (paneId: string, sessionId: string) =>
      core.call("auto_start", { pane_id: paneId, session_id: sessionId }),
    paneClosed: (paneId: string) => {
      void core.call("pane_closed", { pane_id: paneId }).catch(() => {});
    },
    sweep: () => core.call("sweep", {}).then(() => undefined),
    // The core hears of a closed socket from the front (socket_closed).
    cleanupWs: () => {},
    dispose: () => {},
    holder: {
      hold: (input: {
        paneId: string;
        sessionId: string;
        signal: AbortSignal;
        status?: unknown;
        shell?: unknown;
      }) =>
        core
          .call(
            "holder_hold",
            {
              pane_id: input.paneId,
              session_id: input.sessionId,
              ...(input.status ? { status: input.status } : {}),
              ...(input.shell ? { shell: input.shell } : {}),
            },
            input.signal,
          )
          .catch(async () => {
            // The holder went away (its request closed): nobody reads this.
            if (input.signal.aborted)
              return { action: "hold", session_id: input.sessionId };
            // The core went (a stop, a restart): the holder keeps holding
            // and polls again a moment later, as Bun's own runtime going
            // answers it.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return { action: "hold", session_id: input.sessionId };
          }),
      fg: (input: {
        paneId: string;
        spec: unknown;
        status?: unknown;
        shell?: unknown;
      }) =>
        core.call("holder_fg", {
          pane_id: input.paneId,
          spec: input.spec,
          ...(input.status ? { status: input.status } : {}),
          ...(input.shell ? { shell: input.shell } : {}),
        }),
      output: (input: {
        paneId: string;
        holderId: string;
        offset: number;
        end: number;
        data: string;
      }) =>
        core.call("holder_output", {
          pane_id: input.paneId,
          holder_id: input.holderId,
          offset: input.offset,
          end: input.end,
          data: input.data,
        }),
      handback: (input: { paneId: string }) =>
        core.call("holder_handback", { pane_id: input.paneId }),
    },
  } as Record<string, unknown>;
  return new Proxy({} as ConversationService<Ws>, {
    get(_target, key) {
      const service = local();
      if (service && !core.onCore())
        return (service as unknown as Record<PropertyKey, unknown>)[key];
      if (typeof key === "string" && key in remote) return remote[key];
      return () => {
        throw new Error("Conversation mode runs in the Rust core here");
      };
    },
  });
}
