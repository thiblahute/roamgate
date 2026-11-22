import { expect, test } from "bun:test";
import {
  TUCK_DISTANCE,
  TUCK_FLING,
  UNTUCK_DISTANCE,
  tuckDragOffset,
  tuckReleased,
} from "./voiceCallTuck";

test("the card follows the finger down, the bar follows it up, each held back the other way", () => {
  expect(tuckDragOffset(false, 40)).toBe(40);
  expect(tuckDragOffset(false, -40)).toBe(-8);
  expect(tuckDragOffset(true, -30)).toBe(-30);
  expect(tuckDragOffset(true, 30)).toBe(6);
});

test("a release tucks the card past a distance or on a flick, and snaps back otherwise", () => {
  expect(tuckReleased(false, TUCK_DISTANCE, 0)).toBe(true);
  expect(tuckReleased(false, TUCK_DISTANCE - 1, 0)).toBe(false);
  expect(tuckReleased(false, 20, TUCK_FLING)).toBe(true);
  // A flick down that hardly moved, or a flick up, is not a swipe down.
  expect(tuckReleased(false, 4, TUCK_FLING * 2)).toBe(false);
  expect(tuckReleased(false, 30, -TUCK_FLING)).toBe(false);
});

test("a release brings the bar back up past a distance or on a flick up", () => {
  expect(tuckReleased(true, -UNTUCK_DISTANCE, 0)).toBe(false);
  expect(tuckReleased(true, -UNTUCK_DISTANCE + 1, 0)).toBe(true);
  expect(tuckReleased(true, -10, -TUCK_FLING)).toBe(false);
  expect(tuckReleased(true, 40, 1)).toBe(true);
});
