import { expect, test } from "bun:test";
import {
  compareKeys,
  stepNotice,
  stepUnresolved,
  unresolvedPosition,
} from "./unresolvedThreads";

// a and d resolved: b, c and e are the unresolved ones.
const order = [
  { id: "a", resolved: true },
  { id: "b", resolved: false },
  { id: "c", resolved: false },
  { id: "d", resolved: true },
  { id: "e", resolved: false },
];

test("steps go through the unresolved threads only", () => {
  expect(stepUnresolved(order, { index: 1, on: true }, 1)).toEqual({
    index: 2,
    id: "c",
    position: 2,
    total: 3,
    wrapped: false,
  });
  // Over the resolved d.
  expect(stepUnresolved(order, { index: 2, on: true }, 1)?.id).toBe("e");
  expect(stepUnresolved(order, { index: 4, on: true }, -1)?.id).toBe("c");
});

test("a step from a resolved thread goes on from its place", () => {
  expect(stepUnresolved(order, { index: 3, on: true }, 1)?.id).toBe("e");
  expect(stepUnresolved(order, { index: 3, on: true }, -1)?.id).toBe("c");
  expect(stepUnresolved(order, { index: 0, on: true }, 1)?.id).toBe("b");
});

test("between threads, the one at the place is the next", () => {
  // Before c: c is next, b is previous.
  expect(stepUnresolved(order, { index: 2, on: false }, 1)?.id).toBe("c");
  expect(stepUnresolved(order, { index: 2, on: false }, -1)?.id).toBe("b");
  // Past the end and before the start.
  expect(stepUnresolved(order, { index: 5, on: false }, -1)?.id).toBe("e");
  expect(stepUnresolved(order, { index: 0, on: false }, 1)?.id).toBe("b");
});

test("steps wrap around at the ends, and say so", () => {
  const last = stepUnresolved(order, { index: 4, on: true }, 1)!;
  expect(last).toMatchObject({ id: "b", position: 1, wrapped: true });
  expect(stepNotice(last, 1)).toBe("1 of 3 unresolved, back at the first");
  const first = stepUnresolved(order, { index: 1, on: true }, -1)!;
  expect(first).toMatchObject({ id: "e", position: 3, wrapped: true });
  expect(stepNotice(first, -1)).toBe("3 of 3 unresolved, back at the last");
  expect(stepNotice(stepUnresolved(order, { index: 0, on: true }, 1)!, 1)).toBe(
    "1 of 3 unresolved",
  );
});

test("the only unresolved thread is itself again; none is null", () => {
  const one = [
    { id: "a", resolved: true },
    { id: "b", resolved: false },
  ];
  const step = stepUnresolved(one, { index: 1, on: true }, 1)!;
  expect(step).toMatchObject({ id: "b", wrapped: true, total: 1 });
  expect(stepNotice(step, 1)).toBe("1 of 1 unresolved: the only one");
  expect(
    stepUnresolved([{ id: "a", resolved: true }], { index: 0, on: true }, 1),
  ).toBeNull();
  expect(stepUnresolved([], { index: 0, on: false }, -1)).toBeNull();
});

test("a thread's place among the unresolved ones", () => {
  expect(unresolvedPosition(order, "c")).toBe(2);
  expect(unresolvedPosition(order, "e")).toBe(3);
  expect(unresolvedPosition(order, "d")).toBeNull();
  expect(unresolvedPosition(order, null)).toBeNull();
});

test("keys sort part by part, numbers and strings", () => {
  const keys = [
    [-1, -1, 0, "2026-01-01"],
    [-1, 0, 12, "2026-01-01"],
    [-1, 0, 40, "2026-01-01"],
    [0, "a.ts", 3, "2026-01-01"],
    [0, "b.ts", 1, "2026-01-01"],
  ];
  const shuffled = [keys[3]!, keys[0]!, keys[4]!, keys[2]!, keys[1]!];
  expect(shuffled.sort(compareKeys)).toEqual(keys);
});
