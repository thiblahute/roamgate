/**
 * A Ranger chat as the agent chats' shared pieces address it: its comment
 * threads are a review of target `chat` keyed `ranger:<chat id>`, whose
 * agent "pane" is that same key. The review service hands those threads to
 * Ranger (a turn in that chat) instead of typing them into a pane, and
 * Ranger answers in them with its `chat_thread_reply` tool.
 */

const PREFIX = "ranger:";

/** The name Ranger writes thread replies under, and the review's agent. */
export const RANGER_THREAD_AUTHOR = "Ranger";

/** The tool Ranger answers a thread with. */
export const RANGER_THREAD_TOOL = "chat_thread_reply";

/** The review chat key, and agent pane, of a Ranger chat. */
export function rangerChatKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

/** The Ranger chat a review chat key or agent pane names; null otherwise. */
export function rangerChatSession(key: string | undefined): string | null {
  if (!key?.startsWith(PREFIX)) return null;
  const id = key.slice(PREFIX.length);
  return id ? id : null;
}
