/**
 * The Workspaces list's arrangement model that needs no DOM: what a parent
 * row sums up, which side tasks show under an agent, and where a drop lands.
 */
import type { AgentTaskSummary } from "../../server/src/connections/agent-tasks";
import { agentPresence } from "./agentBackground";

export type { AgentTaskSummary };

/** What a row says of everything under it. */
export type TreeSummary = {
  /** Agents at work. */
  working: number;
  /**
   * Agents whose turn is over (Herdr says idle) while their subagents,
   * workflows or background commands still run.
   */
  background: number;
  /** Agents waiting on the user: asking (blocked) or finished unseen (done). */
  waiting: number;
  /** Of those waiting, the ones asking something. */
  blocked: number;
  /** Subagents, teammates and workflows running in those agents. */
  subagents: number;
};

export const EMPTY_TREE_SUMMARY: TreeSummary = {
  working: 0,
  background: 0,
  waiting: 0,
  blocked: 0,
  subagents: 0,
};

export function agentSummary(
  pane: {
    agent_status: string;
    attention_note?: string;
  },
  backgroundRunning = 0,
): TreeSummary {
  const status = pane.agent_status.toLowerCase();
  const blocked = status === "blocked" ? 1 : 0;
  const waiting = blocked || status === "done" || pane.attention_note ? 1 : 0;
  return {
    working: status === "working" ? 1 : 0,
    background:
      agentPresence(status, { running: backgroundRunning }) === "background"
        ? 1
        : 0,
    waiting,
    blocked,
    subagents: 0,
  };
}

export function addSummaries(
  ...summaries: readonly TreeSummary[]
): TreeSummary {
  const total = { ...EMPTY_TREE_SUMMARY };
  for (const each of summaries) {
    total.working += each.working;
    total.background += each.background;
    total.waiting += each.waiting;
    total.blocked += each.blocked;
    total.subagents += each.subagents;
  }
  return total;
}

export function summaryIsEmpty(summary: TreeSummary): boolean {
  return (
    !summary.working &&
    !summary.background &&
    !summary.waiting &&
    !summary.subagents
  );
}

/**
 * Sums a subtree: each item's own agents and running side tasks, then its
 * children's. `backgroundRunning` counts every side task an agent runs
 * (commands and monitors too), for the agents idle while they run.
 * `seen` guards against a structure that loops.
 */
export function subtreeSummary<
  T,
  A extends { agent_status: string; attention_note?: string },
>(
  root: T,
  {
    key,
    children,
    agents,
    runningSubagents = () => 0,
    backgroundRunning = () => 0,
  }: {
    key: (item: T) => string;
    children: (item: T) => readonly T[];
    agents: (item: T) => readonly A[];
    runningSubagents?: (agent: A) => number;
    backgroundRunning?: (agent: A) => number;
  },
  seen = new Set<string>(),
): TreeSummary {
  const id = key(root);
  if (seen.has(id)) return EMPTY_TREE_SUMMARY;
  seen.add(id);
  const own = agents(root).map((agent) => ({
    ...agentSummary(agent, backgroundRunning(agent)),
    subagents: runningSubagents(agent),
  }));
  return addSummaries(
    ...own,
    ...children(root).map((child) =>
      subtreeSummary(
        child,
        { key, children, agents, runningSubagents, backgroundRunning },
        seen,
      ),
    ),
  );
}

/**
 * "2 working · 1 idle, running in the background · 1 waiting · 5
 * subagents": a summary's words.
 */
export function summaryLabel(summary: TreeSummary): string {
  const parts: string[] = [];
  if (summary.working) parts.push(`${summary.working} working`);
  if (summary.background)
    parts.push(`${summary.background} idle, running in the background`);
  if (summary.waiting)
    parts.push(
      summary.blocked
        ? `${summary.waiting} waiting on you (${summary.blocked} asking)`
        : `${summary.waiting} waiting on you`,
    );
  if (summary.subagents)
    parts.push(
      `${summary.subagents} subagent${summary.subagents === 1 ? "" : "s"} running`,
    );
  return parts.join(" · ");
}

/** What a side task row says of its state. */
export type TreeTaskState = "running" | "idle" | "failed";

export type TreeTaskRow = {
  task: AgentTaskSummary;
  state: TreeTaskState;
};

/** Commands and monitors are noise here: the Tasks sheet lists them. */
function isSubagentKind(task: AgentTaskSummary): boolean {
  return (
    task.kind === "agent" ||
    task.kind === "teammate" ||
    task.kind === "workflow"
  );
}

/**
 * The side tasks the Workspaces list shows under an agent: what runs, the
 * teammates still there to be messaged again (Claude Code wakes one on a
 * SendMessage), and failures until the user has seen them. One-shot
 * subagents and workflows that ended, stopped or were lost leave the list;
 * the Tasks sheet keeps them. `done` counts those.
 */
export function treeTaskRows(
  tasks: readonly AgentTaskSummary[],
  failureSeen: (task: AgentTaskSummary) => boolean,
): { rows: TreeTaskRow[]; running: number; done: number } {
  const rows: TreeTaskRow[] = [];
  let running = 0;
  let done = 0;
  for (const task of tasks) {
    if (!isSubagentKind(task)) continue;
    if (task.status === "running") {
      running++;
      rows.push({ task, state: "running" });
    } else if (task.kind === "teammate" && task.status === "completed") {
      // Idle, not gone: a message brings it back.
      rows.push({ task, state: "idle" });
    } else if (task.status === "failed" && !failureSeen(task)) {
      rows.push({ task, state: "failed" });
    } else done++;
  }
  return { rows, running, done };
}

/** "3 subagents · 1 running" */
export function treeTaskLineLabel(rows: readonly TreeTaskRow[]): string {
  const running = rows.filter((row) => row.state === "running").length;
  const failed = rows.filter((row) => row.state === "failed").length;
  const parts = [`${rows.length} subagent${rows.length === 1 ? "" : "s"}`];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

export type DropZone = "before" | "into" | "after";

/** A row's top and bottom quarters order; its middle nests. */
export function dropZone(
  offsetY: number,
  height: number,
  canNest = true,
): DropZone {
  if (!canNest) return offsetY < height / 2 ? "before" : "after";
  if (offsetY < height / 4) return "before";
  if (offsetY > (height * 3) / 4) return "after";
  return "into";
}
