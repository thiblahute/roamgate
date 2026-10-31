import { expect, test } from "bun:test";
import type { AssistantSnapshot } from "../../shared/assistant";
import { paneChatSource, rangerChatSource } from "./chatSource";
import type { HistoryEntry } from "./components/agentHistory";
import { RANGER_VOICE_KEY, RANGER_VOICE_SESSION } from "./voiceRoute";

const entry: HistoryEntry = {
  id: "e1",
  role: "assistant",
  kind: "message",
  text: "Done.",
  sent_at: "2026-10-31T10:00:00Z",
};

test("a pane's chat source: its session's threads, its voice session", () => {
  const pane = {
    pane_id: "p1",
    workspace_id: "w1",
    agent: "claude",
    cwd: "/repo",
    foreground_cwd: "/repo/sub",
  };
  const source = paneChatSource({
    pane,
    connectionId: "local",
    draftKey: "draft",
    session: "session-uuid",
    entries: [entry],
    status: "idle",
    claimsVoice: true,
  });
  expect(source).toEqual({
    kind: "pane",
    agent: "claude",
    draftKey: "draft",
    entries: [entry],
    status: "idle",
    threads: {
      connectionId: "local",
      workspaceId: "w1",
      chat: "session-uuid",
      path: "/repo/sub",
      agent: "claude",
      paneId: "p1",
    },
    voiceSession: "local/p1",
    voiceKey: { connectionId: "local", paneId: "p1" },
  });
  // No session yet: no threads; the inspector's history claims no voice.
  const other = paneChatSource({
    pane: { ...pane, foreground_cwd: undefined },
    connectionId: "local",
    draftKey: "draft",
    session: null,
    entries: [],
    status: "working",
    claimsVoice: false,
  });
  expect(other.threads).toBeNull();
  expect(other.voiceKey).toBeUndefined();
});

test("Ranger's chat source: its chat's threads, voice that stays with Ranger", () => {
  const snapshot = {
    instance_id: "bridge",
    session_id: "chat-one",
    running: true,
    messages: [
      {
        id: "m1",
        role: "user",
        text: "Hi",
        sent_at: "2026-10-31T10:00:00Z",
        tools: [],
        sources: [],
      },
    ],
  } as unknown as AssistantSnapshot;
  const source = rangerChatSource(snapshot, "local");
  expect(source.kind).toBe("ranger");
  expect(source.agent).toBe("Ranger");
  expect(source.status).toBe("working");
  expect(source.entries.map((each) => each.id)).toEqual(["m1"]);
  expect(source.threads).toEqual({
    connectionId: "local",
    workspaceId: "ranger",
    chat: "ranger:chat-one",
    path: "/",
    agent: "Ranger",
    paneId: "ranger:chat-one",
  });
  expect(source.voiceSession).toBe(RANGER_VOICE_SESSION);
  expect(source.voiceKey).toEqual(RANGER_VOICE_KEY);
  // Each chat has its own draft; without a connection, no threads.
  expect(
    rangerChatSource({ ...snapshot, session_id: "chat-two" }, "local").draftKey,
  ).not.toBe(source.draftKey);
  expect(rangerChatSource(snapshot, "").threads).toBeNull();
  expect(rangerChatSource(null, "local").threads).toBeNull();
});
