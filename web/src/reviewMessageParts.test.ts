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

  test("compares quotes loosely", () => {
    expect(looseText("  Some\n  Words\t here ")).toBe("some words here");
  });
});
