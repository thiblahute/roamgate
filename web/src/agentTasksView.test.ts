import { describe, expect, test } from "bun:test";
import {
  agentElapsedMs,
  agentKey,
  agentQuietMs,
  agentsProgress,
  followTarget,
  formatDuration,
  isPhaseCollapsed,
  nextKeyWhere,
  reconcileKey,
  sheetCommand,
  shownKey,
  stepKey,
  type WorkflowAgentView,
  workflowProgress,
  workflowRows,
} from "./agentTasksView";

const agent = (
  agentId: string,
  state: WorkflowAgentView["state"],
  more: Partial<WorkflowAgentView> = {},
): WorkflowAgentView => ({ agentId, label: agentId, state, ...more });

const workflow = {
  phases: [
    { title: "Investigate", agents: [agent("a", "done"), agent("b", "done")] },
    {
      title: "Build",
      agents: [
        agent("c", "done"),
        agent("d", "running", { startedAt: 10, lastActiveAt: 50 }),
        agent("e", "running", { startedAt: 20, lastActiveAt: 90 }),
      ],
    },
    { title: "Check", agents: [agent("f", "failed")] },
  ],
};

describe("progress", () => {
  test("counts a phase's agents and says what it is doing", () => {
    expect(agentsProgress(workflow.phases[1]!.agents)).toEqual({
      total: 3,
      done: 1,
      running: 2,
      failed: 0,
      state: "running",
    });
    expect(agentsProgress(workflow.phases[0]!.agents).state).toBe("done");
    expect(agentsProgress(workflow.phases[2]!.agents).state).toBe("failed");
    expect(agentsProgress([]).state).toBe("waiting");
  });

  test("a workflow's totals and its active phase", () => {
    expect(workflowProgress(workflow)).toMatchObject({
      total: 6,
      done: 3,
      running: 2,
      failed: 1,
      activePhase: 1,
    });
    expect(
      workflowProgress({ phases: [workflow.phases[0]!] }).activePhase,
    ).toBe(-1);
  });
});

describe("rows", () => {
  test("done phases fold away, unless they are the last", () => {
    const none = new Map<string, boolean>();
    expect(isPhaseCollapsed(workflow, 0, none)).toBe(true);
    expect(isPhaseCollapsed(workflow, 1, none)).toBe(false);
    expect(isPhaseCollapsed(workflow, 2, none)).toBe(false);
    expect(isPhaseCollapsed({ phases: [workflow.phases[0]!] }, 0, none)).toBe(
      false,
    );
    expect(workflowRows(workflow, none).map((row) => row.key)).toEqual([
      "phase:Investigate",
      "phase:Build",
      "agent:c",
      "agent:d",
      "agent:e",
      "phase:Check",
      "agent:f",
    ]);
  });

  test("the reader's folding wins", () => {
    const overrides = new Map([
      ["phase:Investigate", false],
      ["phase:Build", true],
    ]);
    expect(workflowRows(workflow, overrides).map((row) => row.key)).toEqual([
      "phase:Investigate",
      "agent:a",
      "agent:b",
      "phase:Build",
      "phase:Check",
      "agent:f",
    ]);
  });

  test("a single unnamed phase has no header", () => {
    const rows = workflowRows(
      { phases: [{ title: "", agents: [agent("a", "running")] }] },
      new Map(),
    );
    expect(rows.map((row) => row.key)).toEqual(["agent:a"]);
  });

  test("a folded agent shows as its phase", () => {
    const rows = workflowRows(workflow, new Map());
    expect(shownKey(workflow, rows, "agent:a")).toBe("phase:Investigate");
    expect(shownKey(workflow, rows, "agent:d")).toBe("agent:d");
  });
});

describe("cursor", () => {
  const keys = ["a", "b", "c"];

  test("moves and stays in the list", () => {
    expect(stepKey(keys, "a", 1)).toBe("b");
    expect(stepKey(keys, "c", 1)).toBe("c");
    expect(stepKey(keys, "a", -1)).toBe("a");
    expect(stepKey(keys, null, 1)).toBe("a");
    expect(stepKey(keys, null, -1)).toBe("c");
    expect(stepKey(keys, "b", 10)).toBe("c");
    expect(stepKey([], "a", 1)).toBeNull();
  });

  test("finds the next match, wrapping around", () => {
    const items = [
      { key: "a", on: true },
      { key: "b", on: false },
      { key: "c", on: true },
    ];
    const next = (current: string | null, direction: 1 | -1) =>
      nextKeyWhere(
        items,
        (item) => item.key,
        current,
        direction,
        (item) => item.on,
      );
    expect(next("a", 1)).toBe("c");
    expect(next("c", 1)).toBe("a");
    expect(next("a", -1)).toBe("c");
    expect(next("b", -1)).toBe("a");
    expect(next(null, 1)).toBe("a");
    expect(
      nextKeyWhere(
        items,
        (item) => item.key,
        "a",
        1,
        (item) => item.key === "a",
      ),
    ).toBeNull();
  });

  test("keeps its row when the list changes, or its place", () => {
    expect(reconcileKey(keys, ["x", "b", "c"], "b")).toBe("b");
    expect(reconcileKey(keys, ["a", "c"], "b")).toBe("c");
    expect(reconcileKey(keys, ["a"], "c")).toBe("a");
    expect(reconcileKey(keys, ["a", "c"], "b", "a")).toBe("a");
    expect(reconcileKey(keys, [], "b")).toBeNull();
    expect(reconcileKey([], keys, null)).toBe("a");
  });
});

describe("follow", () => {
  test("goes to the running agent active last, and stays on it", () => {
    expect(followTarget(workflow, null)).toBe(agentKey("e"));
    expect(followTarget(workflow, "agent:d")).toBe("agent:d");
    expect(followTarget(workflow, "agent:c")).toBe("agent:e");
  });

  test("without times, the last started", () => {
    const view = {
      phases: [
        { title: "", agents: [agent("a", "running"), agent("b", "running")] },
      ],
    };
    expect(followTarget(view, null)).toBe("agent:b");
  });

  test("nothing to follow once nothing runs", () => {
    expect(followTarget({ phases: [workflow.phases[0]!] }, "agent:a")).toBe(
      null,
    );
  });
});

describe("times", () => {
  test("durations read at a glance", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(42 * 60_000)).toBe("42m");
    expect(formatDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatDuration(-5)).toBe("0s");
  });

  test("an agent's elapsed time, and how long a running one is quiet", () => {
    expect(agentElapsedMs(agent("a", "done", { durationMs: 5000 }), 0)).toBe(
      5000,
    );
    expect(
      agentElapsedMs(agent("a", "running", { startedAt: 1000 }), 4000),
    ).toBe(3000);
    expect(agentElapsedMs(agent("a", "done", { startedAt: 1000 }), 4000)).toBe(
      undefined,
    );
    const quiet = agent("a", "running", { lastActiveAt: 0 });
    expect(agentQuietMs(quiet, 30_000)).toBeUndefined();
    expect(agentQuietMs(quiet, 90_000)).toBe(90_000);
    expect(agentQuietMs(agent("a", "done", { lastActiveAt: 0 }), 90_000)).toBe(
      undefined,
    );
  });
});

test("keys the sheet takes, and those it leaves", () => {
  expect(sheetCommand({ key: "j" })).toBe("down");
  expect(sheetCommand({ key: "ArrowUp" })).toBe("up");
  expect(sheetCommand({ key: "G" })).toBe("last");
  expect(sheetCommand({ key: "Escape" })).toBe("back");
  expect(sheetCommand({ key: "Backspace" })).toBe("back");
  expect(sheetCommand({ key: " ", shiftKey: true })).toBe("pageUp");
  expect(sheetCommand({ key: "E" })).toBe("previousFailed");
  expect(sheetCommand({ key: "?" })).toBe("help");
  expect(sheetCommand({ key: "j", ctrlKey: true })).toBeNull();
  expect(sheetCommand({ key: "k", metaKey: true })).toBeNull();
  expect(sheetCommand({ key: "x" })).toBeNull();
});
