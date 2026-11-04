import type {
  AgentChatEvent,
  AgentChatVoiceAction,
} from "../../shared/agentChat";
import type {
  AssistantMessage,
  AssistantSnapshot,
} from "../../shared/assistant";
import { RANGER_THREAD_AUTHOR, rangerChatKey } from "../../shared/rangerChat";
import type { HistoryEntry } from "./components/agentHistory";
import type { VoiceStream } from "./components/useVoiceChat";

/**
 * Ranger's chat as the agent chats' shared pieces read it (chatSource.ts):
 * its messages as history entries, its state as an agent status, its comment
 * threads' review target, and its snapshots as conversation-mode stream
 * events for voice chat.
 */

/**
 * What Ranger's chat pieces read of a conversation: Ranger's snapshot, or
 * another agent's shaped as it (the reviews agent's).
 */
export type RangerChatSnapshot = Pick<
  AssistantSnapshot,
  "instance_id" | "session_id" | "running" | "messages" | "queue" | "error"
>;

/** A Ranger message as a chat entry. Assistant replies are one block. */
export function rangerMessageEntry(
  message: AssistantMessage,
  done: boolean,
): HistoryEntry {
  if (message.role === "user")
    return {
      id: message.id,
      role: "user",
      kind: "message",
      text: message.text,
      sent_at: message.sent_at,
    };
  return {
    id: message.id,
    role: "assistant",
    kind: "message",
    text: message.text,
    sent_at: message.sent_at,
    // What voice reads streamed (live:<id>:0) is found in the saved entry.
    message_id: message.id,
    block_index: 0,
    ...(done ? { turn_end: true } : {}),
  };
}

/** Whether `message` is the reply being written now. */
export function rangerReplyRunning(
  snapshot: Pick<AssistantSnapshot, "running" | "messages">,
  message: AssistantMessage,
): boolean {
  return (
    snapshot.running &&
    message.role === "assistant" &&
    message === snapshot.messages[snapshot.messages.length - 1]
  );
}

/** The chat's messages as entries, oldest first. */
export function rangerHistoryEntries(
  snapshot: Pick<AssistantSnapshot, "running" | "messages"> | null,
): HistoryEntry[] {
  if (!snapshot) return [];
  return snapshot.messages.map((message) =>
    rangerMessageEntry(message, !rangerReplyRunning(snapshot, message)),
  );
}

/** Ranger's state as an agent status ("working", "idle"). */
export function rangerChatStatus(
  snapshot: Pick<AssistantSnapshot, "running"> | null,
): string {
  return snapshot?.running ? "working" : "idle";
}

/** Where the threads of Ranger chat `sessionId` are kept: a chat review. */
export function rangerThreadsTarget(sessionId: string, connectionId: string) {
  return {
    connectionId,
    // A chat review needs a workspace name, not a workspace: Ranger's.
    workspaceId: "ranger",
    chat: rangerChatKey(sessionId),
    path: "/",
    agent: RANGER_THREAD_AUTHOR,
    paneId: rangerChatKey(sessionId),
  };
}

type Seen = {
  text: string;
  /** Tool statuses by id. */
  tools: Map<string, string>;
  stopped: boolean;
};

/** How Ranger takes a spoken message: sent, queued, or steering. */
export type RangerVoiceSend = (
  text: string,
  busy: boolean,
) => Promise<"sent" | "queued" | "steered">;

/**
 * Ranger's snapshots as the conversation-mode events voice chat reads
 * (voiceStream.ts): a new user message is its replay, a reply's growing
 * text its deltas, its tools their calls and results (for narration), and
 * the end of the turn its result. Events start with the first subscriber:
 * what the chat held then is the baseline, never replayed.
 */
export function createRangerVoiceStream(input: {
  read: () => RangerChatSnapshot | null;
  subscribe: (listener: () => void) => () => void;
  send: RangerVoiceSend;
  stop: () => Promise<void>;
}): VoiceStream {
  const listeners = new Set<(event: AgentChatEvent) => void>();
  let unsubscribe: (() => void) | null = null;
  let session: string | undefined;
  let running = false;
  let seen = new Map<string, Seen>();

  const remember = (message: AssistantMessage, stopped: boolean): Seen => ({
    text: message.text,
    tools: new Map(message.tools.map((tool) => [tool.id, tool.status])),
    stopped,
  });
  const baseline = (snapshot: RangerChatSnapshot | null) => {
    session = snapshot?.session_id;
    running = !!snapshot?.running;
    seen = new Map(
      (snapshot?.messages ?? []).map((message) => [
        message.id,
        remember(message, !rangerReplyRunning(snapshot!, message)),
      ]),
    );
  };
  const emit = (event: AgentChatEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const toolInput = (text: string | undefined): unknown => {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const update = () => {
    const snapshot = input.read();
    if (!snapshot) return;
    if (snapshot.session_id !== session) {
      // Another chat: what was awaited will not come here.
      emit({
        type: "session",
        session_id: snapshot.session_id ?? "",
        previous: session ?? null,
      });
      baseline(snapshot);
      return;
    }
    for (const message of snapshot.messages) {
      const before = seen.get(message.id);
      if (message.role === "user") {
        if (!before) {
          seen.set(message.id, remember(message, true));
          emit({
            type: "user",
            uuid: message.id,
            text: message.text,
            images: 0,
          });
        }
        continue;
      }
      const current: Seen = before ?? {
        text: "",
        tools: new Map(),
        stopped: false,
      };
      if (!before) {
        seen.set(message.id, current);
        emit({
          type: "block_start",
          message_id: message.id,
          index: 0,
          block: "text",
        });
      }
      if (message.text !== current.text) {
        // Text is only added to; anything rewritten is read from where it
        // differs.
        let common = 0;
        const limit = Math.min(message.text.length, current.text.length);
        while (
          common < limit &&
          message.text.charCodeAt(common) === current.text.charCodeAt(common)
        )
          common += 1;
        const added = message.text.slice(common);
        current.text = message.text;
        if (added && !current.stopped)
          emit({
            type: "delta",
            message_id: message.id,
            index: 0,
            text: added,
          });
      }
      for (const tool of message.tools) {
        const status = current.tools.get(tool.id);
        const id = `${message.id}:${tool.id}`;
        if (status === undefined)
          emit({
            type: "tool_use",
            tool_use_id: id,
            name: tool.name,
            input: toolInput(tool.arguments),
            message_id: message.id,
            index: 1,
          });
        if (tool.status !== "running" && status !== tool.status)
          emit({
            type: "tool_result",
            tool_use_id: id,
            is_error: tool.status === "failed",
            text: tool.output ?? "",
          });
        current.tools.set(tool.id, tool.status);
      }
      if (!current.stopped && !rangerReplyRunning(snapshot, message)) {
        current.stopped = true;
        emit({ type: "block_stop", message_id: message.id, index: 0 });
      }
    }
    const toolsRunning = !!snapshot.messages[
      snapshot.messages.length - 1
    ]?.tools.some((tool) => tool.status === "running");
    if (snapshot.running !== running) {
      running = snapshot.running;
      emit({
        type: "status",
        status: running ? "working" : "idle",
        tools_running: toolsRunning,
        activity: null,
      });
      if (!running)
        emit({
          type: "result",
          subtype: snapshot.error ? "error" : "success",
          is_error: !!snapshot.error,
          interrupted: false,
          text: "",
        });
    }
  };

  return {
    active: () => !!input.read(),
    busy: () => !!input.read()?.running,
    subscribe(listener) {
      if (!listeners.size) {
        baseline(input.read());
        unsubscribe = input.subscribe(update);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
    async send(text, options): Promise<AgentChatVoiceAction> {
      if (options.stop) {
        await input.stop();
        return "interrupted";
      }
      return input.send(text, !!input.read()?.running);
    },
  };
}
