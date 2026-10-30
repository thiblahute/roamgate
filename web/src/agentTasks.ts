import { useEffect, useState } from "react";
import type {
  AgentTask,
  WorkflowView,
} from "../../server/src/agent/session-tasks";
import { formatDuration } from "./agentTasksView";
import type { Pane } from "./types";
import { useConnectionClient } from "./useConnectionClient";

export type { AgentTask, WorkflowView };

const POLL_MS = 3000;

/** A session's tasks, and the session (null when none is readable). */
export type AgentTasksState = {
  tasks: AgentTask[];
  session: string | null;
  /** Read at least once since enabled, or failed to be. */
  loaded: boolean;
};

const NO_TASKS: AgentTasksState = { tasks: [], session: null, loaded: false };

/** What the session's background commands and subagents are doing. */
export function useAgentTasks(pane: Pane, enabled: boolean): AgentTasksState {
  const client = useConnectionClient();
  const [state, setState] = useState<AgentTasksState>(NO_TASKS);
  useEffect(() => {
    if (!enabled || !pane.agent) {
      setState(NO_TASKS);
      return;
    }
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = (await client.call("agent_tasks.get", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
        })) as { tasks?: AgentTask[]; session?: string };
        if (live)
          setState({
            tasks: result.tasks ?? [],
            session: result.session ?? null,
            loaded: true,
          });
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
  const start = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
  if (!Number.isFinite(start)) return "";
  const end = task.endedAt ? Date.parse(task.endedAt) : now;
  return formatDuration(end - start);
}
