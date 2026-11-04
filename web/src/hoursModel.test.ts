import { expect, test } from "bun:test";
import {
  acceptanceLost,
  evidenceText,
  canPreview,
  groupEvidence,
  clockMinutes,
  failureText,
  previewWorkedMinutes,
  REOPENED_LABELS,
  reopenedTitle,
  splitPoints,
  workedMinutes,
  submitHint,
  clockOf,
  type Day,
  formatMinutes,
  hoursWindow,
  isoAt,
  placeIn,
  recentRange,
} from "./hoursModel";

const block = (
  start: string,
  end: string,
  status: Day["blocks"][0]["status"],
) => ({
  id: `${start}-${status}`,
  start: `2026-11-03T${start}:00-03:00`,
  end: `2026-11-03T${end}:00-03:00`,
  minutes: 30,
  status,
  source: "ai" as const,
});

test("times keep the wall clock and offset they are written with", () => {
  expect(clockOf("2026-11-03T08:05:00-03:00")).toBe("08:05");
  expect(isoAt("2026-11-03T08:05:00-03:00", "09:30")).toBe(
    "2026-11-03T09:30:00-03:00",
  );
  expect(isoAt("2026-11-03T08:05:00Z", "23:59")).toBe("2026-11-03T23:59:00Z");
  expect(isoAt("2026-11-03T08:05:00-03:00", "25:00")).toBeNull();
  expect(formatMinutes(45)).toBe("45m");
  expect(formatMinutes(410)).toBe("6h 50m");
  expect(formatMinutes(420)).toBe("7h");
});

test("a day with an open question cannot be previewed", () => {
  const day: Day = {
    date: "2026-11-03",
    status: "needs_input",
    blocks: [
      block("08:00", "09:00", "accepted"),
      block("09:00", "09:30", "needs_input"),
    ],
    gaps: [],
  };
  expect(canPreview(day)).toBe(false);
  expect(submitHint(day)).toContain("1 question open");
  day.blocks[1]!.status = "skipped";
  expect(canPreview(day)).toBe(true);
  // Only accepted blocks are ever submitted.
  day.blocks.push(block("10:00", "11:00", "proposed"));
  expect(submitHint(day)).toBe(
    "1 accepted block will be previewed; accept the others first to include them.",
  );
  day.blocks[0]!.status = "submitted";
  expect(canPreview(day)).toBe(false);
  expect(submitHint(day)).toBe(
    "Only accepted blocks are submitted: accept them first.",
  );
});

test("the strip spans whole hours around the day", () => {
  const day: Day = {
    date: "2026-11-03",
    status: "proposed",
    blocks: [
      block("08:05", "09:00", "proposed"),
      block("13:00", "14:50", "proposed"),
    ],
    gaps: [],
  };
  const window = hoursWindow(day);
  expect(window).toEqual({ start: 8 * 60, end: 15 * 60 });
  expect(placeIn(day.blocks[0]!, window)?.left).toBeCloseTo((5 / 420) * 100);
  expect(hoursWindow({ ...day, blocks: [] })).toEqual({
    start: 540,
    end: 1080,
  });
});

test("the day list covers the last two weeks", () => {
  expect(recentRange("2026-11-03")).toEqual({
    from: "2026-10-21",
    to: "2026-11-03",
  });
});

test("reported time is whole units; worked time shows only when it differs", () => {
  expect(workedMinutes({ minutes: 45, worked_minutes: 37 })).toBe(37);
  expect(workedMinutes({ minutes: 30, worked_minutes: 30 })).toBeNull();
  expect(workedMinutes({ minutes: 45 })).toBeNull();
  expect(
    failureText({ message: "the block would last 10 min", code: "too_short" }),
  ).toBe("A block must last at least 15 minutes: the block would last 10 min");
  expect(failureText({ message: "overlaps", code: "conflict" })).toBe(
    "overlaps",
  );
  expect(clockMinutes("08:05", "08:50")).toBe(45);
  expect(clockMinutes("09:00", "08:00")).toBe(0);
});

test("a block splits only into whole units", () => {
  expect(splitPoints(block("08:00", "09:00", "proposed"))).toEqual([
    "08:15",
    "08:30",
    "08:45",
  ]);
  expect(splitPoints(block("08:00", "08:30", "proposed"))).toEqual(["08:15"]);
  expect(splitPoints(block("08:00", "08:15", "proposed"))).toEqual([]);
});

test("a reopened block says why and when it was accepted", () => {
  expect(REOPENED_LABELS.neighbour_moved).toBe(
    "Moved by a neighbour: accept again",
  );
  expect(REOPENED_LABELS.recomputed).toBe("Recomputed: accept again");
  expect(REOPENED_LABELS.target_changed).toBe("Project changed: accept again");
  expect(
    reopenedTitle({ reason: "target_changed", previously_accepted_at: "noon" }),
  ).toBe(
    "This block's project changed (a mapping, say). Accepted before on noon; accept it again to submit it.",
  );
  const title = reopenedTitle({
    reason: "neighbour_moved",
    previously_accepted_at: "2026-11-03T15:20:00-03:00",
  });
  expect(title).toStartWith(
    "A neighbour's rounding moved this block. Accepted before on ",
  );
  expect(title).toEndWith("; accept it again to submit it.");
  expect(
    reopenedTitle({ reason: "recomputed", previously_accepted_at: "soon" }),
  ).toBe(
    "The provider computed this block again. Accepted before on soon; accept it again to submit it.",
  );
});

test("a preview's worked total comes from its blocks", () => {
  const day: Day = {
    date: "2026-11-03",
    status: "accepted",
    blocks: [
      {
        ...block("08:00", "08:45", "accepted"),
        id: "a",
        minutes: 45,
        worked_minutes: 37,
      },
      { ...block("09:00", "09:30", "accepted"), id: "b", minutes: 30 },
    ],
    gaps: [],
  };
  expect(
    previewWorkedMinutes([{ block_id: "a" }, { block_id: "b" }], day),
  ).toBe(67);
  expect(previewWorkedMinutes([{ block_id: "x" }], day)).toBeNull();
  expect(previewWorkedMinutes([], null)).toBeNull();
});

test("evidence groups per workspace, notes folded into their workspace", () => {
  const { groups, other, details } = groupEvidence([
    { kind: "workspace", title: "clauth", minutes: 3 },
    { kind: "note", title: "includes 5 min of clauth" },
    { kind: "note", title: "includes 4 min of hdd-warranty" },
    { kind: "note", title: "includes 0 min of upstream" },
    { kind: "note", title: "one share of 100 min split between 2 projects" },
    { kind: "agent_session", title: "agent working in roamgate", minutes: 2 },
  ]);
  expect(groups).toEqual([
    { name: "clauth", minutes: 8 },
    { name: "hdd-warranty", minutes: 4 },
  ]);
  expect(other.map((entry) => entry.kind)).toEqual(["note", "agent_session"]);
  expect(details).toHaveLength(6);
});

test("an acceptance is lost when the block is still there and not accepted", () => {
  const day: Day = {
    date: "2026-11-04",
    status: "proposed",
    blocks: [
      block("10:00", "12:30", "proposed"),
      block("14:35", "15:35", "submitted"),
    ],
    gaps: [],
  };
  expect(acceptanceLost(day.blocks[0]!.id, day)).toContain(
    "did not keep the acceptance",
  );
  expect(acceptanceLost(day.blocks[1]!.id, day)).toBeNull();
  expect(acceptanceLost("gone", day)).toBeNull();
  day.blocks[0]!.status = "accepted";
  expect(acceptanceLost(day.blocks[0]!.id, day)).toBeNull();
});

test("an agent's time elsewhere reads short", () => {
  expect(
    evidenceText({
      kind: "agent_session",
      title: "agent working in roamgate while attention was elsewhere",
      minutes: 12,
    }),
  ).toBe("agent in roamgate 12m");
  expect(evidenceText({ kind: "commit", title: "fix" })).toBe("fix");
});
