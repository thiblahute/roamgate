import { describe, expect, test } from "bun:test";
import {
  rewindChoices,
  rewindClaude,
  selectedRewindEntry,
  showsMessage,
  type RewindMode,
} from "./claudeRewind";

/** Claude Code's /rewind menu, as drawn in the terminal. */
function fakeClaude(messages: string[], options?: { codeChanges?: boolean }) {
  const entries = [...messages, "(current)"];
  let open: "none" | "picker" | "confirm" = "none";
  let cursor = entries.length - 1;
  const picked: { message?: string; mode?: string; index?: number } = {};
  const labels = [
    ...(options?.codeChanges === false
      ? []
      : ["Restore code and conversation"]),
    "Restore conversation",
    ...(options?.codeChanges === false ? [] : ["Restore code"]),
    "Summarize from here",
    "Never mind",
  ];
  const screen = () => {
    if (open === "picker")
      return [
        "▔▔▔▔",
        "   Rewind",
        "   Restore the code and/or conversation to the point before…",
        ...entries.flatMap((entry, index) => [
          `   ${index === cursor ? "❯" : " "} ${entry.length > 40 ? `${entry.slice(0, 39)}…` : entry}`,
          "     No code changes",
        ]),
        "   Enter to continue · Esc to cancel",
      ];
    if (open === "confirm")
      return [
        "   Rewind",
        "   Confirm you want to restore to the point before you sent this message:",
        `   │ ${entries[cursor]}`,
        ...labels.map(
          (label, index) => `   ${index ? " " : "❯"} ${index + 1}. ${label}`,
        ),
      ];
    return ["❯ ", "  -- INSERT --"];
  };
  return {
    picked,
    io: {
      readScreen: screen,
      command: async (text: string) => {
        if (text === "/rewind") open = "picker";
      },
      send: async (keys: string) => {
        for (const key of keys.match(/\x1b\[[AB]|./gs) ?? []) {
          if (open === "picker") {
            if (key === "\x1b[A") cursor = Math.max(0, cursor - 1);
            else if (key === "\x1b[B")
              cursor = Math.min(entries.length - 1, cursor + 1);
            else if (key === "\r") open = "confirm";
            else if (key === "\x1b") open = "none";
          } else if (open === "confirm") {
            if (/\d/.test(key)) {
              picked.message = entries[cursor];
              picked.index = cursor;
              picked.mode = labels[Number(key) - 1];
              open = "none";
            } else if (key === "\x1b") open = "picker";
          }
        }
      },
      sleep: async () => {},
    },
  };
}

describe("claude rewind", () => {
  test("reads the picker's selected line and its choices", () => {
    const { io } = fakeClaude(["first", "second"]);
    void io.command("/rewind");
    expect(selectedRewindEntry(io.readScreen())).toBe("(current)");
    expect(selectedRewindEntry(["❯ "])).toBeNull();
    expect(
      rewindChoices([
        "Confirm you want to restore to the point before you sent this message:",
        "❯ 1. Restore code and conversation",
        "  2. Restore conversation",
        "↓ 5. Summarize up to here",
      ]),
    ).toEqual(
      new Map([
        ["Restore code and conversation", "1"],
        ["Restore conversation", "2"],
        ["Summarize up to here", "5"],
      ]),
    );
  });

  test("matches a message cut short in the picker", () => {
    expect(
      showsMessage("Write b.txt containing…", "Write b.txt containing beta."),
    ).toBe(true);
    expect(showsMessage("Write b.txt", "Write a.txt")).toBe(false);
    expect(showsMessage("First line", "First line\nsecond line")).toBe(true);
  });

  test.each<[RewindMode, string]>([
    ["both", "Restore code and conversation"],
    ["conversation", "Restore conversation"],
    ["code", "Restore code"],
  ])("rewinds to the message asked (%s)", async (mode, label) => {
    const claude = fakeClaude(["write a.txt", "write b.txt", "third"]);
    await rewindClaude(claude.io, "write b.txt", 1, mode);
    expect(claude.picked).toEqual({
      message: "write b.txt",
      mode: label,
      index: 1,
    });
  });

  test("finds the message when the count is off", async () => {
    // The picker lists a message the chat does not show.
    const claude = fakeClaude(["one", "two", "/model", "three", "four"]);
    await rewindClaude(claude.io, "two", 2, "conversation");
    expect(claude.picked.index).toBe(1);
  });

  test("picks the nearest of messages saying the same", async () => {
    const claude = fakeClaude(["go", "go", "stop"]);
    await rewindClaude(claude.io, "go", 1, "conversation");
    expect(claude.picked.index).toBe(1);
    const entries = claude.io.readScreen();
    expect(entries).toEqual(["❯ ", "  -- INSERT --"]);
  });

  test("stops when the message is not in the menu", async () => {
    const claude = fakeClaude(["one", "two"]);
    await expect(
      rewindClaude(claude.io, "missing", 0, "conversation"),
    ).rejects.toThrow("not found");
    expect(claude.picked).toEqual({});
    expect(selectedRewindEntry(claude.io.readScreen())).toBeNull();
  });

  test("stops when the choice is not offered", async () => {
    const claude = fakeClaude(["one", "two"], { codeChanges: false });
    await expect(rewindClaude(claude.io, "one", 1, "code")).rejects.toThrow(
      'does not offer "Restore code"',
    );
    expect(claude.picked).toEqual({});
  });
});
