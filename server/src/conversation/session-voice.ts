import { randomUUID } from "node:crypto";
import type {
  AgentChatQueued,
  AgentChatVoiceAction,
} from "../../../shared/agentChat";

const STOP_WORDS = /^\s*(?:stop|stop it|stop now|arr[eê]te|halt)\s*[.!]*\s*$/i;

/** A spoken "stop": always an interrupt, never a message. */
export function isSpokenStop(text: string): boolean {
  return STOP_WORDS.test(text);
}

/** What spoken messages need of their session (ConversationSession). */
export type VoiceSessionDeps = {
  /** Where the turn is: what decides between queue, interrupt and steer. */
  turn: () => {
    running: boolean;
    compacting: boolean;
    prompts: number;
    tools: number;
    lastBlock: "text" | "thinking" | "tool_use" | null;
  };
  /** Whether a message written now would start a turn at once. */
  ready: () => boolean;
  /** False for a message id taken already (a retried call). */
  take: (id: string) => boolean;
  queued: (id: string) => boolean;
  queueLength: () => number;
  /** Queues a message, and tells the browsers. */
  enqueue: (item: AgentChatQueued) => void;
  drainQueue: (uuid?: string) => Promise<boolean>;
  deliver: (text: string, images: string[], uuid?: string) => Promise<string>;
  interrupt: () => Promise<boolean>;
  waitForResult: (timeoutMs: number) => Promise<boolean>;
  interruptWaitMs: number;
  /** A message on its way to stdin (+1), or there (-1). */
  delivering: (change: 1 | -1) => void;
  /** The lines of a message that steers the turn that runs. */
  steerMessage: (text: string, uuid: string) => Promise<string[]>;
  write: (lines: string[]) => void;
  remember: (uuid: string, text: string, images: string[]) => void;
};

/**
 * A spoken message, the barge-in mix: "stop" interrupts; while Claude is
 * writing reply text the turn is interrupted (the partial reply stays) and
 * the speech becomes the next turn; at any other point of a turn (tools,
 * thinking, between two steps) the speech goes to stdin now and steers the
 * same turn. A pending prompt is left alone: the speech waits in the queue.
 */
export function createVoiceInput(deps: VoiceSessionDeps) {
  return async function voice(input: {
    text: string;
    stop?: boolean;
    uuid?: string;
  }): Promise<{ action: AgentChatVoiceAction; id?: string }> {
    const text = input.text.trim();
    if (input.stop || isSpokenStop(text)) {
      await deps.interrupt();
      return { action: "interrupted" };
    }
    if (!text) throw new Error("Nothing to send");
    if (input.uuid && !deps.take(input.uuid))
      return {
        action: deps.queued(input.uuid) ? "queued" : "sent",
        id: input.uuid,
      };
    if (deps.ready()) {
      if (!deps.queueLength()) {
        const id = await deps.deliver(text, [], input.uuid);
        return { action: "sent", id };
      }
      // Left from a start that failed: they go first, with this one.
      const id = input.uuid ?? randomUUID();
      deps.enqueue({
        id,
        text,
        images: [],
        queued_at: new Date().toISOString(),
      });
      return { action: (await deps.drainQueue(id)) ? "sent" : "queued", id };
    }
    const turn = deps.turn();
    if (!turn.running || turn.prompts || turn.compacting) {
      const item: AgentChatQueued = {
        id: input.uuid ?? randomUUID(),
        text,
        images: [],
        queued_at: new Date().toISOString(),
      };
      deps.enqueue(item);
      return { action: "queued", id: item.id };
    }
    if (turn.tools || turn.lastBlock !== "text") {
      const id = input.uuid ?? randomUUID();
      deps.delivering(1);
      try {
        const message = await deps.steerMessage(text, id);
        // The turn may have ended meanwhile: then it is a turn of its own.
        if (!deps.turn().running)
          return { action: "sent", id: await deps.deliver(text, [], id) };
        deps.write(message);
        deps.remember(id, text, []);
      } finally {
        deps.delivering(-1);
      }
      return { action: "steered", id };
    }
    await deps.interrupt();
    await deps.waitForResult(deps.interruptWaitMs);
    const id = await deps.deliver(text, [], input.uuid);
    return { action: "interrupted_then_sent", id };
  };
}
