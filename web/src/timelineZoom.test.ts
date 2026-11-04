import { describe, expect, test } from "bun:test";
import { place } from "./activityTimelineModel";
import { placeIn } from "./hoursModel";
import {
  brushRange,
  clampRange,
  fitRange,
  panBy,
  rangeTicks,
  tickStep,
  wheelFactor,
  zoomAt,
  zoomOut,
} from "./timelineZoom";

const DAY = { start: 0, end: 1440 };

describe("timeline zoom", () => {
  test("zooming keeps the point under the pointer in place", () => {
    const range = { start: 480, end: 1080 };
    const zoomed = zoomAt(range, DAY, 0.5, 0.25, 20);
    expect(zoomed).toEqual({ start: 555, end: 855 });
    // The pointer's minute (630) is still a quarter in.
    expect((630 - zoomed.start) / (zoomed.end - zoomed.start)).toBe(0.25);
    // Never narrower than the minimum, never out of the day.
    expect(zoomAt(range, DAY, 0.001, 0.5, 20)).toEqual({
      start: 770,
      end: 790,
    });
    expect(zoomAt(range, DAY, 10, 0.5, 20)).toEqual(DAY);
    expect(zoomOut({ start: 1300, end: 1400 }, DAY, 20)).toEqual({
      start: 1240,
      end: 1440,
    });
  });

  test("the wheel zooms in up, out down", () => {
    expect(wheelFactor(-100)).toBeLessThan(1);
    expect(wheelFactor(100)).toBeGreaterThan(1);
    expect(wheelFactor(0)).toBe(1);
  });

  test("panning keeps the width and stops at the day's edges", () => {
    const range = { start: 600, end: 720 };
    expect(panBy(range, DAY, 60)).toEqual({ start: 660, end: 780 });
    expect(panBy(range, DAY, -1000)).toEqual({ start: 0, end: 120 });
    expect(panBy(range, DAY, 1000)).toEqual({ start: 1320, end: 1440 });
  });

  test("a brush zooms to what it covers, at least the minimum", () => {
    const range = { start: 480, end: 1080 };
    expect(brushRange(range, DAY, 0.5, 0.25, 20)).toEqual({
      start: 630,
      end: 780,
    });
    expect(brushRange(range, DAY, 0.5, 0.51, 20)).toEqual({
      start: 773,
      end: 793,
    });
    expect(brushRange(range, DAY, -1, 2, 20)).toEqual(range);
  });

  test("work hours fit the first and last activity, the whole day else", () => {
    expect(fitRange([545, 600, 1012], DAY, 10, 20)).toEqual({
      start: 535,
      end: 1022,
    });
    expect(fitRange([], DAY, 10, 20)).toEqual(DAY);
    expect(clampRange({ start: -50, end: 30 }, DAY, 20)).toEqual({
      start: 0,
      end: 80,
    });
  });

  test("ticks get finer as the zoom narrows", () => {
    expect(tickStep(600, 10)).toBe(60);
    expect(tickStep(120, 10)).toBe(15);
    expect(tickStep(40, 10)).toBe(5);
    expect(tickStep(1440, 8)).toBe(180);
    expect(rangeTicks({ start: 547, end: 610 }, 15, 1)).toEqual([
      555, 570, 585, 600,
    ]);
    // Milliseconds, from the day's midnight.
    const midnight = Date.UTC(2026, 10, 4);
    const minute = 60_000;
    expect(
      rangeTicks(
        { start: midnight + 61 * minute, end: midnight + 80 * minute },
        5,
        minute,
        midnight,
      ).map((tick) => (tick - midnight) / minute),
    ).toEqual([65, 70, 75, 80]);
  });

  test("spans the zoom cuts are clipped to it", () => {
    const window = { start: 600, end: 720, ticks: [] };
    const span = { start: "1970-01-01T00:00:00.500Z", end: null };
    expect(place(span, window, 660)).toEqual({ left: 0, width: 50 });
    expect(
      place(
        { start: "1970-01-01T00:00:00.000Z", end: "1970-01-01T00:00:00.100Z" },
        window,
        660,
      ),
    ).toBeNull();
    // Hours: 09:00 to 13:00 in a 10:00 to 12:00 zoom fills it.
    expect(
      placeIn(
        { start: "2026-11-04T09:00:00", end: "2026-11-04T13:00:00" },
        { start: 600, end: 720 },
      ),
    ).toEqual({ left: 0, width: 100 });
  });
});
