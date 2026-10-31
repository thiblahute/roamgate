import type { AgentTask } from "../agent/session-tasks";
import type { ConnectionManager, ConnectionRuntime } from "./manager";

/** A Workspaces list asks for many agents at once; bound the batch. */
export const AGENT_TASKS_BATCH_MAX = 64;
const READ_TIMEOUT_MS = 5000;

/** What the Workspaces list shows of a task: no output, no long summaries. */
export type AgentTaskSummary = Pick<
  AgentTask,
  | "id"
  | "kind"
  | "title"
  | "status"
  | "name"
  | "startedAt"
  | "endedAt"
  | "rewound"
>;

function summary(task: AgentTask): AgentTaskSummary {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title.slice(0, 200),
    status: task.status,
    ...(task.name ? { name: task.name } : {}),
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt ? { endedAt: task.endedAt } : {}),
    ...(task.rewound ? { rewound: true } : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The side tasks of agents on any connection, for the Workspaces list's
 * subagent rows. Browsers ask when an agent's state or activity changes, not
 * on a timer; each connection's session projection cache does the reading.
 */
export async function readConnectionAgentTasks<
  Runtime extends ConnectionRuntime & {
    agentSessions: {
      readTasks(params: Record<string, unknown>): Promise<unknown>;
    };
    remotePlatform?: string;
  },
>(
  manager: Pick<ConnectionManager<Runtime>, "readyRuntime">,
  params: Record<string, unknown>,
) {
  const requests = Array.isArray(params.requests)
    ? params.requests.slice(0, AGENT_TASKS_BATCH_MAX)
    : [];
  const results = await Promise.all(
    requests.map(async (raw: unknown) => {
      const request =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const connection_id = text(request.connection_id);
      const pane_id = text(request.pane_id);
      const agent = text(request.agent);
      if (!connection_id || !pane_id) return null;
      const identity = { connection_id, pane_id };
      // Only Claude sessions record their side tasks.
      if (agent !== "claude") return { ...identity, tasks: [] };
      const runtime = manager.readyRuntime(connection_id);
      if (!runtime || runtime.remotePlatform === "windows")
        return { ...identity, error: "connection not ready" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = (await Promise.race([
          runtime.agentSessions.readTasks({
            pane_id,
            workspace_id: text(request.workspace_id),
            tab_id: text(request.tab_id),
            agent,
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("timed out")),
              READ_TIMEOUT_MS,
            );
          }),
        ])) as { tasks?: AgentTask[]; session?: string | null };
        return {
          ...identity,
          session: result?.session ?? null,
          tasks: (result?.tasks ?? []).map(summary),
        };
      } catch (error) {
        return {
          ...identity,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { results: results.filter(Boolean) };
}
