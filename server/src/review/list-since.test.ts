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
