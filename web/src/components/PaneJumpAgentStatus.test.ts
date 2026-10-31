import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { backgroundWork } from "../agentBackground";
import { PaneJumpStatusDot, PaneJumpStatusLabel } from "./PaneJumpAgentStatus";

const entry = { agent: "claude", agentStatus: "idle", paneId: "p1" };
const work = backgroundWork([
  { kind: "agent" as const, status: "running" as const, title: "Explore" },
]);

test("the switcher shows an idle agent with work running as background", () => {
  expect(
    renderToStaticMarkup(
      createElement(PaneJumpStatusDot, { entry, background: work }),
    ),
  ).toContain('class="pane-jump-status status-background"');
  const label = renderToStaticMarkup(
    createElement(PaneJumpStatusLabel, { entry, background: work }),
  );
  expect(label).toContain("badge badge-background pane-jump-agent-status");
  expect(label).toContain("Idle · 1 running");
  expect(label).toContain("Subagent: Explore");
});

test("without background work the switcher keeps Herdr's status", () => {
  expect(
    renderToStaticMarkup(
      createElement(PaneJumpStatusDot, { entry, background: null }),
    ),
  ).toBe('<span class="pane-jump-status status-idle"></span>');
  expect(
    renderToStaticMarkup(
      createElement(PaneJumpStatusLabel, { entry, background: null }),
    ),
  ).toBe('<span class="badge badge-idle pane-jump-agent-status">idle</span>');
});
