/**
 * What a Claude agent goes on doing once its turn has ended: the subagents,
 * workflows, background commands and monitors it started that still run.
 * Herdr only knows the main turn, so it calls such an agent idle; Roamgate
 * shows it as working in the background, from the task data the Tasks
 * sheet and the Workspaces list already read. Presentation only: what Herdr
 * reports, and what Roamgate tells it, stay as they are.
 */
import type { AgentTask } from "../../server/src/agent/session-tasks";
import { formatDuration } from "./agentTasksView";

/** The part of a task this needs: the Workspaces list's summaries are enough. */
export type BackgroundTaskLike = Pick<
  AgentTask,
  "kind" | "status" | "title" | "name" | "startedAt"
> &
  Partial<Pick<AgentTask, "resumedAt">> & {
    /** Started in a part of the conversation since rewound. */
    rewound?: boolean;
  };

export type BackgroundWork<T extends BackgroundTaskLike = BackgroundTaskLike> =
  {
    /** How many of the agent's side tasks run. */
    running: number;
    /** Those tasks, as listed. */
    tasks: T[];
  };

export const NO_BACKGROUND_WORK: BackgroundWork = { running: 0, tasks: [] };

/**
 * The side tasks that run. An idle teammate waits for a message (its
 * status is completed until one wakes it), so it does not count; a task
 * started in a part of the conversation since rewound does while it runs.
 */
export function backgroundWork<T extends BackgroundTaskLike>(
  tasks: readonly T[],
): BackgroundWork<T> {
  const running = tasks.filter((task) => task.status === "running");
  return { running: running.length, tasks: running };
}

/** Its turn is over: Herdr says idle, or done (finished, not yet seen). */
export function turnIdle(status?: string): boolean {
  const kind = (status ?? "").toLowerCase();
  return kind === "idle" || kind === "done";
}

/**
 * The state shown for an agent: Herdr's, except an idle one with side tasks
 * still running, which works in the background. Done keeps its own state:
 * the user has a finished turn to look at.
 */
export type AgentPresence =
  | "working"
  | "blocked"
  | "done"
  | "background"
  | "idle"
  | "unknown";

export function agentPresence(
  status: string | undefined,
  work: Pick<BackgroundWork, "running">,
): AgentPresence {
  const kind = (status ?? "").toLowerCase();
  switch (kind) {
    case "working":
    case "blocked":
    case "done":
      return kind;
    case "idle":
      return work.running > 0 ? "background" : "idle";
    default:
      return "unknown";
  }
}

/** Shows the background part: the turn is over and something still runs. */
export function showsBackground(
  status: string | undefined,
  work: Pick<BackgroundWork, "running">,
): boolean {
  return work.running > 0 && turnIdle(status);
}

const NOUNS: Record<AgentTask["kind"], [string, string]> = {
  agent: ["subagent", "subagents"],
  teammate: ["teammate", "teammates"],
  workflow: ["workflow", "workflows"],
  command: ["background command", "background commands"],
  monitor: ["monitor", "monitors"],
};

const KIND_LABELS: Record<AgentTask["kind"], string> = {
  agent: "Subagent",
  teammate: "Teammate",
  workflow: "Workflow",
  command: "Command",
  monitor: "Monitor",
};

/**
 * "2 subagents running", "1 workflow running"; "3 running in the
 * background" when they are of several kinds.
 */
export function backgroundCountLabel(
  work: Pick<BackgroundWork, "running" | "tasks">,
): string {
  const kinds = new Set(work.tasks.map((task) => task.kind));
  if (kinds.size === 1) {
    const [one, many] = NOUNS[[...kinds][0]!];
    return `${work.running} ${work.running === 1 ? one : many} running`;
  }
  return `${work.running} running in the background`;
}

/** "Idle", "Done": a status as a word. */
export function statusWord(status: string | undefined): string {
  const word = (status ?? "").trim() || "unknown";
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

/** What runs, one task a line, for a tooltip or hover card. */
export function backgroundTaskLines(
  work: Pick<BackgroundWork, "tasks">,
  now = Date.now(),
): string[] {
  return work.tasks.map((task) => {
    // A subagent resumed by a message: how long since then.
    const since = task.resumedAt ?? task.startedAt;
    const started = since ? Date.parse(since) : Number.NaN;
    const elapsed = Number.isFinite(started)
      ? ` (${formatDuration(now - started)})`
      : "";
    const title =
      task.name && task.name !== task.title
        ? `${task.name}: ${task.title}`
        : task.title;
    return `${KIND_LABELS[task.kind]}: ${title}${elapsed}${
      task.rewound ? ", from a rewound part" : ""
    }`;
  });
}

/** "Idle, 2 subagents running:" then the tasks, one a line. */
export function backgroundTooltip(
  status: string | undefined,
  work: Pick<BackgroundWork, "running" | "tasks">,
  now = Date.now(),
): string {
  return [
    `${statusWord(status)}, ${backgroundCountLabel(work)}:`,
    ...backgroundTaskLines(work, now),
  ].join("\n");
}
