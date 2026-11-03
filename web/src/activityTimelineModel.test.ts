import { expect, test } from "bun:test";
import {
  addDays,
  colorFor,
  storedGroupBy,
  storeGroupBy,
  subjectGroups,
  axisWindow,
  formatDuration,
  jumpTarget,
  place,
  type TimelineDay,
  type TimelineWorkspace,
  workspaceColor,
  workspaceRows,
} from "./activityTimelineModel";

const at = (hh: number, mm = 0) => new Date(2026, 10, 2, hh, mm).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

function day(overrides: Partial<TimelineDay> = {}): TimelineDay {
  return {
    date: "2026-11-02",
    start: iso(at(0)),
    end: iso(new Date(2026, 10, 3).getTime()),
    focus: [],
    attention: [],
    idle: [],
    agents: [],
    gaps: [],
    totals: { attended_ms: 0, idle_ms: 0, unrecorded_ms: 0, workspaces: [] },
    ...overrides,
  };
}

const workspace = (id: string, extra: Partial<TimelineWorkspace> = {}) => ({
  id,
  connection_id: "local",
  name: id,
  path: `/src/${id}`,
  herdr_workspace_id: `h-${id}`,
  ...extra,
});

test("dates and durations", () => {
  expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  expect(formatDuration(0)).toBe("0m");
  expect(formatDuration(20_000)).toBe("<1m");
  expect(formatDuration(95 * 60_000)).toBe("1h 35m");
});

test("the axis covers whole hours around the activity, at least four", () => {
  const span = { start: iso(at(9, 20)), end: iso(at(10, 10)), open: false };
  const window = axisWindow(
    day({
      focus: [
        {
          ...span,
          connection_id: "l",
          workspace_id: "a",
          pane_id: null,
          source: "browser",
          client_id: null,
          reason: null,
        },
      ],
    }),
    at(23, 59) + 2 * 86_400_000,
  );
  expect(window.start).toBe(at(7));
  expect(window.end).toBe(at(11));
  expect(window.ticks[0]).toBe(at(7));
  // Today: up to now.
  const today = axisWindow(day(), at(18, 30));
  expect([today.start, today.end]).toEqual([at(15), at(19)]);
  // Early in the day, it cannot start before the day does.
  expect(axisWindow(day(), at(1)).start).toBe(at(0));
  expect(
    place({ start: iso(at(10)), end: iso(at(11)) }, window, at(12)),
  ).toEqual({ left: 75, width: 25 });
  expect(place({ start: iso(at(20)), end: null }, window, at(21))).toBeNull();
});

test("rows: workspaces with attention or busy agents, most attended first", () => {
  const rows = workspaceRows(
    day({
      attention: [
        {
          start: iso(at(9)),
          end: iso(at(10)),
          workspace_id: "b",
          source: "browser",
        },
      ],
      agents: [
        {
          connection_id: "local",
          workspace_id: "a",
          pane_id: "p",
          agent: "claude",
          task: null,
          spans: [
            {
              start: iso(at(9)),
              end: iso(at(12)),
              open: false,
              state: "working",
            },
          ],
        },
        {
          connection_id: "local",
          workspace_id: "c",
          pane_id: "p",
          agent: "claude",
          task: null,
          spans: [
            { start: iso(at(9)), end: iso(at(12)), open: false, state: "idle" },
          ],
        },
      ],
      totals: {
        attended_ms: 3_600_000,
        idle_ms: 0,
        unrecorded_ms: 0,
        workspaces: [
          {
            workspace_id: "b",
            attended_ms: 3_600_000,
            browser_ms: 3_600_000,
            phone_ms: 0,
            herdr_ms: 0,
            working_ms: 0,
            blocked_ms: 0,
          },
          {
            workspace_id: "a",
            attended_ms: 0,
            browser_ms: 0,
            phone_ms: 0,
            herdr_ms: 0,
            working_ms: 10_800_000,
            blocked_ms: 0,
          },
        ],
      },
    }),
    [workspace("a"), workspace("b"), workspace("c")],
  );
  expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
  expect(rows[1]!.lanes).toHaveLength(1);
});

test("a jump goes to the workspace at the same path on the shown connection", () => {
  const target = workspace("a");
  expect(
    jumpTarget(target, "local", [
      { workspace_id: "w9", worktree: { checkout_path: "/src/a" } },
    ]),
  ).toBe("w9");
  expect(
    jumpTarget(target, "local", [{ workspace_id: "w3", cwd: "/src/a" }]),
  ).toBe("w3");
  expect(jumpTarget(target, "other", [])).toBe("h-a");
  expect(
    jumpTarget({ ...target, herdr_workspace_id: null }, "x", []),
  ).toBeNull();
});

test("colors are stable per workspace", () => {
  expect(workspaceColor("a")).toBe(workspaceColor("a"));
  expect(workspaceColor("a")).not.toBe(workspaceColor("b"));
});

const subject = (id: string, label: string) => ({
  id,
  label,
  source: "directory" as const,
  path: `/src/${label}`,
  groups: [{ id, label }],
});

test("workspaces gather under their subjects, the ones with none last", () => {
  const ocio = subject("dir:~/src/ocio", "ocio");
  const workspaces = [
    workspace("a", { subject: ocio }),
    workspace("b", { subject: ocio }),
    workspace("c", { subject: null }),
    workspace("d"),
  ];
  const segment = (id: string, from: number, to: number) => ({
    start: iso(at(from)),
    end: iso(at(to)),
    workspace_id: id,
    source: "browser" as const,
  });
  const totals = (id: string, attended: number) => ({
    workspace_id: id,
    attended_ms: attended,
    browser_ms: attended,
    phone_ms: 0,
    herdr_ms: 0,
    working_ms: 0,
    blocked_ms: 0,
  });
  const shown = day({
    attention: [
      segment("c", 8, 12),
      segment("b", 12, 13),
      segment("a", 13, 14),
      segment("d", 14, 15),
    ],
    totals: {
      attended_ms: 0,
      idle_ms: 0,
      unrecorded_ms: 0,
      workspaces: [
        totals("c", 4 * 3_600_000),
        totals("a", 3_600_000),
        totals("b", 3_600_000),
        totals("d", 3_600_000),
      ],
      subjects: [
        {
          subject_id: ocio.id,
          label: "ocio",
          attended_ms: 2 * 3_600_000,
          browser_ms: 2 * 3_600_000,
          phone_ms: 0,
          herdr_ms: 0,
          working_ms: 30 * 60_000,
          blocked_ms: 0,
          workspace_ids: ["a", "b"],
        },
      ],
    },
  });
  const groups = subjectGroups(shown, workspaces);
  expect(
    groups.map((group) => [group.label, group.rows.map((r) => r.id)]),
  ).toEqual([
    ["ocio", ["a", "b"]],
    ["No subject", ["c", "d"]],
  ]);
  expect(groups[0]!.totals.working_ms).toBe(30 * 60_000);
  // An older bridge sends no subject totals: attention still adds up.
  expect(groups[1]!.totals.attended_ms).toBe(5 * 3_600_000);
  expect(groups[0]!.attention.map((s) => s.workspace_id)).toEqual(["b", "a"]);
});

test("colours follow the subject only when grouping by subject", () => {
  const ws = workspace("a", { subject: subject("tree:g1", "upstream") });
  expect(colorFor("a", ws, "workspace")).toBe(workspaceColor("a"));
  expect(colorFor("a", ws, "subject")).toBe(workspaceColor("tree:g1"));
  expect(colorFor("b", workspace("b"), "subject")).toBe(workspaceColor("b"));
});

test("the grouping choice is remembered", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  expect(storedGroupBy(storage)).toBe("workspace");
  storeGroupBy(storage, "subject");
  expect(storedGroupBy(storage)).toBe("subject");
  expect(storedGroupBy(null)).toBe("workspace");
});
