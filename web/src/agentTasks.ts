import { useEffect, useState } from "react";
import type { AgentTask, WorkflowView } from "../../shared/agentSession";
import { formatDuration } from "./agentTasksView";
import type { Pane } from "./types";
import { useConnectionClient } from "./useConnectionClient";
import { isPartialRead } from "./partialRead";

export type { AgentTask, WorkflowView };

const POLL_MS = 3000;

/** A session's tasks, and the session (null when none is readable). */
export type AgentTasksState = {
  tasks: AgentTask[];
  /** The foreground commands the session waits on now, apart from tasks. */
  runningNow: AgentTask[];
  session: string | null;
  /** Read at least once since enabled, or failed to be. */
  loaded: boolean;
};

const NO_TASKS: AgentTasksState = {
  tasks: [],
  runningNow: [],
  session: null,
  loaded: false,
};

type TasksReply = {
  tasks?: AgentTask[];
  running_now?: AgentTask[];
  session?: string;
  partial?: boolean;
};

/**
 * The state a read gives: a read of part of a session keeps the tasks shown
 * of that same session, never another's (the pane's next session, or the
 * pane the chat showed before).
 */
export function nextAgentTasksState(
  current: AgentTasksState,
  result: TasksReply,
): AgentTasksState {
  const session = result.session ?? null;
  if (
    isPartialRead(result) &&
    current.loaded &&
    current.tasks.length &&
    current.session === session
  )
    return { ...current, runningNow: result.running_now ?? [] };
  return {
    tasks: result.tasks ?? [],
    runningNow: result.running_now ?? [],
    session,
    loaded: true,
  };
}

/** What the session's background commands and subagents are doing. */
export function useAgentTasks(pane: Pane, enabled: boolean): AgentTasksState {
  const client = useConnectionClient();
  // Kept with whose tasks they are: another pane's or agent's never show.
  const key = `${client.connectionId}\u0000${pane.pane_id}\u0000${pane.agent ?? ""}`;
  const [held, setHeld] = useState<{ key: string; state: AgentTasksState }>(
    () => ({ key, state: NO_TASKS }),
  );
  const state = held.key === key ? held.state : NO_TASKS;
  useEffect(() => {
    const setState = (next: (current: AgentTasksState) => AgentTasksState) =>
      setHeld((current) => ({
        key,
        state: next(current.key === key ? current.state : NO_TASKS),
      }));
    if (!enabled || !pane.agent) {
      setState(() => NO_TASKS);
      return;
    }
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      // Out of sight, the poll waits for the page to show again.
      if (document.hidden) {
        timer = window.setTimeout(load, POLL_MS);
        return;
      }
      try {
        // A poll: background work, behind what the user is doing.
        const result = (await client.call(
          "agent_tasks.get",
          {
            pane_id: pane.pane_id,
            workspace_id: pane.workspace_id,
            tab_id: pane.tab_id,
            agent: pane.agent,
          },
          undefined,
          { lane: "background" },
        )) as TasksReply;
        if (live) setState((current) => nextAgentTasksState(current, result));
      } catch {
        // Not readable now (a reconnect): the next poll tries again.
        if (live)
          setState((current) =>
            current.loaded ? current : { ...current, loaded: true },
          );
      }
      if (live) timer = window.setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    client,
    enabled,
    key,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  return state;
}

/** A task's details: a command's output's end, or a subagent's conversation. */
export type AgentTaskDetail = {
  task: AgentTask;
  output?: string;
  entries?: import("./components/agentHistory").HistoryEntry[];
  /** A workflow's phases and agents. */
  workflow?: WorkflowView;
};

export function taskStatusLabel(task: AgentTask): string {
  if (task.status === "running") return "running";
  if (task.status === "failed")
    return task.exitCode !== undefined ? `failed (${task.exitCode})` : "failed";
  if (task.status === "lost") return "lost";
  return task.status === "stopped" ? "stopped" : "done";
}

/** How long it ran, or has been running: "42s", "3m 05s", "1h 5m". */
export function taskElapsed(task: AgentTask, now = Date.now()): string {
  // Running again since a message resumed it: the time since then.
  const since =
    task.status === "running"
      ? (task.resumedAt ?? task.startedAt)
      : task.startedAt;
  const start = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(start)) return "";
  const end = task.endedAt ? Date.parse(task.endedAt) : now;
  return formatDuration(end - start);
}
