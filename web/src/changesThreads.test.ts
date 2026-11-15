import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../../shared/review";
import type { DiffReviewAnnotation } from "./annotations";
import {
  cursorThreadPlace,
  placeDiffThreads,
  threadReadingOrder,
  threadsAtCursor,
} from "./changesThreads";
import type { DiffCursorRow } from "./diffCursor";

const thread = (
  id: string,
  line: number,
  text: string | undefined,
  side: "old" | "new" = "new",
  resolved = false,
): ReviewThread =>
  ({
    id,
    sessionId: "s",
    kind: "discussion",
    anchor: { path: "a.ts", line, side, text },
    comments: [],
    resolved,
    createdAt: `2026-11-10T10:00:0${id.length}Z`,
    updatedAt: "",
  }) as unknown as ReviewThread;

const note = (
  id: string,
  kind: "staged" | "unstaged",
  line: number,
  side: "old" | "new" = "new",
): DiffReviewAnnotation => ({
  id,
  source: "diff",
  path: "a.ts",
  kind,
  side,
  line,
  quote: "",
  hunk: "",
  comment: "",
  createdAt: 0,
});

const row = (
  key: string,
  kind: " " | "+" | "-",
  old: number | null,
  now: number | null,
  text: string,
): DiffCursorRow => ({
  key,
  path: "a.ts",
  file: 0,
  hunk: 0,
  kind,
  old,
  new: now,
  text,
});

const sections = [
  { key: "staged:a.ts", path: "a.ts" },
  { key: "unstaged:a.ts", path: "a.ts" },
];

describe("placing the threads written in Changes", () => {
  test("a thread stays on its own entry's line while that line reads as written", () => {
    const t = thread("t1", 2, "B");
    const { placed, unplaced } = placeDiffThreads(
      [note("t1", "staged", 2)],
      new Map([["t1", t]]),
      sections,
      [
        row("staged:a.ts", " ", 1, 1, "A"),
        row("staged:a.ts", "+", null, 2, "B"),
      ],
    );
    expect(unplaced).toEqual([]);
    expect(placed).toMatchObject([
      { key: "staged:a.ts", line: 2, side: "new", moved: false },
    ]);
  });

  test("one that no longer reads so is placed on the nearest line with its words, in any entry of the path", () => {
    const t = thread("t1", 2, "B");
    const { placed } = placeDiffThreads(
      [note("t1", "staged", 2)],
      new Map([["t1", t]]),
      sections,
      [
        row("staged:a.ts", "+", null, 2, "other"),
        row("unstaged:a.ts", " ", 4, 4, "x"),
        row("unstaged:a.ts", "+", null, 5, "B"),
        row("unstaged:a.ts", "+", null, 9, "B"),
      ],
    );
    expect(placed).toMatchObject([
      { key: "unstaged:a.ts", line: 5, side: "new", moved: true },
    ]);
  });

  test("a thread found nowhere in loaded lines is listed, not drawn; with no lines loaded it stays where it was written", () => {
    const t = thread("t1", 2, "gone");
    const rows = [row("staged:a.ts", "+", null, 2, "other")];
    const gone = placeDiffThreads(
      [note("t1", "staged", 2)],
      new Map([["t1", t]]),
      sections,
      rows,
    );
    expect(gone.placed).toEqual([]);
    expect(gone.unplaced).toEqual([t]);
    const unloaded = placeDiffThreads(
      [note("t1", "staged", 2)],
      new Map([["t1", t]]),
      sections,
      [],
    );
    expect(unloaded.placed).toMatchObject([{ key: "staged:a.ts", line: 2 }]);
  });

  test("a comment on the whole file (line 0) stays; a path not shown is left out", () => {
    const whole = thread("w", 0, undefined);
    const other = { ...note("o", "staged", 3), path: "b.ts" };
    const { placed } = placeDiffThreads(
      [note("w", "staged", 0), other],
      new Map([
        ["w", whole],
        ["o", thread("o", 3, "x")],
      ]),
      sections,
      [row("staged:a.ts", "+", null, 2, "other")],
    );
    expect(placed.map((each) => each.thread.id)).toEqual(["w"]);
  });
});

describe("going through the threads", () => {
  const a = thread("a", 3, "x");
  const b = thread("b", 5, "y");
  const c = thread("cc", 1, "z");
  const placed = [
    {
      thread: b,
      key: "unstaged:a.ts",
      path: "a.ts",
      side: "new" as const,
      line: 5,
      moved: false,
    },
    {
      thread: c,
      key: "unstaged:a.ts",
      path: "a.ts",
      side: "new" as const,
      line: 1,
      moved: false,
    },
    {
      thread: a,
      key: "staged:a.ts",
      path: "a.ts",
      side: "new" as const,
      line: 3,
      moved: false,
    },
  ];

  test("the order is file by file, then by line", () => {
    expect(
      threadReadingOrder(placed, sections).map((each) => each.thread.id),
    ).toEqual(["a", "cc", "b"]);
  });

  test("the cursor is on a thread, or before the first one after its line", () => {
    const order = threadReadingOrder(placed, sections);
    expect(
      threadsAtCursor(order, {
        key: "unstaged:a.ts",
        old: null,
        new: 5,
        side: "new",
      }).map((each) => each.thread.id),
    ).toEqual(["b"]);
    expect(
      cursorThreadPlace(
        order,
        sections,
        { key: "unstaged:a.ts", old: null, new: 5, side: "new" },
        1,
      ),
    ).toEqual({ index: 2, on: true });
    expect(
      cursorThreadPlace(
        order,
        sections,
        { key: "unstaged:a.ts", old: 2, new: 2, side: "new" },
        1,
      ),
    ).toEqual({ index: 2, on: false });
    expect(
      cursorThreadPlace(
        order,
        sections,
        { key: "unstaged:a.ts", old: 9, new: 9, side: "new" },
        1,
      ),
    ).toEqual({ index: 3, on: false });
  });
});
