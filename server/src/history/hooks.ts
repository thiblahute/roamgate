import type { WorkItem } from "../../../shared/work";

/**
 * Where the stores tell the history what they wrote, after their own write
 * succeeded. Nothing listens until the server starts its history
 * (runtime.ts): in tests and the CLI these are no-ops, and a listener that
 * throws never fails the store's write.
 */

/** Who made a Work change: the user, or an agent (its session's address). */
export type WorkActor = {
  by: "user" | "agent";
  /** The agent session's address (CONNECTION/PANE), when known. */
  address?: string;
  /** The agent's name ("Claude in roamgate"). */
  caller?: string;
};

export type WorkChange = {
  /** The item after the change; null when it was removed. */
  item: WorkItem | null;
  id: string;
  /** The fields that changed, as the store's history.jsonl has them. */
  change: Record<string, unknown>;
  actor: WorkActor;
  /** When (ISO 8601). */
  at: string;
};

export type HistorySink = {
  changed(area: string, id?: string): void;
  workChanged(change: WorkChange): void;
};

let sink: HistorySink | null = null;

export function setHistorySink(next: HistorySink | null) {
  sink = next;
}

export function historyChanged(area: string, id?: string) {
  try {
    sink?.changed(area, id);
  } catch {
    // The history is a copy: the store's write stands.
  }
}

export function historyWorkChanged(change: WorkChange) {
  try {
    sink?.workChanged(change);
  } catch {}
}
