import type {
  AgentChatEvent,
  AgentChatStreamedText,
} from "../../../shared/agentChat";

type Delta = { message_id: string; index: number; text: string };

/**
 * A session's reply on its way to the browsers: deltas sent together about
 * once a frame, per block, and the reply text sent so far of the turn that
 * runs, for a browser that subscribes in the middle of it (a reload).
 */
export function createReplyStream(options: {
  /** Deltas sent together within this window. */
  coalesceMs: number;
  emit: (event: AgentChatEvent) => void;
  /** Replaying what was handled already: nothing reaches the browsers. */
  muted: () => boolean;
}) {
  // Deltas wait here for about a frame, per block.
  const pending = new Map<string, Delta>();
  let deltaTimer: ReturnType<typeof setTimeout> | null = null;

  // The reply text the browsers were sent of the turn that runs, by block:
  // a browser that subscribes in the middle of it (a reload) starts from
  // there, not from the next delta.
  const streamed = new Map<string, AgentChatStreamedText>();

  function track(event: AgentChatEvent) {
    switch (event.type) {
      case "delta": {
        const key = `${event.message_id}:${event.index}`;
        const block = streamed.get(key);
        if (block) block.text += event.text;
        else
          streamed.set(key, {
            message_id: event.message_id,
            index: event.index,
            text: event.text,
            done: false,
          });
        return;
      }
      case "block_stop": {
        const key = `${event.message_id}:${event.index}`;
        const block = streamed.get(key);
        if (event.text !== undefined)
          streamed.set(key, {
            message_id: event.message_id,
            index: event.index,
            text: event.text,
            done: true,
          });
        else if (block) block.done = true;
        return;
      }
      case "abandoned":
        for (const [key, block] of streamed)
          if (
            block.message_id === event.message_id &&
            block.index >= event.from_index
          )
            streamed.delete(key);
        return;
      case "result":
      case "session":
        streamed.clear();
        return;
    }
  }

  function flush() {
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = null;
    for (const delta of pending.values()) {
      const event = { type: "delta" as const, ...delta };
      track(event);
      if (!options.muted()) options.emit(event);
    }
    pending.clear();
  }

  return {
    /** Sends an event, after the deltas waiting before it. */
    emit(event: AgentChatEvent) {
      flush();
      track(event);
      if (!options.muted()) options.emit(event);
    },
    /** Sends the deltas that wait now. */
    flush,
    /** A delta of reply text: sent with the others of its frame. */
    delta(delta: Delta) {
      const key = `${delta.message_id}:${delta.index}`;
      const held = pending.get(key);
      if (held) held.text += delta.text;
      else pending.set(key, { ...delta });
      deltaTimer ??= setTimeout(flush, options.coalesceMs);
    },
    /** A retry's blocks: their deltas never reach the browser. */
    dropPending(messageId: string, fromIndex: number) {
      for (const [key, held] of pending)
        if (held.message_id === messageId && held.index >= fromIndex)
          pending.delete(key);
    },
    /** The reply text sent so far of the turn that runs, by block. */
    streamed(): AgentChatStreamedText[] {
      return [...streamed.values()].map((block) => ({ ...block }));
    },
    /** The reply text so far, the deltas not sent yet included. */
    snapshot(): AgentChatStreamedText[] {
      const blocks = new Map(
        [...streamed].map(([key, block]) => [key, { ...block }]),
      );
      for (const [key, held] of pending) {
        const block = blocks.get(key);
        if (block) block.text += held.text;
        else
          blocks.set(key, {
            message_id: held.message_id,
            index: held.index,
            text: held.text,
            done: false,
          });
      }
      return [...blocks.values()];
    },
    /** Takes up the reply text a reader before this one saved. */
    restore(blocks: AgentChatStreamedText[]) {
      streamed.clear();
      for (const block of blocks)
        if (block && typeof block.message_id === "string")
          streamed.set(`${block.message_id}:${block.index}`, { ...block });
    },
  };
}
