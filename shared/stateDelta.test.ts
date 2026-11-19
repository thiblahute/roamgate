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
    by: "id",
    order: ["m1", "m2", "m3"],
    upsert: [{ id: "m3", text: "c" }],
    patch: { m2: { set: { text: "b, more" }, unset: [], lists: {} } },
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

test("nested lists keyed by another id field change item by item", () => {
  const agents = (status: string) => [
    { pane_id: "p1", status },
    { pane_id: "p2", status: "idle" },
  ];
  const base = {
    connections: [
      { connection_id: "desktop", agents: agents("idle") },
      { connection_id: "mac", agents: [] },
    ],
  };
  const next = {
    connections: [
      { connection_id: "desktop", agents: agents("working") },
      { connection_id: "mac", agents: [] },
    ],
  };
  const delta = diffState(base, next)!;
  expect(delta.lists.connections?.upsert).toEqual([]);
  expect(
    delta.lists.connections?.patch?.desktop?.lists.agents?.patch?.p1?.set,
  ).toEqual({ status: "working" });
  expect(applyStateDelta(base, delta)).toEqual(next);
});
