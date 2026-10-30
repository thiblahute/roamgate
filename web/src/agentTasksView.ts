/**
 * The background tasks sheet's model: a workflow's progress, the rows its
 * keys move through, and which agent to follow. Pure, so it is tested
 * without a DOM.
 */
import type {
  AgentTask,
  WorkflowAgentView,
  WorkflowView,
} from "../../server/src/agent/session-tasks";

export type { WorkflowAgentView };

type Phase = WorkflowView["phases"][number];

export type PhaseState = "running" | "failed" | "done" | "waiting";

export type Progress = {
  total: number;
  done: number;
  running: number;
  failed: number;
  state: PhaseState;
};

export function agentsProgress(agents: readonly WorkflowAgentView[]): Progress {
  let done = 0;
  let running = 0;
  let failed = 0;
  for (const agent of agents) {
    if (agent.state === "done") done++;
    else if (agent.state === "running") running++;
    else failed++;
  }
  const total = agents.length;
  const state: PhaseState = running
    ? "running"
    : failed
      ? "failed"
      : total && done === total
        ? "done"
        : "waiting";
  return { total, done, running, failed, state };
}

/** All of a workflow's agents, and the phase that runs now (-1: none). */
export function workflowProgress(view: WorkflowView): Progress & {
  activePhase: number;
} {
  const progress = agentsProgress(view.phases.flatMap((phase) => phase.agents));
  return {
    ...progress,
    activePhase: view.phases.findIndex((phase) =>
      phase.agents.some((agent) => agent.state === "running"),
    ),
  };
}

/** Phases have a header when there are several, or the one has a name. */
export function phaseHeaders(view: WorkflowView): boolean {
  return view.phases.length > 1 || !!view.phases[0]?.title;
}

export function phaseKey(phase: Phase, index: number): string {
  return `phase:${phase.title || `#${index}`}`;
}

export function agentKey(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * A done phase folds away once a later one exists; a running or failed
 * phase, and the last one, stay open. The reader's own choice wins.
 */
export function isPhaseCollapsed(
  view: WorkflowView,
  index: number,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  const phase = view.phases[index];
  if (!phase || !phaseHeaders(view)) return false;
  const own = overrides.get(phaseKey(phase, index));
  if (own !== undefined) return own;
  return (
    index < view.phases.length - 1 &&
    agentsProgress(phase.agents).state === "done"
  );
}

export type WorkflowRow =
  | { kind: "phase"; key: string; phase: number }
  | { kind: "agent"; key: string; phase: number; agent: WorkflowAgentView };

/** The rows shown, in order: each phase's header, then its open agents. */
export function workflowRows(
  view: WorkflowView,
  overrides: ReadonlyMap<string, boolean>,
): WorkflowRow[] {
  const headers = phaseHeaders(view);
  const rows: WorkflowRow[] = [];
  view.phases.forEach((phase, index) => {
    if (headers)
      rows.push({ kind: "phase", key: phaseKey(phase, index), phase: index });
    if (isPhaseCollapsed(view, index, overrides)) return;
    for (const agent of phase.agents)
      rows.push({
        kind: "agent",
        key: agentKey(agent.agentId),
        phase: index,
        agent,
      });
  });
  return rows;
}

/** The phase an agent is in, or -1. */
export function phaseOfAgent(view: WorkflowView, agentId: string): number {
  return view.phases.findIndex((phase) =>
    phase.agents.some((agent) => agent.agentId === agentId),
  );
}

/** `delta` rows from `current`, staying in the list. */
export function stepKey(
  keys: readonly string[],
  current: string | null,
  delta: number,
): string | null {
  if (!keys.length) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return delta < 0 ? keys[keys.length - 1]! : keys[0]!;
  return keys[Math.max(0, Math.min(keys.length - 1, at + delta))]!;
}

/**
 * The next item after (or before) `current` that matches, wrapping around;
 * null when none other does.
 */
export function nextKeyWhere<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  current: string | null,
  direction: 1 | -1,
  matches: (item: T) => boolean,
): string | null {
  if (!items.length) return null;
  const at = items.findIndex((item) => keyOf(item) === current);
  const start = at < 0 ? (direction === 1 ? -1 : items.length) : at;
  for (let step = 1; step <= items.length; step++) {
    const index =
      (((start + direction * step) % items.length) + items.length) %
      items.length;
    const item = items[index]!;
    if (keyOf(item) !== current && matches(item)) return keyOf(item);
  }
  return null;
}

/**
 * Where the cursor goes when the list changes under it: it stays on its
 * row; a row gone leaves it at the same place; an agent folded away puts
 * it on its phase.
 */
export function reconcileKey(
  previous: readonly string[],
  next: readonly string[],
  current: string | null,
  fallback?: string | null,
): string | null {
  if (!next.length) return null;
  if (current !== null && next.includes(current)) return current;
  if (fallback && next.includes(fallback)) return fallback;
  const at = current === null ? -1 : previous.indexOf(current);
  if (at < 0) return next[0]!;
  return next[Math.min(at, next.length - 1)]!;
}

/** Where a key lands in the rows shown: a folded agent's is its phase's. */
export function shownKey(
  view: WorkflowView,
  rows: readonly WorkflowRow[],
  key: string | null,
): string | null {
  if (key === null || rows.some((row) => row.key === key)) return key;
  if (!key.startsWith("agent:")) return key;
  const phase = phaseOfAgent(view, key.slice("agent:".length));
  return phase < 0 ? key : phaseKey(view.phases[phase]!, phase);
}

/**
 * The agent to follow: the one followed while it still runs, else the
 * running agent active last (the last started when none says).
 */
export function followTarget(
  view: WorkflowView,
  current: string | null,
): string | null {
  const running = view.phases
    .flatMap((phase) => phase.agents)
    .filter((agent) => agent.state === "running");
  if (!running.length) return null;
  if (running.some((agent) => agentKey(agent.agentId) === current))
    return current;
  let best = running[running.length - 1]!;
  for (const agent of running) {
    const time = agent.lastActiveAt ?? agent.startedAt ?? -1;
    const bestTime = best.lastActiveAt ?? best.startedAt ?? -1;
    if (time > bestTime) best = agent;
  }
  return agentKey(best.agentId);
}

/** "42s", "3m 05s", "42m", "1h 5m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How long an agent ran, or has been running; undefined when unknown. */
export function agentElapsedMs(
  agent: WorkflowAgentView,
  now: number,
): number | undefined {
  if (agent.durationMs !== undefined) return agent.durationMs;
  if (agent.state === "running" && agent.startedAt !== undefined)
    return Math.max(0, now - agent.startedAt);
  return undefined;
}

/** A running agent quiet for a minute or more: how long, else undefined. */
export function agentQuietMs(
  agent: WorkflowAgentView,
  now: number,
): number | undefined {
  if (agent.state !== "running" || agent.lastActiveAt === undefined)
    return undefined;
  const quiet = now - agent.lastActiveAt;
  return quiet >= 60_000 ? quiet : undefined;
}

export function taskNeedsAttention(task: AgentTask): boolean {
  return task.status === "failed" || task.status === "lost";
}

export type SheetCommand =
  | "down"
  | "up"
  | "first"
  | "last"
  | "pageDown"
  | "pageUp"
  | "open"
  | "toggle"
  | "left"
  | "back"
  | "close"
  | "nextRunning"
  | "previousRunning"
  | "nextFailed"
  | "previousFailed"
  | "follow"
  | "help";

/** A key the sheet takes, or null to leave it to the page. */
export function sheetCommand(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): SheetCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "down";
    case "k":
    case "ArrowUp":
      return "up";
    case "g":
    case "Home":
      return "first";
    case "G":
    case "End":
      return "last";
    case "PageDown":
      return "pageDown";
    case "PageUp":
      return "pageUp";
    case " ":
      return event.shiftKey ? "pageUp" : "toggle";
    case "Enter":
    case "l":
    case "ArrowRight":
      return "open";
    case "h":
    case "ArrowLeft":
      return "left";
    case "Escape":
    case "Backspace":
      return "back";
    case "q":
      return "close";
    case "n":
      return "nextRunning";
    case "N":
      return "previousRunning";
    case "e":
      return "nextFailed";
    case "E":
      return "previousFailed";
    case "f":
      return "follow";
    case "?":
      return "help";
    default:
      return null;
  }
}

/** The keys, for the sheet's help. */
export const TASK_SHEET_KEYS: [string, string][] = [
  ["j k / Down Up", "next / previous task, phase or agent"],
  ["g G / Home End", "first / last"],
  ["n N", "next / previous running one"],
  ["e E", "next / previous failed one"],
  ["Enter l / Right", "open the task or agent, or unfold the phase"],
  ["h / Left", "fold the phase, or go to an agent's phase"],
  ["Space", "fold / unfold the phase; in output, page down"],
  ["f", "follow the running agent (or the output's end)"],
  ["Esc Backspace", "back to the overview, then close"],
  ["q", "close"],
  ["?", "this list"],
];
