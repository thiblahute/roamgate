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

/**
 * What made an attention event happen. A browser reports the first six;
 * the recorder knows the Herdr ones. Only `user_input` and `user_focus`
 * are signs of a person (docs/activity.md#causes).
 */
export type EventCause =
  /** A key, pointer, wheel or touch in the page just before. */
  | "user_input"
  /** The page came to the front without input in it, after input since it loaded. */
  | "user_focus"
  /** The page loaded and has had no input since. */
  | "page_load"
  /** The page's socket to the bridge is new and no input came after it. */
  | "reconnect"
  /** The page's view moved without input, following Herdr's focus. */
  | "follow_herdr"
  /** The page's view moved without input, Roamgate itself moved it. */
  | "app"
  /** Herdr's focus event: someone at the TUI, or an agent through its CLI. */
  | "herdr_event"
  /** Herdr's focus found changed in a listing, without an event. */
  | "herdr_listing"
  /** The focus Herdr had when the recorder started. */
  | "recorder_start"
  /** The focus Herdr had when the connection came (back) up. */
  | "connection_ready";

export const EVENT_CAUSES: readonly EventCause[] = [
  "user_input",
  "user_focus",
  "page_load",
  "reconnect",
  "follow_herdr",
  "app",
  "herdr_event",
  "herdr_listing",
  "recorder_start",
  "connection_ready",
];

/** The causes a page can report with its presence. */
export type ReportedCause =
  | "user_input"
  | "user_focus"
  | "page_load"
  | "follow_herdr"
  | "app";

/** Causes that are a sign of a person. */
export function personCause(cause: EventCause | null | undefined): boolean {
  return cause === "user_input" || cause === "user_focus";
}

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
  /** On focus, on a switch or hidden blur, on a reported ui.visibility. */
  cause?: EventCause | null;
  /** The page's input age when it reported the event; null when unknown. */
  input_age_ms?: number | null;
};

export type SubjectGroup = { id: string; label: string };

/** The schema's Subject: the user's grouping of a workspace. */
export type Subject = {
  id: string;
  /** The nearest group. */
  label: string;
  source: "explicit" | "directory";
  /** Directory of the nearest group, when it has one. */
  path: string | null;
  /** From the top-level group to the nearest. */
  groups: SubjectGroup[];
};

export type ActivityWorkspace = {
  id: string;
  connection_id: string;
  name: string;
  path: string | null;
  subject: Subject | null;
  repo: {
    root: string;
    remote_url: string | null;
    branch: string | null;
    is_worktree: boolean;
  } | null;
  herdr_workspace_id: string | null;
};

/** The schema's RecordingGap. */
export type ActivityGap = {
  /** Null: the whole recorder was not running. */
  connection_id: string | null;
  start: string;
  /** Null while the gap is still open. */
  end: string | null;
  reason: string | null;
  /** Never set in the log; only on export to a provider. */
  excluded: boolean;
};

export type RecordingGap = ActivityGap;

export type ActivityPage = {
  events: ActivityEvent[];
  workspaces: ActivityWorkspace[];
  next_cursor: string | null;
};

/** The schema's Status: `roamgate activity status`. */
export type ActivityStatus = {
  recording: boolean;
  retention_days: number;
  last_alive: string | null;
  gaps: RecordingGap[];
  connections: {
    id: string;
    state: "ready" | "disconnected";
    recording_since: string | null;
  }[];
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
