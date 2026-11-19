import { expect, test } from "bun:test";
import { createListDeltas } from "./list-delta";

const panes = (...entries: Array<[string, string]>) => ({
  type: "pane_list",
  panes: entries.map(([pane_id, status]) => ({ pane_id, status })),
});

test("a list read with the stamp the socket was given answers the changes", () => {
  const listReply = createListDeltas();
  const socket = {};
  const first = listReply(
    socket,
    "desktop",
    "pane.list",
    panes(["p1", "idle"], ["p2", "idle"]),
    null,
  ) as { list_stamp: string; panes: unknown[] };
  expect(first.panes).toHaveLength(2);
  expect(typeof first.list_stamp).toBe("string");

  const next = listReply(
    socket,
    "desktop",
    "pane.list",
    panes(["p2", "working"], ["p3", "idle"]),
    first.list_stamp,
  ) as { list_delta: Record<string, unknown> };
  expect(next.list_delta).toMatchObject({
    base: first.list_stamp,
    array: "panes",
    rest: { type: "pane_list" },
    order: ["p2", "p3"],
    upsert: [
      { pane_id: "p2", status: "working" },
      { pane_id: "p3", status: "idle" },
    ],
  });
});

test("an unknown stamp, another socket or another list gets the whole list", () => {
  const listReply = createListDeltas();
  const socket = {};
  const first = listReply(
    socket,
    "desktop",
    "pane.list",
    panes(["p1", "a"]),
    null,
  ) as {
    list_stamp: string;
  };
  for (const [owner, method] of [
    [{}, "pane.list"],
    [socket, "tab.list"],
  ] as const) {
    const reply = listReply(
      owner,
      "desktop",
      method,
      method === "tab.list" ? { tabs: [{ tab_id: "t1" }] } : panes(["p1", "a"]),
      first.list_stamp,
    ) as Record<string, unknown>;
    expect(reply.list_delta).toBeUndefined();
    expect(typeof reply.list_stamp).toBe("string");
  }
  // Items without ids cannot be patched: the result goes as it is.
  const odd = { panes: [{ status: "x" }] };
  expect(listReply(socket, "desktop", "pane.list", odd, null)).toBe(odd);
});
