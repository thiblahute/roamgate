import { expect, test } from "bun:test";
import {
  canStep,
  currentPlace,
  historyKeyStep,
  keepScroll,
  pushPlace,
  settleFrame,
  startHistory,
  stepHistory,
} from "./previewHistory";

test("a tab's history goes back and forward, with the scroll each place was left at", () => {
  let history = startHistory("a.md");
  expect(canStep(history, -1)).toBe(false);
  expect(canStep(history, 1)).toBe(false);
  history = keepScroll(history, 120);
  history = pushPlace(history, { path: "b.md", fragment: "intro" });
  history = keepScroll(history, 40);
  expect(currentPlace(history)).toEqual({
    path: "b.md",
    fragment: "intro",
    scroll: 40,
  });
  const back = stepHistory(history, -1)!;
  expect(back.place).toEqual({ path: "a.md", scroll: 120 });
  expect(canStep(back.history, 1)).toBe(true);
  const forward = stepHistory(back.history, 1)!;
  expect(forward.place.path).toBe("b.md");
  expect(stepHistory(forward.history, 1)).toBeNull();
  // Going somewhere new from a.md drops b.md, ahead of it.
  const elsewhere = pushPlace(back.history, { path: "c.md" });
  expect(elsewhere.places.map((place) => place.path)).toEqual(["a.md", "c.md"]);
  // Where one already is: nothing new.
  expect(pushPlace(elsewhere, { path: "c.md" })).toBe(elsewhere);
});

test("a frame's pages are places of their tab; its first page settles the tab's", () => {
  let history = settleFrame(startHistory("/site/index.html"), "index.html");
  expect(currentPlace(history).framePage).toBe("index.html");
  history = pushPlace(history, {
    path: "/site/index.html",
    framePage: "docs/a.html",
  });
  expect(history.places.length).toBe(2);
  expect(stepHistory(history, -1)?.place.framePage).toBe("index.html");
});

test("Back and Forward's keys: Alt+arrows, Cmd+[ and Cmd+]", () => {
  const key = (key: string, init = {}) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  });
  expect(historyKeyStep(key("ArrowLeft", { altKey: true }))).toBe(-1);
  expect(historyKeyStep(key("ArrowRight", { altKey: true }))).toBe(1);
  expect(historyKeyStep(key("[", { metaKey: true }))).toBe(-1);
  expect(historyKeyStep(key("]", { metaKey: true }))).toBe(1);
  expect(historyKeyStep(key("ArrowLeft"))).toBe(0);
  expect(historyKeyStep(key("[", { ctrlKey: true }))).toBe(0);
  expect(
    historyKeyStep(key("ArrowLeft", { altKey: true, shiftKey: true })),
  ).toBe(0);
});
