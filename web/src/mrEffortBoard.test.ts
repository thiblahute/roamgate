import { expect, test } from "bun:test";
import type { MrInboxEntry, MrPlan } from "../../shared/mrReviews";
import { mrEffortColumn } from "./mrEffortBoard";

const entry = (extra: Partial<MrInboxEntry> = {}) =>
  ({ state: "open", lane: "waiting", ...extra }) as MrInboxEntry;
const part = { part: { connectionId: "local", path: "/wt/p", branch: "p" } };
const unplanned = {} as Pick<MrPlan, "part">;
const planned = part as Pick<MrPlan, "part">;

test("a plan's column is its request's lane, else whether it has a part", () => {
  expect(mrEffortColumn(planned, entry({ lane: "your_move" }))).toBe(
    "your_move",
  );
  expect(mrEffortColumn(planned, entry({ lane: "merging" }))).toBe("merging");
  expect(mrEffortColumn(planned, entry({ lane: "blocked" }))).toBe("blocked");
  expect(mrEffortColumn(planned, entry({ lane: "stale" }))).toBe("stale");
  // A branch row is not a request: the part is not proposed yet.
  expect(
    mrEffortColumn(
      planned,
      entry({ lane: "not_sent", branch: {} as MrInboxEntry["branch"] }),
    ),
  ).toBe("not_sent");
  expect(mrEffortColumn(planned, undefined)).toBe("not_sent");
  // Merged, or closed: done.
  expect(
    mrEffortColumn(planned, entry({ state: "merged", lane: "done" })),
  ).toBe("done");
  expect(mrEffortColumn(planned, entry({ state: "closed" }))).toBe("done");
  expect(mrEffortColumn(unplanned, undefined)).toBe("planned");
  // Every commit upstream already: done.
  expect(mrEffortColumn(unplanned, undefined, true)).toBe("done");
});
