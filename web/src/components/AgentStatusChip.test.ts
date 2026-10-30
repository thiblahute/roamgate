import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentStatusChip } from "./AgentStatusChip";

const running = {
  kind: "agent" as const,
  status: "running" as const,
  title: "Explore the server",
};

test("an idle agent with running subagents says so, in its own state", () => {
  const html = renderToStaticMarkup(
    createElement(AgentStatusChip, {
      status: "idle",
      tasks: [running, { ...running, title: "Read the web side" }],
    }),
  );
  expect(html).toContain("<button");
  expect(html).toContain("is-background has-background");
  expect(html).toContain("Idle · 2 subagents running");
  expect(html).toContain("Subagent: Explore the server");
  expect(html).toContain("Subagent: Read the web side");
  expect(html).toContain("Show the background tasks");
});

test("idle with nothing running, or a working turn, keeps Herdr's chip", () => {
  for (const [status, tasks] of [
    ["idle", []],
    [
      "idle",
      [{ ...running, kind: "teammate" as const, status: "completed" as const }],
    ],
    ["working", [running]],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(AgentStatusChip, { status, tasks: [...tasks] }),
    );
    expect(html).toBe(
      `<span class="agent-history-status is-${status}">${status}</span>`,
    );
  }
});

test("a done turn keeps its colour and adds the count", () => {
  const html = renderToStaticMarkup(
    createElement(AgentStatusChip, { status: "done", tasks: [running] }),
  );
  expect(html).toContain("is-done has-background");
  expect(html).toContain("Done · 1 subagent running");
});
