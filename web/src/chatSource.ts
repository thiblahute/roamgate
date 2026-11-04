import type { HistoryEntry } from "./components/agentHistory";
import {
  type RangerChatSnapshot,
  rangerChatStatus,
  rangerHistoryEntries,
  rangerThreadsTarget,
} from "./rangerChat";
import type { Pane } from "./types";
import {
  RANGER_VOICE_KEY,
  RANGER_VOICE_SESSION,
  voiceSessionId,
} from "./voiceRoute";

/**
 * What the agent chats' shared pieces (AgentHistoryChat, the message box,
 * the comment threads, voice chat) read of the conversation they show: an
 * agent's pane, or a Ranger chat. Sending, stopping and the voice stream
 * stay with the surface that owns them (the pane's drawer, Ranger's panel).
 */
export type ChatSource = {
  kind: "pane" | "ranger";
  /** Who the chat is with, as the message box and threads name it. */
  agent: string;
  /** The message box's draft, kept apart for each conversation. */
  draftKey: string;
  /** The conversation, oldest first. */
  entries: readonly HistoryEntry[];
  /** The agent's state ("working", "idle", "blocked"...). */
  status: string;
  /**
   * Where the chat's comment threads are kept: a review of target `chat`
   * whose agent pane gets them; null while the chat has no session yet.
   */
  threads: ChatThreadsTarget | null;
  /** The session on screen, for the voice router. */
  voiceSession: string;
  /** The one voice chat this chat claims while it talks. */
  voiceKey?: { connectionId: string; paneId: string };
};

/** ChatThreadsProvider's props. */
export type ChatThreadsTarget = {
  connectionId: string;
  workspaceId: string;
  chat: string;
  path: string;
  agent: string;
  paneId: string;
};

/** An agent's pane, its transcript read by the drawer. */
export function paneChatSource(input: {
  pane: Pick<
    Pane,
    "pane_id" | "workspace_id" | "agent" | "cwd" | "foreground_cwd"
  >;
  connectionId: string;
  draftKey: string;
  /** The agent session the threads hang on, once known. */
  session: string | null;
  entries: readonly HistoryEntry[];
  status: string;
  /** Only the pane's own chat claims voice chat. */
  claimsVoice: boolean;
}): ChatSource {
  const { pane, connectionId } = input;
  return {
    kind: "pane",
    agent: pane.agent ?? "agent",
    draftKey: input.draftKey,
    entries: input.entries,
    status: input.status,
    threads:
      input.session && connectionId
        ? {
            connectionId,
            workspaceId: pane.workspace_id,
            chat: input.session,
            path: pane.foreground_cwd ?? pane.cwd ?? "",
            agent: pane.agent ?? "agent",
            paneId: pane.pane_id,
          }
        : null,
    voiceSession: voiceSessionId(connectionId, pane.pane_id),
    ...(input.claimsVoice && connectionId
      ? { voiceKey: { connectionId, paneId: pane.pane_id } }
      : {}),
  };
}

/**
 * Ranger's chat: its snapshot's messages, threads kept on the connection
 * on screen (reviews belong to one), voice chat that stays with Ranger.
 */
export function rangerChatSource(
  snapshot: RangerChatSnapshot | null,
  connectionId: string,
  entries: readonly HistoryEntry[] = rangerHistoryEntries(snapshot),
): ChatSource {
  const session = snapshot?.session_id;
  return {
    kind: "ranger",
    agent: "Ranger",
    draftKey: `ranger:${snapshot?.instance_id ?? ""}:${session ?? ""}`,
    entries,
    status: rangerChatStatus(snapshot),
    threads:
      session && connectionId
        ? rangerThreadsTarget(session, connectionId)
        : null,
    voiceSession: RANGER_VOICE_SESSION,
    voiceKey: RANGER_VOICE_KEY,
  };
}
