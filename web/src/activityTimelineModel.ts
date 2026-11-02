/**
 * The activity timeline's data (server/src/activity/timeline.ts, read with
 * `bridge.activity.timeline`) and the pure layout the view draws from.
 */

export type TimelineSource = "browser" | "phone" | "herdr";
export type AgentState = "working" | "idle" | "blocked" | "unknown";

export type FocusSpan = {
  start: string;
  end: string;
  open: boolean;
  connection_id: string;
  workspace_id: string | null;
  pane_id: string | null;
  source: TimelineSource;
  client_id: string | null;
  reason: string | null;
};

export type AttentionSegment = {
  start: string;
  end: string;
  workspace_id: string;
  source: TimelineSource;
};

export type IdleSpan = {
  start: string;
  end: string;
  open: boolean;
  connection_id: string;
  client_id: string;
  client_kind: "desktop" | "phone";
};

export type AgentSpan = {
  start: string;
  end: string;
  open: boolean;
  state: AgentState;
};

export type AgentLane = {
  connection_id: string;
  workspace_id: string | null;
  pane_id: string | null;
  agent: string;
  task: string | null;
  spans: AgentSpan[];
};

export type RecordingGap = {
  connection_id: string | null;
  start: string;
  end: string | null;
  reason: string | null;
  excluded: boolean;
};

export type WorkspaceTotals = {
  workspace_id: string;
  attended_ms: number;
  browser_ms: number;
  phone_ms: number;
  herdr_ms: number;
  working_ms: number;
  blocked_ms: number;
};

export type TimelineDay = {
  date: string;
  start: string;
  end: string;
  focus: FocusSpan[];
  attention: AttentionSegment[];
  idle: IdleSpan[];
  agents: AgentLane[];
  gaps: RecordingGap[];
  totals: {
    attended_ms: number;
    idle_ms: number;
    unrecorded_ms: number;
    workspaces: WorkspaceTotals[];
  };
};

export type TimelineWorkspace = {
  id: string;
  connection_id: string;
  name: string;
  path: string | null;
  herdr_workspace_id: string | null;
};

export type Timeline = {
  recording: true;
  day_start: string;
  now: string;
  from: string;
  to: string;
  recorder_running: boolean;
  days: TimelineDay[];
  workspaces: TimelineWorkspace[];
};

export type TimelineReply = Timeline | { recording: false };

export const REFRESH_MS = 60_000;
const HOUR = 3_600_000;
/** The axis shows at least this much, so a quiet morning is not a blur. */
const MIN_WINDOW = 4 * HOUR;

/** Adds days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y!, m! - 1, d! + days, 12);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? "<1m" : "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${hours}h`;
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "Monday 2 November", in the browser's language. */
export function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** A stable hue per workspace, the same in every view and theme. */
export function workspaceHue(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

export function workspaceColor(id: string): string {
  return `oklch(0.7 0.14 ${workspaceHue(id)})`;
}

export type AxisWindow = { start: number; end: number; ticks: number[] };

/**
 * The part of the day the axis shows: whole hours around what happened (and
 * now, today), at least MIN_WINDOW, never outside the day.
 */
export function axisWindow(day: TimelineDay, now: number): AxisWindow {
  const dayStart = Date.parse(day.start);
  const dayEnd = Date.parse(day.end);
  const times: number[] = [];
  const add = (span: { start: string; end: string | null }) => {
    times.push(Date.parse(span.start));
    if (span.end) times.push(Date.parse(span.end));
  };
  day.focus.forEach(add);
  day.idle.forEach(add);
  for (const lane of day.agents) lane.spans.forEach(add);
  if (now >= dayStart && now < dayEnd) times.push(now);
  let start = times.length ? Math.min(...times) : dayStart;
  let end = times.length ? Math.max(...times) : dayEnd;
  const hourOf = (ms: number, up: boolean) => {
    const date = new Date(ms);
    const floor = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
    ).getTime();
    return up && floor < ms ? floor + HOUR : floor;
  };
  start = Math.max(dayStart, hourOf(start, false));
  end = Math.min(dayEnd, hourOf(end, true));
  // Widened into the past first: today, now stays at the right edge.
  if (end - start < MIN_WINDOW) {
    start = Math.max(dayStart, end - MIN_WINDOW);
    end = Math.min(dayEnd, start + MIN_WINDOW);
  }
  const hours = (end - start) / HOUR;
  const step = hours > 16 ? 3 : hours > 8 ? 2 : 1;
  const ticks: number[] = [];
  for (let tick = hourOf(start, true); tick <= end; tick += HOUR)
    if (new Date(tick).getHours() % step === 0) ticks.push(tick);
  return { start, end, ticks };
}

/** Left and width in percent of the window; null when outside it. */
export function place(
  span: { start: string; end: string | null },
  window: AxisWindow,
  now: number,
): { left: number; width: number } | null {
  const start = Math.max(Date.parse(span.start), window.start);
  const end = Math.min(
    span.end === null ? now : Date.parse(span.end),
    window.end,
  );
  if (end <= start) return null;
  const total = window.end - window.start;
  return {
    left: ((start - window.start) / total) * 100,
    width: ((end - start) / total) * 100,
  };
}

export type WorkspaceRow = {
  id: string;
  workspace: TimelineWorkspace | null;
  name: string;
  totals: WorkspaceTotals | null;
  attention: AttentionSegment[];
  lanes: AgentLane[];
};

/** Workspaces with attention or agents that day, most attended first. */
export function workspaceRows(
  day: TimelineDay,
  workspaces: TimelineWorkspace[],
): WorkspaceRow[] {
  const byId = new Map(workspaces.map((entry) => [entry.id, entry]));
  const rows = new Map<string, WorkspaceRow>();
  const row = (id: string) => {
    let entry = rows.get(id);
    if (!entry) {
      const workspace = byId.get(id) ?? null;
      entry = {
        id,
        workspace,
        name: workspace?.name ?? id,
        totals: null,
        attention: [],
        lanes: [],
      };
      rows.set(id, entry);
    }
    return entry;
  };
  for (const totals of day.totals.workspaces)
    row(totals.workspace_id).totals = totals;
  for (const segment of day.attention)
    row(segment.workspace_id).attention.push(segment);
  for (const lane of day.agents)
    if (lane.workspace_id) row(lane.workspace_id).lanes.push(lane);
  const attended = (entry: WorkspaceRow) => entry.totals?.attended_ms ?? 0;
  const working = (entry: WorkspaceRow) => entry.totals?.working_ms ?? 0;
  // Agents only ever idle there: nothing worth a row.
  return [...rows.values()]
    .filter(
      (entry) =>
        entry.attention.length > 0 ||
        entry.lanes.some((lane) =>
          lane.spans.some(
            (span) => span.state === "working" || span.state === "blocked",
          ),
        ),
    )
    .sort(
      (a, b) =>
        attended(b) - attended(a) ||
        working(b) - working(a) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * Herdr's id for a timeline workspace: on the connection shown, the
 * workspace at the same path (Herdr's ids change across restarts), else the
 * id last recorded.
 */
export function jumpTarget(
  workspace: TimelineWorkspace,
  activeConnectionId: string | null,
  current: {
    workspace_id: string;
    cwd?: string;
    worktree?: { checkout_path: string };
  }[],
): string | null {
  if (workspace.path && activeConnectionId === workspace.connection_id) {
    const match = current.find(
      (entry) =>
        entry.worktree?.checkout_path === workspace.path ||
        entry.cwd === workspace.path,
    );
    if (match) return match.workspace_id;
  }
  return workspace.herdr_workspace_id;
}

export const SOURCE_LABELS: Record<TimelineSource, string> = {
  browser: "Browser",
  phone: "Phone",
  herdr: "Herdr TUI",
};

export const STATE_LABELS: Record<AgentState, string> = {
  working: "Working",
  blocked: "Blocked",
  idle: "Idle",
  unknown: "Unknown",
};
