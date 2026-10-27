import { describe, expect, test } from "bun:test";
import { withoutRewoundTurns } from "./session-rewind";

const prompt = (uuid: string, parentUuid: string | null, text: string) => ({
  type: "user",
  uuid,
  parentUuid,
  message: { role: "user", content: text },
});
const reply = (uuid: string, parentUuid: string, text: string) => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolUse = (uuid: string, parentUuid: string, id: string) => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Bash", input: {} }],
  },
});
const toolResult = (uuid: string, parentUuid: string, id: string) => ({
  type: "user",
  uuid,
  parentUuid,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  },
});
const ids = (records: Record<string, unknown>[]) =>
  records.map((record) => record.uuid);

describe("withoutRewoundTurns", () => {
  test("drops the turns a rewind went back before", () => {
    const records = [
      prompt("u1", null, "write a.txt"),
      reply("a1", "u1", "done"),
      prompt("u2", "a1", "write b.txt"),
      toolUse("t2", "u2", "call-2"),
      toolResult("r2", "t2", "call-2"),
      reply("a2", "r2", "done"),
      prompt("u3", "a2", "third"),
      reply("a3", "u3", "third"),
      { type: "last-prompt", leafUuid: "a3" },
      // Rewound to before "write b.txt", then sent this.
      prompt("u4", "a1", "gamma"),
      reply("a4", "u4", "gamma"),
    ];
    expect(ids(withoutRewoundTurns(records))).toEqual([
      "u1",
      "a1",
      undefined,
      "u4",
      "a4",
    ]);
  });

  test("keeps the results of tool calls run side by side", () => {
    const records = [
      prompt("u1", null, "look"),
      toolUse("t1", "u1", "call-1"),
      toolUse("t2", "t1", "call-2"),
      toolResult("r1", "t1", "call-1"),
      toolResult("r2", "t2", "call-2"),
      reply("a1", "r2", "seen"),
      prompt("u2", "a1", "next"),
    ];
    expect(withoutRewoundTurns(records)).toBe(records);
  });

  test("leaves what came before a compaction", () => {
    const records = [
      prompt("u1", null, "first"),
      reply("a1", "u1", "one"),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "c1",
        parentUuid: null,
        logicalParentUuid: "a1",
      },
      prompt("u2", "c1", "after"),
    ];
    expect(withoutRewoundTurns(records)).toBe(records);
  });
});
