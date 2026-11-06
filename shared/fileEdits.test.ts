import { describe, expect, test } from "bun:test";
import {
  fileEditFromArgumentText,
  fileEditFromArguments,
  fileEditFromResult,
  lineDiff,
} from "./fileEdits";

describe("a change's lines", () => {
  test("common lines stay as context, the rest removed then added", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      " a",
      "-b",
      "+B",
      " c",
    ]);
    expect(lineDiff("one\ntwo", "one\ntwo\nthree")).toEqual([
      " one",
      " two",
      "+three",
    ]);
    expect(lineDiff("", "new")).toEqual(["+new"]);
    expect(lineDiff("gone\n", "")).toEqual(["-gone"]);
  });

  test("a kept line in the middle of a change stays context", () => {
    expect(lineDiff("x\nkeep\ny", "X\nkeep\nY")).toEqual([
      "-x",
      "+X",
      " keep",
      "-y",
      "+Y",
    ]);
  });

  test("too long to work out: all out, then all in", () => {
    const before = Array.from({ length: 700 }, (_, i) => `a${i}`).join("\n");
    const lines = lineDiff(before, "b");
    expect(lines).toHaveLength(701);
    expect(lines.at(-1)).toBe("+b");
  });
});

describe("from Claude Code's result", () => {
  test("its patch, numbered, the 'no newline' marker left out", () => {
    expect(
      fileEditFromResult({
        filePath: "/w/a.ts",
        oldString: "b",
        newString: "B",
        structuredPatch: [
          {
            oldStart: 10,
            oldLines: 3,
            newStart: 10,
            newLines: 3,
            lines: [" a", "-b", "+B", " c", "\\ No newline at end of file"],
          },
        ],
      }),
    ).toEqual({
      path: "/w/a.ts",
      added: 1,
      removed: 1,
      hunks: [
        { old_start: 10, new_start: 10, lines: [" a", "-b", "+B", " c"] },
      ],
    });
  });

  test("a new file: its content, created", () => {
    expect(
      fileEditFromResult({
        type: "create",
        filePath: "/w/new.ts",
        content: "one\ntwo\n",
        structuredPatch: [],
      }),
    ).toEqual({
      path: "/w/new.ts",
      created: true,
      added: 2,
      removed: 0,
      hunks: [{ old_start: 0, new_start: 1, lines: ["+one", "+two"] }],
    });
  });

  test("nothing it can say: none", () => {
    expect(
      fileEditFromResult({ filePath: "/w/a", structuredPatch: [] }),
    ).toBeNull();
    expect(fileEditFromResult({ stdout: "x" })).toBeNull();
    expect(fileEditFromResult("ok")).toBeNull();
  });

  test("a long change is cut, its counts whole", () => {
    const edit = fileEditFromResult({
      type: "create",
      filePath: "/w/big.txt",
      content: `${"x\n".repeat(500)}`,
    })!;
    expect(edit.added).toBe(500);
    expect(edit.hunks[0]!.lines).toHaveLength(160);
    expect(edit.truncated).toBe(true);
  });
});

describe("from the call's arguments", () => {
  test("Edit, MultiEdit, Write and NotebookEdit", () => {
    expect(
      fileEditFromArguments("Edit", {
        file_path: "/w/a.ts",
        old_string: "a\nb",
        new_string: "a\nc",
      }),
    ).toEqual({
      path: "/w/a.ts",
      added: 1,
      removed: 1,
      hunks: [{ lines: [" a", "-b", "+c"] }],
    });
    expect(
      fileEditFromArguments("MultiEdit", {
        file_path: "/w/a.ts",
        edits: [
          { old_string: "x", new_string: "y" },
          { old_string: "p", new_string: "q" },
        ],
      })?.hunks,
    ).toEqual([{ lines: ["-x", "+y"] }, { lines: ["-p", "+q"] }]);
    expect(
      fileEditFromArguments("Write", { file_path: "/w/n.md", content: "hi\n" }),
    ).toEqual({
      path: "/w/n.md",
      added: 1,
      removed: 0,
      hunks: [{ lines: ["+hi"] }],
    });
    expect(
      fileEditFromArguments("NotebookEdit", {
        notebook_path: "/w/n.ipynb",
        new_source: "print(1)",
      })?.added,
    ).toBe(1);
  });

  test("another tool, or no file: none", () => {
    expect(fileEditFromArguments("Bash", { command: "ls" })).toBeNull();
    expect(fileEditFromArguments("Edit", { old_string: "a" })).toBeNull();
    expect(fileEditFromArguments(undefined, {})).toBeNull();
  });

  test("arguments as the chat has them, half written or whole", () => {
    expect(
      fileEditFromArgumentText(
        "Write",
        JSON.stringify({ file_path: "/w/x", content: "a" }),
      )?.path,
    ).toBe("/w/x");
    expect(fileEditFromArgumentText("Write", '{"file_path": "/w/')).toBeNull();
    expect(
      fileEditFromArgumentText("Read", '{"file_path": "/w/x"}'),
    ).toBeNull();
  });
});
