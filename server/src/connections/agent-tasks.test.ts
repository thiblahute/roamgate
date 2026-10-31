/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import type { AgentTask } from "../agent/session-tasks";
import { readConnectionAgentTasks } from "./agent-tasks";

test("reads side tasks of agents on several connections in one batch", async () => {
  const asked: Record<string, unknown>[] = [];
  const task = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
    id,
    kind: "agent",
    title: `Task ${id}`,
    status: "running",
    startedAt: "2026-10-31T10:00:00Z",
    outputFile: "/tmp/secret-output",
    summary: "long result",
    ...extra,
  });
  const runtime = (tasks: AgentTask[]) => ({
    agentSessions: {
      readTasks: async (params: Record<string, unknown>) => {
        asked.push(params);
        return { session: "s1", tasks };
      },
    },
  });
  const runtimes: Record<string, ReturnType<typeof runtime> | undefined> = {
    local: runtime([task("a"), task("b", { kind: "teammate", name: "rev" })]),
    desktop: runtime([
      task("c", { status: "failed" }),
      task("d", { rewound: true }),
    ]),
  };
  const manager = {
    readyRuntime: (id: string) => runtimes[id] as never,
  };
  const result = await readConnectionAgentTasks(manager, {
    requests: [
      {
        connection_id: "local",
        pane_id: "p1",
        workspace_id: "w1",
        tab_id: "t1",
        agent: "claude",
      },
      { connection_id: "desktop", pane_id: "p2", agent: "claude" },
      { connection_id: "local", pane_id: "p3", agent: "codex" },
      { connection_id: "gone", pane_id: "p4", agent: "claude" },
      { pane_id: "nameless" },
    ],
  });
  expect(result.results).toEqual([
    {
      connection_id: "local",
      pane_id: "p1",
      session: "s1",
      tasks: [
        {
          id: "a",
          kind: "agent",
          title: "Task a",
          status: "running",
          startedAt: "2026-10-31T10:00:00Z",
        },
        {
          id: "b",
          kind: "teammate",
          title: "Task b",
          status: "running",
          name: "rev",
          startedAt: "2026-10-31T10:00:00Z",
        },
      ],
    },
    {
      connection_id: "desktop",
      pane_id: "p2",
      session: "s1",
      tasks: [
        {
          id: "c",
          kind: "agent",
          title: "Task c",
          status: "failed",
          startedAt: "2026-10-31T10:00:00Z",
        },
        {
          id: "d",
          kind: "agent",
          title: "Task d",
          status: "running",
          startedAt: "2026-10-31T10:00:00Z",
          rewound: true,
        },
      ],
    },
    // Only Claude sessions record side tasks: nothing is read for others.
    { connection_id: "local", pane_id: "p3", tasks: [] },
    { connection_id: "gone", pane_id: "p4", error: "connection not ready" },
  ]);
  expect(asked).toEqual([
    { pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "claude" },
    { pane_id: "p2", workspace_id: "", tab_id: "", agent: "claude" },
  ]);
});
