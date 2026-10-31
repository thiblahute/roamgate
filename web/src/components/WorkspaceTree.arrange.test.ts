import { expect, jest, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  applyWorkspaceTreeOp,
  emptyWorkspaceTree,
  type WorkspaceTree,
  type WorkspaceTreeOp,
} from "../../../shared/workspaceTree";
import { bridge } from "../api";
import * as tasksOpen from "../agentTasksOpen";
import { __storeTesting, store } from "../store";
import type { Pane, Workspace } from "../types";
import type { ConnectionAgentSessions } from "../useAllServerAgentSessions";
import { AGENT_LIST_SCOPE_STORAGE_KEY } from "../workspaceAgentLayout";
import {
  __workspaceTreeTesting,
  applyWorkspaceTreeOps,
  getWorkspaceTree,
} from "../workspaceTreeStore";
import { WorkspaceTree as WorkspaceTreeView } from "./WorkspaceTree";

function workspace(
  workspace_id: string,
  label: string,
  path: string,
  number: number,
): Workspace {
  return {
    workspace_id,
    number,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "idle",
    worktree: {
      repo_key: label,
      repo_name: label,
      repo_root: path,
      checkout_path: path,
      is_linked_worktree: false,
    },
  };
}

function agent(
  workspace_id: string,
  pane_id: string,
  agent_status: string,
): Pane {
  return {
    pane_id,
    terminal_id: `${pane_id}:term`,
    workspace_id,
    tab_id: `${workspace_id}:t1`,
    focused: false,
    agent: "claude",
    agent_status,
    revision: 1,
  };
}

function snapshot(
  connection_id: string,
  workspaces: Workspace[],
  panes: Pane[],
): ConnectionAgentSessions {
  return {
    connection_id,
    connection_generation: 1,
    agents: null,
    workspaces,
    tabs: workspaces.map((each) => ({
      tab_id: `${each.workspace_id}:t1`,
      workspace_id: each.workspace_id,
      number: 1,
      label: "main",
      focused: true,
      pane_count: 1,
      agent_status: "idle",
    })),
    panes,
  };
}

// Isolate browser globals and React's module graph from other Bun tests.
if (process.env.ROAMGATE_ARRANGE_TREE_DOM_TEST !== "1") {
  test("the user's arrangement in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_ARRANGE_TREE_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 20_000);
} else {
  test("nests across servers, keeps the unavailable greyed, sums up subtrees and lists subagents", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const previousState = store.get();
    const mocks: { mockRestore(): void }[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ocio = workspace("w1", "gstreamer-ocio", "/src/gst.wt/ocio", 1);
    const notes = workspace("w2", "notes", "/src/notes", 2);
    let deskWorkspaces = [
      workspace("d1", "up-ocio-rs", "/home/me/rs.wt/up-ocio", 1),
      workspace("d2", "desktop-misc", "/home/me/misc", 2),
    ];
    const alphaPanes = [
      agent("w1", "p1", "working"),
      // Its turn is over, a background command still runs.
      agent("w2", "p2", "idle"),
    ];
    const deskPanes = () => [
      agent(deskWorkspaces[0]!.workspace_id, "dp1", "blocked"),
      // Idle with a workflow running.
      agent(deskWorkspaces[0]!.workspace_id, "dp2", "idle"),
    ];
    let tree: WorkspaceTree = [
      {
        op: "create_group",
        id: "g1",
        label: "upstreaming",
        parent: {
          workspace: {
            connection_id: "alpha",
            path: "/src/gst.wt/ocio",
            label: "gstreamer-ocio",
          },
        },
      },
      {
        op: "move",
        subject: {
          workspace: {
            connection_id: "desk",
            path: "/home/me/rs.wt/up-ocio",
            label: "up-ocio-rs",
            workspace_id: "d1",
          },
        },
        parent: { node: "g1" },
      },
      {
        op: "move",
        subject: {
          workspace: {
            connection_id: "laptop",
            path: "/x/y",
            label: "on-the-laptop",
          },
        },
        parent: { node: "g1" },
      },
      {
        op: "move",
        subject: {
          workspace: {
            connection_id: "alpha",
            path: "/src/closed",
            label: "closed",
          },
        },
        parent: { node: "g1" },
      },
    ].reduce(
      (each, op) => applyWorkspaceTreeOp(each, op as WorkspaceTreeOp),
      emptyWorkspaceTree(),
    );
    const applied: WorkspaceTreeOp[][] = [];
    const row = (label: string) =>
      [...container.querySelectorAll<HTMLElement>("[role='treeitem']")].find(
        (each) => each.querySelector(".ws-label")?.textContent === label,
      );
    const render = () =>
      act(async () =>
        root.render(
          createElement(WorkspaceTreeView, {
            onCreateWorkspace: () => {},
          }),
        ),
      );
    try {
      jest.useFakeTimers();
      browser.localStorage.setItem(
        `roamgate:${AGENT_LIST_SCOPE_STORAGE_KEY}`,
        "all",
      );
      const call = spyOn(bridge, "call").mockImplementation((async (
        method: string,
        params?: Record<string, unknown>,
      ) => {
        if (method === "connections.agent_sessions")
          return {
            connections: [
              snapshot("alpha", [ocio, notes], alphaPanes),
              snapshot("desk", deskWorkspaces, deskPanes()),
            ],
          };
        if (method === "connections.agent_tasks")
          return {
            results: [
              {
                connection_id: "alpha",
                pane_id: "p1",
                tasks: [
                  {
                    id: "t1",
                    kind: "agent",
                    title: "Explore",
                    status: "running",
                    startedAt: new Date().toISOString(),
                  },
                  {
                    id: "t2",
                    kind: "teammate",
                    title: "Reviewer",
                    name: "rev",
                    status: "completed",
                    // Idle, started in a part of the session since rewound.
                    rewound: true,
                  },
                  {
                    id: "t3",
                    kind: "agent",
                    title: "Old",
                    status: "completed",
                  },
                  {
                    id: "t4",
                    kind: "command",
                    title: "make",
                    status: "running",
                  },
                ],
              },
              {
                connection_id: "alpha",
                pane_id: "p2",
                tasks: [
                  {
                    id: "c1",
                    kind: "command",
                    title: "bun test",
                    status: "running",
                  },
                ],
              },
              {
                connection_id: "desk",
                pane_id: "dp2",
                tasks: [
                  {
                    id: "f1",
                    kind: "workflow",
                    title: "Restack",
                    status: "running",
                  },
                ],
              },
            ],
          };
        if (method === "bridge.workspace_tree.apply") {
          const ops = params?.ops as WorkspaceTreeOp[];
          applied.push(ops);
          tree = ops.reduce(applyWorkspaceTreeOp, tree);
          return { tree };
        }
        if (method === "bridge.workspace_tree.get") return { tree };
        return {};
      }) as never);
      const focusPane = spyOn(store, "focusWorkspaceSource").mockResolvedValue(
        true,
      );
      const openTask = spyOn(tasksOpen, "openAgentTask");
      mocks.push(call, focusPane, openTask);
      __workspaceTreeTesting.set(tree);
      __storeTesting.replaceState({
        ...previousState,
        activeConnectionId: "alpha",
        serverRuntimeGeneration: 1,
        status: "connected",
        connectionPaused: false,
        lastRefresh: 1,
        workspaces: [ocio, notes],
        tabs: snapshot("alpha", [ocio, notes], []).tabs,
        panes: alphaPanes,
        connections: ["alpha", "desk", "laptop"].map((id) => ({
          id,
          label: id,
          generation: 1,
          source: "test",
          is_default: id === "alpha",
          state: id === "laptop" ? "disconnected" : "ready",
        })),
      });
      await render();
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      await render();

      const group = row("upstreaming")!;
      expect(group.getAttribute("aria-level")).toBe("2");
      // After the parent's agent and its subagents line.
      expect(group.previousElementSibling?.textContent).toContain("subagents");
      // The desktop's worktree sits under the group, not in its usual place.
      const placed = row("up-ocio-rs")!;
      expect(placed.getAttribute("aria-level")).toBe("3");
      expect(placed.dataset.connectionId).toBe("desk");
      expect(
        [...container.querySelectorAll(".ws-label")].filter(
          (each) => each.textContent === "up-ocio-rs",
        ),
      ).toHaveLength(1);
      // Unavailable children stay, greyed, with a way to remove them.
      const offline = row("on-the-laptop")!;
      expect(offline.classList.contains("workspace-tree-unavailable")).toBe(
        true,
      );
      expect(offline.textContent).toContain("offline");
      expect(row("closed")!.textContent).toContain("gone");

      // The parent sums up its subtree: its own working agent and running
      // subagent, the desktop agent asking something below.
      const summary = row("gstreamer-ocio")!.querySelector(
        ".workspace-tree-summary",
      )!;
      // The desktop agent idle while its workflow runs counts apart.
      expect(summary.getAttribute("aria-label")).toBe(
        "1 working · 1 idle, running in the background · 1 waiting on you (1 asking) · 2 subagents running",
      );
      expect(summary.querySelector(".is-background")?.textContent).toBe("1");
      expect(
        group
          .querySelector(".workspace-tree-summary")
          ?.getAttribute("aria-label"),
      ).toBe(
        "1 idle, running in the background · 1 waiting on you (1 asking) · 1 subagent running",
      );

      // An idle agent whose command still runs: its row's dot, its own row
      // and the hover card say it works in the background.
      const notesRow = row("notes")!;
      const dot = notesRow.querySelector(".ws-agent-dot")!;
      expect(dot.className).toBe("ws-agent-dot is-background");
      expect(dot.getAttribute("aria-label")).toBe(
        "Idle, running in the background",
      );
      expect(notesRow.getAttribute("title")).toContain(
        "1 running in the background:\n  Command: bun test",
      );
      const notesAgent = [
        ...container.querySelectorAll<HTMLElement>(".agent-row"),
      ].find((each) => each.getAttribute("title")?.includes("pane p2"))!;
      expect(
        notesAgent.querySelector(".agent-status-icon-dot")?.className,
      ).toContain("is-background");
      expect(notesAgent.querySelector(".agent-row-status")?.textContent).toBe(
        "Idle · 1 running",
      );
      expect(notesAgent.getAttribute("title")).toContain(
        "Idle, 1 background command running:\nCommand: bun test",
      );

      // The subagents line: the running subagent and the idle teammate.
      const line = container.querySelector<HTMLElement>(".agent-task-line")!;
      expect(line.textContent).toContain("2 subagents · 1 running");
      expect(line.textContent).toContain("1 done");
      expect(container.querySelector(".agent-task-row")).toBeNull();
      await act(async () => line.click());
      const tasks = [
        ...container.querySelectorAll<HTMLElement>(".agent-task-row"),
      ];
      expect(tasks.map((each) => each.textContent)).toEqual([
        expect.stringContaining("Explore"),
        expect.stringContaining("Reviewer"),
      ]);
      expect(tasks[1]!.textContent).toContain("idle");
      expect(
        tasks.map((each) => !!each.querySelector(".agent-task-row-rewound")),
      ).toEqual([false, true]);
      expect(tasks[1]!.getAttribute("aria-label")).toBe(
        "Reviewer, idle, started in a rewound part",
      );
      await act(async () => tasks[0]!.click());
      expect(focusPane).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "alpha", paneId: "p1" }),
        { fromKnownList: true },
      );
      expect(openTask).toHaveBeenCalledWith("p1", "t1");
      // Expanded stays expanded across a reload of the list.
      await act(async () => root.unmount());
      const again = createRoot(container);
      await act(async () =>
        again.render(
          createElement(WorkspaceTreeView, { onCreateWorkspace: () => {} }),
        ),
      );
      expect(container.querySelectorAll(".agent-task-row")).toHaveLength(2);

      // Collapsing a group is stored on the server and keeps its summary.
      await act(async () =>
        row("upstreaming")!
          .querySelector<HTMLButtonElement>(".workspace-group-toggle")!
          .click(),
      );
      expect(applied[applied.length - 1]).toEqual([
        { op: "set_collapsed", node: "g1", collapsed: true },
      ]);
      expect(row("up-ocio-rs")).toBeUndefined();
      expect(
        row("upstreaming")!.querySelector(".workspace-tree-summary"),
      ).not.toBeNull();

      // Removing an unavailable child.
      await act(async () =>
        row("upstreaming")!
          .querySelector<HTMLButtonElement>(".workspace-group-toggle")!
          .click(),
      );
      await act(async () =>
        row("closed")!
          .querySelector<HTMLButtonElement>(".workspace-tree-remove")!
          .click(),
      );
      expect(row("closed")).toBeUndefined();
      expect(applied[applied.length - 1]?.[0]?.op).toBe("remove");

      // The desktop's Herdr restarts and numbers its workspaces again: the
      // child is found by its path, and the new id goes back as a hint.
      deskWorkspaces = [
        workspace("d9", "desktop-misc", "/home/me/misc", 1),
        workspace("d8", "up-ocio-rs", "/home/me/rs.wt/up-ocio", 2),
      ];
      await act(async () => {
        jest.advanceTimersByTime(16_000);
      });
      await act(async () =>
        again.render(
          createElement(WorkspaceTreeView, { onCreateWorkspace: () => {} }),
        ),
      );
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
      expect(row("up-ocio-rs")!.getAttribute("aria-level")).toBe("3");
      await act(async () => {
        jest.advanceTimersByTime(2500);
      });
      const refreshed = applied
        .flat()
        .flatMap((op) => (op.op === "refresh" ? op.nodes : []))
        .map((each) => each.ref.workspace_id);
      expect(refreshed).toContain("d8");
      expect(
        getWorkspaceTree().nodes.some(
          (node) => node.kind === "workspace" && node.ref.workspace_id === "d8",
        ),
      ).toBe(true);
      await act(async () => again.unmount());
    } finally {
      jest.useRealTimers();
      for (const mock of mocks) mock.mockRestore();
      container.remove();
      __storeTesting.replaceState(previousState);
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      await browser.happyDOM.close();
    }
  });
  test("moves a repo-nested worktree to the top level, where it stays", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const previousState = store.get();
    const mocks: { mockRestore(): void }[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const gst = workspace("w1", "gstreamer", "/src/gstreamer", 1);
    const ocio: Workspace = {
      ...workspace("w2", "gstreamer-ocio", "/src/gstreamer.wt/ocio", 2),
      worktree: {
        repo_key: "gstreamer",
        repo_name: "gstreamer",
        repo_root: "/src/gstreamer",
        checkout_path: "/src/gstreamer.wt/ocio",
        is_linked_worktree: true,
      },
    };
    const notes = workspace("w3", "notes", "/src/notes", 3);
    gst.worktree = { ...gst.worktree!, repo_key: "gstreamer" };
    let tree: WorkspaceTree = emptyWorkspaceTree();
    const applied: WorkspaceTreeOp[][] = [];
    const rows = () => [
      ...container.querySelectorAll<HTMLElement>(".workspace-row"),
    ];
    const row = (name: string) =>
      rows().find((each) => each.getAttribute("aria-label") === name);
    try {
      // The row menu is loaded on first use: have it ready.
      await import("./ContextMenu");
      jest.useFakeTimers();
      const call = spyOn(bridge, "call").mockImplementation((async (
        method: string,
        params?: Record<string, unknown>,
      ) => {
        if (method === "bridge.workspace_tree.apply") {
          const ops = params?.ops as WorkspaceTreeOp[];
          applied.push(ops);
          tree = ops.reduce(applyWorkspaceTreeOp, tree);
          return { tree };
        }
        if (method === "bridge.workspace_tree.get") return { tree };
        return {};
      }) as never);
      mocks.push(call);
      __workspaceTreeTesting.set(tree);
      __storeTesting.replaceState({
        ...previousState,
        activeConnectionId: "alpha",
        serverRuntimeGeneration: 1,
        status: "connected",
        connectionPaused: false,
        lastRefresh: 1,
        workspaces: [gst, ocio, notes],
        tabs: snapshot("alpha", [gst, ocio, notes], []).tabs,
        panes: [],
        connections: [
          {
            id: "alpha",
            label: "alpha",
            generation: 1,
            source: "test",
            is_default: true,
            state: "ready",
          },
        ],
      });
      await act(async () =>
        root.render(
          createElement(WorkspaceTreeView, { onCreateWorkspace: () => {} }),
        ),
      );
      // Nested under its main checkout, without the name it repeats.
      const nested = row("gstreamer-ocio")!;
      expect(nested.getAttribute("aria-level")).toBe("2");
      expect(nested.querySelector(".ws-label")?.textContent).toBe("ocio");
      expect(nested.title.split("\n")[0]).toBe("gstreamer-ocio");

      await act(async () => {
        nested.dispatchEvent(
          new browser.MouseEvent("contextmenu", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }) as unknown as Event,
        );
      });
      const menuItem = () =>
        [...document.querySelectorAll<HTMLElement>(".context-menu-item")].find(
          (each) => each.textContent === "Move to top level",
        );
      for (let tries = 0; tries < 50 && !menuItem(); tries++)
        await act(async () => {
          await Promise.resolve();
          jest.advanceTimersByTime(10);
        });
      const item = menuItem();
      expect(item).toBeDefined();
      await act(async () => item!.click());
      expect(applied[applied.length - 1]).toEqual([
        {
          op: "move",
          subject: {
            workspace: {
              connection_id: "alpha",
              path: "/src/gstreamer.wt/ocio",
              label: "gstreamer-ocio",
              workspace_id: "w2",
            },
          },
          parent: { root: "list" },
        },
      ]);
      await act(async () =>
        root.render(
          createElement(WorkspaceTreeView, { onCreateWorkspace: () => {} }),
        ),
      );
      // At the top level, in Herdr's order, shown once and in full.
      expect(rows().map((each) => each.getAttribute("aria-label"))).toEqual([
        "gstreamer",
        "gstreamer-ocio",
        "notes",
      ]);
      const top = row("gstreamer-ocio")!;
      expect(top.getAttribute("aria-level")).toBe("1");
      expect(top.querySelector(".ws-label")?.textContent).toBe(
        "gstreamer-ocio",
      );
      expect(
        row("gstreamer")!.querySelector(".workspace-group-toggle"),
      ).toBeNull();
      // A workspace already at the top level, put there explicitly, stays.
      await act(async () => {
        row("notes")!.dispatchEvent(
          new browser.MouseEvent("contextmenu", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }) as unknown as Event,
        );
      });
      // It is a top-level row already: nothing to offer.
      expect(
        document.querySelector(".context-menu-header")?.textContent,
      ).toContain("notes");
      expect(menuItem()).toBeUndefined();
      await act(async () => {
        document.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }) as unknown as Event,
        );
        await applyWorkspaceTreeOps([
          {
            op: "move",
            subject: {
              workspace: {
                connection_id: "alpha",
                path: "/src/notes",
                label: "notes",
                workspace_id: "w3",
              },
            },
            parent: { root: "list" },
          },
        ]);
      });
      await act(async () =>
        root.render(
          createElement(WorkspaceTreeView, { onCreateWorkspace: () => {} }),
        ),
      );
      expect(rows().map((each) => each.getAttribute("aria-label"))).toEqual([
        "gstreamer",
        "gstreamer-ocio",
        "notes",
      ]);
      await act(async () => root.unmount());
    } finally {
      jest.useRealTimers();
      for (const mock of mocks) mock.mockRestore();
      container.remove();
      __storeTesting.replaceState(previousState);
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      await browser.happyDOM.close();
    }
  });
}
