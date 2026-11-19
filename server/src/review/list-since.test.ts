import { expect, test } from "bun:test";
import { listReviewsSince } from "./list-since";

test("a review list sends again only the reviews the page does not hold", () => {
  const snapshot = (id: string, title: string) =>
    ({
      session: { id, title },
      threads: [],
    }) as unknown as Parameters<typeof listReviewsSince>[0][number];
  const first = listReviewsSince(
    [snapshot("a", "one"), snapshot("b", "two")],
    undefined,
  );
  expect(first.sessions.map((each) => each.session.id)).toEqual(["a", "b"]);
  expect(first.unchanged).toBeUndefined();

  // "b" changed since: only it comes again; "a" is named.
  const next = listReviewsSince(
    [snapshot("a", "one"), snapshot("b", "two, renamed")],
    first.stamps,
  );
  expect(next.sessions.map((each) => each.session.id)).toEqual(["b"]);
  expect(next.unchanged).toEqual(["a"]);
  expect(next.stamps.a).toBe(first.stamps.a);
  expect(next.stamps.b).not.toBe(first.stamps.b);
});

test("a list read in pages sends the most recent reviews first, then the rest", () => {
  const snapshot = (id: string) =>
    ({ session: { id, title: id }, threads: [] }) as unknown as Parameters<
      typeof listReviewsSince
    >[0][number];
  const all = ["a", "b", "c"].map(snapshot);
  const first = listReviewsSince(all, {}, 2);
  expect(first.sessions.map((each) => each.session.id)).toEqual(["a", "b"]);
  expect(first.remaining).toBe(1);
  expect(Object.keys(first.stamps)).toEqual(["a", "b"]);
  const last = listReviewsSince(all, first.stamps, 2);
  expect(last.unchanged).toEqual(["a", "b"]);
  expect(last.sessions.map((each) => each.session.id)).toEqual(["c"]);
  expect(last.remaining).toBe(0);
});
