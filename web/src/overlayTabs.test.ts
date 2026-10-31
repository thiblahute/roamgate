import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetOverlayTabsForTests,
  adoptOverlayTabs,
  connectOverlayTabs,
  forgetVanishedOverlayTabs,
  OVERLAY_SHOWN_STORAGE_KEY,
  overlayTabIdFor,
  overlayTabIdsFor,
  overlayWasShown,
  parseOverlayShown,
  parseOverlayTabMarks,
  rememberOverlayShown,
  serializeOverlayTabMarks,
  setOverlayTab,
  splitOverlayTopology,
  vanishedOverlayMarks,
  withOverlayShown,
  withOverlayTab,
} from "./overlayTabs";
import type { Pane, Tab, Workspace } from "./types";

const previousLocalStorage = globalThis.localStorage;
let storedValues = new Map<string, string>();

beforeEach(() => {
  storedValues = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return storedValues.size;
      },
      key: (index: number) => [...storedValues.keys()][index] ?? null,
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
      removeItem: (key: string) => storedValues.delete(key),
      clear: () => storedValues.clear(),
    },
  });
  __resetOverlayTabsForTests();
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: previousLocalStorage,
  });
  __resetOverlayTabsForTests();
});

function workspace(id: string, tabs: number, panes: number): Workspace {
  return {
    workspace_id: id,
    number: 1,
    label: id,
    focused: id === "w1",
    pane_count: panes,
    tab_count: tabs,
    active_tab_id: `${id}:t1`,
    agent_status: "idle",
  };
}

function tab(id: string, workspaceId: string, focused = false): Tab {
  return {
    tab_id: id,
    workspace_id: workspaceId,
    number: 1,
    label: id,
    focused,
    pane_count: 1,
    agent_status: "idle",
  };
}

function pane(id: string, tabId: string, workspaceId: string): Pane {
  return {
    pane_id: id,
    terminal_id: `term-${id}`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    agent_status: "idle",
    revision: 1,
  };
}

describe("overlay tab marks", () => {
  test("keeps one overlay tab per Space: marking another moves the mark", () => {
    let marks = withOverlayTab({}, "c1", "w1", "w1:t2");
    marks = withOverlayTab(marks, "c1", "w2", "w2:t1");
    marks = withOverlayTab(marks, "c1", "w1", "w1:t3");
    expect(marks).toEqual({ c1: { w1: "w1:t3", w2: "w2:t1" } });
    marks = withOverlayTab(marks, "c1", "w1", null);
    marks = withOverlayTab(marks, "c1", "w2", null);
    expect(marks).toEqual({});
  });

  test("parses only well-formed stored marks", () => {
    const marks = withOverlayTab({}, "c1", "w1", "w1:t2");
    expect(
      parseOverlayTabMarks(
        JSON.parse(JSON.stringify(serializeOverlayTabMarks(marks))),
      ),
    ).toEqual(marks);
    expect(parseOverlayTabMarks(null)).toEqual({});
    expect(parseOverlayTabMarks({ version: 2, connections: {} })).toEqual({});
    expect(
      parseOverlayTabMarks({
        version: 1,
        connections: { c1: { w1: 7, w2: "", w3: "w3:t1", w4: "w3:t1" } },
      }),
    ).toEqual({ c1: { w3: "w3:t1" } });
  });

  test("forgets a mark when its workspace closes or a seen tab goes", () => {
    const entries = { w1: "w1:t2", w2: "w2:t1", w3: "w3:t4" };
    expect(
      vanishedOverlayMarks(
        entries,
        new Set(["w1", "w3"]),
        new Set(["w1:t1", "w3:t1"]),
        new Set(["w1:t2"]),
      ),
    ).toEqual(["w1", "w2"]);
    // An empty list may be a Herdr still restoring its session.
    expect(
      vanishedOverlayMarks(entries, new Set(), new Set(), new Set()),
    ).toEqual([]);
  });

  test("a tab marked as it is created survives a list read made before it", () => {
    setOverlayTab("c1", "w1", "w1:t2");
    forgetVanishedOverlayTabs(
      "c1",
      [workspace("w1", 1, 1)],
      [tab("w1:t1", "w1")],
    );
    expect(overlayTabIdFor("c1", "w1")).toBe("w1:t2");
    forgetVanishedOverlayTabs(
      "c1",
      [workspace("w1", 2, 2)],
      [tab("w1:t1", "w1"), tab("w1:t2", "w1")],
    );
    forgetVanishedOverlayTabs(
      "c1",
      [workspace("w1", 1, 1)],
      [tab("w1:t1", "w1")],
    );
    expect(overlayTabIdFor("c1", "w1")).toBeNull();
  });

  test("a closed overlay tab forgets its Space was shown", () => {
    setOverlayTab("c1", "w1", "w1:t2");
    rememberOverlayShown("c1", "w1", true);
    rememberOverlayShown("c1", "w2", true);
    forgetVanishedOverlayTabs(
      "c1",
      [workspace("w1", 2, 2)],
      [tab("w1:t1", "w1"), tab("w1:t2", "w1")],
    );
    expect(overlayWasShown("c1", "w1")).toBe(true);
    forgetVanishedOverlayTabs(
      "c1",
      [workspace("w1", 1, 1)],
      [tab("w1:t1", "w1")],
    );
    expect(overlayWasShown("c1", "w1")).toBe(false);
    expect(overlayWasShown("c1", "w2")).toBe(true);
  });

  test("syncs through the server: its value wins, local marks are promoted", async () => {
    const sent: unknown[] = [];
    setOverlayTab("c1", "w1", "w1:t2");
    connectOverlayTabs(async (value) => {
      sent.push(value);
    }, undefined);
    expect(sent).toEqual([
      { version: 1, connections: { c1: { w1: "w1:t2" } } },
    ]);
    connectOverlayTabs(
      async (value) => {
        sent.push(value);
      },
      { version: 1, connections: { c1: { w1: "w1:t9" } } },
    );
    expect(overlayTabIdFor("c1", "w1")).toBe("w1:t9");
    setOverlayTab("c1", "w2", "w2:t1");
    expect(sent[sent.length - 1]).toEqual({
      version: 1,
      connections: { c1: { w1: "w1:t9", w2: "w2:t1" } },
    });
    adoptOverlayTabs({ version: 1, connections: {} });
    expect(overlayTabIdsFor("c1").size).toBe(0);
  });
});

describe("splitOverlayTopology", () => {
  const workspaces = [workspace("w1", 3, 4), workspace("w2", 1, 1)];
  const tabs = [
    tab("w1:t1", "w1"),
    tab("w1:t2", "w1"),
    tab("w1:t3", "w1"),
    tab("w2:t1", "w2"),
  ];
  const panes = [
    pane("p1", "w1:t1", "w1"),
    pane("p2", "w1:t2", "w1"),
    pane("p3", "w1:t2", "w1"),
    pane("p4", "w1:t3", "w1"),
    pane("p5", "w2:t1", "w2"),
  ];

  test("moves the overlay tab and its panes out of every list and count", () => {
    const split = splitOverlayTopology(
      { workspaces, tabs, panes },
      new Set(["w1:t2"]),
    );
    expect(split.tabs.map((each) => each.tab_id)).toEqual([
      "w1:t1",
      "w1:t3",
      "w2:t1",
    ]);
    expect(split.panes.map((each) => each.pane_id)).toEqual(["p1", "p4", "p5"]);
    expect(split.overlayTabs.map((each) => each.tab_id)).toEqual(["w1:t2"]);
    expect(split.overlayPanes.map((each) => each.pane_id)).toEqual([
      "p2",
      "p3",
    ]);
    expect(split.workspaces[0]).toMatchObject({ tab_count: 2, pane_count: 2 });
    expect(split.workspaces[1]).toBe(workspaces[1]);
  });

  test("a Space whose only other tab is the overlay counts one tab", () => {
    // The phone hides its tabs button for a single tab.
    const split = splitOverlayTopology(
      {
        workspaces: [workspace("w2", 2, 2)],
        tabs: [tab("w2:t1", "w2"), tab("w2:t2", "w2")],
        panes: [pane("a", "w2:t1", "w2"), pane("b", "w2:t2", "w2")],
      },
      new Set(["w2:t2"]),
    );
    expect(split.workspaces[0]?.tab_count).toBe(1);
    expect(
      split.tabs.filter((each) => each.workspace_id === "w2"),
    ).toHaveLength(1);
  });

  test("never leaves the overlay tab as a workspace's active tab", () => {
    const split = splitOverlayTopology(
      {
        workspaces: [{ ...workspace("w1", 2, 2), active_tab_id: "w1:t2" }],
        tabs: [tab("w1:t1", "w1"), tab("w1:t2", "w1", true)],
        panes: [pane("a", "w1:t1", "w1"), pane("b", "w1:t2", "w1")],
      },
      new Set(["w1:t2"]),
    );
    expect(split.workspaces[0]?.active_tab_id).toBe("w1:t1");
    expect(split.tabs[0]?.focused).toBe(true);
  });

  test("without marks it changes nothing", () => {
    const split = splitOverlayTopology({ workspaces, tabs, panes }, new Set());
    expect(split.tabs).toBe(tabs);
    expect(split.panes).toBe(panes);
    expect(split.workspaces).toBe(workspaces);
    expect(split.overlayTabs).toEqual([]);
  });
});

describe("overlay shown state", () => {
  test("is remembered per connection and Space", () => {
    rememberOverlayShown("alpha", "w1", true);
    expect(overlayWasShown("alpha", "w1")).toBe(true);
    expect(overlayWasShown("alpha", "w2")).toBe(false);
    expect(overlayWasShown("beta", "w1")).toBe(false);
    rememberOverlayShown("beta", "w2", true);
    rememberOverlayShown("alpha", "w1", false);
    expect(overlayWasShown("alpha", "w1")).toBe(false);
    expect(overlayWasShown("beta", "w2")).toBe(true);
    expect(
      JSON.parse(
        storedValues.get(`roamgate:${OVERLAY_SHOWN_STORAGE_KEY}`) ?? "null",
      ),
    ).toEqual({
      version: 1,
      connections: { beta: ["w2"] },
    });
    rememberOverlayShown("beta", "w2", false);
    expect(storedValues.has(`roamgate:${OVERLAY_SHOWN_STORAGE_KEY}`)).toBe(
      false,
    );
  });

  test("reads malformed or foreign values as nothing shown", () => {
    expect(parseOverlayShown(null)).toEqual({});
    expect(
      parseOverlayShown({ version: 2, connections: { a: ["w1"] } }),
    ).toEqual({});
    expect(
      parseOverlayShown({
        version: 1,
        connections: { a: ["w1", "w1", 3, ""], b: "w1", "": ["w1"] },
      }),
    ).toEqual({ a: ["w1"] });
    storedValues.set(`roamgate:${OVERLAY_SHOWN_STORAGE_KEY}`, "{not json");
    expect(overlayWasShown("a", "w1")).toBe(false);
  });

  test("keeps working when storage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(() => rememberOverlayShown("a", "w1", true)).not.toThrow();
    expect(overlayWasShown("a", "w1")).toBe(false);
  });

  test("marking a Space shown or hidden leaves the others", () => {
    const spaces = withOverlayShown({ a: ["w1"] }, "a", "w2", true);
    expect(spaces).toEqual({ a: ["w1", "w2"] });
    expect(withOverlayShown(spaces, "a", "w1", false)).toEqual({ a: ["w2"] });
    expect(withOverlayShown({ a: ["w1"] }, "a", "w1", false)).toEqual({});
  });
});
