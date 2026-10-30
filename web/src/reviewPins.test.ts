import { expect, test } from "bun:test";
import type { ReviewSnapshot } from "../../shared/review";
import {
  addLatest,
  livePins,
  pinHolds,
  reviewPinKey,
  withLatest,
} from "./reviewPins";

function snap(id: string, workspaceId?: string): ReviewSnapshot {
  return {
    session: {
      id,
      connectionId: "desktop",
      workspaceId,
      root: "/r",
      title: id,
      target: { kind: "range", base: "main", head: "HEAD" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
    },
    threads: [],
  };
}

test("a pin holds only while its review is still of that workspace", () => {
  const here = reviewPinKey("desktop", "w1R");
  expect(pinHolds(here, snap("a", "w1R"))).toBe(true);
  // Opened again from another workspace, the review moved there.
  expect(pinHolds(here, snap("a", "w24"))).toBe(false);
  // One without a workspace stays where it was pinned.
  expect(pinHolds(here, snap("a"))).toBe(true);
  expect(pinHolds(reviewPinKey("laptop", "w1R"), snap("a", "w1R"))).toBe(false);
});

test("pins of reviews that moved are dropped, unknown ones kept", () => {
  const sessions = new Map([
    ["moved", snap("moved", "w24")],
    ["mine", snap("mine", "w2")],
  ]);
  const pins = {
    [reviewPinKey("desktop", "w1R")]: "moved",
    [reviewPinKey("desktop", "w2")]: "mine",
    [reviewPinKey("desktop", "w3")]: "not-loaded-yet",
  };
  expect(livePins(pins, sessions, new Set())).toEqual({
    [reviewPinKey("desktop", "w2")]: "mine",
    [reviewPinKey("desktop", "w3")]: "not-loaded-yet",
  });
  const live = { [reviewPinKey("desktop", "w2")]: "mine" };
  // Nothing to drop: the same object, so the state does not change.
  expect(livePins(live, sessions, new Set(["desktop"]))).toBe(live);
});

test("pins of reviews gone from a loaded connection are dropped", () => {
  const sessions = new Map([["mine", snap("mine", "w2")]]);
  const pins = {
    [reviewPinKey("desktop", "w2")]: "mine",
    [reviewPinKey("desktop", "w3")]: "removed",
    [reviewPinKey("laptop", "w1")]: "laptop-review",
  };
  // The desktop's list loaded without "removed"; the laptop's did not load.
  expect(livePins(pins, sessions, new Set(["desktop"]))).toEqual({
    [reviewPinKey("desktop", "w2")]: "mine",
    [reviewPinKey("laptop", "w1")]: "laptop-review",
  });
  expect(livePins(pins, sessions, new Set(["desktop", "laptop"]))).toEqual({
    [reviewPinKey("desktop", "w2")]: "mine",
  });
});

test("remembered workspaces keep the latest ones only", () => {
  let last: Record<string, string> = {};
  for (let i = 0; i < 60; i++) last = withLatest(last, `w${i}`, `s${i}`, 50);
  expect(Object.keys(last).length).toBe(50);
  expect(last.w9).toBeUndefined();
  expect(last.w10).toBe("s10");
  // Set again, a workspace becomes the latest.
  last = withLatest(last, "w10", "again", 50);
  last = withLatest(last, "new", "s", 50);
  expect(last.w10).toBe("again");
  expect(last.w11).toBeUndefined();

  let closed: ReadonlySet<string> = new Set();
  for (let i = 0; i < 60; i++) closed = addLatest(closed, `w${i}`, 50);
  expect(closed.size).toBe(50);
  expect(closed.has("w9")).toBe(false);
  expect(closed.has("w59")).toBe(true);
});
