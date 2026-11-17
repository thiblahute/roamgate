import { expect, test } from "bun:test";
import { nextMounted } from "./chatMountWindow";

test("items near the view are drawn, and stay while few are", () => {
  const none = new Set<string>();
  const mounted = nextMounted(none, new Set(["a", "b"]), 3);
  expect([...mounted]).toEqual(["a", "b"]);
  expect(nextMounted(mounted, new Set(["b"]), 3)).toBe(mounted);
});

test("past the limit, the first drawn of those away from the view go", () => {
  const mounted = new Set(["a", "b", "c"]);
  const next = nextMounted(mounted, new Set(["c", "d", "e"]), 3);
  expect([...next].sort()).toEqual(["c", "d", "e"]);
  // Those near the view stay even past it.
  expect([...nextMounted(new Set(["a"]), new Set(["b", "c"]), 1)]).toEqual([
    "b",
    "c",
  ]);
});
