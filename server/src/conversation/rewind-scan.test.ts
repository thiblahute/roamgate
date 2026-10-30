import { describe, expect, test } from "bun:test";
import { scanRewind } from "./rewind-scan";

const lines = (...records: Record<string, unknown>[]) =>
  records.map((record) => JSON.stringify(record)).join("\n");
const prompt = (uuid: string, parentUuid: string | null) => ({
  type: "user",
  uuid,
  parentUuid,
  message: { role: "user", content: `message ${uuid}` },
});
const tool = (
  uuid: string,
  parentUuid: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "doing it" },
      { type: "tool_use", id: `t-${uuid}`, name, input },
    ],
  },
});

describe("scanRewind", () => {
  test("the files Claude's file tools edited after the message, once each", () => {
    const transcript = lines(
      prompt("u1", null),
      tool("a1", "u1", "Bash", { command: "touch x" }),
      prompt("u2", "a1"),
      tool("a2", "u2", "Edit", { file_path: "/w/a.ts" }),
      tool("a3", "a2", "NotebookEdit", { notebook_path: "/w/n.ipynb" }),
      tool("a4", "a3", "Write", { file_path: "/w/a.ts" }),
      tool("a5", "a4", "Read", { file_path: "/w/r.ts" }),
    );
    expect(scanRewind(transcript, "u1")).toEqual({
      found: true,
      edited: ["/w/a.ts", "/w/n.ipynb"],
      checkpoint: false,
    });
    expect(scanRewind(`${transcript}\n{"half`, "u2").edited).toEqual([
      "/w/a.ts",
      "/w/n.ipynb",
    ]);
  });

  test("commands only: nothing edited", () => {
    const transcript = lines(
      prompt("u1", null),
      tool("a1", "u1", "Bash", { command: "sed -i s/a/b/ f" }),
    );
    expect(scanRewind(transcript, "u1")).toEqual({
      found: true,
      edited: [],
      checkpoint: false,
    });
  });

  test("the checkpoint Claude Code took for the message", () => {
    const transcript = lines(
      prompt("u1", null),
      {
        type: "file-history-snapshot",
        messageId: "u1",
        snapshot: { messageId: "u1", trackedFileBackups: {} },
      },
      tool("a1", "u1", "Edit", { file_path: "/w/a.ts" }),
    );
    expect(scanRewind(transcript, "u1").checkpoint).toBe(true);
  });

  test("turns a rewind left behind do not count", () => {
    const transcript = lines(
      prompt("u1", null),
      tool("a1", "u1", "Bash", { command: "ls" }),
      prompt("u2", "a1"),
      tool("a2", "u2", "Edit", { file_path: "/w/gone.ts" }),
      // Rewound to before u2: the next message hangs from a1.
      prompt("u3", "a1"),
      tool("a3", "u3", "Bash", { command: "ls" }),
    );
    expect(scanRewind(transcript, "u1").edited).toEqual([]);
    expect(scanRewind(transcript, "u2").found).toBe(false);
  });
});
