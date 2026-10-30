import { expect, test } from "bun:test";
import type { ReviewSnapshot } from "../../shared/review";
import { livePins, pinHolds, reviewPinKey } from "./reviewPins";

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
  expect(livePins(pins, sessions)).toEqual({
    [reviewPinKey("desktop", "w2")]: "mine",
    [reviewPinKey("desktop", "w3")]: "not-loaded-yet",
  });
  const live = { [reviewPinKey("desktop", "w2")]: "mine" };
  // Nothing to drop: the same object, so the state does not change.
  expect(livePins(live, sessions)).toBe(live);
});
