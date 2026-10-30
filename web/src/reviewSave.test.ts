import { expect, test } from "bun:test";
import { handoffStatus, notSavedStatus, saveOrKeep } from "./reviewSave";

test("a failed save keeps the text and says why", async () => {
  const kept: string[] = [];
  const error = await saveOrKeep(
    async () => {
      throw new Error("connection lost");
    },
    () => kept.push("my comment"),
  );
  expect(error).toBe("connection lost");
  expect(kept).toEqual(["my comment"]);
  expect(notSavedStatus(error!)).toContain("connection lost");
  expect(notSavedStatus(error!)).toContain("kept");
});

test("a save that succeeds keeps nothing", async () => {
  let kept = false;
  const error = await saveOrKeep(
    async () => "saved",
    () => {
      kept = true;
    },
  );
  expect(error).toBeNull();
  expect(kept).toBe(false);
});

test("a handoff that failed does not claim it was sent", () => {
  const failed = handoffStatus("Claude", "agent pane is gone", 2, true);
  expect(failed).not.toContain("Sent to");
  expect(failed).toContain("agent pane is gone");
  expect(handoffStatus("Claude", null, 1, false)).toBe(
    "Sent to Claude: 1 open discussion.",
  );
  expect(handoffStatus("Claude", null, 2, true)).toBe(
    "Sent to Claude: 2 open discussions and your overall comment.",
  );
});
