import { expect, test } from "bun:test";
import {
  conversationCommands,
  conversationRefusal,
  isMcpCommand,
  matchCommands,
} from "./claudeCommands";

const commands = ["clear", "compact", "commit", "codex:rescue", "context"].map(
  (name) => ({ name, description: "" }),
);

test("a command being typed lists the matches, prefix first", () => {
  expect(matchCommands("/co", commands).map((c) => c.name)).toEqual([
    "compact",
    "commit",
    "codex:rescue",
    "context",
  ]);
  expect(matchCommands("/resc", commands).map((c) => c.name)).toEqual([
    "codex:rescue",
  ]);
  expect(matchCommands("/", commands, 2).map((c) => c.name)).toEqual([
    "clear",
    "compact",
  ]);
});

test("anything but a command being typed lists nothing", () => {
  expect(matchCommands("/compact now", commands)).toEqual([]);
  expect(matchCommands("hi /co", commands)).toEqual([]);
  expect(matchCommands("", commands)).toEqual([]);
});

test("conversation mode offers no TUI-only commands", () => {
  const offered = conversationCommands([
    { name: "clear", description: "" },
    { name: "config", description: "" },
    { name: "compact", description: "" },
    { name: "rewind", description: "" },
    { name: "model", description: "" },
    { name: "mcp", description: "" },
    { name: "my-skill", description: "" },
  ]).map((c) => c.name);
  expect(offered).toEqual([
    "clear",
    "compact",
    "rewind",
    "model",
    "mcp",
    "my-skill",
  ]);
});

test("conversation mode refuses TUI-only commands, not shell lines", () => {
  // A `!` line runs, as Claude Code's bash mode does (shellLine).
  expect(conversationRefusal("!ls")).toBeNull();
  expect(conversationRefusal("/config")).toContain("/config");
  expect(conversationRefusal("/compact now")).toBeNull();
  // The chat's own picker, or a switch the bridge makes.
  expect(conversationRefusal("/model")).toBeNull();
  expect(conversationRefusal("/model sonnet")).toBeNull();
  // The chat's own sheet.
  expect(conversationRefusal("/mcp")).toBeNull();
  expect(conversationRefusal("/my-skill do it")).toBeNull();
  expect(conversationRefusal("Hello")).toBeNull();
});

test("/mcp opens the sheet, with or without Claude Code's arguments", () => {
  expect(isMcpCommand("/mcp")).toBe(true);
  expect(isMcpCommand("  /mcp \n")).toBe(true);
  expect(isMcpCommand("/mcp reconnect docs")).toBe(true);
  expect(isMcpCommand("/mcps")).toBe(false);
  expect(isMcpCommand("use /mcp please")).toBe(false);
});
