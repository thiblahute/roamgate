import { expect, test } from "bun:test";
import { applyStateDelta, diffState } from "./stateDelta";

test("a state's changes carry only the changed fields and list items", () => {
  const kept = { id: "m1", text: "a long message".repeat(100) };
  const base = {
    revision: 1,
    running: false,
    error: "x",
    messages: [kept, { id: "m2", text: "b" }],
  };
  const next = {
    revision: 2,
    running: true,
    messages: [kept, { id: "m2", text: "b, more" }, { id: "m3", text: "c" }],
  };
  const delta = diffState(base, next)!;
  expect(delta.set).toEqual({ revision: 2, running: true });
  expect(delta.unset).toEqual(["error"]);
  expect(delta.lists.messages).toEqual({
    order: ["m1", "m2", "m3"],
    upsert: [
      { id: "m2", text: "b, more" },
      { id: "m3", text: "c" },
    ],
  });
  expect(applyStateDelta(base, delta)).toEqual(next);
  expect(diffState(next, { ...next })).toBeNull();
});

test("changes to a list the base lacks an item of do not apply", () => {
  const delta = diffState(
    { messages: [{ id: "m1" }] },
    { messages: [{ id: "m1" }, { id: "m2" }] },
  )!;
  expect(applyStateDelta({ messages: [] }, delta)).toBeNull();
});
