import { useEffect, useRef, useSyncExternalStore } from "react";
import { type BackgroundWork, backgroundWork } from "./agentBackground";
import { bridge } from "./api";
import { roamgateLocalStorage } from "./browserStorage";
import type { Pane } from "./types";
import type { AgentTaskSummary } from "./workspaceTreeView";
import { PARTIAL_RETRY_MS } from "./partialRead";

/**
 * The side tasks (subagents, teammates, workflows) of the agents the
 * Workspaces list shows, on any connection. Read again only when an agent's
 * state or activity changes, as the list's own refreshes report it: no
 * timer of its own.
 */
type Entry = { version: string; tasks: AgentTaskSummary[]; at: number };
const entries = new Map<string, Entry>();
const pending = new Map<
  string,
  { version: string; connectionId: string; pane: Pane; due: number }
>();
/**
 * A working agent's activity changes all the time: its tasks are read again
 * at most this often for that alone. A change of state is read at once.
 */
export const TREE_TASKS_ACTIVITY_MS = 15_000;
const inFlight = new Set<string>();
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function agentTaskKey(connectionId: string, paneId: string): string {
  return `${connectionId}\u0000${paneId}`;
}

/** What changes when an agent's side tasks may have. */
export function agentTaskVersion(pane: Pane): string {
  return [agentTaskState(pane), pane.last_activity_at ?? ""].join("|");
}

/** The part of the version that is not mere activity. */
function agentTaskState(pane: Pane): string {
  return [
    pane.terminal_id,
    pane.agent_status,
    pane.state_change_seq ?? "",
  ].join("|");
}

function stateOfVersion(version: string): string {
  return version.slice(0, version.lastIndexOf("|"));
}

/**
 * When an agent whose version is now `version` has its tasks read again: at
 * once for a new agent or a change of state, a while after the last read
 * when only its activity moved.
 */
export function agentTasksReadDue(
  last: { version: string; at: number } | undefined,
  version: string,
  now: number,
): number {
  return last && stateOfVersion(last.version) === stateOfVersion(version)
    ? Math.max(now, last.at + TREE_TASKS_ACTIVITY_MS)
    : now;
}

function notify() {
  revision += 1;
  for (const listener of listeners) listener();
}

async function flush() {
  timer = undefined;
  timerDue = Number.POSITIVE_INFINITY;
  const now = Date.now();
  const batch = [...pending.entries()]
    .filter(([key, request]) => !inFlight.has(key) && request.due <= now)
    .slice(0, 64);
  if (!batch.length) {
    if (pending.size) schedule();
    return;
  }
  for (const [key] of batch) {
    pending.delete(key);
    inFlight.add(key);
  }
  try {
    // Badges of the list: background work, behind what the user is doing.
    const result = await bridge.call(
      "connections.agent_tasks",
      {
        requests: batch.map(([, { connectionId, pane }]) => ({
          connection_id: connectionId,
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
        })),
      },
      undefined,
      { lane: "background" },
    );
    const results: {
      connection_id: string;
      pane_id: string;
      tasks?: AgentTaskSummary[];
      partial?: boolean;
    }[] = Array.isArray(result?.results) ? result.results : [];
    for (const [key, request] of batch) {
      const found = results.find(
        (each) => agentTaskKey(each.connection_id, each.pane_id) === key,
      );
      // An error keeps what was known; the next change asks again.
      const at = Date.now();
      // Read from part of the session (a restart): asked again shortly,
      // what showed already staying meanwhile.
      if (found?.partial) {
        if (!pending.has(key))
          pending.set(key, { ...request, due: at + PARTIAL_RETRY_MS });
        if (entries.get(key)?.tasks.length) continue;
      }
      if (found && Array.isArray(found.tasks))
        entries.set(key, { version: request.version, tasks: found.tasks, at });
      else if (!entries.has(key))
        entries.set(key, { version: request.version, tasks: [], at });
    }
    notify();
  } catch {
    // Not connected, or an older server: nothing to show.
  } finally {
    for (const [key] of batch) inFlight.delete(key);
    if (pending.size) schedule();
  }
}

let timerDue = Number.POSITIVE_INFINITY;

function schedule() {
  const now = Date.now();
  let due = Number.POSITIVE_INFINITY;
  for (const [key, request] of pending)
    if (!inFlight.has(key)) due = Math.min(due, request.due);
  // What is in flight is looked at again once it settles.
  if (due === Number.POSITIVE_INFINITY) return;
  const at = Math.max(now + 250, due);
  if (timer !== undefined && timerDue <= at) return;
  clearTimeout(timer);
  timerDue = at;
  timer = setTimeout(() => void flush(), at - now);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Keeps the given Claude agents' side tasks current and re-renders when
 * they change. Returns a lookup by connection and pane.
 */
export function useTreeAgentTasks(
  agents: readonly { connectionId: string; pane: Pane }[],
): (connectionId: string, paneId: string) => AgentTaskSummary[] {
  useSyncExternalStore(subscribe, () => revision);
  const wanted = agents
    .filter(({ pane }) => pane.agent === "claude")
    .map(({ connectionId, pane }) => ({
      key: agentTaskKey(connectionId, pane.pane_id),
      version: agentTaskVersion(pane),
      connectionId,
      pane,
    }));
  const signature = wanted
    .map((each) => `${each.key}=${each.version}`)
    .join(";");
  const latest = useRef(wanted);
  latest.current = wanted;
  useEffect(() => {
    void signature;
    let queued = false;
    const now = Date.now();
    for (const each of latest.current) {
      const entry = entries.get(each.key);
      if (entry?.version === each.version) continue;
      if (pending.get(each.key)?.version === each.version) continue;
      const due = agentTasksReadDue(entry, each.version, now);
      pending.set(each.key, {
        version: each.version,
        connectionId: each.connectionId,
        pane: each.pane,
        due,
      });
      queued = true;
    }
    if (queued) schedule();
  }, [signature]);
  return (connectionId, paneId) =>
    entries.get(agentTaskKey(connectionId, paneId))?.tasks ?? [];
}

/**
 * What the agents the Workspaces list follows still run once their turn is
 * over, for the other lists (the pane switcher, Find workspace): the tasks
 * the list already read, nothing asked for here.
 */
export function useAgentBackground(): (
  connectionId: string,
  paneId: string,
) => BackgroundWork<AgentTaskSummary> {
  useSyncExternalStore(subscribe, () => revision);
  return (connectionId, paneId) =>
    backgroundWork(
      entries.get(agentTaskKey(connectionId, paneId))?.tasks ?? [],
    );
}

const SEEN_FAILURES_KEY = "roamgate.workspaceTree.seenTaskFailures";
const SEEN_FAILURES_MAX = 500;

function readSeenFailures(): string[] {
  try {
    const value = JSON.parse(
      roamgateLocalStorage.getItem(SEEN_FAILURES_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((each): each is string => typeof each === "string")
      : [];
  } catch {
    return [];
  }
}

let seenFailures = new Set(readSeenFailures());

function failureKey(connectionId: string, paneId: string, taskId: string) {
  return `${connectionId}\u0000${paneId}\u0000${taskId}`;
}

export function taskFailureSeen(
  connectionId: string,
  paneId: string,
  taskId: string,
): boolean {
  return seenFailures.has(failureKey(connectionId, paneId, taskId));
}

/** A failure the user opened leaves the Workspaces list. */
export function markTaskFailureSeen(
  connectionId: string,
  paneId: string,
  taskId: string,
) {
  const key = failureKey(connectionId, paneId, taskId);
  if (seenFailures.has(key)) return;
  const list = [...seenFailures, key].slice(-SEEN_FAILURES_MAX);
  seenFailures = new Set(list);
  try {
    roamgateLocalStorage.setItem(SEEN_FAILURES_KEY, JSON.stringify(list));
  } catch {
    // Kept for this page when storage is unavailable.
  }
  notify();
}

export const __treeTasksTesting = {
  reset() {
    entries.clear();
    pending.clear();
    inFlight.clear();
    clearTimeout(timer);
    timer = undefined;
    timerDue = Number.POSITIVE_INFINITY;
    seenFailures = new Set();
  },
  set(connectionId: string, paneId: string, tasks: AgentTaskSummary[]) {
    entries.set(agentTaskKey(connectionId, paneId), {
      version: "*",
      tasks,
      at: Date.now(),
    });
    notify();
  },
};
