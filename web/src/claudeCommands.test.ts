import { expect, test } from "bun:test";
import {
  conversationCommands,
  conversationRefusal,
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
    { name: "my-skill", description: "" },
  ]).map((c) => c.name);
  expect(offered).toEqual(["clear", "compact", "rewind", "my-skill"]);
});

test("conversation mode refuses shell lines and TUI-only commands", () => {
  expect(conversationRefusal("!ls")).toContain("terminal");
  expect(conversationRefusal("/config")).toContain("/config");
  expect(conversationRefusal("/compact now")).toBeNull();
  expect(conversationRefusal("/my-skill do it")).toBeNull();
  expect(conversationRefusal("Hello")).toBeNull();
});
