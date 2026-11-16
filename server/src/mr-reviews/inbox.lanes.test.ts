import { expect, test } from "bun:test";
import type { MrInboxEntry, MrOwnStatus } from "../../../shared/mrReviews";
import { assignLanes } from "./lanes";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const own = (extra: Partial<MrOwnStatus> = {}): MrOwnStatus => ({
  approvedBy: [],
  approved: false,
  changesRequested: [],
  unresolved: 0,
  conflicts: false,
  needsRebase: false,
  ...extra,
});
const entry = (
  n: number,
  extra: Partial<MrInboxEntry> = {},
  status: Partial<MrOwnStatus> = {},
): MrInboxEntry => ({
  provider: "gitlab",
  host: "h",
  project: "g/p",
  number: n,
  key: `gitlab:h/g/p#${n}`,
  url: `https://h/g/p/-/merge_requests/${n}`,
  title: `MR ${n}`,
  author: "me",
  draft: false,
  state: "open",
  updatedAt: "2026-11-15T00:00:00Z",
  headSha: "a",
  sourceBranch: "b",
  targetBranch: "main",
  pipeline: "success",
  notes: 0,
  reasons: ["authored"],
  section: "authored",
  unread: null,
  isNew: false,
  own: own(status),
  ...extra,
});
const lanes = (entries: MrInboxEntry[]) => {
  assignLanes(entries, { staleDays: 90, now: NOW });
  return entries.map((each) => [each.number, each.lane, each.next?.text]);
};

test("rules from the forge's status give lanes and next steps", () => {
  expect(
    lanes([
      entry(1, { pipeline: "failed" }),
      entry(2, {}, { conflicts: true }),
      entry(3, {}, { changesRequested: ["bob"] }),
      entry(4, {}, { unresolved: 2 }),
      entry(5, { draft: true }),
      entry(6, {}, { approvedBy: ["bob"] }),
      entry(7),
      entry(8, { updatedAt: "2026-01-01T00:00:00Z", pipeline: "failed" }),
      entry(9, { state: "merged" }),
    ]),
  ).toEqual([
    [1, "your_move", "Fix the failed pipeline"],
    [2, "your_move", "Rebase on main: it conflicts"],
    [3, "your_move", "Address the changes bob asked for"],
    [4, "your_move", "Answer 2 unresolved threads"],
    [5, "your_move", "Mark it ready for review"],
    [6, "waiting", "Approved: waiting to be merged"],
    [7, "waiting", "Waiting for review"],
    [8, "stale", "No activity for 319 days: ping, rebase or close it"],
    [9, "done", "Merged"],
  ]);
});

test("others' requests get no lane", () => {
  const theirs = entry(1, { reasons: ["review_requested"], section: "mine" });
  assignLanes([theirs], { staleDays: 90, now: NOW });
  expect(theirs.lane).toBeUndefined();
});

test("an override's whose-move wins, unless outdated; its next step shows", () => {
  const meta = { at: "t", by: "agent" as const, marker: "m" };
  const set = entry(1, {
    pipeline: "failed",
    override: { whose: "reviewer", next: "bob reruns CI", ...meta },
  });
  const outdated = entry(2, {
    pipeline: "failed",
    override: { whose: "reviewer", ...meta },
    overrideOutdated: true,
  });
  const stale = entry(3, { override: { stale: true, ...meta } });
  lanes([set, outdated, stale]);
  expect(set.lane).toBe("waiting");
  expect(set.laneWhy).toBe("waiting on reviewer");
  expect(set.next).toEqual({
    text: "bob reruns CI",
    from: "override",
    by: "agent",
  });
  expect(outdated.lane).toBe("your_move");
  expect(stale.lane).toBe("stale");
});

test("a request waiting for another is drawn under it and Blocked", () => {
  const meta = { at: "t", by: "user" as const, marker: "m" };
  const parent = entry(1);
  const child = entry(2, {
    override: { dependsOn: [parent.key], ...meta },
  });
  const grandchild = entry(3, {
    override: { dependsOn: [child.key], ...meta },
  });
  const external = entry(4, {
    override: { dependsOn: ["gitlab:h/other#9"], ...meta },
  });
  const merged = entry(5, { state: "merged" });
  const afterMerged = entry(6, {
    override: { dependsOn: [merged.key], ...meta },
  });
  lanes([parent, child, grandchild, external, merged, afterMerged]);
  expect(child.lane).toBe("blocked");
  expect(child.parent).toBe(parent.key);
  expect(grandchild.parent).toBe(child.key);
  expect(child.next?.text).toBe("Waits for !1");
  // Not listed: flat, in its own lane by the rules.
  expect(external.parent).toBeUndefined();
  expect(external.dependsOn).toEqual(["gitlab:h/other#9"]);
  // Its dependency merged: no longer blocked.
  expect(afterMerged.lane).toBe("waiting");
  expect(afterMerged.parent).toBeUndefined();
});

test("cycles are drawn flat", () => {
  const meta = { at: "t", by: "user" as const, marker: "m" };
  const a = entry(1, { override: { dependsOn: ["gitlab:h/g/p#2"], ...meta } });
  const b = entry(2, { override: { dependsOn: ["gitlab:h/g/p#1"], ...meta } });
  lanes([a, b]);
  expect(a.parent).toBeUndefined();
  expect(b.parent).toBeUndefined();
  expect(a.lane).toBe("blocked");
});
