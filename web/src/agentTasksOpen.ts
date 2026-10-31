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

/** Given a task: open the sheet on it rather than toggle the sheet. */
export type AgentTasksRequest = { taskId: string };
type Listener = (request?: AgentTasksRequest) => void;

const listeners = new Map<string, Set<Listener>>();
/** A task asked for before its pane showed: opened once it does. */
const waiting = new Map<string, { taskId: string; until: number }>();
const WAIT_MS = 10_000;

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
  listener: Listener,
): () => void {
  let own = listeners.get(paneId);
  if (!own) {
    own = new Set();
    listeners.set(paneId, own);
  }
  own.add(listener);
  const early = waiting.get(paneId);
  if (early) {
    waiting.delete(paneId);
    if (early.until > Date.now()) {
      queueMicrotask(() => {
        if (own.has(listener)) listener({ taskId: early.taskId });
      });
    }
  }
  return () => {
    own.delete(listener);
    if (!own.size) listeners.delete(paneId);
  };
}

/**
 * Opens the pane's tasks sheet on one task (a subagent row in the
 * Workspaces list). The pane may not show yet: it opens when it does.
 */
export function openAgentTask(paneId: string, taskId: string) {
  const own = listeners.get(paneId);
  if (!own?.size) {
    waiting.set(paneId, { taskId, until: Date.now() + WAIT_MS });
    return;
  }
  for (const listener of [...own]) listener({ taskId });
}
