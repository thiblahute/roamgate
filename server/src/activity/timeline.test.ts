import { expect, test } from "bun:test";
import type { ActivityWorkspace } from "./protocol";
import {
  type AgentRow,
  addDays,
  buildTimeline,
  dayBounds,
  dayOf,
  type FocusRow,
  isDate,
  type PresenceRow,
  type TimelineInput,
  timelineRange,
} from "./timeline";

const MIN = 60_000;
/** 2026-11-02 at hh:mm, local time. */
const at = (hh: number, mm = 0) => new Date(2026, 10, 2, hh, mm).getTime();
const ms = (iso: string | null) => (iso === null ? null : Date.parse(iso));

function workspace(id: string): ActivityWorkspace {
  return {
    id,
    connection_id: "local",
    name: id.toUpperCase(),
    path: `/src/${id}`,
    subject: null,
    repo: null,
    herdr_workspace_id: `h-${id}`,
  };
}

let seq = 0;
function focus(
  start: number,
  end: number | null,
  workspaceId: string,
  extra: Partial<FocusRow> = {},
): FocusRow {
  return {
    seq: ++seq,
    start,
    end,
    reason: end === null ? null : "switch",
    connection_id: "local",
    workspace_id: workspaceId,
    tab_id: null,
    pane_id: "p1",
    source: "browser",
    client_id: "c1",
    client_kind: "desktop",
    session: 1,
    ...extra,
  };
}

function agent(
  ts: number,
  state: AgentRow["state"],
  extra: Partial<AgentRow> = {},
): AgentRow {
  return {
    seq: ++seq,
    ts,
    connection_id: "local",
    workspace_id: "a",
    pane_id: "p1",
    name: "claude",
    state,
    task: null,
    session: 1,
    ...extra,
  };
}

function presence(
  ts: number,
  kind: PresenceRow["kind"],
  extra: Partial<PresenceRow> = {},
): PresenceRow {
  return {
    seq: ++seq,
    ts,
    kind,
    connection_id: "local",
    client_id: "c1",
    client_kind: "desktop",
    visible: kind === "ui.visibility" ? true : null,
    session: 1,
    ...extra,
  };
}

function input(overrides: Partial<TimelineInput> = {}): TimelineInput {
  const day = dayBounds("2026-11-02", "00:00");
  return {
    from: day.start,
    to: day.end,
    now: at(18),
    dayStart: "00:00",
    focus: [],
    presence: [],
    agents: [],
    gaps: [],
    sessions: [
      { id: 1, started_at: at(8), last_alive: at(18) - MIN, stopped_at: null },
    ],
    workspaces: [workspace("a"), workspace("b"), workspace("c")],
    ...overrides,
  };
}

test("days follow the day start, in local time", () => {
  expect(dayOf(at(3), "04:00")).toBe("2026-11-01");
  expect(dayOf(at(4), "04:00")).toBe("2026-11-02");
  expect(dayBounds("2026-11-02", "04:00")).toEqual({
    start: at(4),
    end: new Date(2026, 10, 3, 4).getTime(),
  });
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(isDate("2026-02-29")).toBe(false);
  expect(isDate("2028-02-29")).toBe(true);
  expect(isDate("today")).toBe(false);
});

test("focus spans carry their source and reason; open ones end now", () => {
  const timeline = buildTimeline(
    input({
      focus: [
        focus(at(9), at(10), "a"),
        focus(at(11), null, "b", { client_kind: "phone", client_id: "ph" }),
      ],
    }),
  );
  const [day] = timeline.days;
  expect(timeline.recorder_running).toBe(true);
  expect(day!.focus).toHaveLength(2);
  expect(day!.focus[0]).toMatchObject({
    source: "browser",
    reason: "switch",
    open: false,
    workspace_id: "a",
  });
  expect(ms(day!.focus[1]!.end)).toBe(at(18));
  expect(day!.focus[1]).toMatchObject({
    source: "phone",
    open: true,
    reason: null,
  });
  expect(timeline.workspaces.map((entry) => entry.id)).toEqual(["a", "b"]);
});

test("spans are clipped to the range and split across days", () => {
  const from = dayBounds("2026-11-01", "00:00").start;
  const timeline = buildTimeline(
    input({
      from,
      focus: [focus(new Date(2026, 10, 1, 23).getTime(), at(1), "a")],
    }),
  );
  expect(timeline.days.map((day) => day.date)).toEqual([
    "2026-11-01",
    "2026-11-02",
  ]);
  expect(timeline.days[0]!.totals.attended_ms).toBe(60 * MIN);
  expect(timeline.days[1]!.totals.attended_ms).toBe(60 * MIN);
  expect(ms(timeline.days[1]!.focus[0]!.start)).toBe(at(0));
});

test("browser and phone attention wins; Herdr only fills the holes", () => {
  const timeline = buildTimeline(
    input({
      focus: [
        focus(at(9), at(12), "c", { source: "herdr", client_id: null }),
        focus(at(10), at(11), "a", { reason: "hidden" }),
        // A phone looking elsewhere meanwhile: the latest start wins.
        focus(at(10, 30), at(10, 45), "b", {
          client_kind: "phone",
          client_id: "ph",
        }),
      ],
    }),
  );
  const [day] = timeline.days;
  // Herdr's TUI counts only within idle_seconds (5 minutes) of a sign of a
  // person: here the browser hidden at 11:00, to type in the terminal.
  expect(
    day!.attention.map((segment) => [
      segment.workspace_id,
      segment.source,
      (ms(segment.end)! - ms(segment.start)!) / MIN,
    ]),
  ).toEqual([
    ["a", "browser", 30],
    ["b", "phone", 15],
    ["a", "browser", 15],
    ["c", "herdr", 5],
  ]);
  const totals = Object.fromEntries(
    day!.totals.workspaces.map((entry) => [entry.workspace_id, entry]),
  );
  expect(totals.c).toMatchObject({
    herdr_ms: 5 * MIN,
    attended_ms: 5 * MIN,
  });
  expect(totals.a).toMatchObject({
    browser_ms: 45 * MIN,
    attended_ms: 45 * MIN,
  });
  expect(totals.b).toMatchObject({ phone_ms: 15 * MIN });
  expect(day!.totals.attended_ms).toBe(65 * MIN);
  // The focus spans themselves stay as recorded.
  expect(day!.focus.find((entry) => entry.source === "herdr")).toMatchObject({
    workspace_id: "c",
  });
});

test("an overnight Herdr span with no sign of a person is not attended", () => {
  const from = dayBounds("2026-11-01", "00:00").start;
  const evening = new Date(2026, 10, 1, 22, 44).getTime();
  const timeline = buildTimeline(
    input({
      from,
      now: at(9),
      sessions: [
        {
          id: 1,
          started_at: evening,
          last_alive: at(9) - MIN,
          stopped_at: null,
        },
      ],
      focus: [
        // The browser went idle at 22:35, before the recorder restarted.
        focus(new Date(2026, 10, 1, 22).getTime(), evening - 9 * MIN, "a", {
          reason: "idle",
        }),
        // Opened by the restart, not by a person; it ran on all night.
        focus(evening, at(8, 4), "c", { source: "herdr", client_id: null }),
        // A switch in the TUI at 08:04 is a sign of a person.
        focus(at(8, 4), null, "b", { source: "herdr", client_id: null }),
      ],
    }),
  );
  const [yesterday, today] = timeline.days;
  expect(yesterday!.totals.attended_ms).toBe(35 * MIN);
  expect(yesterday!.attention.map((segment) => segment.source)).toEqual([
    "browser",
  ]);
  expect(
    today!.attention.map((segment) => [
      segment.workspace_id,
      segment.source,
      (ms(segment.end)! - ms(segment.start)!) / MIN,
    ]),
  ).toEqual([["b", "herdr", 5]]);
  expect(today!.totals.attended_ms).toBe(5 * MIN);
  expect(
    today!.totals.workspaces.find((entry) => entry.workspace_id === "c"),
  ).toBeUndefined();
});

test("Herdr time counts after input, a page brought to the front or a switch", () => {
  const timeline = buildTimeline(
    input({
      idleMs: 10 * MIN,
      focus: [
        focus(at(8), at(17), "c", { source: "herdr", client_id: null }),
        // A switch in Herdr's TUI at 9:00.
        focus(at(7), at(8), "b", {
          source: "herdr",
          client_id: null,
          connection_id: "desktop",
        }),
        focus(at(9), at(9, 30), "b", {
          source: "herdr",
          client_id: null,
          connection_id: "desktop",
        }),
      ],
      presence: [
        presence(at(12), "session.active"),
        presence(at(14), "ui.visibility", { visible: true }),
        presence(at(15), "ui.visibility", { visible: false }),
      ],
    }),
  );
  const [day] = timeline.days;
  expect(
    day!.attention.map((segment) => [
      new Date(ms(segment.start)!).getHours(),
      segment.workspace_id,
      (ms(segment.end)! - ms(segment.start)!) / MIN,
    ]),
  ).toEqual([
    // After the desktop TUI's switches at 8:00 and 9:30 (its span from
    // 9:00 opened with no switch: no sign), input at 12:00 and the page
    // brought to the front at 14:00.
    [8, "c", 10],
    [9, "c", 10],
    [12, "c", 10],
    [14, "c", 10],
  ]);
  expect(day!.totals.attended_ms).toBe(40 * MIN);
});

test("idle runs from session.idle to the client's next sign of life", () => {
  const timeline = buildTimeline(
    input({
      focus: [focus(at(9), at(9, 55), "a", { reason: "idle" })],
      presence: [
        presence(at(9, 55), "session.idle"),
        presence(at(10, 30), "session.active"),
        presence(at(12), "session.idle", { client_id: "c2" }),
        presence(at(12, 10), "ui.visibility", {
          client_id: "c2",
          visible: false,
        }),
        presence(at(17), "session.idle", { client_id: "c3" }),
      ],
    }),
  );
  const idle = timeline.days[0]!.idle.map((span) => [
    span.client_id,
    (ms(span.end)! - ms(span.start)!) / MIN,
    span.open,
  ]);
  expect(idle).toEqual([
    ["c1", 35, false],
    ["c2", 10, false],
    ["c3", 60, true],
  ]);
  expect(timeline.days[0]!.totals.idle_ms).toBe(105 * MIN);
});

test("agent lanes are built from consecutive states, cut by gaps", () => {
  const timeline = buildTimeline(
    input({
      agents: [
        agent(at(9), "working"),
        agent(at(10), "blocked"),
        agent(at(10, 30), "working"),
        agent(at(12), "idle"),
        agent(at(13), "unknown"),
        agent(at(9), "working", { pane_id: "p2", name: "codex" }),
      ],
      gaps: [
        { connection_id: "local", start: at(11), end: at(11, 30), reason: "x" },
      ],
    }),
  );
  const [day] = timeline.days;
  const claude = day!.agents.find((lane) => lane.agent === "claude")!;
  expect(
    claude.spans.map((span) => [
      span.state,
      (ms(span.end)! - ms(span.start)!) / MIN,
    ]),
  ).toEqual([
    ["working", 60],
    ["blocked", 30],
    ["working", 30],
    ["working", 30],
    ["idle", 60],
  ]);
  const codex = day!.agents.find((lane) => lane.agent === "codex")!;
  // Still working now, but not while the connection was gone.
  expect(codex.spans.at(-1)).toMatchObject({ state: "working", open: true });
  const totals = day!.totals.workspaces.find(
    (entry) => entry.workspace_id === "a",
  )!;
  // Working time is wall clock: two agents at once count once.
  expect(totals.working_ms).toBe((9 * 60 - 30) * MIN);
  expect(totals.blocked_ms).toBe(30 * MIN);
});

test("a stopped recorder ends open spans at its last stamp and leaves a gap", () => {
  const timeline = buildTimeline(
    input({
      sessions: [
        { id: 1, started_at: at(8), last_alive: at(12), stopped_at: null },
      ],
      focus: [focus(at(11), null, "a")],
      agents: [agent(at(11), "working")],
    }),
  );
  const [day] = timeline.days;
  expect(timeline.recorder_running).toBe(false);
  expect(day!.focus[0]).toMatchObject({ open: false });
  expect(ms(day!.focus[0]!.end)).toBe(at(12));
  expect(ms(day!.agents[0]!.spans[0]!.end)).toBe(at(12));
  expect(day!.gaps).toEqual([
    {
      connection_id: null,
      start: expect.any(String),
      end: null,
      reason: "recorder",
      excluded: false,
    },
  ]);
  expect(day!.totals.unrecorded_ms).toBe(6 * 60 * MIN);
});

test("an open gap spanning days ends at midnight on the earlier day", () => {
  const from = dayBounds("2026-11-01", "00:00").start;
  const timeline = buildTimeline(
    input({
      from,
      gaps: [
        {
          connection_id: "local",
          start: new Date(2026, 10, 1, 22).getTime(),
          end: null,
          reason: "disconnected",
        },
      ],
    }),
  );
  expect(ms(timeline.days[0]!.gaps[0]!.end)).toBe(at(0));
  expect(timeline.days[1]!.gaps[0]!.end).toBeNull();
});

test("an invalid range is refused", () => {
  expect(() => buildTimeline(input({ from: Number.NaN }))).toThrow();
  expect(() => buildTimeline(input({ to: at(0) - 1 }))).toThrow();
});

test("a request's range is whole local days, today by default", () => {
  const day = (date: string, start: string) => {
    const bounds = dayBounds(date, start);
    return { from: bounds.start, to: bounds.end };
  };
  expect(timelineRange({}, at(9), "00:00")).toEqual(day("2026-11-02", "00:00"));
  expect(timelineRange({}, at(3), "04:00")).toEqual(day("2026-11-01", "04:00"));
  expect(timelineRange({ from: "2026-11-01" }, at(9), "00:00")).toEqual(
    day("2026-11-01", "00:00"),
  );
  expect(
    timelineRange({ from: "2026-10-30", to: "2026-11-01" }, at(9), "00:00"),
  ).toEqual({
    from: dayBounds("2026-10-30", "00:00").start,
    to: dayBounds("2026-11-01", "00:00").end,
  });
  expect(() => timelineRange({ from: "x" }, at(9), "00:00")).toThrow();
  expect(() =>
    timelineRange({ from: "2026-11-02", to: "2026-11-01" }, at(9), "00:00"),
  ).toThrow();
  expect(() =>
    timelineRange({ from: "2025-01-01", to: "2026-11-01" }, at(9), "00:00"),
  ).toThrow();
});

test("totals per subject add up its workspaces; agents overlap once", () => {
  const subject = {
    id: "dir:~/devel/gstreamer/ocio",
    label: "ocio",
    source: "directory" as const,
    path: "/src/ocio",
    groups: [
      { id: "dir:~/devel/gstreamer", label: "gstreamer" },
      { id: "dir:~/devel/gstreamer/ocio", label: "ocio" },
    ],
  };
  const timeline = buildTimeline(
    input({
      workspaces: [
        { ...workspace("a"), subject },
        { ...workspace("b"), subject },
        workspace("c"),
      ],
      focus: [
        focus(at(9), at(10), "a"),
        focus(at(10), at(11), "b"),
        focus(at(11), at(11, 30), "c"),
      ],
      agents: [
        agent(at(9), "working", { workspace_id: "a", pane_id: "pa" }),
        agent(at(10), "idle", { workspace_id: "a", pane_id: "pa" }),
        agent(at(9, 30), "working", { workspace_id: "b", pane_id: "pb" }),
        agent(at(10, 30), "idle", { workspace_id: "b", pane_id: "pb" }),
      ],
    }),
  );
  const [day] = timeline.days;
  expect(day!.totals.subjects).toEqual([
    {
      subject_id: subject.id,
      label: "ocio",
      attended_ms: 120 * MIN,
      browser_ms: 120 * MIN,
      phone_ms: 0,
      herdr_ms: 0,
      working_ms: 90 * MIN,
      blocked_ms: 0,
      workspace_ids: ["a", "b"],
    },
    {
      subject_id: null,
      label: null,
      attended_ms: 30 * MIN,
      browser_ms: 30 * MIN,
      phone_ms: 0,
      herdr_ms: 0,
      working_ms: 0,
      blocked_ms: 0,
      workspace_ids: ["c"],
    },
  ]);
  expect(timeline.workspaces.find((w) => w.id === "a")?.subject).toEqual(
    subject,
  );
});

test("only a person's causes are signs: loads, reconnects, follows and listings are not", () => {
  const herdr = { source: "herdr" as const, client_id: null };
  const timeline = buildTimeline(
    input({
      idleMs: 10 * MIN,
      focus: [
        // Herdr's focus all day, as the recorder found it when it started.
        focus(at(8), null, "c", { ...herdr, cause: "recorder_start" }),
        // A page reloaded after a deploy: no person, though it ran 6 min.
        focus(at(9), at(9, 6), "a", { cause: "reconnect", reason: "idle" }),
        // Herdr's focus found moved by a listing (a browser's pane focus),
        // ended by another listing: no sign either way.
        focus(at(10), at(10, 30), "b", {
          ...herdr,
          connection_id: "desktop",
          cause: "herdr_listing",
          end_cause: "herdr_listing",
        }),
        // A switch in Herdr's TUI at 11:00: a sign.
        focus(at(11), at(11, 30), "b", {
          ...herdr,
          connection_id: "desktop",
          cause: "herdr_event",
          end_cause: "herdr_listing",
        }),
        // The user's own browser span at 13:00, ended by the view following
        // Herdr: the span counts, and its end leaves the usual tail.
        focus(at(13), at(13, 5), "a", {
          cause: "user_input",
          end_cause: "follow_herdr",
        }),
      ],
      presence: [
        presence(at(9), "ui.visibility", { cause: "page_load" }),
        presence(at(12), "ui.visibility", { cause: "reconnect" }),
        presence(at(14), "ui.visibility", { cause: "user_focus" }),
        presence(at(15), "session.active", { cause: "user_input" }),
      ],
    }),
  );
  const [day] = timeline.days;
  expect(
    day!.attention.map((segment) => [
      `${new Date(ms(segment.start)!).getHours()}:${new Date(ms(segment.start)!).getMinutes()}`,
      segment.workspace_id,
      (ms(segment.end)! - ms(segment.start)!) / MIN,
    ]),
  ).toEqual([
    ["11:0", "b", 10],
    ["13:0", "a", 5],
    ["13:5", "c", 10],
    ["14:0", "c", 10],
    ["15:0", "c", 10],
  ]);
  expect(day!.focus.find((span) => span.workspace_id === "a")!.cause).toBe(
    "reconnect",
  );
});
