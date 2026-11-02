import { expect, jest, test } from "bun:test";
import { watchLoopStalls } from "./loop-stall";

test("reports a tick that ran late past the threshold", () => {
  jest.useFakeTimers();
  let clock = 0;
  const reports: number[] = [];
  const watch = watchLoopStalls({
    report: ({ stalled_ms }) => reports.push(stalled_ms),
    now: () => clock,
  });
  try {
    clock = 1_000;
    jest.advanceTimersByTime(1_000);
    // The next tick ran 1.2 s late: the loop was busy.
    clock = 3_200;
    jest.advanceTimersByTime(1_000);
    clock = 4_300;
    jest.advanceTimersByTime(1_000);
    expect(reports).toEqual([1_200]);
  } finally {
    watch.stop();
    jest.useRealTimers();
  }
});
