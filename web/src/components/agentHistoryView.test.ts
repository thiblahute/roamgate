import { expect, test } from "bun:test";
import { toolOverlayMatches, type HistoryEntry } from "./agentHistory";
import {
  collapsedToolProgress,
  toolStepSummary,
  type ToolStep,
  groupHistoryChatItems,
  pairToolSteps,
  previewToolArgumentFields,
  searchHistoryChatEntries,
  summarizeToolSteps,
  toolArgumentFields,
  toolArgumentHeadline,
  takeQueuedToolLoads,
  toolPayloadKey,
} from "./agentHistoryView";

function entry(
  id: string,
  role: HistoryEntry["role"],
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry {
  return {
    id,
    role,
    kind: role === "tool" ? "tool_call" : "message",
    text: `${role} ${id}`,
    sent_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("consecutive tool entries collapse into one chat block", () => {
  const items = groupHistoryChatItems([
    entry("1", "user"),
    entry("2", "tool"),
    entry("3", "tool", { kind: "tool_result" }),
    entry("4", "assistant"),
    entry("5", "tool"),
  ]);
  expect(
    items.map((item) =>
      item.type === "message"
        ? item.entry.id
        : item.entries.map((tool) => tool.id),
    ),
  ).toEqual(["1", ["2", "3"], "4", ["5"]]);
  // Group keys follow their first entry so appended results keep identity.
  expect(items[1]).toMatchObject({ type: "tools", id: "tools:2" });
  // Minimap sequences count bubbles only, skipping tool rows.
  expect(items[0]).toMatchObject({ type: "message", sequence: 1 });
  expect(items[2]).toMatchObject({ type: "message", sequence: 2 });
});

test("a tool block and its steps keep their ids when the transcript replaces the streamed calls", () => {
  const ids = (entries: HistoryEntry[]) =>
    groupHistoryChatItems(entries).flatMap((item) =>
      item.type === "tools"
        ? [[item.id, pairToolSteps(item.entries).map((step) => step.id)]]
        : [],
    );
  const question = entry("q", "user");
  // A conversation's calls as streamed, then as its transcript has them.
  const streamed = [
    entry("live:tool:a", "tool", { source_call_id: "a" }),
    entry("live:result:a", "tool", {
      kind: "tool_result",
      source_call_id: "a",
    }),
    entry("live:tool:b", "tool", { source_call_id: "b" }),
  ];
  const saved = [
    entry("h1", "tool", { source_call_id: "a", text: "" }),
    entry("h2", "tool", { kind: "tool_result", source_call_id: "a" }),
  ];
  const expected = [["tools:call:a", ["call:a", "call:b"]]];
  expect(ids([question, ...streamed])).toEqual(expected);
  expect(ids([question, ...saved, ...streamed.slice(2)])).toEqual(expected);
  expect(
    ids([question, ...saved, entry("h3", "tool", { source_call_id: "b" })]),
  ).toEqual(expected);
  // A block that starts with a result (its call before a message) is
  // known by it, not by the call another block starts with.
  expect(
    ids([
      entry("c", "tool", { source_call_id: "x" }),
      entry("m", "assistant"),
      entry("r", "tool", { kind: "tool_result", source_call_id: "x" }),
      entry("c2", "tool", { source_call_id: "x" }),
    ]),
  ).toEqual([
    ["tools:call:x", ["call:x"]],
    ["tools:r", ["r", "call:x"]],
  ]);
});

test("the same slash command typed again and again is one chip with a count", () => {
  const exit = (id: string, at: string) =>
    entry(id, "user", {
      text: "/exit",
      sent_at: at,
      command: { name: "/exit", args: "" },
    });
  const items = groupHistoryChatItems([
    entry("1", "assistant"),
    ...Array.from({ length: 11 }, (_, index) =>
      exit(
        `e${index}`,
        `2026-11-03T14:${String(29 + Math.floor(index / 2)).padStart(2, "0")}:00Z`,
      ),
    ),
    entry("2", "assistant"),
    exit("x1", "2026-11-03T15:00:00Z"),
    entry("3", "user", {
      text: "/model opus",
      command: { name: "/model", args: "opus" },
    }),
  ]);
  expect(
    items.map((item) =>
      item.type === "message"
        ? [item.entry.id, item.repeated ?? 1, item.sequence]
        : item.id,
    ),
  ).toEqual([
    ["1", 1, 1],
    // Eleven in a row: one, under the first one's id, the last one's time.
    ["e0", 11, 2],
    ["2", 1, 3],
    // Not in a row with them: its own chip.
    ["x1", 1, 4],
    // Another command (or the same with other arguments): its own.
    ["3", 1, 5],
  ]);
  expect(items[1]).toMatchObject({
    firstSentAt: "2026-11-03T14:29:00Z",
    entry: { sent_at: "2026-11-03T14:34:00Z" },
  });
});

test("tool block summaries count paired steps by tool, most used first", () => {
  expect(
    summarizeToolSteps(
      pairToolSteps([
        entry("1", "tool", { tool_name: "read" }),
        entry("2", "tool", { kind: "tool_result", tool_name: "read" }),
        entry("3", "tool", { tool_name: "bash" }),
        entry("4", "tool", {
          kind: "tool_result",
          tool_name: "bash",
          is_error: true,
        }),
        entry("5", "tool", { tool_name: "bash" }),
        entry("6", "tool", { kind: "tool_result", tool_name: "bash" }),
      ]),
    ),
  ).toEqual({
    calls: 3,
    errors: 1,
    dismissed: 0,
    tools: [
      { name: "bash", count: 2 },
      { name: "read", count: 1 },
    ],
  });
  // Results whose calls left the history window stand in for them.
  expect(
    summarizeToolSteps(
      pairToolSteps([
        entry("1", "tool", { kind: "tool_result", tool_name: "edit" }),
      ]),
    ),
  ).toEqual({
    calls: 1,
    errors: 0,
    dismissed: 0,
    tools: [{ name: "edit", count: 1 }],
  });
});

test("tool steps pair each call with its result by call id", () => {
  const steps = pairToolSteps([
    entry("1", "tool", { tool_name: "read", source_call_id: "a" }),
    entry("2", "tool", { tool_name: "bash", source_call_id: "b" }),
    entry("3", "tool", { kind: "tool_result", source_call_id: "b" }),
    entry("4", "tool", { kind: "tool_result", source_call_id: "a" }),
    // Its call left the history window: the result stands alone.
    entry("5", "tool", {
      kind: "tool_result",
      tool_name: "edit",
      source_call_id: "z",
    }),
  ]);
  expect(
    steps.map((step) => [step.name, step.call?.id, step.result?.id]),
  ).toEqual([
    ["read", "1", "4"],
    ["bash", "2", "3"],
    ["edit", undefined, "5"],
  ]);
});

test("argument headlines pick the most telling field", () => {
  expect(
    toolArgumentHeadline(
      JSON.stringify({ description: "List files", command: "ls -la\npwd" }),
    ),
  ).toBe("List files");
  expect(toolArgumentHeadline(JSON.stringify({ command: "ls -la\npwd" }))).toBe(
    "ls -la",
  );
  expect(toolArgumentHeadline(JSON.stringify({ file_path: "/a/b.ts" }))).toBe(
    "/a/b.ts",
  );
  expect(toolArgumentHeadline(JSON.stringify({ limit: 5 }))).toBe(
    '{"limit":5}',
  );
  expect(toolArgumentHeadline("\n  plain text args\nmore")).toBe(
    "plain text args",
  );
});

test("argument fields keep strings verbatim and format other values", () => {
  expect(
    toolArgumentFields(
      JSON.stringify({ command: "ls", description: "List", opts: { a: 1 } }),
    ),
  ).toEqual([
    { key: "command", value: "ls", code: true },
    { key: "description", value: "List", code: false },
    { key: "opts", value: '{\n  "a": 1\n}', code: true },
  ]);
  expect(toolArgumentFields("not json")).toEqual([
    { key: "", value: "not json", code: true },
  ]);
  expect(toolArgumentFields("")).toEqual([]);
});

test("tool steps without call ids pair with the next call of the same tool", () => {
  const steps = pairToolSteps([
    entry("1", "tool", { tool_name: "bash" }),
    entry("2", "tool", { tool_name: "read" }),
    entry("3", "tool", { kind: "tool_result", tool_name: "read" }),
    entry("4", "tool", { kind: "tool_result", tool_name: "bash" }),
    // An id on both sides that does not match never pairs by name.
    entry("5", "tool", { tool_name: "edit", source_call_id: "x" }),
    entry("6", "tool", {
      kind: "tool_result",
      tool_name: "edit",
      source_call_id: "y",
    }),
  ]);
  expect(
    steps.map((step) => [step.name, step.call?.id, step.result?.id]),
  ).toEqual([
    ["bash", "1", "4"],
    ["read", "2", "3"],
    ["edit", "5", undefined],
    ["edit", undefined, "6"],
  ]);
});

test("chat search keeps a tool call and its result together", () => {
  const entries = [
    entry("1", "user", { text: "fix the build" }),
    entry("2", "tool", {
      tool_name: "bash",
      source_call_id: "a",
      text: '{"command":"bun run build"}',
    }),
    // Redacted result: it cannot match on its own text.
    entry("3", "tool", {
      kind: "tool_result",
      tool_name: "bash",
      source_call_id: "a",
      text: "",
      text_bytes: 40,
    }),
    entry("4", "tool", {
      tool_name: "read",
      source_call_id: "b",
      text: '{"file_path":"a.ts"}',
    }),
    entry("5", "tool", {
      kind: "tool_result",
      tool_name: "read",
      source_call_id: "b",
      text: "export const build = 1;",
    }),
    entry("6", "assistant", { text: "done" }),
  ];
  const ids = (query: string) =>
    searchHistoryChatEntries(entries, query).map((item) => item.id);
  expect(ids("build")).toEqual(["1", "2", "3", "4", "5"]);
  expect(ids("bun run")).toEqual(["2", "3"]);
  expect(ids("done")).toEqual(["6"]);
  expect(ids("  ")).toEqual(["1", "2", "3", "4", "5", "6"]);
});

test("argument previews share one budget across all fields", () => {
  const field = (key: string, value: string) => ({ key, value, code: false });
  // Many short fields: each fits on its own, but together they exceed the
  // budget, so the preview stops and reports truncation.
  const many = Array.from({ length: 1000 }, (_, i) => field(`k${i}`, "abcdef"));
  const clipped = previewToolArgumentFields(many, 100);
  expect(clipped.truncated).toBe(true);
  expect(
    clipped.fields.reduce(
      (total, item) => total + item.key.length + item.value.length,
      0,
    ),
  ).toBeLessThanOrEqual(100);
  // One long field is cut to what is left of the budget.
  expect(previewToolArgumentFields([field("cmd", "x".repeat(50))], 13)).toEqual(
    { fields: [field("cmd", "x".repeat(10))], truncated: true },
  );
  // Fields that fit are returned whole.
  const fits = [field("a", "1"), field("b", "2")];
  expect(previewToolArgumentFields(fits, 100)).toEqual({
    fields: fits,
    truncated: false,
  });
});

test("payload keys change when an entry is rewritten under the same id", () => {
  const stub = entry("7", "tool", {
    text: "",
    text_bytes: 120,
    text_hash: "aaa",
  });
  expect(toolPayloadKey(stub)).toBe(toolPayloadKey({ ...stub }));
  // A same-length rewrite still changes the hash, and so the key.
  expect(toolPayloadKey(stub)).not.toBe(
    toolPayloadKey({ ...stub, text_hash: "bbb" }),
  );
  // Without a hash (older bridges), the byte length versions the payload.
  const legacy = entry("7", "tool", { text: "", text_bytes: 120 });
  expect(toolPayloadKey(legacy)).not.toBe(
    toolPayloadKey({ ...legacy, text_bytes: 180 }),
  );
});

test("fetched payloads match entries by hash, or by length without one", () => {
  const overlay = { text: "x", bytes: 1, hash: "aaa" };
  expect(toolOverlayMatches(overlay, { text_bytes: 1, text_hash: "aaa" })).toBe(
    true,
  );
  // Same length, different content: the stale payload no longer matches.
  expect(toolOverlayMatches(overlay, { text_bytes: 1, text_hash: "bbb" })).toBe(
    false,
  );
  expect(toolOverlayMatches(overlay, { text_bytes: 1 })).toBe(true);
  expect(toolOverlayMatches(overlay, { text_bytes: 2 })).toBe(false);
});

test("queued tool loads respect the limit and wait behind in-flight versions", () => {
  const stub = (id: string, bytes: number) =>
    entry(id, "tool", { text: "", text_bytes: bytes });
  const take = (
    queue: HistoryEntry[],
    options: { inFlight?: number; started?: string[]; loading?: string[] },
  ) => {
    const { start, rest } = takeQueuedToolLoads(queue, {
      inFlight: options.inFlight ?? 0,
      limit: 2,
      started: new Set(options.started),
      loadingIds: new Set(options.loading),
    });
    return {
      start: start.map(toolPayloadKey),
      rest: rest.map(toolPayloadKey),
    };
  };
  // Starts up to the limit; the rest stays queued in order.
  expect(take([stub("a", 1), stub("b", 1), stub("c", 1)], {})).toEqual({
    start: ["a:1", "b:1"],
    rest: ["c:1"],
  });
  // A rewritten payload whose old version is still in flight is kept, not
  // dropped, and starts on a later pass once that request settles.
  expect(take([stub("a", 2)], { inFlight: 1, loading: ["a"] })).toEqual({
    start: [],
    rest: ["a:2"],
  });
  expect(take([stub("a", 2)], { started: ["a:1"] })).toEqual({
    start: ["a:2"],
    rest: [],
  });
  // Only the newest queued version of an entry is fetched; versions that
  // already started and duplicates are dropped.
  expect(
    take([stub("a", 1), stub("b", 1), stub("a", 2), stub("b", 1)], {
      started: ["b:1"],
    }),
  ).toEqual({ start: ["a:2"], rest: [] });
});

test("a message sent to another agent session shows in the chat beside its call", () => {
  const call = entry("c1", "tool", {
    tool_name: "Bash",
    source_call_id: "toolu_1",
    text: JSON.stringify({
      command: 'roamgate-review message desktop/w5:p1 -- "Is the build green?"',
    }),
  });
  const result = entry("r1", "tool", {
    kind: "tool_result",
    source_call_id: "toolu_1",
    text: JSON.stringify({ sent: true, to: { name: "Merge checks" } }),
  });
  const items = groupHistoryChatItems([call, result]);
  // After the whole block: the call and its result stay together.
  expect(items.map((item) => item.type)).toEqual(["tools", "message"]);
  const sent = items[1]!.type === "message" ? items[1]!.entry : null;
  expect(sent).toMatchObject({
    id: "c1:sent",
    text: "Is the build green?",
    injected: { kind: "session", label: "To Merge checks (desktop/w5:p1)" },
  });
  // Refused (a rate limit, an unknown address): said so.
  const failed = groupHistoryChatItems([
    call,
    { ...result, is_error: true, text: '{"error": "too many messages"}' },
  ]);
  expect(
    failed[1]!.type === "message" && failed[1]!.entry.injected?.label,
  ).toBe("Not sent to desktop/w5:p1");
  // Any other command is a plain tool call.
  expect(
    groupHistoryChatItems([
      entry("c2", "tool", {
        tool_name: "Bash",
        text: JSON.stringify({ command: "roamgate-review sessions" }),
      }),
    ]).map((item) => item.type),
  ).toEqual(["tools"]);
});

test("a sent message shows from the bridge's metadata when the payload is withheld", () => {
  const items = groupHistoryChatItems([
    entry("c1", "tool", {
      tool_name: "Bash",
      source_call_id: "toolu_1",
      text: "",
      text_bytes: 120,
      agent_message: { to: "desktop/w5:p1", text: "Rebase please" },
    }),
    entry("r1", "tool", {
      kind: "tool_result",
      source_call_id: "toolu_1",
      text: "",
      text_bytes: 40,
      agent_message_result: { sent: true, name: "Merge checks" },
    }),
  ]);
  expect(items.map((item) => item.type)).toEqual(["tools", "message"]);
  expect(items[1]).toMatchObject({
    type: "message",
    entry: {
      text: "Rebase please",
      injected: { kind: "session", label: "To Merge checks (desktop/w5:p1)" },
    },
  });
});

test("a collapsed group lists running steps and the last finished ones", () => {
  const step = (id: string, done: boolean, summary?: string): ToolStep => ({
    id,
    name: "bash",
    call: {
      id,
      role: "tool",
      kind: "tool_call",
      text: "",
      text_bytes: 20,
      sent_at: "2026-01-01T00:00:00Z",
      ...(summary ? { summary } : {}),
    },
    ...(done
      ? {
          result: {
            id: `${id}r`,
            role: "tool" as const,
            kind: "tool_result" as const,
            text: "",
            sent_at: "2026-01-01T00:00:00Z",
          },
        }
      : {}),
  });
  const steps = [
    step("a", true),
    step("b", false, "Still going"),
    step("c", true),
    step("d", true),
    step("e", true),
    step("f", true),
  ];
  const { visible, earlier } = collapsedToolProgress(steps);
  expect(visible.map((item) => item.id)).toEqual(["b", "d", "e", "f"]);
  expect(earlier).toBe(2);
  expect(toolStepSummary(steps[1]!)).toBe("Still going");
  expect(toolStepSummary(steps[0]!)).toBe("");
  expect(collapsedToolProgress(steps.slice(0, 2)).earlier).toBe(0);
});

test("a step's summary prefers the server's, else reads its arguments", () => {
  const call = (name: string, args: unknown, summary?: string): ToolStep => ({
    id: name,
    name,
    call: {
      id: name,
      role: "tool",
      kind: "tool_call",
      tool_name: name,
      text: JSON.stringify(args),
      sent_at: "2026-01-01T00:00:00Z",
      ...(summary ? { summary } : {}),
    },
  });
  expect(
    toolStepSummary(
      call(
        "SendMessage",
        { to: "a0ed74d49757d9571", summary: "Holder question answered" },
        "To the cutover agent: Holder question answered",
      ),
    ),
  ).toBe("To the cutover agent: Holder question answered");
  expect(
    toolStepSummary(
      call("SendMessage", { to: "a0ed74d49757d9571", summary: "Answered" }),
    ),
  ).toBe("To an agent: Answered");
  expect(
    toolStepSummary(call("Read", { file_path: "/x/web/src/App.tsx" })),
  ).toBe("Read src/App.tsx");
});
