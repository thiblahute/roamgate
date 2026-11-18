import { afterEach, expect, test } from "bun:test";
import { clearLocalSeen, recordLocalSeen, withLocalSeen } from "./localSeen";
import type { Pane } from "./types";

afterEach(clearLocalSeen);

const pane = (
  id: string,
  status: string,
  seq?: number,
  seenAt?: number,
): Pane => ({
  pane_id: id,
  terminal_id: `t-${id}`,
  workspace_id: "w1",
  tab_id: "t1",
  focused: false,
  agent: "claude",
  agent_status: status,
  revision: 1,
  ...(seq === undefined ? {} : { state_change_seq: seq }),
  ...(seenAt === undefined ? {} : { seen_at: seenAt }),
});

test("a look shows at once: seen now, and Done gone in the state seen", () => {
  const panes = [
    pane("a", "done", 4, 100),
    pane("b", "done", 7),
    pane("c", "working"),
  ];
  expect(withLocalSeen("desk", panes, 1_000)).toBe(panes);
  recordLocalSeen("desk", "a", "t-a", 4, 1_000);
  recordLocalSeen("desk", "b", "t-b", undefined, 1_000);
  const shown = withLocalSeen("desk", panes, 1_001);
  expect(shown.map((each) => [each.agent_status, each.seen_at])).toEqual([
    ["idle", 1_000],
    // Looked at, but not in a finished state: still Done.
    ["done", 1_000],
    ["working", undefined],
  ]);
  // Another connection's panes of the same ids are not these.
  expect(withLocalSeen("mac", panes, 1_001)).toBe(panes);
});

test("a list read before the look landed does not bring Done back, a later turn does", () => {
  recordLocalSeen("desk", "a", "t-a", 4, 1_000);
  // A look as the agent leaves the screen keeps the state seen before.
  recordLocalSeen("desk", "a", "t-a", undefined, 2_000);
  const stale = [pane("a", "done", 4, 500)];
  expect(withLocalSeen("desk", stale, 2_500)[0]).toMatchObject({
    agent_status: "idle",
    seen_at: 2_000,
  });
  // The server's later look wins; a new turn finished since is Done.
  expect(
    withLocalSeen("desk", [pane("a", "done", 6, 3_000)], 3_100)[0],
  ).toMatchObject({
    agent_status: "done",
    seen_at: 3_000,
  });
  // Another terminal in the same pane is another agent.
  const replaced = [{ ...pane("a", "done", 4), terminal_id: "t-other" }];
  expect(withLocalSeen("desk", replaced, 2_500)).toBe(replaced);
});

test("looks are forgotten once the server has long had them", () => {
  recordLocalSeen("desk", "a", "t-a", 4, 1_000);
  const panes = [pane("a", "done", 4)];
  expect(withLocalSeen("desk", panes, 1_000 + 31_000)).toBe(panes);
  expect(withLocalSeen("desk", panes, 1_001)).toBe(panes);
});
