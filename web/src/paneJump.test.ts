import { describe, expect, test } from "bun:test";
import type { ConnectionSummary } from "./api";
import type { ConnectionSessionView } from "./connectionSessions";
import {
  activePaneIdForSnapshot,
  paneCanClose,
  paneJumpConnectionTarget,
  paneJumpDefaultIndex,
  paneJumpEntries,
  paneJumpTargetId,
  paneSearchEntries,
  parseWorkspaceHistory,
  recordWorkspaceVisit,
  workspaceHistoryKey,
} from "./paneJump";
import type { Pane, Tab, Workspace } from "./types";

function workspace(workspaceId: string, label: string): Workspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
  };
}

function tab(tabId: string, workspaceId: string): Tab {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    number: 1,
    label: "1",
    focused: false,
    pane_count: 1,
    agent_status: "unknown",
  };
}

function pane(
  paneId: string,
  workspaceId: string,
  tabId: string,
  agent?: string,
): Pane {
  return {
    pane_id: paneId,
    terminal_id: `terminal-${paneId}`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    cwd: `/repos/${workspaceId}`,
    agent,
    agent_status: agent ? "working" : "unknown",
    revision: 1,
  };
}

function connection(id: string, label: string): ConnectionSummary {
  return {
    id,
    label,
    source: "profile",
    is_default: false,
    state: "ready",
    generation: 1,
  };
}

function connectionView(
  id: string,
  label: string,
  topology: Pick<ConnectionSessionView, "workspaces" | "tabs" | "panes"> &
    Partial<Pick<ConnectionSessionView, "recentPaneIds" | "active">>,
): ConnectionSessionView {
  return {
    connection: connection(id, label),
    active: false,
    recentPaneIds: [],
    error: null,
    loaded: true,
    ...topology,
  };
}

describe("panes on connections that are not displayed", () => {
  const snapshot = {
    panes: [pane("p1", "w1", "t1")],
    recentPaneIds: ["p1"],
    tabs: [tab("t1", "w1")],
    workspaces: [workspace("w1", "local-repo")],
  };
  // Pane and workspace ids repeat across connections on purpose.
  const desktop = connectionView("desktop", "Desktop", {
    workspaces: [
      { ...workspace("w1", "tracing"), number: 1 },
      { ...workspace("w2", "executor"), number: 2 },
    ],
    tabs: [tab("t1", "w1"), tab("t2", "w2")],
    panes: [
      pane("p1", "w1", "t1"),
      pane("p2", "w1", "t1", "claude"),
      pane("p3", "w2", "t2"),
    ],
    recentPaneIds: ["p2"],
  });

  test("the recent switcher lists one pane per workspace after local panes", () => {
    const entries = paneJumpEntries(snapshot, "p1", [desktop]);
    expect(entries.map((entry) => entry.key)).toEqual([
      "p1",
      "desktop:p2",
      "desktop:p3",
    ]);
    // Real panes, labelled with their connection.
    expect(entries[1]).toMatchObject({
      paneId: "p2",
      paneLabel: "Desktop · Pane p2",
      title: "tracing",
      agent: "claude",
      connectionId: "desktop",
    });
  });

  test("search reaches every pane, by workspace or connection name", () => {
    expect(
      paneSearchEntries(snapshot, "", "p1", [desktop]).map(
        (entry) => entry.key,
      ),
    ).toEqual(["p1", "desktop:p2", "desktop:p1", "desktop:p3"]);
    expect(
      paneSearchEntries(snapshot, "executor", "p1", [desktop]).map(
        (entry) => entry.key,
      ),
    ).toEqual(["desktop:p3"]);
    expect(
      paneSearchEntries(snapshot, "desktop", "p1", [desktop]),
    ).toHaveLength(3);
  });

  test("the displayed connection's view adds nothing twice", () => {
    const displayed = { ...desktop, active: true };
    expect(
      paneJumpEntries(snapshot, "p1", [displayed]).map((entry) => entry.key),
    ).toEqual(["p1"]);
  });

  test("an entry elsewhere jumps across connections, never locally", () => {
    const entries = paneJumpEntries(snapshot, "p1", [desktop]);
    expect(paneJumpTargetId(entries, 1)).toBeNull();
    expect(paneJumpConnectionTarget(entries, 1)).toEqual({
      connectionId: "desktop",
      paneId: "p2",
    });
    expect(paneJumpConnectionTarget(entries, 0)).toBeNull();
  });
});

describe("recent pane projection", () => {
  test("falls back from a stale selection to the layout-focused pane", () => {
    const layout = {
      focused_pane_id: "mobile-active",
      panes: [
        {
          pane_id: "mobile-active",
          focused: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    };

    expect(activePaneIdForSnapshot({ selectedPaneId: "stale", layout })).toBe(
      "mobile-active",
    );
    expect(
      activePaneIdForSnapshot({ selectedPaneId: "mobile-active", layout }),
    ).toBe("mobile-active");
  });

  test("only allows inline close when a pane has a sibling in its tab", () => {
    const panes = [
      pane("p1", "w1", "t1"),
      pane("p2", "w1", "t1"),
      pane("p3", "w1", "t2"),
    ];

    expect(paneCanClose(panes, "p1")).toBe(true);
    expect(paneCanClose(panes, "p2")).toBe(true);
    expect(paneCanClose(panes, "p3")).toBe(false);
    expect(paneCanClose(panes, "missing")).toBe(false);
  });

  test("emphasizes the workspace and keeps agent state as metadata", () => {
    const entries = paneJumpEntries(
      {
        layout: {
          panes: [
            {
              pane_id: "p1",
              focused: true,
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
        panes: [pane("p1", "w1", "t1", "codex")],
        recentPaneIds: ["p1"],
        tabs: [tab("t1", "w1")],
        workspaces: [workspace("w1", "example-repo")],
      },
      "p1",
    );

    expect(entries).toEqual([
      {
        key: "p1",
        paneId: "p1",
        paneLabel: "Pane p1",
        workspaceId: "w1",
        title: "example-repo",
        tabLabel: "Tab 1",
        cwd: "/repos/w1",
        agent: "codex",
        agentStatus: "working",
        current: true,
      },
    ]);
  });

  test("keeps recent order, removes duplicates, and omits absent agent state", () => {
    const entries = paneJumpEntries({
      layout: {
        panes: [
          {
            pane_id: "p1",
            focused: false,
            rect: { x: 0, y: 0, width: 1, height: 1 },
          },
          {
            pane_id: "p2",
            focused: true,
            rect: { x: 1, y: 0, width: 1, height: 1 },
          },
        ],
      },
      panes: [pane("p1", "w1", "t1"), pane("p2", "w2", "t2")],
      recentPaneIds: ["p2", "p2"],
      tabs: [tab("t1", "w1"), tab("t2", "w2")],
      workspaces: [workspace("w1", "one"), workspace("w2", "two")],
    });

    expect(entries.map((entry) => entry.paneId)).toEqual(["p2", "p1"]);
    expect(entries[0].title).toBe("two");
    expect(entries[0].agent).toBeUndefined();
    expect(entries[0].agentStatus).toBeUndefined();
  });

  test("distinguishes same-tab panes by their existing short IDs in both modes", () => {
    const snapshot = {
      panes: [pane("w1:p1", "w1", "t1"), pane("w1:p2", "w1", "t1")],
      recentPaneIds: ["w1:p1", "w1:p2"],
      tabs: [tab("t1", "w1")],
      workspaces: [workspace("w1", "one")],
    };
    for (const entries of [
      paneJumpEntries(snapshot),
      paneSearchEntries(snapshot, ""),
    ]) {
      expect(entries.map((entry) => entry.paneLabel)).toEqual([
        "Pane p1",
        "Pane p2",
      ]);
      expect(entries.map((entry) => entry.tabLabel)).toEqual([
        "Tab 1",
        "Tab 1",
      ]);
      expect(entries.map((entry) => entry.cwd)).toEqual([
        "/repos/w1",
        "/repos/w1",
      ]);
    }
    expect(
      paneSearchEntries(snapshot, "Pane p2").map((entry) => entry.paneId),
    ).toEqual(["w1:p2"]);
  });

  test("does not refocus the pane that is already current", () => {
    const entries = [
      {
        key: "current",
        paneId: "current",
        paneLabel: "Pane current",
        workspaceId: "w1",
        title: "one",
        tabLabel: "Tab 1",
        cwd: "",
        current: true,
      },
      {
        key: "previous",
        paneId: "previous",
        paneLabel: "Pane previous",
        workspaceId: "w2",
        title: "two",
        tabLabel: "Tab 1",
        cwd: "",
        current: false,
      },
    ];

    expect(paneJumpTargetId(entries, 0)).toBeNull();
    expect(paneJumpTargetId(entries, 1)).toBe("previous");
    expect(paneJumpTargetId(entries, 2)).toBeNull();
  });
});

describe("pane search projection", () => {
  const snapshot = {
    layout: {
      panes: [
        {
          pane_id: "p1",
          focused: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    },
    panes: [
      pane("p1", "w1", "t1"),
      pane("p2", "w2", "t2", "codex"),
      pane("p3", "w3", "t3"),
    ],
    recentPaneIds: ["p1"],
    tabs: [tab("t1", "w1"), tab("t2", "w2"), tab("t3", "w3")],
    workspaces: [
      workspace("w1", "roamgate"),
      workspace("w2", "herdr-docs"),
      workspace("w3", "roamgate-site"),
    ],
  };

  test("reaches panes that the recent list never kept", () => {
    expect(
      paneJumpEntries(snapshot, "p1").map((entry) => entry.paneId),
    ).toEqual(["p1"]);
    expect(
      paneSearchEntries(snapshot, "", "p1").map((entry) => entry.paneId),
    ).toEqual(["p1", "p2", "p3"]);
  });

  test("matches workspace, directory, and agent text case-insensitively", () => {
    const ids = (query: string) =>
      paneSearchEntries(snapshot, query, "p1").map((entry) => entry.paneId);

    expect(ids("HERDR")).toEqual(["p2"]);
    expect(ids("codex")).toEqual(["p2"]);
    expect(ids("/repos/w3")).toEqual(["p3"]);
    expect(ids("roamgate")).toEqual(["p1", "p3"]);
    expect(ids("nothing here")).toEqual([]);
  });

  test("requires every token but ignores their order", () => {
    const ids = (query: string) =>
      paneSearchEntries(snapshot, query, "p1").map((entry) => entry.paneId);

    expect(ids("codex herdr")).toEqual(["p2"]);
    expect(ids("codex roamgate")).toEqual([]);
    expect(ids("  tab   herdr  ")).toEqual(["p2"]);
  });

  test("keeps the recent order ahead of the remaining panes", () => {
    const entries = paneSearchEntries(
      { ...snapshot, recentPaneIds: ["p3", "p2"] },
      "",
      "p3",
    );

    expect(entries.map((entry) => entry.paneId)).toEqual(["p3", "p2", "p1"]);
    expect(entries[0].current).toBe(true);
    expect(entries[1].current).toBe(false);
  });
});

describe("the entry a freshly opened switcher starts on", () => {
  const snapshot = {
    panes: [pane("p1", "w1", "t1"), pane("p2", "w2", "t2")],
    recentPaneIds: ["p2", "p1"],
    tabs: [tab("t1", "w1"), tab("t2", "w2")],
    workspaces: [workspace("w1", "local-repo"), workspace("w2", "docs")],
  };
  const desktop = connectionView("desktop", "Desktop", {
    workspaces: [workspace("w1", "tracing")],
    tabs: [tab("t1", "w1")],
    panes: [pane("p1", "w1", "t1")],
    recentPaneIds: ["p1"],
  });
  // p2 is displayed; p1 repeats on both connections on purpose.
  const entries = paneJumpEntries(snapshot, "p2", [desktop]);

  test("is the most recent other pane without a remembered jump", () => {
    expect(entries.map((entry) => entry.key)).toEqual([
      "p2",
      "p1",
      "desktop:p1",
    ]);
    expect(paneJumpDefaultIndex(entries, "local", null)).toBe(1);
  });

  test("is the pane the last jump came from, connection included", () => {
    expect(
      paneJumpDefaultIndex(entries, "local", {
        from: { connectionId: "desktop", paneId: "p1", workspaceId: "w1" },
        to: { connectionId: "local", paneId: "p2", workspaceId: "w2" },
      }),
    ).toBe(2);
    expect(
      paneJumpDefaultIndex(entries, "local", {
        from: { connectionId: "local", paneId: "p1", workspaceId: "w1" },
        to: { connectionId: "local", paneId: "p2", workspaceId: "w2" },
      }),
    ).toBe(1);
  });

  test("ignores the last jump once focus moved on its own", () => {
    const moved = paneJumpEntries(snapshot, "p1", [desktop]);
    expect(
      paneJumpDefaultIndex(moved, "local", {
        from: { connectionId: "desktop", paneId: "p1", workspaceId: "w1" },
        to: { connectionId: "local", paneId: "p2", workspaceId: "w2" },
      }),
    ).toBe(0);
  });
});

describe("workspace scope", () => {
  const snapshot = {
    panes: [
      pane("p1", "w1", "t1"),
      pane("p2", "w1", "t2", "claude"),
      pane("p3", "w2", "t3"),
    ],
    recentPaneIds: ["p2", "p1"],
    tabs: [tab("t1", "w1"), tab("t2", "w1"), tab("t3", "w2")],
    workspaces: [workspace("w1", "local-repo"), workspace("w2", "docs")],
  };
  const desktop = connectionView("desktop", "Desktop", {
    workspaces: [
      { ...workspace("w1", "tracing"), number: 1 },
      { ...workspace("w2", "executor"), number: 2 },
    ],
    tabs: [tab("t1", "w1"), tab("t2", "w2")],
    panes: [
      pane("p1", "w1", "t1"),
      pane("p2", "w1", "t1"),
      pane("p3", "w2", "t2"),
    ],
  });

  test("lists one entry per workspace, recent ones first", () => {
    const entries = paneJumpEntries(snapshot, "p2", [desktop], "workspaces");
    expect(entries.map((entry) => [entry.key, entry.title])).toEqual([
      ["p2", "local-repo"],
      ["p3", "docs"],
      ["desktop:p1", "tracing"],
      ["desktop:p3", "executor"],
    ]);
  });

  test("marks the workspace current through any of its panes", () => {
    // p1 is displayed; the workspace leads with p2, the recent pane there.
    const entries = paneJumpEntries(snapshot, "p1", [desktop], "workspaces");
    expect(entries[0]).toMatchObject({ paneId: "p2", current: true });
    expect(paneJumpTargetId(entries, 0)).toBeNull();
    expect(paneJumpTargetId(entries, 1)).toBe("p3");
  });

  test("search keeps a workspace its matching pane leads to", () => {
    const entries = paneSearchEntries(
      snapshot,
      "claude",
      "p1",
      [desktop],
      "workspaces",
    );
    expect(entries.map((entry) => entry.key)).toEqual(["p2"]);
  });

  test("walks back through workspaces in visit order across connections", () => {
    // Visited local:docs, then desktop:tracing, then local:local-repo, and
    // now back on local:docs.
    const keys = [
      workspaceHistoryKey("local", "w2"),
      workspaceHistoryKey("local", "w1"),
      workspaceHistoryKey("desktop", "w1"),
    ];
    const entries = paneJumpEntries(snapshot, "p3", [desktop], "workspaces", {
      activeConnectionId: "local",
      keys,
    });
    expect(entries.map((entry) => entry.title)).toEqual([
      "docs",
      "local-repo",
      "tracing",
      // Never visited: listed last, in their existing order.
      "executor",
    ]);
    const roundTrip = {
      from: { connectionId: "desktop", paneId: "p2", workspaceId: "w1" },
      to: { connectionId: "local", paneId: "p3", workspaceId: "w2" },
    };
    // Once: the workspace left last. Twice: the one before it, not a cycle
    // back through the round trip.
    const once = paneJumpDefaultIndex(
      entries,
      "local",
      roundTrip,
      "workspaces",
    );
    expect(entries[once]?.title).toBe("local-repo");
    expect(entries[once + 1]?.title).toBe("tracing");
  });

  test("records each visited workspace once, most recent first", () => {
    const a = workspaceHistoryKey("local", "w1");
    const b = workspaceHistoryKey("desktop", "w1");
    const c = workspaceHistoryKey("local", "w2");
    let history = recordWorkspaceVisit([], a);
    history = recordWorkspaceVisit(history, b);
    history = recordWorkspaceVisit(history, c);
    history = recordWorkspaceVisit(history, b);
    expect(history).toEqual([b, c, a]);
    expect(recordWorkspaceVisit(history, b)).toBe(history);
    // Workspace ids repeat across connections.
    expect(a).not.toBe(b);
  });

  test("reads back a stored history and ignores anything else", () => {
    const a = workspaceHistoryKey("local", "w1");
    const b = workspaceHistoryKey("desktop", "w1");
    expect(parseWorkspaceHistory(JSON.stringify([a, b, a]))).toEqual([a, b]);
    expect(parseWorkspaceHistory(JSON.stringify([a, 3, "w1", null]))).toEqual([
      a,
    ]);
    for (const raw of [null, "", "{", '{"a":1}', "42"])
      expect(parseWorkspaceHistory(raw)).toEqual([]);
  });
});
