import { expect, test } from "bun:test";
import {
  OPEN_AT_TIMEOUT_MS,
  openReviewAt,
  pendingOpenAt,
  requestOpenAt,
  reviewTargetInHash,
  takeOpenAt,
} from "./reviewOpenAt";
import { workTargetInHash } from "./workOpen";

test("a target asked for waits for its view, then is taken or dropped", () => {
  requestOpenAt({ thread: "a100000000000001" }, 1_000);
  const asked = pendingOpenAt(1_000);
  expect(asked?.thread).toBe("a100000000000001");
  // Another target's taking leaves it.
  takeOpenAt((asked?.seq ?? 0) + 1);
  expect(pendingOpenAt(1_000)).toBe(asked);
  takeOpenAt(asked?.seq);
  expect(pendingOpenAt(1_000)).toBeNull();
  // No view drew it in time: dropped.
  requestOpenAt({ thread: "a100000000000002" }, 1_000);
  expect(pendingOpenAt(1_000 + OPEN_AT_TIMEOUT_MS + 1)).toBeNull();
});

test("a review opened at a comment: the target kept, its list read first when unknown", async () => {
  const calls: string[] = [];
  const deps = (known: boolean) => ({
    summary: () => (known ? {} : undefined),
    load: async (connection: string) => {
      calls.push(`load ${connection}`);
    },
    show: (connection: string, review: string) => {
      calls.push(`show ${connection} ${review}`);
    },
  });
  await openReviewAt(
    "desktop",
    "4aad5bedb15e09e5",
    { thread: "3bad5213aaaa0000", comment: "77c0ffee00000001" },
    deps(false),
  );
  expect(calls).toEqual(["load desktop", "show desktop 4aad5bedb15e09e5"]);
  expect(pendingOpenAt()).toMatchObject({
    review: "4aad5bedb15e09e5",
    thread: "3bad5213aaaa0000",
    comment: "77c0ffee00000001",
  });
  takeOpenAt();
  // Known, and no thread: shown at once, nothing to go to.
  calls.length = 0;
  await openReviewAt("desktop", "4aad5bedb15e09e5", undefined, deps(true));
  expect(calls).toEqual(["show desktop 4aad5bedb15e09e5"]);
  expect(pendingOpenAt()).toBeNull();
});

test("links name a review or a Work item, and the thread and comment in it", () => {
  expect(
    reviewTargetInHash(
      "#roamgate-review=4aad5bedb15e09e5&thread=3bad5213aaaa0000&comment=77c0ffee00000001",
    ),
  ).toEqual({
    review: "4aad5bedb15e09e5",
    thread: "3bad5213aaaa0000",
    comment: "77c0ffee00000001",
  });
  expect(reviewTargetInHash("#roamgate-review=4aad5bedb15e09e5")).toEqual({
    review: "4aad5bedb15e09e5",
  });
  // A comment without its thread, or ids that are none, are left out.
  expect(
    reviewTargetInHash(
      "#roamgate-review=4aad5bedb15e09e5&comment=77c0ffee00000001",
    ),
  ).toEqual({ review: "4aad5bedb15e09e5" });
  expect(reviewTargetInHash("#roamgate-review=<script>")).toBeNull();
  expect(reviewTargetInHash("#roamgate-work=3878370a636e490e")).toBeNull();
  expect(workTargetInHash("#roamgate-work=3878370a636e490e")).toEqual({
    item: "3878370a636e490e",
  });
  expect(
    workTargetInHash(
      "#roamgate-work=3878370a636e490e&thread=c1f2069a3a8d17a1&comment=5a43ff20639281cd",
    ),
  ).toEqual({
    item: "3878370a636e490e",
    thread: "c1f2069a3a8d17a1",
    comment: "5a43ff20639281cd",
  });
  expect(workTargetInHash("#roamgate-work=nope")).toBeNull();
});
