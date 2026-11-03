import { expect, test } from "bun:test";
import {
  canPreview,
  clockMinutes,
  failureText,
  workedLabel,
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

test("a rounded block says what was worked; too_short names the rule", () => {
  expect(workedLabel({ minutes: 15, worked_minutes: 9 })).toBe(
    "15m (worked 9m)",
  );
  expect(workedLabel({ minutes: 30, worked_minutes: 30 })).toBe("30m");
  expect(workedLabel({ minutes: 45 })).toBe("45m");
  expect(
    failureText({ message: "the block would last 10 min", code: "too_short" }),
  ).toBe("A block must last at least 15 minutes: the block would last 10 min");
  expect(failureText({ message: "overlaps", code: "conflict" })).toBe(
    "overlaps",
  );
  expect(clockMinutes("08:05", "08:50")).toBe(45);
  expect(clockMinutes("09:00", "08:00")).toBe(0);
});
