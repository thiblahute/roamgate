import { describe, expect, test } from "bun:test";
import {
  looseText,
  messageBlockCount,
  messageBlocks,
} from "./reviewMessageParts";

describe("messageBlocks", () => {
  test("splits a message into the parts one comments on", () => {
    const blocks = messageBlocks(
      "Intro\nsecond\n\n\nPara\n\n1. x\n\n1. y\n\n```rust\nfn a() {}\nfn b() {}\n```\n\n```suggestion:-1+0\nnew\n```",
    );
    expect(blocks).toEqual([
      { kind: "markdown", source: "Intro\nsecond" },
      { kind: "blank", lines: 1 },
      { kind: "markdown", source: "Para" },
      { kind: "markdown", source: "1. x" },
      { kind: "markdown", source: "2. y" },
      { kind: "code", lang: "rust", lines: ["fn a() {}", "fn b() {}"] },
      { kind: "suggestion", range: "-1+0", code: "new" },
    ]);
    expect(messageBlockCount(blocks)).toBe(7);
  });

  test("a nested list item and a table cell are parts of their own", () => {
    const blocks = messageBlocks(
      "- one\n  - one a\n    more\n  1. first\n- [ ] two\n\n| H | I |\n| - | - |\n| a | b |",
    );
    expect(blocks).toEqual([
      { kind: "markdown", source: "- one" },
      { kind: "markdown", source: "- one a\n  more", depth: 1 },
      { kind: "markdown", source: "1. first", depth: 1 },
      { kind: "markdown", source: "- [ ] two" },
      {
        kind: "table",
        header: ["H", "I"],
        rows: [["a", "b"]],
        align: [null, null],
      },
    ]);
    expect(messageBlockCount(blocks)).toBe(8);
  });

  test("compares quotes loosely", () => {
    expect(looseText("  Some\n  Words\t here ")).toBe("some words here");
  });
});
