import { expect, test } from "bun:test";
import type { AgentPermissionPrompt } from "../../shared/review";
import { withWaitsOn } from "./needsYou";
import type { PaneJumpEntry } from "./paneJump";

const entry = (paneId: string, needsYou?: "blocked" | "done") =>
  ({
    key: paneId,
    paneId,
    paneLabel: paneId,
    workspaceId: "w1",
    title: "repo",
    tabLabel: "Tab 1",
    cwd: "/repo",
    agent: "claude",
    current: false,
    ...(needsYou ? { needsYou, agentStatus: needsYou } : {}),
  }) satisfies PaneJumpEntry;

test("an agent needing the user says what it waits on", () => {
  const prompts = new Map<string, AgentPermissionPrompt[]>([
    [
      "local",
      [
        {
          id: "x",
          connectionId: "local",
          paneId: "p1",
          agent: "Claude",
          tool: "Bash",
          summary: "cargo test",
          canAlways: true,
          createdAt: "",
          expiresAt: "",
        } as AgentPermissionPrompt,
      ],
    ],
  ]);
  const [asking, blocked, done, working] = withWaitsOn(
    [
      entry("p1", "blocked"),
      entry("p2", "blocked"),
      entry("p3", "done"),
      entry("p4"),
    ],
    "local",
    prompts,
  );
  expect(asking?.waitsOn).toBe("Bash: cargo test");
  expect(blocked?.waitsOn).toBe("Asking you something");
  // No chat history in this browser: said plainly.
  expect(done?.waitsOn).toBe("Finished since you last looked");
  expect(working?.waitsOn).toBeUndefined();
});
