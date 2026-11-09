import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolProgress } from "./AgentHistoryChat";
import type { ToolStep } from "./agentHistoryView";

const step = (id: string, summary: string, done: boolean): ToolStep => ({
  id,
  name: "Bash",
  call: {
    id,
    role: "tool",
    kind: "tool_call",
    text: "",
    text_bytes: 10,
    summary,
    sent_at: "2026-01-01T00:00:00Z",
  },
  ...(done
    ? {
        result: {
          id: `${id}r`,
          role: "tool" as const,
          kind: "tool_result" as const,
          text: "",
          sent_at: "2026-01-01T00:00:00Z",
        },
      }
    : {}),
});

test("the collapsed progress shows running and recent steps with their summaries", () => {
  const html = renderToStaticMarkup(
    <ToolProgress
      steps={[
        step("a", "First", true),
        step("b", "Second", true),
        step("c", "Third", true),
        step("d", "Fourth", true),
        step("e", "Run the tests", false),
      ]}
    />,
  );
  expect(html).toContain("+1 earlier");
  expect(html).not.toContain("First");
  expect(html).toContain("Fourth");
  expect(html).toContain("Run the tests");
  expect(html).toContain("is-pending");
});
