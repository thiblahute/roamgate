import type {
  AgentChatEvent,
  AgentChatRewindCheck,
  AgentChatRewindMode,
  AgentChatRewindResult,
} from "../../../shared/agentChat";
import type { ProtocolDriver, RewindContext } from "./drivers/types";

/** What a rewind needs of its session (ConversationSession). */
export type RewindSessionDeps = {
  driver: ProtocolDriver;
  /** The driver's rewind runs with this. */
  context: RewindContext;
  /** A hand-back is stopping the process. */
  stopping: () => boolean;
  queueLength: () => number;
  /** A turn runs, a prompt waits, or a message is on its way. */
  busy: () => boolean;
  /** A process runs, and how many prompts wait for the user. */
  running: () => { process: boolean; prompts: number };
  interrupt: () => Promise<boolean>;
  waitForResult: (timeoutMs: number) => Promise<boolean>;
  interruptWaitMs: number;
  emit: (event: AgentChatEvent) => void;
  pushStatus: () => void;
  /** What waited in the queue goes, unless the session is closed. */
  flushQueue: () => void;
};

/**
 * Rewinds a session to before one of the user's messages, through its
 * driver; nothing is written meanwhile and no handover may cut it.
 */
export function createSessionRewind(deps: RewindSessionDeps) {
  const agentName = deps.driver.displayName;
  // A rewind runs: nothing is written meanwhile (what is sent waits in the
  // queue) and no handover may cut it.
  let rewinding = false;

  /**
   * What a rewind to before `uuid` could do to the code, from the
   * transcript alone: the sheet asks it as the user picks, so it starts
   * nothing and asks the process nothing.
   */
  async function rewindCheck(uuid: string): Promise<AgentChatRewindCheck> {
    if (!deps.driver.rewind) return { code: "unknown" };
    return deps.driver.rewind.check(deps.context, uuid);
  }

  /**
   * Rewinds the session to before the user's message `uuid` (the driver's
   * rewind: the conversation, the code, or both). The one process does it
   * between turns: there is never a second writer.
   */
  async function rewind(input: {
    uuid: string;
    lastSeen?: string;
    mode: AgentChatRewindMode;
    interrupt?: boolean;
  }): Promise<AgentChatRewindResult> {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    const driverRewind = deps.driver.rewind;
    if (!driverRewind) return refuse(`${agentName} cannot rewind`);
    if (rewinding) return refuse("A rewind is running already");
    if (deps.stopping()) return refuse("The session is being handed back");
    if (deps.queueLength())
      return refuse(
        "Messages wait in the queue; send them or take them back first",
      );
    if (deps.busy() && input.interrupt && deps.running().process) {
      await deps.interrupt();
      await deps.waitForResult(deps.interruptWaitMs);
    }
    if (deps.busy())
      return refuse(
        deps.running().prompts
          ? "A question or permission waits for an answer"
          : "A turn is running; stop it first",
      );
    rewinding = true;
    deps.pushStatus();
    try {
      const result = await driverRewind.run(deps.context, {
        uuid: input.uuid,
        ...(input.lastSeen !== undefined ? { lastSeen: input.lastSeen } : {}),
        mode: input.mode,
      });
      // Every browser drops what it streamed of the turns cut, and what it
      // still showed as on its way out of the queue.
      if (result.ok && input.mode !== "code")
        deps.emit({ type: "rewound", uuid: input.uuid });
      return result;
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    } finally {
      rewinding = false;
      deps.pushStatus();
      if (deps.queueLength()) deps.flushQueue();
    }
  }

  return {
    rewind,
    rewindCheck,
    /** A rewind runs. */
    running: () => rewinding,
  };
}
