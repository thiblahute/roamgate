import { describe, expect, test } from "bun:test";
import {
  type AgentTaskSummary,
  agentSummary,
  dropZone,
  subtreeSummary,
  summaryLabel,
  treeTaskLineLabel,
  treeTaskRows,
} from "./workspaceTreeView";

describe("what a parent row sums up", () => {
  type Item = {
    id: string;
    children?: Item[];
    agents?: {
      pane_id: string;
      agent_status: string;
      attention_note?: string;
    }[];
  };
  const options = (running: Record<string, number> = {}) => ({
    key: (item: Item) => item.id,
    children: (item: Item) => item.children ?? [],
    agents: (item: Item) => item.agents ?? [],
    runningSubagents: (agent: { pane_id: string }) =>
      running[agent.pane_id] ?? 0,
  });

  test("counts working and waiting agents across the whole subtree", () => {
    const ocio: Item = {
      id: "ocio",
      agents: [{ pane_id: "p0", agent_status: "working" }],
      children: [
        {
          id: "upstreaming",
          children: [
            {
              id: "up-colorspace",
              agents: [
                { pane_id: "p1", agent_status: "blocked" },
                { pane_id: "p2", agent_status: "idle" },
              ],
            },
            {
              id: "up-ocio",
              agents: [
                { pane_id: "p3", agent_status: "done" },
                { pane_id: "p4", agent_status: "working" },
                {
                  pane_id: "p5",
                  agent_status: "idle",
                  attention_note: "merge?",
                },
              ],
            },
          ],
        },
      ],
    };
    const summary = subtreeSummary(ocio, options({ p0: 2, p4: 3 }));
    expect(summary).toEqual({
      working: 2,
      background: 0,
      waiting: 3,
      blocked: 1,
      subagents: 5,
    });
    expect(summaryLabel(summary)).toBe(
      "2 working · 3 waiting on you (1 asking) · 5 subagents running",
    );
  });

  test("a structure that loops is counted once", () => {
    const a: Item = {
      id: "a",
      agents: [{ pane_id: "p", agent_status: "working" }],
    };
    a.children = [a];
    expect(subtreeSummary(a, options()).working).toBe(1);
  });

  test("an idle agent is neither working nor waiting", () => {
    expect(agentSummary({ agent_status: "idle" })).toEqual({
      working: 0,
      background: 0,
      waiting: 0,
      blocked: 0,
      subagents: 0,
    });
  });

  test("an idle agent whose side tasks run counts in the background, apart", () => {
    const item: Item = {
      id: "w",
      agents: [
        { pane_id: "idle-bg", agent_status: "idle" },
        { pane_id: "idle", agent_status: "idle" },
        { pane_id: "working-bg", agent_status: "working" },
        { pane_id: "done-bg", agent_status: "done" },
      ],
    };
    const running: Record<string, number> = {
      "idle-bg": 2,
      "working-bg": 1,
      "done-bg": 1,
    };
    const summary = subtreeSummary(item, {
      ...options(),
      backgroundRunning: (agent) => running[agent.pane_id] ?? 0,
    });
    // Working stays working, done stays waiting on the user.
    expect(summary).toEqual({
      working: 1,
      background: 1,
      waiting: 1,
      blocked: 0,
      subagents: 0,
    });
    expect(summaryLabel(summary)).toBe(
      "1 working · 1 idle, running in the background · 1 waiting on you",
    );
    expect(
      agentSummary({ agent_status: "idle" }, 0).background +
        agentSummary({ agent_status: "idle" }, 3).background,
    ).toBe(1);
  });
});

describe("which subagents stay in the tree", () => {
  const task = (
    id: string,
    kind: AgentTaskSummary["kind"],
    status: AgentTaskSummary["status"],
  ): AgentTaskSummary => ({ id, kind, title: id, status });

  test("running ones, live teammates and unseen failures stay; finished ones go", () => {
    const tasks = [
      task("running-agent", "agent", "running"),
      task("running-workflow", "workflow", "running"),
      task("idle-teammate", "teammate", "completed"),
      task("busy-teammate", "teammate", "running"),
      task("stopped-teammate", "teammate", "stopped"),
      task("failed-agent", "agent", "failed"),
      task("seen-failure", "workflow", "failed"),
      task("done-agent", "agent", "completed"),
      task("done-workflow", "workflow", "completed"),
      task("stopped-agent", "agent", "stopped"),
      task("lost-agent", "agent", "lost"),
      task("build", "command", "running"),
      task("watch", "monitor", "running"),
    ];
    const { rows, running, done } = treeTaskRows(
      tasks,
      (each) => each.id === "seen-failure",
    );
    expect(rows.map((row) => [row.task.id, row.state])).toEqual([
      ["running-agent", "running"],
      ["running-workflow", "running"],
      ["idle-teammate", "idle"],
      ["busy-teammate", "running"],
      ["failed-agent", "failed"],
    ]);
    expect(running).toBe(3);
    // Commands and monitors are not counted: they stay in the Tasks sheet.
    expect(done).toBe(6);
    expect(treeTaskLineLabel(rows)).toBe("5 subagents · 3 running · 1 failed");
  });

  test("when all of an agent's subagents are finished, nothing stays", () => {
    const { rows, done } = treeTaskRows(
      [task("a", "agent", "completed"), task("b", "workflow", "stopped")],
      () => false,
    );
    expect(rows).toEqual([]);
    expect(done).toBe(2);
  });
});

describe("where a drop lands", () => {
  test("a row's top and bottom quarters order, its middle nests", () => {
    expect(dropZone(2, 24)).toBe("before");
    expect(dropZone(12, 24)).toBe("into");
    expect(dropZone(22, 24)).toBe("after");
    expect(dropZone(10, 24, false)).toBe("before");
    expect(dropZone(14, 24, false)).toBe("after");
  });
});
