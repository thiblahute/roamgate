import { expect, test } from "bun:test";
import type { ReviewThread } from "../../../shared/review";
import { sourceThreadsByLine } from "./sourceThreads";

const thread = (
  id: string,
  line: number | undefined,
  resolved = false,
  endLine?: number,
): ReviewThread => ({
  id,
  sessionId: "s1",
  kind: "discussion",
  anchor: {
    path: "a.rs",
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
  },
  comments: [],
  resolved,
  createdAt: `2026-11-10T10:00:${String(line ?? 0).padStart(2, "0")}Z`,
  updatedAt: "2026-11-10T10:00:00Z",
});

test("a thread is drawn under the last line it is on, within the file; one on no line is not drawn", () => {
  const byLine = sourceThreadsByLine(
    [
      thread("t3", 8, false, 9),
      thread("t1", 3),
      thread("t2", 5, true),
      thread("t4", 9),
      thread("gone", undefined),
      thread("past", 40, false, 50),
    ],
    false,
    12,
  );
  expect([...byLine.keys()]).toEqual([9, 3, 5, 12]);
  expect(byLine.get(9)?.map((each) => each.id)).toEqual(["t3", "t4"]);
  expect(byLine.get(12)?.map((each) => each.id)).toEqual(["past"]);
});

test("only the unresolved threads: the resolved ones are left out", () => {
  const byLine = sourceThreadsByLine(
    [thread("t1", 3), thread("t2", 5, true)],
    true,
    12,
  );
  expect([...byLine.keys()]).toEqual([3]);
});
