import { expect, test } from "bun:test";
import {
  addOlderPage,
  canLoadOlder,
  endOlder,
  oldestShownEntry,
  slideOlder,
  withOlderEntries,
  historyLoadError,
  mergeAgentHistory,
  retryOnceOnTimeout,
  selectHistoryEntries,
  ALL_HISTORY_FILTERS,
  type AgentHistoryResponse,
  type HistoryEntry,
} from "./agentHistory";

const entry = (id: string, text = id): HistoryEntry => ({
  id,
  kind: "message",
  role: "user",
  text,
  sent_at: "2026-01-01T00:00:00Z",
});
function response(
  entries: HistoryEntry[],
  revision = 1,
  epoch = "a",
): AgentHistoryResponse {
  return {
    history_version: 2,
    mode: "snapshot",
    cursor: { epoch, revision },
    window_limit: 200,
    entries,
    agent: "pi",
    pane_id: "p",
    workspace_id: "w",
    tab_id: "t",
    updated_at: "",
    path: "/tmp/a",
  };
}

test("merges updates, removals and explicit order without retaining full transport payloads", () => {
  const first = mergeAgentHistory(
    null,
    response([entry("1"), entry("2")]),
    null,
  )!;
  const next = mergeAgentHistory(
    first,
    {
      ...response([]),
      mode: "delta",
      base_revision: 1,
      cursor: { epoch: "a", revision: 2 },
      removed: ["1"],
      upserts: [entry("2", "edited"), entry("3")],
      order: ["3", "2"],
    },
    first.cursor,
  )!;
  expect(next.messages.map((item) => item.text)).toEqual(["3", "edited"]);
  expect(next).not.toHaveProperty("upserts");
  expect(next).not.toHaveProperty("entries");
  const unchanged = mergeAgentHistory(
    next,
    {
      ...response([]),
      mode: "delta",
      base_revision: 2,
      cursor: next.cursor,
      upserts: [],
      removed: [],
    },
    next.cursor,
  )!;
  expect(unchanged.messages).toEqual(next.messages);
});

test("rejects stale, duplicate and out-of-order responses including old epoch resets", () => {
  const first = mergeAgentHistory(null, response([entry("1")]), null)!;
  const second = mergeAgentHistory(
    first,
    response([entry("2")], 2),
    first.cursor,
  )!;
  expect(
    mergeAgentHistory(second, response([entry("stale")]), first.cursor),
  ).toBe(second);
  expect(
    mergeAgentHistory(second, response([entry("duplicate")], 2), first.cursor),
  ).toBe(second);
  expect(
    mergeAgentHistory(
      second,
      response([entry("old reset")], 1, "old"),
      first.cursor,
    ),
  ).toBe(second);
  expect(
    mergeAgentHistory(
      second,
      response([entry("regression")], 1),
      second.cursor,
    ),
  ).toBe(second);
  expect(
    mergeAgentHistory(
      second,
      {
        ...response([]),
        mode: "delta",
        base_revision: 3,
        cursor: { epoch: "a", revision: 4 },
        upserts: [],
        removed: [],
      },
      second.cursor,
    ),
  ).toBe(second);
  const reset = mergeAgentHistory(
    second,
    response([], 1, "new"),
    second.cursor,
  )!;
  expect(reset.cursor.epoch).toBe("new");
  expect(reset.messages).toEqual([]);
  expect(
    mergeAgentHistory(null, response([entry("previous pane")]), second.cursor),
  ).toBeNull();
});

test("filtering leaves hidden entries synchronized across delta updates and removals", () => {
  const tool: HistoryEntry = {
    ...entry("tool", "old output"),
    role: "tool",
    kind: "tool_result",
  };
  const first = mergeAgentHistory(null, response([entry("user"), tool]), null)!;
  const filters = { user: true, agent: false, tool: false };
  expect(selectHistoryEntries(first.messages, filters).visible).toEqual([
    entry("user"),
  ]);
  const next = mergeAgentHistory(
    first,
    {
      ...response([]),
      mode: "delta",
      base_revision: 1,
      cursor: { epoch: "a", revision: 2 },
      removed: ["user"],
      upserts: [{ ...tool, text: "updated output" }, entry("new")],
      order: ["tool", "new"],
    },
    first.cursor,
  )!;
  expect(selectHistoryEntries(next.messages, filters).visible).toEqual([
    entry("new"),
  ]);
  expect(
    selectHistoryEntries(next.messages, ALL_HISTORY_FILTERS).visible.map(
      (item) => item.text,
    ),
  ).toEqual(["updated output", "new"]);
  expect(next.cursor).toEqual({ epoch: "a", revision: 2 });
});

test("window counts conversation entries only; tool entries ride along", () => {
  const tool = (id: string): HistoryEntry => ({
    ...entry(id),
    role: "tool",
    kind: "tool_call",
    tool_name: "bash",
    text: "",
    text_bytes: 10,
  });
  const interleaved: HistoryEntry[] = [];
  for (let index = 0; index < 205; index++) {
    interleaved.push(entry(`u${index}`), tool(`t${index}`));
  }
  const merged = mergeAgentHistory(null, response(interleaved), null)!;
  expect(merged.messages.filter((item) => item.role !== "tool")).toHaveLength(
    200,
  );
  expect(merged.messages[0].id).toBe("u5");
  expect(merged.messages[1].id).toBe("t5");
  expect(merged.messages.filter((item) => item.role === "tool")).toHaveLength(
    200,
  );
});

test("bounds snapshots and rejects malformed delta ordering", () => {
  const first = mergeAgentHistory(
    null,
    response(Array.from({ length: 205 }, (_, index) => entry(String(index)))),
    null,
  )!;
  expect(first.messages).toHaveLength(200);
  expect(first.messages[0].id).toBe("5");
  expect(
    mergeAgentHistory(
      first,
      {
        ...response([]),
        mode: "delta",
        base_revision: 1,
        cursor: { epoch: "a", revision: 2 },
        upserts: [],
        removed: [],
        order: ["unknown"],
      },
      first.cursor,
    ),
  ).toBe(first);
});

test("a refresh keeps the objects of entries that did not change", () => {
  const first = mergeAgentHistory(
    null,
    response([entry("1"), entry("2"), entry("3")]),
    null,
  )!;
  // A snapshot hands over new objects for every entry, one of them changed.
  const next = mergeAgentHistory(
    first,
    response([entry("1"), entry("2", "edited"), entry("3"), entry("4")], 2),
    first.cursor,
  )!;
  expect(next.messages[0]).toBe(first.messages[0]!);
  expect(next.messages[1]).not.toBe(first.messages[1]!);
  expect(next.messages[1]!.text).toBe("edited");
  expect(next.messages[2]).toBe(first.messages[2]!);
  expect(next.messages[3]!.id).toBe("4");
});

test("a read that timed out is asked once more", async () => {
  let calls = 0;
  expect(
    await retryOnceOnTimeout(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout: agent_history.get");
      return "ok";
    }),
  ).toBe("ok");
  expect(calls).toBe(2);
  calls = 0;
  await expect(
    retryOnceOnTimeout(async () => {
      calls += 1;
      throw new Error("timeout: agent_history.get");
    }),
  ).rejects.toThrow("timeout: agent_history.get");
  expect(calls).toBe(2);
  calls = 0;
  await expect(
    retryOnceOnTimeout(async () => {
      calls += 1;
      throw new Error("not connected to bridge");
    }),
  ).rejects.toThrow("not connected");
  expect(calls).toBe(1);
});

test("a read that timed out says so before it is asked again", async () => {
  const seen: string[] = [];
  let calls = 0;
  await retryOnceOnTimeout(
    async () => {
      calls += 1;
      seen.push(`call ${calls}`);
      if (calls === 1) throw new Error("timeout: agent_history.get");
      return "ok";
    },
    () => seen.push("timed out"),
  );
  expect(seen).toEqual(["call 1", "timed out", "call 2"]);
});

test("timeouts read as a slow bridge, other errors as they are", () => {
  expect(historyLoadError([])).toBe("");
  const text = historyLoadError([
    "timeout: agent_history.get",
    "timeout: agent_session.get",
    "Agent session is unavailable",
  ]);
  expect(text).not.toContain("timeout:");
  expect(text).toContain("slow to answer");
  expect(text.split("\n")).toHaveLength(2);
  expect(text).toContain("Agent session is unavailable");
});

test("older pages go in front of the window, deduplicated", () => {
  const live = mergeAgentHistory(
    null,
    response([entry("5"), entry("6")]),
    null,
  )!;
  expect(canLoadOlder(null, live)).toBe(true);
  expect(oldestShownEntry(null, live)!.id).toBe("5");
  let older = addOlderPage(
    null,
    "a",
    { entries: [entry("3"), entry("4"), entry("5")], has_more: true },
    live.messages,
  );
  // The window's own entry is not repeated.
  expect(older.entries.map((each) => each.id)).toEqual(["3", "4"]);
  expect(oldestShownEntry(older, live)!.id).toBe("3");
  older = addOlderPage(
    older,
    "a",
    { entries: [entry("1"), entry("2"), entry("3")], has_more: false },
    live.messages,
  );
  expect(withOlderEntries(older, live).map((each) => each.id)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  expect(canLoadOlder(older, live)).toBe(false);
  // A page of another epoch starts over.
  expect(
    addOlderPage(
      older,
      "b",
      { entries: [entry("9")], has_more: true },
      live.messages,
    ).entries.map((each) => each.id),
  ).toEqual(["9"]);
  // Gone from the history: nothing older for now, what was read stays.
  const ended = endOlder(older, "a");
  expect(ended.hasMore).toBe(false);
  expect(ended.entries).toBe(older.entries);
  expect(endOlder(older, "b").entries).toEqual([]);
});

test("a sliding window hands what it lets go of to the older entries", () => {
  const first = mergeAgentHistory(
    null,
    response([entry("3"), entry("4"), entry("5")]),
    null,
  )!;
  const older = addOlderPage(
    null,
    "a",
    { entries: [entry("1"), entry("2")], has_more: false },
    first.messages,
  );
  // 3 leaves the window by its start, 6 arrives; 4 is removed meanwhile.
  const next = mergeAgentHistory(
    first,
    response([entry("5"), entry("6")], 2),
    first.cursor,
  )!;
  const slid = slideOlder(older, first, next)!;
  expect(slid.entries.map((each) => each.id)).toEqual(["1", "2", "3", "4"]);
  expect(slid.entries[2]).toBe(first.messages[0]!);
  expect(withOlderEntries(slid, next).map((each) => each.id)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  // Nothing changed: the same state, so nothing re-renders.
  expect(slideOlder(slid, next, next)).toBe(slid);
  // An entry the window holds again leaves the older ones.
  const back = mergeAgentHistory(
    next,
    response([entry("2"), entry("5"), entry("6")], 3),
    next.cursor,
  )!;
  expect(slideOlder(slid, next, back)!.entries.map((each) => each.id)).toEqual([
    "1",
    "3",
    "4",
  ]);
  // A reset (another epoch) or no history drops them.
  const reset = mergeAgentHistory(
    next,
    response([entry("7")], 1, "b"),
    next.cursor,
  )!;
  expect(reset.cursor.epoch).toBe("b");
  expect(slideOlder(slid, next, reset)).toBeNull();
  expect(slideOlder(slid, next, null)).toBeNull();
  expect(slideOlder(null, first, next)).toBeNull();
});
