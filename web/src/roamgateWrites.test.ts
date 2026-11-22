import { expect, test } from "bun:test";
import { canOpenRoamgateWrite, openRoamgateWrite } from "./roamgateWrites";

test("a write's link shows the review it wrote in, where that review lives", () => {
  const shown: [string, string][] = [];
  const openers = {
    connectionId: () => "desktop",
    showReview: (connection: string, review: string) => {
      shown.push([connection, review]);
    },
  };
  const write = {
    action: "reply" as const,
    review: "4aad5bedb15e09e5",
    thread: "3bad5213aaaa0000",
  };
  expect(canOpenRoamgateWrite(write)).toBe(true);
  expect(openRoamgateWrite(write, openers)).toBe(true);
  expect(shown).toEqual([["desktop", "4aad5bedb15e09e5"]]);
  // Before its result, a call does not say where: nothing to open.
  const pending = { action: "comment" as const, text: "Rename" };
  expect(canOpenRoamgateWrite(pending)).toBe(false);
  expect(openRoamgateWrite(pending, openers)).toBe(false);
  expect(
    openRoamgateWrite(write, { ...openers, connectionId: () => null }),
  ).toBe(false);
  expect(shown).toHaveLength(1);
});
