/**
 * The activity timeline (docs/activity.md#timeline): the log's rows for a
 * range turned into spans per local day. Pure: the rows come from reader.ts,
 * the clock and the day start from the caller.
 */
import type {
  ActivityWorkspace,
  AgentState,
  BlurReason,
  ClientKind,
  EventSource,
  RecordingGap,
  Subject,
} from "./protocol";
import { isoTime } from "./protocol";

/** A recorder whose last alive stamp is older than this is not running. */
export const RECORDER_STALE_MS = 150_000;

/** `idle_seconds`' default: how long a sign of a person lasts. */
export const DEFAULT_IDLE_MS = 300_000;

/** A focus event and the blur that ended it, if any. */
export type FocusRow = {
  seq: number;
  start: number;
  end: number | null;
  reason: BlurReason | null;
  connection_id: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  source: EventSource;
  client_id: string | null;
  client_kind: ClientKind | null;
  session: number;
};

/** session.idle, session.active and ui.visibility, per client. */
export type PresenceRow = {
  seq: number;
  ts: number;
  kind: "session.idle" | "session.active" | "ui.visibility";
  connection_id: string;
  client_id: string;
  client_kind: ClientKind;
  visible: boolean | null;
  session: number;
};

export type AgentRow = {
  seq: number;
  ts: number;
  connection_id: string;
  workspace_id: string | null;
  pane_id: string | null;
  name: string;
  state: AgentState;
  task: string | null;
  session: number;
};

export type GapInputRow = {
  connection_id: string | null;
  start: number;
  end: number | null;
  reason: string | null;
};

export type SessionInputRow = {
  id: number;
  started_at: number;
  last_alive: number;
  stopped_at: number | null;
};

/**
 * What the log holds for `[from, to)`: rows that start in it, plus the
 * focus spans still running into it and each lane's last agent state and
 * each client's last presence row before it.
 */
export type TimelineInput = {
  from: number;
  to: number;
  now: number;
  dayStart: string;
  focus: FocusRow[];
  presence: PresenceRow[];
  agents: AgentRow[];
  gaps: GapInputRow[];
  sessions: SessionInputRow[];
  workspaces: ActivityWorkspace[];
  /**
   * `idle_seconds` in milliseconds: how long after a sign of a person
   * (input in a browser or phone, a focus change in Herdr's TUI) Herdr's
   * TUI focus still counts as attention.
   */
  idleMs?: number;
};

/** browser and phone are Roamgate clients; herdr is Herdr's TUI focus. */
export type TimelineSource = "browser" | "phone" | "herdr";

export type FocusSpan = {
  start: string;
  end: string;
  /** Still running: `end` is now. */
  open: boolean;
  connection_id: string;
  workspace_id: string | null;
  pane_id: string | null;
  source: TimelineSource;
  client_id: string | null;
  /** Null while open. */
  reason: BlurReason | null;
};

/** Who had the attention, without overlaps: what the totals count. */
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
  client_kind: ClientKind;
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

export type WorkspaceTotals = {
  workspace_id: string;
  /** browser_ms + phone_ms + herdr_ms. */
  attended_ms: number;
  browser_ms: number;
  phone_ms: number;
  /**
   * Herdr's TUI focus, only where no browser or phone had attention and
   * within `idle_seconds` of a sign of a person.
   */
  herdr_ms: number;
  /** Time at least one of the workspace's agents was working. */
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
  /** Time at least one agent of the subject's workspaces was working. */
  working_ms: number;
  blocked_ms: number;
  workspace_ids: string[];
};

export type DayTotals = {
  attended_ms: number;
  idle_ms: number;
  /** The whole recorder was not running. */
  unrecorded_ms: number;
  workspaces: WorkspaceTotals[];
  subjects: SubjectTotals[];
};

export type TimelineDay = {
  /** Local date the day starts on, `YYYY-MM-DD`. */
  date: string;
  start: string;
  end: string;
  focus: FocusSpan[];
  attention: AttentionSegment[];
  idle: IdleSpan[];
  agents: AgentLane[];
  /** The schema's RecordingGap, clipped to the day; `end` null while open. */
  gaps: RecordingGap[];
  totals: DayTotals;
};

export type TimelineWorkspace = {
  id: string;
  connection_id: string;
  name: string;
  path: string | null;
  herdr_workspace_id: string | null;
  subject: Subject | null;
};

export type Timeline = {
  recording: true;
  day_start: string;
  now: string;
  from: string;
  to: string;
  /** False when the recorder is not running: open spans end at its last stamp. */
  recorder_running: boolean;
  days: TimelineDay[];
  workspaces: TimelineWorkspace[];
};

// --- Days ---------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dayStartMinutes(dayStart: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(dayStart);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
  );
  return (
    date.getFullYear() === Number(match[1]) &&
    date.getMonth() === Number(match[2]) - 1 &&
    date.getDate() === Number(match[3])
  );
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Adds days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y!, m! - 1, d! + days, 12));
}

/** The local day `date`, from `dayStart` to `dayStart` the next day. */
export function dayBounds(
  date: string,
  dayStart: string,
): { start: number; end: number } {
  const [y, m, d] = date.split("-").map(Number);
  const minutes = dayStartMinutes(dayStart);
  const at = (offset: number) =>
    new Date(
      y!,
      m! - 1,
      d! + offset,
      Math.floor(minutes / 60),
      minutes % 60,
    ).getTime();
  return { start: at(0), end: at(1) };
}

/** The day `ms` belongs to, given the day start. */
export function dayOf(ms: number, dayStart: string): string {
  const date = localDate(new Date(ms));
  return ms < dayBounds(date, dayStart).start ? addDays(date, -1) : date;
}

/** The dates from `first` to `last`, both included. */
export function datesBetween(first: string, last: string): string[] {
  const dates: string[] = [];
  for (let date = first; date <= last; date = addDays(date, 1))
    dates.push(date);
  return dates;
}

// --- Intervals ----------------------------------------------------------

type Interval = { start: number; end: number };

/** Sorted, merged. */
function union(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const entry of sorted) {
    const last = merged[merged.length - 1];
    if (last && entry.start <= last.end)
      last.end = Math.max(last.end, entry.end);
    else merged.push({ ...entry });
  }
  return merged;
}

function length(intervals: Interval[]): number {
  return union(intervals).reduce(
    (sum, entry) => sum + entry.end - entry.start,
    0,
  );
}

/** `interval` minus the (merged) `cuts`. */
function subtract(interval: Interval, cuts: Interval[]): Interval[] {
  const parts: Interval[] = [];
  let cursor = interval.start;
  for (const cut of cuts) {
    if (cut.end <= cursor) continue;
    if (cut.start >= interval.end) break;
    if (cut.start > cursor) parts.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < interval.end) parts.push({ start: cursor, end: interval.end });
  return parts;
}

function clip<T extends Interval>(span: T, range: Interval): T | null {
  const start = Math.max(span.start, range.start);
  const end = Math.min(span.end, range.end);
  return end > start ? { ...span, start, end } : null;
}

/** The parts of `span` inside the (merged) `windows`. */
function within<T extends Interval>(span: T, windows: Interval[]): T[] {
  return windows
    .map((window) => clip(span, window))
    .filter((part): part is T => part !== null);
}

// --- Building -----------------------------------------------------------

type Resolved = {
  start: number;
  end: number;
  open: boolean;
};

type ResolvedFocus = Resolved & {
  row: FocusRow;
  source: TimelineSource;
};

function timelineSource(row: FocusRow): TimelineSource {
  if (row.source === "herdr") return "herdr";
  return row.client_kind === "phone" ? "phone" : "browser";
}

/** When what a session left open ends: now while it runs, else its last stamp. */
function sessionEnds(sessions: SessionInputRow[], now: number) {
  const latest = sessions.reduce<SessionInputRow | null>(
    (best, entry) => (!best || entry.id > best.id ? entry : best),
    null,
  );
  const running =
    !!latest &&
    latest.stopped_at === null &&
    now - latest.last_alive <= RECORDER_STALE_MS;
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  return {
    latest,
    running,
    end(session: number): { end: number; open: boolean } {
      if (running && session === latest!.id) return { end: now, open: true };
      const row = byId.get(session);
      if (!row) return { end: now, open: true };
      return { end: row.stopped_at ?? row.last_alive, open: false };
    },
  };
}

/** The span with the latest start (then the latest seq) wins an instant. */
function latest<T extends { start: number; seq: number }>(
  spans: T[],
): T | null {
  let best: T | null = null;
  for (const span of spans)
    if (
      !best ||
      span.start > best.start ||
      (span.start === best.start && span.seq > best.seq)
    )
      best = span;
  return best;
}

/**
 * When a person was there: Herdr cannot say whether anyone looks at its TUI
 * (no attached client count, no input time; its output events cannot tell
 * typing from a program writing), and its focus spans run all night. So its
 * TUI time counts only within `idleMs` of a sign of a person:
 *
 * - a browser or phone span, while it runs (it ends `idleMs` after the last
 *   input at the latest) and `idleMs` after it ends, unless it ended as idle
 *   (dated at the last input plus `idleMs` already): the page was hidden,
 *   say, to type in the terminal;
 * - input after idle (`session.active`) or a page brought to the front;
 * - a focus change in Herdr's TUI, a Herdr span that ended with `switch`.
 *   A span opened when the recorder or the connection starts is no sign.
 */
function personWindows(
  focus: ResolvedFocus[],
  presence: PresenceRow[],
  idleMs: number,
): Interval[] {
  const windows: Interval[] = [];
  for (const entry of focus) {
    if (entry.source === "herdr") {
      if (entry.row.end !== null && entry.row.reason === "switch")
        windows.push({ start: entry.row.end, end: entry.row.end + idleMs });
      continue;
    }
    windows.push({
      start: entry.start,
      end: entry.end + (entry.row.reason === "idle" ? 0 : idleMs),
    });
  }
  for (const row of presence)
    if (
      row.kind === "session.active" ||
      (row.kind === "ui.visibility" && row.visible)
    )
      windows.push({ start: row.ts, end: row.ts + idleMs });
  return union(windows);
}

/**
 * Non-overlapping attention for a day: at each instant the most recently
 * started browser or phone span; Herdr spans only where none is running,
 * and only within the person windows (see personWindows).
 */
function attentionSegments(focus: ResolvedFocus[], day: Interval) {
  const spans = focus
    .filter((entry) => entry.row.workspace_id)
    .map((entry) => clip(entry, day))
    .filter((entry): entry is ResolvedFocus => entry !== null)
    .map((entry) => ({ ...entry, seq: entry.row.seq }));
  const bounds = [
    ...new Set(spans.flatMap((entry) => [entry.start, entry.end])),
  ].sort((a, b) => a - b);
  const segments: {
    start: number;
    end: number;
    workspace_id: string;
    source: TimelineSource;
  }[] = [];
  for (let index = 0; index + 1 < bounds.length; index++) {
    const start = bounds[index]!;
    const end = bounds[index + 1]!;
    const active = spans.filter(
      (entry) => entry.start <= start && entry.end >= end,
    );
    const winner =
      latest(active.filter((entry) => entry.source !== "herdr")) ??
      latest(active);
    if (!winner) continue;
    const last = segments[segments.length - 1];
    if (
      last &&
      last.end === start &&
      last.workspace_id === winner.row.workspace_id &&
      last.source === winner.source
    )
      last.end = end;
    else
      segments.push({
        start,
        end,
        workspace_id: winner.row.workspace_id!,
        source: winner.source,
      });
  }
  return segments;
}

type LaneSpan = Resolved & { state: AgentState };
type Lane = {
  connection_id: string;
  workspace_id: string | null;
  pane_id: string | null;
  agent: string;
  task: string | null;
  spans: LaneSpan[];
};

function agentLanes(
  rows: AgentRow[],
  ends: ReturnType<typeof sessionEnds>,
  gapsFor: (connectionId: string) => Interval[],
  limit: number,
): Lane[] {
  const byKey = new Map<string, AgentRow[]>();
  for (const row of rows) {
    const key = `${row.connection_id}\u0000${row.pane_id ?? ""}\u0000${row.name}`;
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(row);
  }
  const lanes: Lane[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const first = list[0]!;
    const lane: Lane = {
      connection_id: first.connection_id,
      workspace_id: null,
      pane_id: first.pane_id,
      agent: first.name,
      task: null,
      spans: [],
    };
    const cuts = gapsFor(first.connection_id);
    list.forEach((row, index) => {
      if (row.workspace_id) lane.workspace_id = row.workspace_id;
      if (row.task) lane.task = row.task;
      const next = list[index + 1];
      let end: number;
      let open = false;
      if (next) end = next.ts;
      else if (row.state === "unknown")
        // A pane that closed: nothing is known after it.
        end = row.ts;
      else ({ end, open } = ends.end(row.session));
      end = Math.min(end, limit);
      for (const part of subtract({ start: row.ts, end }, cuts)) {
        const previous = lane.spans[lane.spans.length - 1];
        const partOpen = open && part.end === end;
        if (
          previous &&
          previous.state === row.state &&
          previous.end === part.start
        ) {
          previous.end = part.end;
          previous.open = partOpen;
        } else lane.spans.push({ ...part, open: partOpen, state: row.state });
      }
    });
    if (lane.spans.length > 0) lanes.push(lane);
  }
  return lanes.sort(
    (a, b) =>
      (a.workspace_id ?? "").localeCompare(b.workspace_id ?? "") ||
      a.agent.localeCompare(b.agent) ||
      (a.pane_id ?? "").localeCompare(b.pane_id ?? ""),
  );
}

function idleSpans(
  presence: PresenceRow[],
  focus: FocusRow[],
  ends: ReturnType<typeof sessionEnds>,
  limit: number,
) {
  type Signal = { seq: number; ts: number; row?: PresenceRow };
  const byClient = new Map<string, Signal[]>();
  const add = (client: string, signal: Signal) => {
    let list = byClient.get(client);
    if (!list) byClient.set(client, (list = []));
    list.push(signal);
  };
  for (const row of presence)
    add(row.client_id, { seq: row.seq, ts: row.ts, row });
  // A new focus by the same client also means it is no longer idle.
  for (const row of focus)
    if (row.client_id) add(row.client_id, { seq: row.seq, ts: row.start });
  const spans: (Resolved & {
    connection_id: string;
    client_id: string;
    client_kind: ClientKind;
  })[] = [];
  for (const list of byClient.values()) {
    list.sort((a, b) => a.seq - b.seq);
    list.forEach((signal, index) => {
      const row = signal.row;
      if (row?.kind !== "session.idle") return;
      const next = list[index + 1];
      let end: number;
      let open = false;
      if (next) end = Math.max(next.ts, row.ts);
      else ({ end, open } = ends.end(row.session));
      end = Math.min(end, limit);
      if (end > row.ts)
        spans.push({
          start: row.ts,
          end,
          open,
          connection_id: row.connection_id,
          client_id: row.client_id,
          client_kind: row.client_kind,
        });
    });
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function buildTimeline(input: TimelineInput): Timeline {
  const { from, to, now, dayStart } = input;
  if (![from, to, now].every(Number.isFinite) || to <= from)
    throw new Error("invalid timeline range");
  const limit = Math.min(to, now);
  const ends = sessionEnds(input.sessions, now);
  const subjects = new Map(
    input.workspaces.map((workspace) => [workspace.id, workspace.subject]),
  );
  const subjectOfId = (id: string) => subjects.get(id) ?? null;

  const gaps: (Interval & {
    connection_id: string | null;
    reason: string | null;
    open: boolean;
  })[] = input.gaps.map((gap) => ({
    connection_id: gap.connection_id,
    reason: gap.reason,
    start: gap.start,
    end: gap.end ?? now,
    open: gap.end === null,
  }));
  // A recorder that is not running now has not recorded since it stopped.
  if (ends.latest && !ends.running) {
    const since = ends.latest.stopped_at ?? ends.latest.last_alive;
    if (since < now)
      gaps.push({
        connection_id: null,
        reason: "recorder",
        start: since,
        end: now,
        open: true,
      });
  }
  const recorderGaps = union(gaps.filter((gap) => gap.connection_id === null));
  const gapsFor = (connectionId: string) =>
    union(
      gaps.filter(
        (gap) =>
          gap.connection_id === null || gap.connection_id === connectionId,
      ),
    );

  const focus: ResolvedFocus[] = input.focus.map((row) => {
    let end: number;
    let open = false;
    if (row.end !== null) end = row.end;
    else ({ end, open } = ends.end(row.session));
    return {
      row,
      source: timelineSource(row),
      start: row.start,
      end: Math.max(row.start, Math.min(end, limit)),
      open,
    };
  });
  const idleMs = input.idleMs ?? DEFAULT_IDLE_MS;
  const windows = personWindows(focus, input.presence, idleMs);
  // Herdr's TUI time with no sign of a person is no attention.
  const attended = focus.flatMap((entry) =>
    entry.source === "herdr" ? within(entry, windows) : [entry],
  );
  const idle = idleSpans(input.presence, input.focus, ends, limit);
  const lanes = agentLanes(input.agents, ends, gapsFor, limit);

  const firstDay = dayOf(from, dayStart);
  const lastDay = dayOf(Math.max(from, to - 1), dayStart);
  const days: TimelineDay[] = [];
  const referenced = new Set<string>();
  for (const date of datesBetween(firstDay, lastDay)) {
    const bounds = dayBounds(date, dayStart);
    const day = {
      start: Math.max(bounds.start, from),
      end: Math.min(bounds.end, to),
    };
    const dayFocus = focus
      .map((entry) => clip(entry, day))
      .filter((entry): entry is ResolvedFocus => entry !== null)
      .sort((a, b) => a.start - b.start || a.row.seq - b.row.seq);
    const attention = attentionSegments(attended, day);
    const dayIdle = idle
      .map((entry) => clip(entry, day))
      .filter((entry) => entry !== null);
    const dayLanes = lanes
      .map((lane) => ({
        ...lane,
        spans: lane.spans
          .map((span) => clip(span, day))
          .filter((span): span is LaneSpan => span !== null),
      }))
      .filter((lane) => lane.spans.length > 0);
    const dayGaps = gaps
      .map((gap) => clip(gap, day))
      .filter((gap) => gap !== null)
      .sort((a, b) => a.start - b.start);

    const totals = new Map<string, WorkspaceTotals>();
    const totalsFor = (workspaceId: string) => {
      let entry = totals.get(workspaceId);
      if (!entry)
        totals.set(
          workspaceId,
          (entry = {
            workspace_id: workspaceId,
            attended_ms: 0,
            browser_ms: 0,
            phone_ms: 0,
            herdr_ms: 0,
            working_ms: 0,
            blocked_ms: 0,
          }),
        );
      return entry;
    };
    for (const segment of attention) {
      const entry = totalsFor(segment.workspace_id);
      const duration = segment.end - segment.start;
      entry.attended_ms += duration;
      entry[`${segment.source}_ms`] += duration;
    }
    const byWorkspace = new Map<string, Lane[]>();
    for (const lane of dayLanes) {
      if (!lane.workspace_id) continue;
      let list = byWorkspace.get(lane.workspace_id);
      if (!list) byWorkspace.set(lane.workspace_id, (list = []));
      list.push(lane);
    }
    for (const [workspaceId, list] of byWorkspace) {
      const spans = list.flatMap((lane) => lane.spans);
      const working = length(spans.filter((span) => span.state === "working"));
      const blocked = length(spans.filter((span) => span.state === "blocked"));
      if (working === 0 && blocked === 0) continue;
      const entry = totalsFor(workspaceId);
      entry.working_ms = working;
      entry.blocked_ms = blocked;
    }
    const workspaceTotals = [...totals.values()].sort(
      (a, b) =>
        b.attended_ms - a.attended_ms ||
        b.working_ms - a.working_ms ||
        a.workspace_id.localeCompare(b.workspace_id),
    );
    const subjectTotals = new Map<string | null, SubjectTotals>();
    for (const entry of workspaceTotals) {
      const subject = subjectOfId(entry.workspace_id);
      const key = subject?.id ?? null;
      let total = subjectTotals.get(key);
      if (!total)
        subjectTotals.set(
          key,
          (total = {
            subject_id: key,
            label: subject?.label ?? null,
            attended_ms: 0,
            browser_ms: 0,
            phone_ms: 0,
            herdr_ms: 0,
            working_ms: 0,
            blocked_ms: 0,
            workspace_ids: [],
          }),
        );
      total.workspace_ids.push(entry.workspace_id);
      for (const field of [
        "attended_ms",
        "browser_ms",
        "phone_ms",
        "herdr_ms",
      ] as const)
        total[field] += entry[field];
    }
    // Agents overlap across a subject's workspaces: count each instant once.
    for (const total of subjectTotals.values()) {
      const ids = new Set(total.workspace_ids);
      const spans = dayLanes
        .filter((lane) => lane.workspace_id && ids.has(lane.workspace_id))
        .flatMap((lane) => lane.spans);
      total.working_ms = length(
        spans.filter((span) => span.state === "working"),
      );
      total.blocked_ms = length(
        spans.filter((span) => span.state === "blocked"),
      );
    }
    for (const entry of dayFocus)
      if (entry.row.workspace_id) referenced.add(entry.row.workspace_id);
    for (const lane of dayLanes)
      if (lane.workspace_id) referenced.add(lane.workspace_id);

    days.push({
      date,
      start: isoTime(day.start),
      end: isoTime(day.end),
      focus: dayFocus.map((entry) => ({
        start: isoTime(entry.start),
        end: isoTime(entry.end),
        open: entry.open && entry.end === limit,
        connection_id: entry.row.connection_id,
        workspace_id: entry.row.workspace_id,
        pane_id: entry.row.pane_id,
        source: entry.source,
        client_id: entry.row.client_id,
        reason: entry.row.end === null ? null : entry.row.reason,
      })),
      attention: attention.map((segment) => ({
        ...segment,
        start: isoTime(segment.start),
        end: isoTime(segment.end),
      })),
      idle: dayIdle.map((entry) => ({
        start: isoTime(entry.start),
        end: isoTime(entry.end),
        open: entry.open && entry.end === limit,
        connection_id: entry.connection_id,
        client_id: entry.client_id,
        client_kind: entry.client_kind,
      })),
      agents: dayLanes.map((lane) => ({
        connection_id: lane.connection_id,
        workspace_id: lane.workspace_id,
        pane_id: lane.pane_id,
        agent: lane.agent,
        task: lane.task,
        spans: lane.spans.map((span) => ({
          start: isoTime(span.start),
          end: isoTime(span.end),
          open: span.open && span.end === limit,
          state: span.state,
        })),
      })),
      gaps: dayGaps.map((gap) => ({
        connection_id: gap.connection_id,
        start: isoTime(gap.start),
        end: gap.open && gap.end === now ? null : isoTime(gap.end),
        reason: gap.reason,
        excluded: false,
      })),
      totals: {
        attended_ms: attention.reduce(
          (sum, segment) => sum + segment.end - segment.start,
          0,
        ),
        idle_ms: length(dayIdle),
        unrecorded_ms: length(
          recorderGaps
            .map((gap) => clip({ ...gap, end: Math.min(gap.end, limit) }, day))
            .filter((gap) => gap !== null),
        ),
        workspaces: workspaceTotals,
        subjects: [...subjectTotals.values()].sort(
          (a, b) =>
            b.attended_ms - a.attended_ms ||
            b.working_ms - a.working_ms ||
            (a.label ?? "\uffff").localeCompare(b.label ?? "\uffff"),
        ),
      },
    });
  }

  return {
    recording: true,
    day_start: dayStart,
    now: isoTime(now),
    from: isoTime(from),
    to: isoTime(to),
    recorder_running: ends.running || !ends.latest,
    days,
    workspaces: input.workspaces
      .filter((workspace) => referenced.has(workspace.id))
      .map((workspace) => ({
        id: workspace.id,
        connection_id: workspace.connection_id,
        name: workspace.name,
        path: workspace.path,
        herdr_workspace_id: workspace.herdr_workspace_id,
        subject: workspace.subject,
      })),
  };
}

/** The longest range one timeline request may cover. */
export const TIMELINE_MAX_DAYS = 92;

/**
 * The range of a timeline request: `from` and `to` are local dates
 * (`YYYY-MM-DD`, both included); either defaults to the other, both to the
 * day `now` is in.
 */
export function timelineRange(
  params: { from?: unknown; to?: unknown },
  now: number,
  dayStart: string,
): { from: number; to: number } {
  for (const key of ["from", "to"] as const)
    if (
      params[key] !== undefined &&
      params[key] !== null &&
      !isDate(params[key])
    )
      throw new Error(`${key} must be a date, YYYY-MM-DD`);
  const today = dayOf(now, dayStart);
  const first = (params.from ?? params.to ?? today) as string;
  const last = (params.to ?? params.from ?? today) as string;
  if (last < first) throw new Error("to is before from");
  if (datesBetween(first, last).length > TIMELINE_MAX_DAYS)
    throw new Error(`at most ${TIMELINE_MAX_DAYS} days at once`);
  return {
    from: dayBounds(first, dayStart).start,
    to: dayBounds(last, dayStart).end,
  };
}
