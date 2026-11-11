import { expect, test } from "bun:test";
import type { ReviewThread } from "../../shared/review";

/**
 * Where n / N and j / k stop in a review's comments (reviewStops, taken
 * out of the review pane): the order they are drawn in, folded threads,
 * message parts and the comments on them. messageLayout needs a DOM.
 */
if (process.env.ROAMGATE_REVIEW_STOPS_TEST !== "1") {
  test("comment stops in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_STOPS_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 30_000);
} else {
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { commentStops, GENERAL_AT, stopsOn } = await import("./reviewStops");

  const at = "2026-11-11T10:00:00Z";
  const thread = (
    id: string,
    bodies: string[],
    more: Partial<ReviewThread> = {},
  ): ReviewThread => ({
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: { path: "a.ts", line: 1 },
    comments: bodies.map((body, index) => ({
      id: `${id}c${index}`,
      author: index ? "claude" : "you",
      body,
      createdAt: at,
      updatedAt: at,
    })),
    resolved: false,
    createdAt: at,
    updatedAt: at,
    ...more,
  });
  const ids = (
    stops: { comment: { id: string }; part?: number; at: number }[],
  ) =>
    stops.map(
      (stop) =>
        `${stop.at}:${stop.comment.id}${stop.part === undefined ? "" : `#${stop.part}`}`,
    );
  const none = () => [];
  const open = () => false;

  test("above the diff the open forge discussions come first, then yours; under a row the forge's first", () => {
    const mine = thread("t1", ["mine"]);
    const forge = thread("m1", ["forge"], { kind: "merge-request" });
    const forgeDone = thread("m2", ["done"], {
      kind: "merge-request",
      resolved: true,
    });
    const onRow = thread("t2", ["on row", "answer"]);
    const forgeOnRow = thread("m3", ["forge on row"], {
      kind: "merge-request",
    });
    const stops = commentStops(
      {
        general: [mine, forgeDone, forge],
        byRow: new Map([[4, [onRow, forgeOnRow]]]),
      },
      [4],
      open,
      none,
    );
    expect(ids(stops)).toEqual([
      "-1:m1c0",
      "-1:t1c0",
      "4:m3c0",
      "4:t2c0",
      "4:t2c1",
    ]);
  });

  test("a folded thread is one stop, its first message", () => {
    const folded = thread("t1", ["first", "second", "third"]);
    const stops = commentStops(
      { general: [], byRow: new Map([[2, [folded]]]) },
      [2],
      (each) => each.id === "t1",
      none,
    );
    expect(ids(stops)).toEqual(["2:t1c0"]);
  });

  test("rows are taken in the order given, rows without threads have none", () => {
    const a = thread("a", ["a"]);
    const b = thread("b", ["b"]);
    const stops = commentStops(
      {
        general: [],
        byRow: new Map([
          [9, [a]],
          [3, [b]],
        ]),
      },
      [3, 7, 9],
      open,
      none,
    );
    expect(ids(stops)).toEqual(["3:bc0", "9:ac0"]);
  });

  test("a message of several parts is a stop, then one per part, each followed by the comments on it", () => {
    const body = "First paragraph here.\n\nSecond paragraph there.";
    const message = thread("t1", [body]);
    const note = thread("n1", ["about the second"], {
      anchor: {
        path: "a.ts",
        line: 1,
        message: {
          thread: "t1",
          comment: "t1c0",
          quote: "Second paragraph there.",
        },
      },
    });
    const stops = commentStops(
      { general: [], byRow: new Map([[0, [message]]]) },
      [0],
      open,
      (commentId) => (commentId === "t1c0" ? [note] : []),
    );
    expect(ids(stops)).toEqual(["0:t1c0", "0:t1c0#0", "0:t1c0#1", "0:n1c0"]);
  });

  test("a forge discussion's messages are stops as they are, never parts", () => {
    const forge = thread("m1", ["First paragraph.\n\nSecond paragraph."], {
      kind: "merge-request",
    });
    const stops = commentStops(
      { general: [], byRow: new Map([[1, [forge]]]) },
      [1],
      open,
      none,
    );
    expect(ids(stops)).toEqual(["1:m1c0"]);
  });

  test("the stops on a line are those of its rows; above the diff, GENERAL_AT's; none while hidden", () => {
    const stops = commentStops(
      {
        general: [thread("g", ["general"])],
        byRow: new Map([
          [1, [thread("l", ["left"])]],
          [2, [thread("r", ["right"])]],
          [5, [thread("x", ["other"])]],
        ]),
      },
      [1, 2, 5],
      open,
      none,
    );
    expect(ids(stopsOn(stops, 1, [1, 2], false))).toEqual(["1:lc0", "2:rc0"]);
    expect(ids(stopsOn(stops, 5, [5], false))).toEqual(["5:xc0"]);
    expect(ids(stopsOn(stops, GENERAL_AT, [], false))).toEqual(["-1:gc0"]);
    expect(stopsOn(stops, 1, [1, 2], true)).toEqual([]);
  });
}
