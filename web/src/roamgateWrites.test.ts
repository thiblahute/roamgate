import { expect, test } from "bun:test";
import {
  canOpenRoamgateWrite,
  openRoamgateWrite,
  roamgateWriteHeadline,
} from "./roamgateWrites";

const openersSeeing = (shown: string[]) => ({
  connectionId: () => "desktop",
  showReview: (
    connection: string,
    review: string,
    at: { thread?: string; comment?: string },
  ) => {
    shown.push(
      `review ${connection} ${review}${at.thread ? ` ${at.thread}` : ""}${at.comment ? ` ${at.comment}` : ""}`,
    );
  },
  showItem: (item: string) => {
    shown.push(`item ${item}`);
  },
});

test("a write's link shows the review it wrote in, where that review lives", () => {
  const shown: string[] = [];
  const openers = openersSeeing(shown);
  const write = {
    action: "reply" as const,
    review: "4aad5bedb15e09e5",
    thread: "3bad5213aaaa0000",
    comment: "77c0ffee00000001",
  };
  expect(canOpenRoamgateWrite(write)).toBe(true);
  expect(openRoamgateWrite(write, openers)).toBe(true);
  // A Work item's change opens its card on the board.
  expect(
    openRoamgateWrite(
      { action: "item_update", item: "3878370a636e490e" },
      openers,
    ),
  ).toBe(true);
  expect(shown).toEqual([
    // At the comment written.
    "review desktop 4aad5bedb15e09e5 3bad5213aaaa0000 77c0ffee00000001",
    "item 3878370a636e490e",
  ]);
  // Before its result, a call does not say where: nothing to open.
  const pending = { action: "comment" as const, text: "Rename" };
  expect(canOpenRoamgateWrite(pending)).toBe(false);
  expect(openRoamgateWrite(pending, openers)).toBe(false);
  expect(
    openRoamgateWrite(write, { ...openers, connectionId: () => null }),
  ).toBe(false);
  expect(shown).toHaveLength(2);
});

test("a reply on a Work item's thread names the item", () => {
  const reviews = (id: string) =>
    id === "work-review"
      ? {
          session: {
            title: "Work: Inspector header bar",
            target: { kind: "work", item: "3878370a636e490e" },
          },
        }
      : undefined;
  const headline = (write: Parameters<typeof roamgateWriteHeadline>[0]) =>
    roamgateWriteHeadline(write, "the summary", reviews as never);
  expect(
    headline({
      action: "reply",
      review: "work-review",
      text: "Right: splitting the bar keeps the title\nmore",
    }),
  ).toBe(
    "Replied on Work: Inspector header bar · Right: splitting the bar keeps the title",
  );
  // The call's description wins; another review keeps the summary.
  expect(
    headline({
      action: "reply",
      review: "work-review",
      description: "Say why",
    }),
  ).toBe("Say why");
  expect(headline({ action: "reply", review: "code", text: "Done" })).toBe(
    "the summary",
  );
  expect(headline({ action: "item_done", item: "1" })).toBe("the summary");
});
