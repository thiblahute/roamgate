/**
 * Opening a Claude pane's background tasks sheet from elsewhere: its
 * shortcut, the command menu, or /tasks typed in its chat. The pane that
 * shows the agent answers: its chat opens its own sheet, its terminal one
 * over it.
 */

/** /tasks in a Claude chat's box: Roamgate's sheet, not Claude Code's. */
export const TASKS_CHAT_COMMAND = {
  name: "/tasks",
  description: "Roamgate: background tasks, subagents and workflows",
};

export function isTasksCommand(text: string): boolean {
  return text.trim() === TASKS_CHAT_COMMAND.name;
}

const listeners = new Map<string, Set<() => void>>();

/**
 * Opens (or closes) the pane's tasks sheet; false when no view of that pane
 * answers, so the key goes on.
 */
export function requestAgentTasks(paneId: string): boolean {
  const own = listeners.get(paneId);
  if (!own?.size) return false;
  for (const listener of [...own]) listener();
  return true;
}

/** Answers the pane's requests while it shows; returns the unsubscribe. */
export function onAgentTasksRequest(
  paneId: string,
  listener: () => void,
): () => void {
  let own = listeners.get(paneId);
  if (!own) {
    own = new Set();
    listeners.set(paneId, own);
  }
  own.add(listener);
  return () => {
    own.delete(listener);
    if (!own.size) listeners.delete(paneId);
  };
}
