import { expect, test } from "bun:test";
import {
  isLocalReview,
  localReviewChips,
  localReviewKey,
  localReviewOfKey,
  localReviewsOf,
  movedReviews,
  type LocalReviewSession,
} from "./localReviews";
import { activityGroups } from "./reviewActivity";

const session = (
  id: string,
  extra: Partial<LocalReviewSession> = {},
): { session: LocalReviewSession } => ({
  session: {
    id,
    connectionId: "desk",
    workspaceId: "w1",
    root: "/repo",
    target: { kind: "range", base: "main", head: "HEAD" },
    title: id,
    summary: "",
    updatedAt: "2026-11-20T10:00:00.000Z",
    agent: {},
    gitlab: false,
    ...extra,
  } as LocalReviewSession,
});

test("the local reviews are a workspace's reviews of its checkouts, or every workspace's", () => {
  const reviews = [
    session("a"),
    session("b", { workspaceId: "w2" }),
    session("c", { connectionId: "mac" }),
    session("chat", { target: { kind: "chat", chat: "w1:p1" } as never }),
    session("site", {
      target: { kind: "rendered", url: "https://x" } as never,
    }),
    session("mr", {
      target: { kind: "mr", url: "https://gitlab/x/-/merge_requests/1" },
    }),
  ];
  expect(isLocalReview(reviews[3]!.session)).toBe(false);
  expect(
    localReviewsOf(reviews, { connectionId: "desk", workspaceId: "w1" }).map(
      (each) => each.session.id,
    ),
  ).toEqual(["a", "mr"]);
  expect(localReviewsOf(reviews, null).map((each) => each.session.id)).toEqual([
    "a",
    "b",
    "c",
    "mr",
  ]);
});

test("a row's chips: comments, news, its agent, GitLab, then its branch as read", () => {
  const item = (extra: Partial<LocalReviewSession> = {}, counts = {}) => ({
    comments: 0,
    waiting: 0,
    newCommits: false,
    ...counts,
    snapshot: session("a", extra),
  });
  const texts = (chips: { text: string; tone?: string }[]) =>
    chips.map((chip) =>
      chip.tone ? `${chip.text} (${chip.tone})` : chip.text,
    );
  expect(texts(localReviewChips(item(), undefined))).toEqual(["empty"]);
  expect(
    texts(localReviewChips(item({ summary: "Looks good" }), undefined)),
  ).toEqual(["overall comment only"]);
  expect(
    texts(
      localReviewChips(
        item(
          {
            agent: { name: "Claude", working: { since: "x" } } as never,
            gitlab: true,
          },
          { comments: 2, waiting: 1, newCommits: true },
        ),
        { state: "read", activity: { sessionId: "a", newCommits: true } },
      ),
    ),
  ).toEqual([
    "2 comments",
    "new commits since (news)",
    "1 waiting for you (news)",
    "Claude working (good)",
    "GitLab (label)",
  ]);
  const branch = (state: Parameters<typeof localReviewChips>[1]) =>
    texts(localReviewChips(item(), state)).slice(1);
  expect(branch({ state: "reading" })).toEqual([]);
  expect(
    branch({
      state: "read",
      activity: { sessionId: "a", newCommits: false, gone: "base-gone" },
    }),
  ).toEqual(["base gone (bad)"]);
  expect(
    branch({
      state: "read",
      activity: { sessionId: "a", newCommits: false, unreadable: true },
    }),
  ).toEqual(["branch not read in time (wait)"]);
  expect(branch({ state: "offline", connection: "Mac" })).toEqual([
    "on Mac, offline (wait)",
  ]);
  expect(branch({ state: "failed" })).toEqual(["branch not read (wait)"]);
});

test("the moved reviews, the row keys, and one activity read per checkout", () => {
  expect([
    ...movedReviews(
      new Map([
        [
          "a",
          { state: "read", activity: { sessionId: "a", newCommits: true } },
        ],
        [
          "b",
          { state: "read", activity: { sessionId: "b", newCommits: false } },
        ],
        ["c", { state: "reading" }],
      ] as const),
    ),
  ]).toEqual(["a"]);
  expect(localReviewOfKey(localReviewKey("abc"))).toBe("abc");
  expect(localReviewOfKey("gitlab:host/p#1")).toBeNull();
  expect(localReviewOfKey(null)).toBeNull();
  expect(
    activityGroups([
      { id: "a", connectionId: "desk", root: "/r1" },
      { id: "b", connectionId: "desk", root: "/r2" },
      { id: "c", connectionId: "desk", root: "/r1" },
      { id: "d", connectionId: "mac", root: "/r1" },
    ]),
  ).toEqual([
    { connectionId: "desk", root: "/r1", ids: ["a", "c"] },
    { connectionId: "desk", root: "/r2", ids: ["b"] },
    { connectionId: "mac", root: "/r1", ids: ["d"] },
  ]);
});
