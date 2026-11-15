import { expect, test } from "bun:test";
import {
  canStep,
  currentPlace,
  dropFramePage,
  dropRepeat,
  framePageFor,
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

test("a frame's page is kept with the directory it is a path from, shown again only there", () => {
  const history = settleFrame(
    startHistory("/casa/paneles/a.html"),
    "a.html",
    "/casa/paneles/",
  );
  const place = currentPlace(history);
  expect(place.frameRoot).toBe("/casa/paneles/");
  expect(framePageFor(place, "/casa/paneles/a.html", "/casa/paneles/")).toBe(
    "a.html",
  );
  // Not known yet: checked once the frame says where it is.
  expect(framePageFor(place, "/casa/paneles/a.html")).toBe("a.html");
  // Another tab's place, or a page from another directory: never.
  expect(framePageFor(place, "/casa/out/b.html", "/casa/paneles/")).toBe(
    undefined,
  );
  expect(
    framePageFor(place, "/casa/paneles/a.html", "/casa/out/"),
  ).toBeUndefined();
  // Kept before its directory was: its tab's own.
  expect(
    framePageFor(
      { path: "/casa/paneles/a.html", framePage: "x.html", scroll: 0 },
      "/casa/paneles/a.html",
      "/casa/out/",
    ),
  ).toBe("x.html");
});

test("a page kept that is gone: the place is its tab's own page, once", () => {
  let history = settleFrame(startHistory("/s/a.html"), "a.html", "/s/");
  history = keepScroll(history, 300);
  history = pushPlace(history, {
    path: "/s/a.html",
    framePage: "gone.html",
    frameRoot: "/s/",
  });
  const dropped = dropFramePage(history);
  expect(currentPlace(dropped)).toEqual({ path: "/s/a.html", scroll: 0 });
  expect(dropFramePage(dropped)).toBe(dropped);
  // Its own page shown there: the place before it, scrolled as left.
  const once = dropRepeat(settleFrame(dropped, "a.html", "/s/"));
  expect(once.places).toEqual([
    { path: "/s/a.html", framePage: "a.html", frameRoot: "/s/", scroll: 300 },
  ]);
  expect(once.at).toBe(0);
  expect(dropRepeat(once)).toBe(once);
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
