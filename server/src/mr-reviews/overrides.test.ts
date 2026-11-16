import { expect, test } from "bun:test";
import {
  applyOverride,
  normalizeOverride,
  overrideOutdated,
  renameOverrideKeys,
} from "./overrides";
import { mrReviewsSettings, normalizeStoredMrReviews } from "./settings";
import { storedMrReviews } from "./settings";

const meta = { by: "user" as const, at: "2026-11-16T10:00:00Z", marker: "m1" };

test("fields are set, capped and cleared; an empty override goes", () => {
  const first = applyOverride(
    undefined,
    {
      set: {
        whose: "reviewer",
        next: `  ${"x".repeat(300)}  `,
        labels: ["infra", "INFRA", "", "a".repeat(60)],
        link: "https://notes.example/plan",
      },
    },
    meta,
  )!;
  expect(first.whose).toBe("reviewer");
  expect(first.next).toHaveLength(200);
  expect(first.labels).toEqual(["infra", "a".repeat(40)]);
  expect(first.marker).toBe("m1");
  // A label change keeps the marker whose-move was set against.
  const second = applyOverride(
    first,
    { set: { labels: ["x"] } },
    { ...meta, marker: "m2" },
  )!;
  expect(second.marker).toBe("m1");
  expect(second.labels).toEqual(["x"]);
  // Setting the next step anchors it again.
  expect(
    applyOverride(second, { set: { next: "ping" } }, { ...meta, marker: "m3" })!
      .marker,
  ).toBe("m3");
  expect(
    applyOverride(second, { clear: ["whose", "next"] }, meta)!.whose,
  ).toBeUndefined();
  expect(applyOverride(second, { clear: "all" }, meta)).toBeNull();
  expect(
    applyOverride(second, { clear: ["whose", "next", "labels", "link"] }, meta),
  ).toBeNull();
});

test("whose-move and next step age with the request, labels never", () => {
  const set = applyOverride(
    undefined,
    { set: { next: "wait", labels: ["l"] } },
    meta,
  )!;
  expect(overrideOutdated(set, "m1")).toBe(false);
  expect(overrideOutdated(set, "m2")).toBe(true);
  const labelsOnly = applyOverride(
    undefined,
    { set: { labels: ["l"] } },
    meta,
  )!;
  expect(overrideOutdated(labelsOnly, "m2")).toBe(false);
});

test("settings.json keeps overrides checked, capped, and round trips", () => {
  const stored = normalizeStoredMrReviews({
    overrides: {
      "gitlab:h/p#1": {
        whose: { person: "@bob" },
        next: "ask bob",
        depends_on: ["gitlab:h/p#2", "gitlab:h/p#2", 3],
        at: "2026-11-16T10:00:00Z",
        by: "agent",
        marker: "m",
      },
      "gitlab:h/p#2": { whose: "nobody", at: "x", marker: "m" },
      "": { next: "no key" },
    },
    stale_days: 30,
  })!;
  expect(Object.keys(stored.overrides!)).toEqual(["gitlab:h/p#1"]);
  const settings = mrReviewsSettings(stored);
  expect(settings.overrides["gitlab:h/p#1"]).toEqual({
    whose: { person: "bob" },
    next: "ask bob",
    dependsOn: ["gitlab:h/p#2"],
    at: "2026-11-16T10:00:00Z",
    by: "agent",
    marker: "m",
  });
  expect(settings.staleDays).toBe(30);
  expect(
    mrReviewsSettings(normalizeStoredMrReviews(storedMrReviews(settings))),
  ).toEqual(settings);
  expect(normalizeOverride({ at: "x", marker: "m" })).toBeNull();
});

test("the oldest overrides are forgotten past the cap", () => {
  const overrides: Record<string, unknown> = {};
  for (let n = 0; n < 510; n++)
    overrides[`k${n}`] = {
      next: "n",
      at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
      marker: "m",
    };
  const stored = normalizeStoredMrReviews({ overrides })!;
  expect(Object.keys(stored.overrides!)).toHaveLength(500);
  expect(stored.overrides!.k0).toBeUndefined();
  expect(stored.overrides!.k509).toBeDefined();
});

test("renaming a key follows into other rows' dependencies", () => {
  const out = renameOverrideKeys(
    {
      old: { next: "x", at: "t", by: "user", marker: "m" },
      other: { dependsOn: ["old", "new"], at: "t", by: "user", marker: "m" },
    },
    "old",
    "new",
  );
  expect(Object.keys(out).sort()).toEqual(["new", "other"]);
  expect(out.other!.dependsOn).toEqual(["new"]);
});
