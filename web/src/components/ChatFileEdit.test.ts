import { expect, test } from "bun:test";
import type { HistoryEntry } from "./agentHistory";
import { pairToolSteps } from "./agentHistoryView";
import { stepFileEdits } from "./AgentHistoryChat";
import { fileEditRows } from "./ChatFileEdit";

test("an edit's rows are numbered as its hunks say, hunks apart by a gap", () => {
  expect(
    fileEditRows({
      path: "/w/a.ts",
      added: 2,
      removed: 1,
      hunks: [
        { old_start: 10, new_start: 10, lines: [" a", "-b", "+B", "+C"] },
        { old_start: 40, new_start: 41, lines: [" z"] },
      ],
    }),
  ).toEqual([
    { kind: "context", text: "a", number: 10 },
    { kind: "remove", text: "b", number: 11 },
    { kind: "add", text: "B", number: 11 },
    { kind: "add", text: "C", number: 12 },
    { kind: "gap" },
    { kind: "context", text: "z", number: 41 },
  ]);
  // No numbers known: none shown.
  expect(
    fileEditRows({
      path: "/w/a",
      added: 1,
      removed: 0,
      hunks: [{ lines: ["+x"] }],
    }),
  ).toEqual([{ kind: "add", text: "x" }]);
});

test("a block's edits: the entry's change, a streamed call's arguments, never a failed one", () => {
  const entry = (patch: Partial<HistoryEntry>): HistoryEntry => ({
    id: patch.id ?? "x",
    role: "tool",
    kind: "tool_call",
    text: "",
    sent_at: "2026-11-06T10:00:00.000Z",
    ...patch,
  });
  const kept = {
    path: "/w/a.ts",
    added: 1,
    removed: 0,
    hunks: [{ old_start: 3, new_start: 3, lines: ["+x"] }],
  };
  const steps = pairToolSteps([
    // From the transcript, its payload withheld.
    entry({
      id: "c1",
      tool_name: "Edit",
      source_call_id: "c1",
      text_bytes: 120,
      file_edit: kept,
    }),
    entry({
      id: "r1",
      kind: "tool_result",
      tool_name: "Edit",
      source_call_id: "c1",
      text: "ok",
    }),
    // Streamed in conversation mode, no result yet.
    entry({
      id: "live:c2",
      tool_name: "Write",
      source_call_id: "c2",
      text: JSON.stringify({ file_path: "/w/b.md", content: "hi" }),
    }),
    // Failed.
    entry({
      id: "c3",
      tool_name: "Edit",
      source_call_id: "c3",
      text: JSON.stringify({
        file_path: "/w/c",
        old_string: "a",
        new_string: "b",
      }),
    }),
    entry({
      id: "r3",
      kind: "tool_result",
      tool_name: "Edit",
      source_call_id: "c3",
      text: "String not found",
      is_error: true,
    }),
    entry({
      id: "c4",
      tool_name: "Read",
      source_call_id: "c4",
      text: JSON.stringify({ file_path: "/w/a.ts" }),
    }),
  ]);
  const edits = stepFileEdits(steps);
  expect(
    edits.map(({ call, ...rest }) => ({ ...rest, call: call.id })),
  ).toEqual([
    { id: "c1", edit: kept, pending: false, call: "c1" },
    {
      id: "live:c2",
      edit: {
        path: "/w/b.md",
        added: 1,
        removed: 0,
        hunks: [{ lines: ["+hi"] }],
      },
      pending: true,
      call: "live:c2",
    },
  ]);
});

test("the card: the file and its counts, the first lines, the rest a tap away", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement: h } = await import("react");
  const { ChatFileEdit } = await import("./ChatFileEdit");
  const edit = {
    path: "/w/src/long.ts",
    added: 14,
    removed: 1,
    hunks: [
      {
        old_start: 1,
        new_start: 1,
        lines: ["-old", ...Array.from({ length: 14 }, (_, i) => `+line ${i}`)],
      },
    ],
  };
  const html = renderToStaticMarkup(h(ChatFileEdit, { edit }));
  expect(html).toContain("Edited");
  expect(html).toContain("/w/src/");
  expect(html).toContain("<strong>long.ts</strong>");
  expect(html).toContain("+14");
  expect(html).toContain("-1");
  expect(html.match(/chat-file-edit-line /g)).toHaveLength(10);
  expect(html).toContain("Show 5 more lines");
  expect(
    renderToStaticMarkup(h(ChatFileEdit, { edit, state: "asked" })),
  ).toContain("Change to");
  expect(
    renderToStaticMarkup(
      h(ChatFileEdit, { edit: { ...edit, created: true }, state: "running" }),
    ),
  ).toContain("is-pending");
});
