import { requestAgentChatHandover } from "./agentChat";
import type { ConnectionClient } from "./api";
import { detectShortcutPlatform } from "./shortcutBindings";

/**
 * Ctrl+Z on an agent's conversation, as in a shell: the conversation stops
 * as a job of the pane's shell (its terminal shows the prompt, no Claude
 * runs, the session is saved), and `fg` there brings it back. Never on a
 * phone's keyboard: its chat menu has the same switch.
 */

/** Ctrl+Z alone (no Shift, Alt or Cmd). */
export function isSuspendKey(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "z"
  );
}

/**
 * Whether Ctrl+Z in the message box suspends instead of undoing: with the
 * box empty, in Vim's normal mode (where Vim's own Ctrl+Z suspends it, and
 * undo is u), or on a Mac, where undo is Cmd+Z.
 */
export function boxSuspends(box: {
  text: string;
  vimNormal: boolean;
  platform?: ReturnType<typeof detectShortcutPlatform>;
}): boolean {
  const platform = box.platform ?? detectShortcutPlatform();
  return !box.text.trim() || box.vimNormal || platform === "mac";
}

/** The chat's Ctrl+Z: the session goes back to the shell, stopped. */
export function suspendConversation(
  client: ConnectionClient,
  paneId: string,
  title?: string | null,
) {
  return requestAgentChatHandover(client, paneId, "terminal", {
    suspend: { title: title ?? null },
  });
}

/**
 * The page's `fg` (the terminal's banner, a phone): Roamgate types it into
 * the pane's shell, naming the stopped conversation's job.
 */
export async function foregroundConversation(
  client: ConnectionClient,
  paneId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    return (await client.call("agent_chat.fg", { pane_id: paneId })) as
      | { ok: true }
      | { ok: false; reason: string };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
