import { describe, expect, test } from "bun:test";
import { emptyServerSessionState, type State } from "./store";
import type { Pane } from "./types";
import { voiceSessions } from "./voiceRoute";

describe("the sessions a call can name", () => {
  const pane = (pane_id: string, workspace_id: string, cwd: string) =>
    ({
      pane_id,
      workspace_id,
      tab_id: `${workspace_id}:t1`,
      terminal_id: `term-${pane_id}`,
      agent: "claude",
      agent_status: "working",
      cwd,
      terminal_title_stripped: "",
    }) as unknown as Pane;
  const workspace = (workspace_id: string, label: string) =>
    ({ workspace_id, label, number: 1 }) as never;
  // The Mac is the connection "local" here, this machine "desktop".
  const state = (others: State["sessionsByConnectionId"] = {}) =>
    ({
      activeConnectionId: "desktop",
      connections: [
        { id: "desktop", label: "desktop", generation: 1, state: "ready" },
        { id: "local", label: "mac", generation: 4, state: "ready" },
      ],
      workspaces: [workspace("w1", "roamgate")],
      panes: [pane("w1:p1", "w1", "/var/home/me/roamgate")],
      sessionsByConnectionId: {
        desktop: emptyServerSessionState(1),
        local: emptyServerSessionState(4),
        ...others,
      },
    }) as unknown as State;
  const mac = {
    connection_id: "local",
    connection_generation: 4,
    workspaces: [workspace("w14", "matrix-mcp")],
    tabs: [],
    panes: [pane("w14:p1", "w14", "/Users/me/devel/misc/matrix-mcp")],
    agents: null,
  };

  test("lists another connection's sessions the page never read", () => {
    // "Show all connections" off: the page holds no topology for the Mac.
    const sessions = voiceSessions(state(), [mac]);
    expect(sessions.map((session) => session.id)).toEqual([
      "desktop/w1:p1",
      "local/w14:p1",
    ]);
    expect(sessions[1]).toMatchObject({
      machine: "mac",
      workspace: "matrix-mcp",
      folder: "/Users/me/devel/misc/matrix-mcp",
      agent: "claude",
    });
  });

  test("takes the topology the page read over the summary", () => {
    const read = {
      ...emptyServerSessionState(4),
      lastRefresh: 1,
      workspaces: [workspace("w15", "other")],
      panes: [pane("w15:p1", "w15", "/Users/me/other")],
    };
    expect(
      voiceSessions(state({ local: read }), [mac]).map((session) => session.id),
    ).toEqual(["desktop/w1:p1", "local/w15:p1"]);
  });

  test("skips a summary of an older runtime of the connection", () => {
    expect(
      voiceSessions(state(), [{ ...mac, connection_generation: 3 }]).map(
        (session) => session.id,
      ),
    ).toEqual(["desktop/w1:p1"]);
  });
});
