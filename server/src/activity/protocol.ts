/**
 * Shapes of the activity protocol (docs/activity.md, activity.schema.json):
 * what the log reads back as. The recorder writes rows; these are the views.
 */

export type EventKind =
  | "workspace.focus"
  | "workspace.blur"
  | "agent.state"
  | "session.idle"
  | "session.active"
  | "ui.visibility";

export type AgentState = "working" | "idle" | "blocked" | "unknown";

export type BlurReason =
  | "switch"
  | "hidden"
  | "idle"
  | "disconnect"
  | "timeout"
  | "recorder_stop";

export type ClientKind = "desktop" | "phone";

export type EventSource = "browser" | "herdr";

export type ActivityEvent = {
  id: string;
  ts: string;
  kind: EventKind;
  connection_id: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  agent?: {
    name: string;
    state: AgentState;
    task: string | null;
    session_id: string | null;
  } | null;
  visible?: boolean | null;
  idle_after_seconds?: number | null;
  reason?: BlurReason | null;
  open?: boolean | null;
  client?: { id: string; kind: ClientKind } | null;
  source?: EventSource;
};

export type ActivityWorkspace = {
  id: string;
  connection_id: string;
  name: string;
  path: string | null;
  subject: null;
  repo: {
    root: string;
    remote_url: string | null;
    branch: string | null;
    is_worktree: boolean;
  } | null;
  herdr_workspace_id: string | null;
};

export type ActivityGap = {
  /** Null: the whole recorder was not running. */
  connection_id: string | null;
  start: string;
  end: string | null;
  reason: string;
  excluded: boolean;
};

/** Herdr's `done` (finished, not yet seen) is reported as idle. */
export function agentState(status: unknown): AgentState {
  switch (status) {
    case "working":
    case "idle":
    case "blocked":
      return status;
    case "done":
      return "idle";
    default:
      return "unknown";
  }
}

/** Opaque, and ordered as strings the way the log is. */
export function eventId(seq: number): string {
  return String(seq).padStart(16, "0");
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** ISO 8601 in local time with its offset, as the protocol writes times. */
export function isoTime(ms: number): string {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
