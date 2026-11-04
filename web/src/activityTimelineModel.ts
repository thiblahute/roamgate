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

/** A subject's workspaces together; `subject_id` null for those with none. */
export type SubjectTotals = {
  subject_id: string | null;
  label: string | null;
  attended_ms: number;
  browser_ms: number;
  phone_ms: number;
  herdr_ms: number;
  working_ms: number;
  blocked_ms: number;
  workspace_ids: string[];
};

/** The user's grouping of a workspace (docs/activity.md#subjects). */
export type Subject = {
  id: string;
  label: string;
  source: "explicit" | "directory";
  path: string | null;
  groups: { id: string; label: string }[];
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
    /** Absent from bridges older than subjects. */
    subjects?: SubjectTotals[];
  };
};

export type TimelineWorkspace = {
  id: string;
  connection_id: string;
  name: string;
  path: string | null;
  herdr_workspace_id: string | null;
  subject?: Subject | null;
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

/** How the timeline lists and colours workspaces. */
export type GroupBy = "workspace" | "subject";

const GROUP_BY_KEY = "roamgate.activity.groupBy";

export function storedGroupBy(
  storage: Pick<Storage, "getItem"> | null,
): GroupBy {
  try {
    return storage?.getItem(GROUP_BY_KEY) === "subject"
      ? "subject"
      : "workspace";
  } catch {
    return "workspace";
  }
}

export function storeGroupBy(
  storage: Pick<Storage, "setItem"> | null,
  value: GroupBy,
) {
  try {
    storage?.setItem(GROUP_BY_KEY, value);
  } catch {
    // Private mode: the choice lasts the page.
  }
}

/** A workspace's colour: its subject's when grouping by subject. */
export function colorFor(
  workspaceId: string,
  workspace: TimelineWorkspace | null | undefined,
  groupBy: GroupBy,
): string {
  const subject = groupBy === "subject" ? workspace?.subject : null;
  return workspaceColor(subject ? subject.id : workspaceId);
}

export type AxisWindow = { start: number; end: number; ticks: number[] };

/** When things happened: the edges of every span (and now, today). */
export function activityTimes(day: TimelineDay, now: number): number[] {
  const dayStart = Date.parse(day.start);
  const dayEnd = Date.parse(day.end);
  const times: number[] = [];
  const add = (span: { start: string; end: string | null }) => {
    times.push(Date.parse(span.start));
    if (span.end) times.push(Date.parse(span.end));
  };
  day.focus.forEach(add);
  day.attention.forEach(add);
  day.idle.forEach(add);
  for (const lane of day.agents) lane.spans.forEach(add);
  if (now >= dayStart && now < dayEnd) times.push(now);
  return times;
}

/**
 * When the user was there: the edges of their attention, for the "Work
 * hours" zoom (agents may run all day); every activity when there is none.
 */
export function attentionTimes(day: TimelineDay, now: number): number[] {
  const times = day.attention.flatMap((span) => [
    Date.parse(span.start),
    span.end ? Date.parse(span.end) : now,
  ]);
  return times.length ? times : activityTimes(day, now);
}

/** The local midnight of a day (YYYY-MM-DD), where the axis's ticks start. */
export function localMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

/**
 * The part of the day the axis shows: whole hours around what happened (and
 * now, today), at least MIN_WINDOW, never outside the day.
 */
export function axisWindow(day: TimelineDay, now: number): AxisWindow {
  const dayStart = Date.parse(day.start);
  const dayEnd = Date.parse(day.end);
  const times = activityTimes(day, now);
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

export type SubjectGroup = {
  /** Null: the workspaces with no subject. */
  id: string | null;
  label: string;
  subject: Subject | null;
  totals: Omit<SubjectTotals, "subject_id" | "label" | "workspace_ids">;
  attention: AttentionSegment[];
  rows: WorkspaceRow[];
};

/**
 * The day's workspace rows under their subjects, most attended first; the
 * workspaces with no subject last.
 */
export function subjectGroups(
  day: TimelineDay,
  workspaces: TimelineWorkspace[],
): SubjectGroup[] {
  const rows = workspaceRows(day, workspaces);
  const groups = new Map<string | null, SubjectGroup>();
  const reported = new Map(
    (day.totals.subjects ?? []).map((entry) => [entry.subject_id, entry]),
  );
  for (const row of rows) {
    const subject = row.workspace?.subject ?? null;
    const key = subject?.id ?? null;
    let group = groups.get(key);
    if (!group) {
      const totals = reported.get(key);
      group = {
        id: key,
        label: subject?.label ?? "No subject",
        subject,
        totals: {
          attended_ms: totals?.attended_ms ?? 0,
          browser_ms: totals?.browser_ms ?? 0,
          phone_ms: totals?.phone_ms ?? 0,
          herdr_ms: totals?.herdr_ms ?? 0,
          working_ms: totals?.working_ms ?? 0,
          blocked_ms: totals?.blocked_ms ?? 0,
        },
        attention: [],
        rows: [],
      };
      // An older bridge: attention adds up, agents' overlap is unknown.
      if (!totals)
        for (const field of [
          "attended_ms",
          "browser_ms",
          "phone_ms",
          "herdr_ms",
        ] as const)
          group.totals[field] = 0;
      groups.set(key, group);
    }
    group.rows.push(row);
    group.attention.push(...row.attention);
    if (!reported.has(key) && row.totals)
      for (const field of [
        "attended_ms",
        "browser_ms",
        "phone_ms",
        "herdr_ms",
      ] as const)
        group.totals[field] += row.totals[field];
  }
  for (const group of groups.values())
    group.attention.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.id === null) - Number(b.id === null) ||
      b.totals.attended_ms - a.totals.attended_ms ||
      b.totals.working_ms - a.totals.working_ms ||
      a.label.localeCompare(b.label),
  );
}
