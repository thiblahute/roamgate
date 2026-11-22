import {
  AGENT_MESSAGE_MAX_CHARS,
  type AgentMessageSender,
  agentAddress,
  cleanAgentMessageText,
  frameAgentMessage,
  parseAgentAddress,
} from "../../../shared/agentMessage";
import type { ClaudeModDelivery } from "../conversation/prompt-pane";
import { type TurnCauses, turnCauses } from "../voice/turn-causes";

/**
 * Agent sessions messaging each other through Roamgate (`roamgate-review
 * sessions` and `message`): the sessions Roamgate manages on every ready
 * connection, and messages delivered to them framed as another agent's,
 * never as the user's. A session in conversation mode gets one through
 * Roamgate's queue; a terminal Claude running Roamgate's mod through the
 * mod, which submits it once Claude is idle; any other terminal session
 * through Herdr's `agent.prompt`, once it is idle.
 */

/** What a connection gives of its agents, as Herdr lists them. */
export type MessengerSnapshot = {
  workspaces: unknown[];
  tabs: unknown[];
  panes: unknown[];
  agents: unknown[];
};

/** A ready connection, as the messenger uses it. */
export type MessengerRuntime = {
  /** Conversation mode on the connection. */
  conversation: {
    /** Whether conversation mode holds the pane's session (any phase). */
    holds(paneId: string): boolean;
    /** Its chat's status: idle, working, blocked, starting or stopped. */
    status(paneId: string): string;
    /**
     * A message for the agent, queued or written now; false when the
     * terminal owns the session.
     */
    prompt(paneId: string, text: string): Promise<boolean>;
  };
  /** The pane's Claude mod, when it runs a live one. */
  claudeMod?: ClaudeModDelivery;
  herdr: {
    call(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<unknown>;
  };
  read(): Promise<MessengerSnapshot>;
};

export type AgentSessionInfo = {
  /** `connection/pane`: what `message` takes. */
  address: string;
  name: string;
  title: string | null;
  workspace: string;
  workspace_id: string;
  connection: string;
  agent: string;
  mode: "conversation" | "terminal";
  state: string;
  cwd: string | null;
  /** The session asking. */
  self?: true;
};

export class AgentMessageError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Pending = {
  id: number;
  text: string;
  from: string;
  /** The sender's name, for the turn it starts (voice/turn-causes.ts). */
  fromName: string;
  queuedAt: number;
  /** Who the Claude mod is told it comes from. */
  source: "message" | "companion";
};

const RATE_WINDOW_MS = 10 * 60_000;

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A title worth showing: not a path, a number, or the agent's own name. */
function meaningful(value: string, agent: string): string | null {
  const stripped = value.replace(/^[\s✳*•]+/, "").trim();
  if (!stripped) return null;
  if (/^[~/]/.test(stripped) || /^\d+$/.test(stripped)) return null;
  if (stripped.toLowerCase() === agent.toLowerCase()) return null;
  if (/^(?:zsh|bash|fish|sh|claude|codex|pi|roamgate-hold)$/i.test(stripped))
    return null;
  return stripped.slice(0, 120);
}

export function createAgentMessenger(args: {
  /** The ready connections, by id. */
  connections: () => string[];
  runtime: (connectionId: string) => MessengerRuntime | null;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  /** How often a terminal session is checked for idle while one waits. */
  pollMs?: number;
  /** How long a message waits for a busy terminal session. */
  waitLimitMs?: number;
  /** Messages a sender may send in ten minutes. */
  senderLimit?: number;
  /** Messages between two sessions, both ways, in ten minutes. */
  pairLimit?: number;
  /** Messages that may wait for one terminal session. */
  waitingLimit?: number;
  /** Where the turns a message starts are noted as another agent's. */
  causes?: Pick<TurnCauses, "note">;
}) {
  const log = args.log ?? (() => {});
  const now = args.now ?? Date.now;
  const pollMs = args.pollMs ?? 3000;
  const waitLimitMs = args.waitLimitMs ?? 30 * 60_000;
  const senderLimit = args.senderLimit ?? 20;
  const pairLimit = args.pairLimit ?? 8;
  const waitingLimit = args.waitingLimit ?? 5;
  const causes = args.causes ?? turnCauses;
  // The voice companion's work is its own turn, the others an agent's.
  const noteCause = (
    connectionId: string,
    paneId: string,
    item: Pick<Pending, "fromName" | "source">,
  ) =>
    causes.note(
      connectionId,
      paneId,
      item.source === "companion"
        ? { by: "companion" }
        : { by: "agent", name: item.fromName },
    );
  const sent = new Map<string, number[]>();
  const pairs = new Map<string, number[]>();
  const waiting = new Map<string, Pending[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  let disposed = false;

  async function list(): Promise<AgentSessionInfo[]> {
    const found: AgentSessionInfo[] = [];
    await Promise.all(
      args.connections().map(async (connectionId) => {
        const runtime = args.runtime(connectionId);
        if (!runtime) return;
        let snapshot: MessengerSnapshot;
        try {
          snapshot = await runtime.read();
        } catch (error) {
          log("agent sessions not read", {
            connection: connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        const workspaces = new Map(
          records(snapshot.workspaces).map((each) => [
            text(each.workspace_id),
            each,
          ]),
        );
        const tabs = new Map(
          records(snapshot.tabs).map((each) => [text(each.tab_id), each]),
        );
        const panes = new Map(
          records(snapshot.panes).map((each) => [text(each.pane_id), each]),
        );
        for (const agentRecord of records(snapshot.agents)) {
          const paneId = text(agentRecord.pane_id);
          const pane = panes.get(paneId) ?? {};
          const agent = text(agentRecord.agent) || text(pane.agent);
          if (!paneId || !agent) continue;
          const workspaceId =
            text(agentRecord.workspace_id) || text(pane.workspace_id);
          const workspace = workspaces.get(workspaceId) ?? {};
          const tab =
            tabs.get(text(agentRecord.tab_id) || text(pane.tab_id)) ?? {};
          const workspaceName =
            text(workspace.label) || workspaceId || connectionId;
          const title =
            meaningful(text(tab.label), agent) ??
            meaningful(
              text(agentRecord.terminal_title_stripped) ||
                text(pane.terminal_title_stripped),
              agent,
            );
          const conversation = runtime.conversation.holds(paneId);
          found.push({
            address: agentAddress(connectionId, paneId),
            name: title ?? workspaceName,
            title,
            workspace: workspaceName,
            workspace_id: workspaceId,
            connection: connectionId,
            agent,
            mode: conversation ? "conversation" : "terminal",
            state: conversation
              ? runtime.conversation.status(paneId)
              : text(agentRecord.agent_status) ||
                text(pane.agent_status) ||
                "unknown",
            cwd:
              text(agentRecord.cwd) ||
              text(pane.cwd) ||
              text(agentRecord.foreground_cwd) ||
              null,
          });
        }
      }),
    );
    return found.sort((a, b) => a.address.localeCompare(b.address));
  }

  function recent(map: Map<string, number[]>, key: string): number[] {
    const since = now() - RATE_WINDOW_MS;
    const kept = (map.get(key) ?? []).filter((at) => at > since);
    if (kept.length) map.set(key, kept);
    else map.delete(key);
    return kept;
  }

  function retryIn(times: number[]): string {
    const seconds = Math.max(
      1,
      Math.ceil(((times[0] ?? now()) + RATE_WINDOW_MS - now()) / 1000),
    );
    return seconds < 120
      ? `${seconds} s`
      : `${Math.ceil(seconds / 60)} minutes`;
  }

  /**
   * Refuses a message past the limits: a sender sending too many, or two
   * sessions going back and forth (a loop of agents answering each other).
   */
  function checkRate(from: string, to: string) {
    const bySender = recent(sent, from);
    if (bySender.length >= senderLimit)
      throw new AgentMessageError(
        `too many messages: at most ${senderLimit} in ten minutes; try again in ${retryIn(bySender)}`,
        429,
      );
    const pair = [from, to].sort().join("\n");
    const between = recent(pairs, pair);
    if (between.length >= pairLimit)
      throw new AgentMessageError(
        `too many messages between these two sessions (${pairLimit} in ten minutes, both ways): this looks like a loop; stop and tell your user, or try again in ${retryIn(between)}`,
        429,
      );
  }

  function record(from: string, to: string) {
    const at = now();
    sent.set(from, [...recent(sent, from), at]);
    const pair = [from, to].sort().join("\n");
    pairs.set(pair, [...recent(pairs, pair), at]);
  }

  /** Types what waits for a terminal session once it is idle. */
  function schedule(address: string, delayMs = pollMs) {
    if (disposed || timers.has(address)) return;
    const timer = setTimeout(() => {
      timers.delete(address);
      void flush(address);
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    timers.set(address, timer);
  }

  async function flush(address: string) {
    const queue = waiting.get(address);
    if (!queue?.length || disposed) return;
    const limit = now() - waitLimitMs;
    const expired = queue.filter((each) => each.queuedAt <= limit);
    for (const each of expired)
      log("agent message expired waiting for its session", {
        to: address,
        from: each.from,
        id: each.id,
      });
    const left = queue.filter((each) => each.queuedAt > limit);
    if (!left.length) {
      waiting.delete(address);
      return;
    }
    waiting.set(address, left);
    const target = parseAgentAddress(address)!;
    const runtime = args.runtime(target.connectionId);
    if (!runtime) return schedule(address);
    try {
      // Taken by conversation mode meanwhile: its queue has them.
      if (runtime.conversation.holds(target.paneId)) {
        while (left.length) {
          const next = left[0]!;
          if (!(await runtime.conversation.prompt(target.paneId, next.text)))
            break;
          noteCause(target.connectionId, target.paneId, next);
          left.shift();
        }
      } else if (runtime.claudeMod) {
        // A Claude mod came up meanwhile: it takes them all, in order.
        while (left.length) {
          const next = left[0]!;
          if (!runtime.claudeMod.deliver(target.paneId, next.text, next.source))
            break;
          noteCause(target.connectionId, target.paneId, next);
          left.shift();
          log("agent message handed to the session's Claude mod", {
            to: address,
            from: next.from,
            id: next.id,
          });
        }
      }
      if (left.length && !runtime.conversation.holds(target.paneId)) {
        const info = (await runtime.herdr.call(
          "agent.get",
          { target: target.paneId },
          5000,
        )) as { agent?: Record<string, unknown> } | null;
        const state = text(info?.agent?.agent_status);
        if (state === "idle" || state === "done") {
          const next = left.shift()!;
          noteCause(target.connectionId, target.paneId, next);
          await runtime.herdr.call(
            "agent.prompt",
            { target: target.paneId, text: next.text },
            5000,
          );
          log("agent message delivered to an idle terminal session", {
            to: address,
            from: next.from,
            id: next.id,
          });
        }
      }
    } catch (error) {
      log("agent message not delivered yet", {
        to: address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (left.length) {
      waiting.set(address, left);
      schedule(address);
    } else waiting.delete(address);
  }

  async function send(input: {
    from: { connectionId: string; paneId: string };
    to: string;
    text: string;
  }) {
    const body = cleanAgentMessageText(input.text);
    if (!body) throw new AgentMessageError("say something: the text is empty");
    if (body.length > AGENT_MESSAGE_MAX_CHARS)
      throw new AgentMessageError(
        `keep it under ${AGENT_MESSAGE_MAX_CHARS} characters; point to a file for more`,
      );
    const target = parseAgentAddress(input.to);
    if (!target)
      throw new AgentMessageError(
        "an address is CONNECTION/PANE, as `roamgate-review sessions` lists them",
      );
    const address = agentAddress(target.connectionId, target.paneId);
    const fromAddress = agentAddress(
      input.from.connectionId,
      input.from.paneId,
    );
    if (address === fromAddress)
      throw new AgentMessageError("that is your own session");
    const sessions = await list();
    const sender = sessions.find((each) => each.address === fromAddress);
    if (!sender)
      throw new AgentMessageError(
        "only an agent session Roamgate manages can send messages, and this pane runs none it knows",
        403,
      );
    const receiver = sessions.find((each) => each.address === address);
    if (!receiver)
      throw new AgentMessageError(
        `no agent session Roamgate manages is at ${address}; run \`roamgate-review sessions\``,
        404,
      );
    checkRate(fromAddress, address);
    const from: AgentMessageSender = {
      address: fromAddress,
      name: sender.name,
      workspace: sender.workspace,
      agent: sender.agent,
    };
    const runtime = args.runtime(target.connectionId);
    if (!runtime)
      throw new AgentMessageError("its connection is not ready", 503);
    // Its reply named as it makes one: the mod's tool, else the client.
    const framed = frameAgentMessage(from, body, {
      tool: runtime.claudeMod?.hasTools?.(target.paneId) === true,
    });
    let delivery: "conversation" | "mod" | "terminal" | "waiting";
    if (
      receiver.mode === "conversation" &&
      (await runtime.conversation.prompt(target.paneId, framed))
    ) {
      noteCause(target.connectionId, target.paneId, {
        fromName: sender.name,
        source: "message",
      });
      delivery = "conversation";
    } else if (
      !waiting.get(address)?.length &&
      runtime.claudeMod?.deliver(target.paneId, framed, "message")
    ) {
      noteCause(target.connectionId, target.paneId, {
        fromName: sender.name,
        source: "message",
      });
      delivery = "mod";
    } else {
      const queue = waiting.get(address) ?? [];
      if (queue.length >= waitingLimit)
        throw new AgentMessageError(
          `${waitingLimit} messages already wait for that session to be idle; try again later`,
          429,
        );
      const item: Pending = {
        id: nextId++,
        text: framed,
        from: fromAddress,
        fromName: sender.name,
        queuedAt: now(),
        source: "message",
      };
      waiting.set(address, [...queue, item]);
      // Idle now (and nothing waits before it): typed at once.
      await flush(address);
      delivery = waiting.get(address)?.some((each) => each.id === item.id)
        ? "waiting"
        : "terminal";
    }
    record(fromAddress, address);
    log("agent message sent", {
      from: fromAddress,
      to: address,
      chars: body.length,
      delivery,
    });
    return {
      sent: true,
      to: receiver,
      delivery,
      note:
        delivery === "conversation"
          ? "In its queue: it reads it at once when idle, else when its turn ends."
          : delivery === "mod"
            ? "Handed to its Claude: it reads it at once when idle, else when its turn ends."
            : delivery === "terminal"
              ? "Typed into its terminal: it was idle."
              : "Its terminal is busy: Roamgate types it in once the session is idle (for up to 30 minutes).",
    };
  }

  /**
   * Hands `text` as it is (no frame, no rate limit: the voice companion's
   * work for the user) to the session at `address`, the way `send` does:
   * conversation mode's queue, else its Claude mod, else typed once the
   * terminal session is idle (waiting for up to the limit).
   */
  async function deliver(address: string, text: string): Promise<void> {
    const target = parseAgentAddress(address);
    if (!target) throw new AgentMessageError("an address is CONNECTION/PANE");
    const key = agentAddress(target.connectionId, target.paneId);
    const runtime = args.runtime(target.connectionId);
    if (!runtime)
      throw new AgentMessageError("its connection is not ready", 503);
    if (await runtime.conversation.prompt(target.paneId, text)) return;
    if (
      !waiting.get(key)?.length &&
      runtime.claudeMod?.deliver(target.paneId, text, "companion")
    )
      return;
    const queue = waiting.get(key) ?? [];
    if (queue.length >= waitingLimit)
      throw new AgentMessageError(
        `${waitingLimit} messages already wait for that session to be idle; try again later`,
        429,
      );
    waiting.set(key, [
      ...queue,
      {
        id: nextId++,
        text,
        from: "voice companion",
        fromName: "voice companion",
        queuedAt: now(),
        source: "companion",
      },
    ]);
    // Idle now (and nothing waits before it): typed at once.
    await flush(key);
  }

  return {
    list,
    send,
    deliver,
    /** Messages waiting for a busy terminal session, by address. */
    waitingFor: (address: string) => waiting.get(address)?.length ?? 0,
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      waiting.clear();
    },
  };
}

export type AgentMessenger = ReturnType<typeof createAgentMessenger>;
