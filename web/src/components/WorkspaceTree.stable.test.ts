import { expect, jest, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  applyWorkspaceTreeOp,
  emptyWorkspaceTree,
  type WorkspaceTreeOp,
} from "../../../shared/workspaceTree";
import { bridge } from "../api";
import { connectionStorageKey } from "../connectionStorage";
import { __storeTesting, store } from "../store";
import type { Pane, Workspace } from "../types";
import type { ConnectionAgentSessions } from "../useAllServerAgentSessions";
import { AGENT_LIST_SCOPE_STORAGE_KEY } from "../workspaceAgentLayout";
import { WORKSPACE_PINS_STORAGE_KEY } from "../workspacePins";
import { COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY } from "../workspaceTreeCollapse";
import { __workspaceTreeTesting } from "../workspaceTreeStore";
import { WorkspaceTree } from "./WorkspaceTree";

function workspace(
  workspace_id: string,
  label: string,
  path: string,
  number: number,
  extra: Partial<Workspace> = {},
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
      repo_key: path.split("/")[2]!,
      repo_name: path.split("/")[2]!,
      repo_root: path,
      checkout_path: path,
      is_linked_worktree: false,
    },
    ...extra,
  };
}

function linked(
  workspace_id: string,
  label: string,
  path: string,
  number: number,
  parent: string,
  root: string,
): Workspace {
  const base = workspace(workspace_id, label, path, number);
  return {
    ...base,
    worktree: {
      ...base.worktree!,
      repo_root: root,
      is_linked_worktree: true,
      parent_workspace_id: parent,
    },
  };
}

function agent(workspace_id: string, pane_id: string): Pane {
  return {
    pane_id,
    terminal_id: `${pane_id}:term`,
    workspace_id,
    tab_id: `${workspace_id}:t1`,
    focused: false,
    agent: "claude",
    agent_status: "idle",
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
if (process.env.ROAMGATE_STABLE_TREE_DOM_TEST !== "1") {
  test("the list stays put across connections in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_STABLE_TREE_DOM_TEST: "1" },
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
  test("switching the displayed connection moves only the selection", async () => {
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
    const alpha = [
      workspace("w1", "gst", "/src/gst", 1, { focused: true }),
      linked("w2", "gst-fix", "/src/gst.wt/fix", 2, "w1", "/src/gst"),
      workspace("w3", "notes", "/src/notes", 3),
    ];
    const desk = [
      workspace("d1", "rs", "/home/rs", 1, { focused: true }),
      linked("d2", "rs-ocio", "/home/rs.wt/ocio", 2, "d1", "/home/rs"),
      workspace("d3", "misc", "/home/misc", 3),
    ];
    const alphaPanes = [agent("w1", "p1")];
    const deskPanes = [agent("d3", "dp1")];
    const snapshots = [
      snapshot("alpha", alpha, alphaPanes),
      snapshot("desk", desk, deskPanes),
    ];
    // A group of the user's spanning both servers.
    const tree = [
      {
        op: "create_group",
        id: "g1",
        label: "upstreaming",
        parent: null,
      },
      {
        op: "move",
        subject: {
          workspace: {
            connection_id: "desk",
            path: "/home/misc",
            label: "misc",
          },
        },
        parent: { node: "g1" },
      },
      {
        op: "move",
        subject: {
          workspace: {
            connection_id: "alpha",
            path: "/src/notes",
            label: "notes",
          },
        },
        parent: { node: "g1" },
      },
    ].reduce(
      (each, op) => applyWorkspaceTreeOp(each, op as WorkspaceTreeOp),
      emptyWorkspaceTree(),
    );
    const connections = ["alpha", "desk"].map((id) => ({
      id,
      label: id,
      generation: 1,
      source: "test",
      is_default: id === "alpha",
      type: id === "desk" ? "ssh" : "local",
      state: "ready",
    }));
    const show = (id: "alpha" | "desk", loaded = true) =>
      act(async () => {
        const data = snapshots[id === "alpha" ? 0 : 1]!;
        __storeTesting.replaceState({
          ...store.get(),
          activeConnectionId: id,
          serverRuntimeGeneration: 1,
          status: "connected",
          connectionPaused: false,
          lastRefresh: loaded ? Date.now() : 0,
          workspaces: loaded ? data.workspaces : [],
          tabs: loaded ? data.tabs : [],
          panes: loaded ? data.panes : [],
          connections: connections as never,
        });
      });
    // Each row as drawn, but for what says which one is selected.
    const SELECTION =
      /^(is-active|is-selected|is-focused|active|selected|focused)$/;
    const drawn = () =>
      [
        ...container.querySelectorAll<HTMLElement>(
          ".workspace-tree-panel [role='treeitem'], .workspace-tree-panel .tree-row",
        ),
      ]
        .filter((row, index, all) => all.indexOf(row) === index)
        .map((row) => ({
          connection: row.dataset.connectionId ?? null,
          label:
            row.querySelector(".ws-label")?.textContent ??
            row.textContent?.trim().slice(0, 40),
          level: row.getAttribute("aria-level"),
          expanded: row.getAttribute("aria-expanded"),
          classes: [...row.classList]
            .filter((each) => !SELECTION.test(each))
            .sort()
            .join(" "),
          dot:
            row.querySelector<HTMLElement>(".workspace-host-dot")?.style
              .background ?? null,
          padding: row.style.paddingLeft,
        }));
    try {
      jest.useFakeTimers();
      const call = spyOn(bridge, "call").mockImplementation((async (
        method: string,
      ) => {
        if (method === "connections.agent_sessions")
          return { connections: snapshots };
        if (method === "bridge.workspace_tree.get") return { tree };
        return {};
      }) as never);
      mocks.push(call);
      __workspaceTreeTesting.set(tree);
      browser.localStorage.setItem(
        `roamgate:${AGENT_LIST_SCOPE_STORAGE_KEY}`,
        "all",
      );
      // The user's own choices on each server: a pin here, a fold there.
      browser.localStorage.setItem(
        `roamgate:${connectionStorageKey("alpha", WORKSPACE_PINS_STORAGE_KEY)}`,
        '["workspace:w3"]',
      );
      browser.localStorage.setItem(
        `roamgate:${connectionStorageKey("desk", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY)}`,
        '["workspace:d1"]',
      );
      __storeTesting.replaceState({ ...previousState });
      await show("alpha");
      const render = () =>
        act(async () =>
          root.render(
            createElement(WorkspaceTree, { onCreateWorkspace: () => {} }),
          ),
        );
      await render();
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      await render();
      const fromAlpha = drawn();
      expect(fromAlpha.length).toBeGreaterThan(5);
      // Every server keeps its own dot, the default local one none.
      expect(
        fromAlpha
          .filter((row) => row.connection === "desk")
          .every((row) => row.dot),
      ).toBe(true);
      expect(
        fromAlpha
          .filter((row) => row.connection === "alpha")
          .every((row) => !row.dot),
      ).toBe(true);
      const selectedLabel = () =>
        container.querySelector(
          ".workspace-tree-panel [aria-selected='true'] .ws-label",
        )?.textContent;
      expect(selectedLabel()).toBe("gst");

      // Switching: first the moment the store has not loaded desk yet.
      await show("desk", false);
      await render();
      expect(drawn()).toEqual(fromAlpha);
      await show("desk");
      await render();
      expect(drawn()).toEqual(fromAlpha);
      expect(selectedLabel()).toBe("rs");
      // The choices of each server are still theirs, in storage too.
      expect(
        browser.localStorage.getItem(
          `roamgate:${connectionStorageKey("desk", WORKSPACE_PINS_STORAGE_KEY)}`,
        ) ?? "[]",
      ).not.toContain("w3");
      expect(
        browser.localStorage.getItem(
          `roamgate:${connectionStorageKey("alpha", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY)}`,
        ) ?? "[]",
      ).not.toContain("d1");

      await show("alpha", false);
      await render();
      expect(drawn()).toEqual(fromAlpha);
      await show("alpha");
      await render();
      expect(drawn()).toEqual(fromAlpha);
      expect(selectedLabel()).toBe("gst");
    } finally {
      await act(async () => root.unmount());
      for (const each of mocks) each.mockRestore();
      jest.useRealTimers();
      __storeTesting.replaceState(previousState);
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
}
