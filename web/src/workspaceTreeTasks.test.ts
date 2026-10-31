import { describe, expect, test } from "bun:test";
import type { Pane } from "./types";
import {
  agentTasksReadDue,
  agentTaskVersion,
  TREE_TASKS_ACTIVITY_MS,
} from "./workspaceTreeTasks";

const pane = (overrides: Partial<Pane> = {}) =>
  ({
    pane_id: "p1",
    workspace_id: "w1",
    tab_id: "t1",
    terminal_id: "term1",
    agent: "claude",
    agent_status: "working",
    state_change_seq: 3,
    last_activity_at: 1000,
    ...overrides,
  }) as Pane;

describe("Workspaces list side tasks", () => {
  test("a new agent or a change of state is read at once", () => {
    const now = 1_000_000;
    expect(agentTasksReadDue(undefined, agentTaskVersion(pane()), now)).toBe(
      now,
    );
    const last = { version: agentTaskVersion(pane()), at: now - 1000 };
    expect(
      agentTasksReadDue(
        last,
        agentTaskVersion(pane({ agent_status: "idle" })),
        now,
      ),
    ).toBe(now);
    expect(
      agentTasksReadDue(
        last,
        agentTaskVersion(pane({ state_change_seq: 4 })),
        now,
      ),
    ).toBe(now);
  });

  test("activity alone is read again at most every so often", () => {
    const now = 1_000_000;
    const last = { version: agentTaskVersion(pane()), at: now - 1000 };
    const busier = agentTaskVersion(pane({ last_activity_at: 1005 }));
    expect(agentTasksReadDue(last, busier, now)).toBe(
      last.at + TREE_TASKS_ACTIVITY_MS,
    );
    const old = { ...last, at: now - TREE_TASKS_ACTIVITY_MS * 2 };
    expect(agentTasksReadDue(old, busier, now)).toBe(now);
  });
});
