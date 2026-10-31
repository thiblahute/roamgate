import { expect, mock, test } from "bun:test";
import type { AgentChatEvent } from "../../shared/agentChat";
import type {
  AssistantMessage,
  AssistantSnapshot,
} from "../../shared/assistant";
import { createTurnFeed } from "./components/voiceStream";
import {
  createRangerVoiceStream,
  rangerChatStatus,
  rangerHistoryEntries,
  rangerThreadsTarget,
} from "./rangerChat";

const message = (
  id: string,
  role: AssistantMessage["role"],
  text: string,
  tools: AssistantMessage["tools"] = [],
): AssistantMessage => ({
  id,
  role,
  text,
  sent_at: "2026-10-31T10:00:00Z",
  tools,
  sources: [],
});

const snapshotOf = (
  messages: AssistantMessage[],
  running = false,
  session = "chat-one",
): AssistantSnapshot => ({
  instance_id: "bridge",
  revision: 1,
  session_id: session,
  config: {
    provider: "claude-code",
    model: "sonnet",
    credential_source: "assistant",
    allowed_workspaces: [],
  },
  providers: [],
  models: [],
  messages,
  running,
  error: null,
  auth: null,
});

test("Ranger's messages become chat entries, the reply being written not ended", () => {
  const snapshot = snapshotOf(
    [
      message("ask", "user", "How is the rebase?"),
      message("old", "assistant", "Done."),
      message("ask-2", "user", "And CI?"),
      message("draft", "assistant", "Checking"),
    ],
    true,
  );
  const entries = rangerHistoryEntries(snapshot);
  expect(entries.map((entry) => [entry.id, entry.role, entry.kind])).toEqual([
    ["ask", "user", "message"],
    ["old", "assistant", "message"],
    ["ask-2", "user", "message"],
    ["draft", "assistant", "message"],
  ]);
  // Its reply is one block, found by voice's live:<id>:0.
  expect(entries[1]).toMatchObject({
    message_id: "old",
    block_index: 0,
    turn_end: true,
  });
  expect(entries[3]!.turn_end).toBeUndefined();
  expect(rangerChatStatus(snapshot)).toBe("working");
  expect(rangerChatStatus({ ...snapshot, running: false })).toBe("idle");
  expect(rangerHistoryEntries(null)).toEqual([]);
});

test("a Ranger chat's threads are a chat review its agent pane names", () => {
  expect(rangerThreadsTarget("chat-one", "local")).toEqual({
    connectionId: "local",
    workspaceId: "ranger",
    chat: "ranger:chat-one",
    path: "/",
    agent: "Ranger",
    paneId: "ranger:chat-one",
  });
});

/** A snapshot store the voice stream reads, as assistant.ts is. */
function store(initial: AssistantSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: AssistantSnapshot) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

test("Ranger's snapshots stream to voice chat as conversation-mode events", () => {
  const chat = store(snapshotOf([message("old", "assistant", "Earlier.")]));
  const stream = createRangerVoiceStream({
    read: chat.read,
    subscribe: chat.subscribe,
    send: async () => "sent",
    stop: async () => {},
  });
  const events: AgentChatEvent[] = [];
  const unsubscribe = stream.subscribe((event) => events.push(event));
  // What the chat held is not replayed.
  chat.set(chat.read());
  expect(events).toEqual([]);
  chat.set(
    snapshotOf(
      [
        message("old", "assistant", "Earlier."),
        message("ask", "user", "How is CI?"),
        message("draft", "assistant", ""),
      ],
      true,
    ),
  );
  chat.set(
    snapshotOf(
      [
        message("old", "assistant", "Earlier."),
        message("ask", "user", "How is CI?"),
        message("draft", "assistant", "", [
          {
            id: "t1",
            name: "workspace_status",
            status: "running",
            arguments: '{"workspace_id":"w"}',
          },
        ]),
      ],
      true,
    ),
  );
  chat.set(
    snapshotOf(
      [
        message("old", "assistant", "Earlier."),
        message("ask", "user", "How is CI?"),
        message("draft", "assistant", "CI is", [
          { id: "t1", name: "workspace_status", status: "completed" },
        ]),
      ],
      true,
    ),
  );
  chat.set(
    snapshotOf([
      message("old", "assistant", "Earlier."),
      message("ask", "user", "How is CI?"),
      message("draft", "assistant", "CI is green.", [
        { id: "t1", name: "workspace_status", status: "completed" },
      ]),
    ]),
  );
  expect(events).toEqual([
    { type: "user", uuid: "ask", text: "How is CI?", images: 0 },
    { type: "block_start", message_id: "draft", index: 0, block: "text" },
    {
      type: "status",
      status: "working",
      tools_running: false,
      activity: null,
    },
    {
      type: "tool_use",
      tool_use_id: "draft:t1",
      name: "workspace_status",
      input: { workspace_id: "w" },
      message_id: "draft",
      index: 1,
    },
    { type: "delta", message_id: "draft", index: 0, text: "CI is" },
    {
      type: "tool_result",
      tool_use_id: "draft:t1",
      is_error: false,
      text: "",
    },
    { type: "delta", message_id: "draft", index: 0, text: " green." },
    { type: "block_stop", message_id: "draft", index: 0 },
    {
      type: "status",
      status: "idle",
      tools_running: false,
      activity: null,
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      interrupted: false,
      text: "",
    },
  ]);
  // Another chat shown ends what was awaited here.
  events.length = 0;
  chat.set(snapshotOf([], false, "chat-two"));
  expect(events).toEqual([
    { type: "session", session_id: "chat-two", previous: "chat-one" },
  ]);
  unsubscribe();
  expect(chat.listeners.size).toBe(0);
});

test("voice reads Ranger's answer to what was said, as it is written", async () => {
  const chat = store(snapshotOf([]));
  const stream = createRangerVoiceStream({
    read: chat.read,
    subscribe: chat.subscribe,
    send: async () => "sent",
    stop: async () => {},
  });
  const said = "[Voice] what is running?";
  const feed = createTurnFeed({ uuid: "spoken", text: said });
  const unsubscribe = stream.subscribe(feed.handle);
  const read = (async () => {
    let text = "";
    for await (const chunk of feed.text) text += chunk;
    return text;
  })();
  chat.set(
    snapshotOf(
      [message("ask", "user", said), message("reply", "assistant", "Two")],
      true,
    ),
  );
  chat.set(
    snapshotOf([
      message("ask", "user", said),
      message("reply", "assistant", "Two agents."),
    ]),
  );
  expect((await read).trim()).toBe("Two agents.");
  expect(feed.ids()).toEqual(["live:reply:0"]);
  unsubscribe();
});

test("what is said goes to Ranger: sent, queued while it answers, or a stop", async () => {
  const chat = store(snapshotOf([]));
  const send = mock(async (_text: string, busy: boolean) =>
    busy ? ("queued" as const) : ("sent" as const),
  );
  const stop = mock(async () => {});
  const stream = createRangerVoiceStream({
    read: chat.read,
    subscribe: chat.subscribe,
    send,
    stop,
  });
  expect(stream.active()).toBe(true);
  expect(stream.busy()).toBe(false);
  expect(await stream.send("hello", { uuid: "a" })).toBe("sent");
  expect(send).toHaveBeenLastCalledWith("hello", false);
  chat.set(snapshotOf([], true));
  expect(stream.busy()).toBe(true);
  expect(await stream.send("and then", { uuid: "b" })).toBe("queued");
  expect(send).toHaveBeenLastCalledWith("and then", true);
  expect(await stream.send("stop", { uuid: "c", stop: true })).toBe(
    "interrupted",
  );
  expect(stop).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(2);
});
