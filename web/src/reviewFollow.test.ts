import { expect, test } from "bun:test";
import { followCommit, nearestLine, normalizedSubject } from "./reviewFollow";

const list = (...subjects: string[]) =>
  subjects.map((subject, index) => ({ sha: `n${index}`, subject }));

test("the same sha stays", () => {
  expect(
    followCommit({ sha: "n1", subject: "x", index: 0 }, list("a", "b")),
  ).toEqual({ sha: "n1", index: 1, how: "same" });
});

test("a rebased or reworded commit is found by its patch id first", () => {
  const found = followCommit(
    { sha: "old", subject: "Add b", index: 1, count: 3 },
    list("Add a", "Add b", "Reword of c"),
    { old: "p3", n0: "p1", n1: "p2", n2: "p3" },
  );
  expect(found).toEqual({ sha: "n2", index: 2, how: "patch" });
});

test("an amended commit is found by its subject, then its normalized one", () => {
  expect(
    followCommit(
      { sha: "old", subject: "Add b", index: 0 },
      list("Add a", "Add b"),
      { old: "changed", n0: "p1", n1: "p2" },
    ),
  ).toEqual({ sha: "n1", index: 1, how: "subject" });
  expect(
    followCommit(
      { sha: "old", subject: "fixup! Add b.", index: 0 },
      list("Add a", "add  B"),
    ),
  ).toEqual({ sha: "n1", index: 1, how: "similar-subject" });
});

test("several commits with that subject: the nearest to where it was", () => {
  expect(
    followCommit(
      { sha: "old", subject: "WIP", index: 3 },
      list("WIP", "x", "WIP", "y", "z"),
    ),
  ).toEqual({ sha: "n2", index: 2, how: "subject" });
});

test("no match: the same place when the count is the same, else the nearest", () => {
  expect(
    followCommit(
      { sha: "old", subject: "gone", index: 1, count: 3 },
      list("a", "b", "c"),
    ),
  ).toEqual({ sha: "n1", index: 1, how: "position" });
  expect(
    followCommit(
      { sha: "old", subject: "gone", index: 4, count: 5 },
      list("a", "b"),
    ),
  ).toEqual({ sha: "n1", index: 1, how: "nearest" });
  // Its place unknown (a commit opened from a conversation): the first.
  expect(followCommit({ sha: "old" }, list("a", "b"))).toEqual({
    sha: "n0",
    index: 0,
    how: "nearest",
  });
  expect(followCommit({ sha: "old" }, [])).toBeNull();
});

test("subjects are compared without fixup prefixes, case or spacing", () => {
  expect(normalizedSubject("squash! fixup!  Make It Work.")).toBe(
    "make it work",
  );
});

test("the line comes back exact, else the nearest on its side", () => {
  const lines = [
    { old: 1, new: 1 },
    { old: 2, new: null },
    { old: null, new: 2 },
    { old: 9, new: 10 },
  ];
  expect(nearestLine(lines, { old: 2, new: null })).toBe(1);
  expect(nearestLine(lines, { old: null, new: 8 })).toBe(3);
  expect(nearestLine(lines, { old: 3, new: null })).toBe(1);
  expect(nearestLine(lines, {})).toBe(0);
  expect(nearestLine([], { new: 1 })).toBe(-1);
});
