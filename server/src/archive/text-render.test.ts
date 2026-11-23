import { describe, expect, test } from "bun:test";
import { ADAPTERS } from "./adapters";
import {
  FOLD,
  headerLine,
  parseTextLine,
  suffixedPath,
  TextRenderer,
  textPath,
} from "./text-render";

const options = { toolCallChars: 20, thinking: false };

function claudeLine(record: object): Buffer {
  return Buffer.from(JSON.stringify(record));
}

describe("TextRenderer", () => {
  test("one line per message, tool calls cut, tool output left out", () => {
    const renderer = new TextRenderer(ADAPTERS.claude!, false, options);
    renderer.line(
      claudeLine({
        type: "user",
        timestamp: "2026-11-14T10:00:00.000Z",
        cwd: "/home/u/proj",
        message: { role: "user", content: "first line\nsecond line" },
      }),
    );
    renderer.line(
      claudeLine({
        type: "assistant",
        timestamp: "2026-11-14T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running it" },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "x".repeat(100) },
            },
          ],
        },
      }),
    );
    renderer.line(
      claudeLine({
        type: "user",
        timestamp: "2026-11-14T10:00:06.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "secret output" }],
        },
      }),
    );
    renderer.line(Buffer.from("not json"));
    expect(renderer.lines).toEqual([
      `2026-11-14T10:00:00 user text: first line${FOLD}second line`,
      "2026-11-14T10:00:05 assistant text: running it",
      `2026-11-14T10:00:05 assistant tool_use Bash: ${"x".repeat(20)}`,
    ]);
    expect(renderer.save().cwd).toBe("/home/u/proj");
  });

  test("resumes from a saved state: titles and timestamps carry over", () => {
    const first = new TextRenderer(ADAPTERS.claude!, false, options);
    first.line(claudeLine({ type: "ai-title", aiTitle: "A title" }));
    first.line(
      claudeLine({
        type: "user",
        timestamp: "2026-11-14T10:00:00Z",
        message: { content: "hello" },
      }),
    );
    const second = new TextRenderer(
      ADAPTERS.claude!,
      false,
      options,
      first.save(),
    );
    second.line(claudeLine({ type: "ai-title", aiTitle: "A title" }));
    second.line(claudeLine({ type: "ai-title", aiTitle: "New title" }));
    expect(second.lines).toEqual(["2026-11-14T10:00:00 meta title: New title"]);
    expect(second.save().firstTs).toBe("2026-11-14T10:00:00");
  });

  test("the day is fixed at the first line: undated when no time came first", () => {
    const renderer = new TextRenderer(ADAPTERS.claude!, false, options);
    renderer.line(claudeLine({ type: "result", result: { found: "x" } }));
    renderer.line(
      claudeLine({
        type: "user",
        timestamp: "2026-11-14T10:00:00Z",
        message: { content: "later" },
      }),
    );
    expect(renderer.save().day).toBe("undated");
    const dated = new TextRenderer(ADAPTERS.claude!, false, options);
    dated.line(claudeLine({ type: "ai-title", aiTitle: "T", timestamp: "x" }));
    expect(dated.save().day).toBe("undated");
  });

  test("prompt history lines carry the project as a token", () => {
    const renderer = new TextRenderer(ADAPTERS.claude!, true, options);
    renderer.line(
      Buffer.from(
        JSON.stringify({
          display: "fix the build",
          timestamp: Date.parse("2026-11-14T10:00:00Z"),
          project: "/home/u/my proj",
        }),
      ),
    );
    expect(renderer.lines).toEqual([
      "2026-11-14T10:00:00 user prompt /home/u/my_proj: fix the build",
    ]);
  });

  test("secrets are redacted and counted", () => {
    const renderer = new TextRenderer(ADAPTERS.claude!, false, options);
    renderer.line(
      claudeLine({
        type: "user",
        timestamp: "2026-11-14T10:00:00Z",
        message: { content: "use glpat-abcdefghij1234567890" },
      }),
    );
    expect(renderer.lines[0]).toBe(
      "2026-11-14T10:00:00 user text: use [secret]",
    );
    expect(renderer.redactions).toBe(1);
  });
});

describe("paths and lines", () => {
  const subject = {
    host: "desk",
    agent: "claude",
    relpath: "-home-u-proj/abc.jsonl",
    history: false,
    project: "-home-u-proj",
    session: "abc",
    subagent: false,
  };

  test("host/agent/project/day/session.md, dated by the first message", () => {
    expect(textPath(subject, {})).toBeNull();
    expect(textPath(subject, { day: "2026-11-14" })).toBe(
      "desk/claude/-home-u-proj/2026/11/14/abc.md",
    );
    expect(
      textPath(
        {
          ...subject,
          relpath: "-home-u-proj/abc/subagents/agent-1.jsonl",
          subagent: true,
        },
        { day: "2026-11-14" },
      ),
    ).toBe("desk/claude/-home-u-proj/2026/11/14/abc.agent-1.md");
    expect(textPath(subject, { day: "undated" })).toBe(
      "desk/claude/-home-u-proj/undated/abc.md",
    );
    expect(
      textPath({ ...subject, relpath: "@history.jsonl", history: true }, {}),
    ).toBe("desk/@history/claude/history.md");
  });

  test("the collision suffix is the raw path's sha256", () => {
    const a = suffixedPath("x/y.md", "desk/claude/p/a.jsonl");
    expect(a).toMatch(/^x\/y\.[0-9a-f]{8}\.md$/);
    expect(suffixedPath("x/y.md", "desk/claude/p/a.jsonl")).toBe(a);
    expect(suffixedPath("x/y.md", "desk/claude/p/b.jsonl")).not.toBe(a);
  });

  test("lines parse back, colons in the text included", () => {
    expect(parseTextLine("# desk/claude/x cwd=/a")).toBeNull();
    expect(parseTextLine("2026-11-14T10:00:00 user text: a: b")).toEqual({
      ts: "2026-11-14T10:00:00",
      role: "user",
      kind: "text",
      tool: null,
      text: "a: b",
    });
    expect(parseTextLine("- assistant tool_use Bash: ls -la: x")?.tool).toBe(
      "Bash",
    );
    expect(headerLine("desk/claude/x", { cwd: "/a" })).toBe(
      "# desk/claude/x cwd=/a",
    );
  });
});
