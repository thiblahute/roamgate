/// <reference types="bun-types" />

import { describe, expect, jest, test } from "bun:test";
import {
  applyWorkspaceTreeOp,
  type WorkspaceTree,
  WorkspaceTreeError,
} from "../../../shared/workspaceTree";
import type { GuiSettings } from "./gui-settings";
import {
  agentGroupPaths,
  agentGroupPlacementOps,
  applyWorkspaceTreeOps,
  closedWorkspaceOfEvent,
  createWorkspaceTreePruner,
  onWorkspaceTreeChanged,
  placeCreatedWorkspace,
  pruneGoneWorkspaces,
  readWorkspaceTree,
  WORKSPACE_TREE_MAX_BYTES,
} from "./workspace-tree";

function memorySettings() {
  let settings: GuiSettings = {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {},
    ui: {},
  };
  let writes = 0;
  return {
    get: () => settings,
    writes: () => writes,
    read: async () => settings,
    update: async (
      change: (current: GuiSettings) => GuiSettings | Promise<GuiSettings>,
    ) => {
      const next = await change(settings);
      if (next !== settings) writes++;
      settings = next;
      return settings;
    },
  };
}

const ocio = {
  workspace_id: "w1",
  label: "gstreamer-ocio",
  worktree: {
    checkout_path: "/src/gstreamer.worktrees/ocio",
    repo_key: "gstreamer",
    is_linked_worktree: true,
  },
};

describe("the stored arrangement", () => {
  test("applies operations in one write and tells every listener", async () => {
    const store = memorySettings();
    const seen: WorkspaceTree[] = [];
    const stop = onWorkspaceTreeChanged((tree) => seen.push(tree));
    try {
      const tree = await applyWorkspaceTreeOps(
        [
          { op: "create_group", id: "g1", label: "upstreaming", parent: null },
          {
            op: "move",
            subject: {
              workspace: {
                connection_id: "desktop",
                path: "/home/me/rs",
                label: "rs",
              },
            },
            parent: { node: "g1" },
          },
        ],
        { update: store.update },
      );
      expect(tree.nodes).toHaveLength(2);
      expect(store.writes()).toBe(1);
      expect(seen).toEqual([tree]);
      expect(await readWorkspaceTree(store.read)).toEqual(tree);
    } finally {
      stop();
    }
  });

  test("writes nothing when an operation cannot apply", async () => {
    const store = memorySettings();
    await expect(
      applyWorkspaceTreeOps(
        [
          { op: "create_group", id: "g1", label: "a", parent: null },
          { op: "move", subject: { node: "g1" }, parent: { node: "g1" } },
        ],
        { update: store.update },
      ),
    ).rejects.toThrow("inside itself");
    expect(store.writes()).toBe(0);
    expect(store.get().workspace_tree).toBeUndefined();
  });

  test("an emptied arrangement leaves no trace in settings.json", async () => {
    const store = memorySettings();
    await applyWorkspaceTreeOps(
      [{ op: "create_group", id: "g1", label: "a", parent: null }],
      { update: store.update },
    );
    await applyWorkspaceTreeOps([{ op: "delete_group", node: "g1" }], {
      update: store.update,
    });
    expect(store.get()).not.toHaveProperty("workspace_tree");
  });

  test("refuses to grow past its size limit", async () => {
    const store = memorySettings();
    const label = "x".repeat(4000);
    const ops = Array.from({ length: 140 }, (_, index) => ({
      op: "move" as const,
      subject: {
        workspace: {
          connection_id: "c",
          path: `/${index}/${label}`,
          label: String(index),
        },
      },
      parent: { node: "g" },
    }));
    await expect(
      applyWorkspaceTreeOps(
        [{ op: "create_group", id: "g", label: "g", parent: null }, ...ops],
        { update: store.update },
      ),
    ).rejects.toThrow("too large");
    expect(WORKSPACE_TREE_MAX_BYTES).toBe(512 * 1024);
  });
});

describe("automatic placement", () => {
  test("places what an agent made under its workspace and says so", async () => {
    const store = memorySettings();
    const seen: WorkspaceTree[] = [];
    const stop = onWorkspaceTreeChanged((tree) => seen.push(tree));
    try {
      const changed = await placeCreatedWorkspace(
        {
          connectionId: "local",
          workspace: {
            workspace_id: "w5",
            label: "up-colorspace",
            worktree: {
              checkout_path: "/src/gstreamer.worktrees/up-colorspace",
              repo_key: "gstreamer",
              is_linked_worktree: true,
            },
          },
          parent: ocio,
        },
        store.update,
      );
      expect(changed).toBe(true);
      const tree = store.get().workspace_tree!;
      const child = tree.nodes.find(
        (node) => node.kind === "workspace" && node.ref.workspace_id === "w5",
      )!;
      const parent = tree.nodes.find((node) => node.id === child.parent)!;
      expect(parent).toMatchObject({
        kind: "workspace",
        parent: null,
        ref: { path: "/src/gstreamer.worktrees/ocio" },
      });
      expect(seen).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("leaves a worktree made from its repository's main checkout alone", async () => {
    const store = memorySettings();
    const changed = await placeCreatedWorkspace(
      {
        connectionId: "local",
        workspace: {
          workspace_id: "w5",
          label: "up-colorspace",
          worktree: {
            checkout_path: "/src/gstreamer.worktrees/up-colorspace",
            repo_key: "gstreamer",
            is_linked_worktree: true,
          },
        },
        parent: {
          workspace_id: "w0",
          label: "gstreamer",
          worktree: {
            checkout_path: "/src/gstreamer",
            repo_key: "gstreamer",
            is_linked_worktree: false,
          },
        },
      },
      store.update,
    );
    expect(changed).toBe(false);
    expect(store.writes()).toBe(0);
  });

  test("does nothing without both workspaces", async () => {
    const store = memorySettings();
    expect(
      await placeCreatedWorkspace(
        { connectionId: "local", workspace: undefined, parent: ocio },
        store.update,
      ),
    ).toBe(false);
  });
});

describe("an agent's --group", () => {
  const desktop = (path: string, label?: string) => ({
    connection_id: "desktop",
    path,
    ...(label ? { label } : {}),
  });
  const gst = desktop("/src/gst", "gst");
  const agent = desktop("/src/gst.worktrees/agent", "agent");
  const made = desktop("/src/cerbero.worktrees/pc", "cerbero-pc");
  // gst > upstreaming, and gst > agent (the asking workspace).
  const tree: WorkspaceTree = {
    version: 1,
    nodes: [
      { id: "gst", kind: "workspace", parent: null, ref: gst },
      { id: "up", kind: "group", parent: "gst", label: "upstreaming" },
      { id: "me", kind: "workspace", parent: "gst", ref: agent },
    ],
  };
  const apply = (ops: ReturnType<typeof agentGroupPlacementOps>["ops"]) =>
    ops.reduce(applyWorkspaceTreeOp, tree);

  test("a path from the top moves the workspace there", () => {
    const placement = agentGroupPlacementOps(tree, {
      subject: made,
      asker: agent,
      group: "GST/Upstreaming",
    });
    expect(placement).toEqual({
      ops: [
        {
          op: "move",
          subject: { workspace: made },
          parent: { node: "up" },
        },
      ],
      path: ["gst", "upstreaming"],
      created: [],
    });
    const after = apply(placement.ops);
    expect(
      after.nodes.find(
        (node) => node.kind === "workspace" && node.ref.path === made.path,
      )?.parent,
    ).toBe("up");
  });

  test("a path relative to the agent's group", () => {
    expect(
      agentGroupPlacementOps(tree, {
        subject: made,
        asker: agent,
        group: "upstreaming",
      }).path,
    ).toEqual(["gst", "upstreaming"]);
    // Not from somewhere the agent is not.
    expect(() =>
      agentGroupPlacementOps(tree, { subject: made, group: "upstreaming" }),
    ).toThrow(WorkspaceTreeError);
  });

  test("an agent in its usual place starts from its main checkout", () => {
    const worktree = desktop("/src/gst.worktrees/other", "other");
    expect(
      agentGroupPlacementOps(tree, {
        subject: made,
        asker: worktree,
        askerUsualParent: gst,
        group: "upstreaming",
      }).ops.at(-1),
    ).toEqual({
      op: "move",
      subject: { workspace: made },
      parent: { node: "up" },
    });
  });

  test("a missing group is refused unless created", () => {
    expect(() =>
      agentGroupPlacementOps(tree, {
        subject: made,
        asker: agent,
        group: "gst/upstreaming/soundtouch",
      }),
    ).toThrow(/No group "gst\/upstreaming\/soundtouch".*--create-group/);
    const placement = agentGroupPlacementOps(tree, {
      subject: made,
      asker: agent,
      group: "gst/upstreaming/soundtouch",
      create: true,
      newId: () => "g-new",
    });
    expect(placement.ops).toEqual([
      {
        op: "create_group",
        id: "g-new",
        label: "soundtouch",
        parent: { node: "up" },
      },
      { op: "move", subject: { workspace: made }, parent: { node: "g-new" } },
    ]);
    expect(placement.path).toEqual(["gst", "upstreaming", "soundtouch"]);
    expect(placement.created).toEqual(["soundtouch"]);
    expect(apply(placement.ops).nodes).toHaveLength(5);
  });

  test("without a subject it only checks the path", () => {
    expect(
      agentGroupPlacementOps(tree, { asker: agent, group: "gst > upstreaming" })
        .ops,
    ).toEqual([]);
    expect(() =>
      agentGroupPlacementOps(tree, { asker: agent, group: " / " }),
    ).toThrow(WorkspaceTreeError);
  });

  test("a workspace cannot go into itself or below itself", () => {
    expect(() =>
      agentGroupPlacementOps(tree, { subject: gst, group: "gst" }),
    ).toThrow(WorkspaceTreeError);
    expect(() =>
      agentGroupPlacementOps(tree, { subject: gst, group: "gst/upstreaming" }),
    ).toThrow(WorkspaceTreeError);
  });

  test("groups lists the paths and the agent's own", () => {
    expect(agentGroupPaths(tree, { ref: agent })).toEqual({
      groups: [
        { path: "gst", kind: "workspace", connection_id: "desktop" },
        { path: "gst/upstreaming", kind: "group" },
      ],
      yours: "gst",
    });
    expect(agentGroupPaths(tree).yours).toBeNull();
  });
});

describe("workspaces that no longer exist leave the arrangement", () => {
  const ges = {
    connection_id: "desktop",
    path: "/src/gstreamer.worktrees/ges-child-names",
    label: "upstream-ges-child-names",
    workspace_id: "w3",
  };
  const colour = {
    connection_id: "desktop",
    path: "/src/gstreamer.worktrees/colour",
    label: "up-colour",
    workspace_id: "w2",
  };
  const remote = {
    connection_id: "mac",
    path: "/Users/me/src/notes",
    label: "notes",
    workspace_id: "w1",
  };
  const liveDesktop = [
    { workspace_id: "w2", label: "up-colour", path: colour.path },
  ];

  async function arranged() {
    const store = memorySettings();
    await applyWorkspaceTreeOps(
      [
        { op: "create_group", id: "up", label: "upstream", parent: null },
        { op: "move", subject: { workspace: colour }, parent: { node: "up" } },
        { op: "move", subject: { workspace: ges }, parent: { node: "up" } },
        { op: "move", subject: { workspace: remote }, parent: { node: "up" } },
      ],
      { update: store.update },
    );
    return store;
  }
  const labels = (tree: WorkspaceTree) =>
    tree.nodes.map((node) =>
      node.kind === "group" ? `[${node.label}]` : node.ref.label,
    );

  function pruner(
    store: Awaited<ReturnType<typeof arranged>>,
    lists: Map<
      string,
      { workspace_id: string; label: string; path?: string }[]
    >,
  ) {
    const reads: string[] = [];
    const pruner = createWorkspaceTreePruner({
      list: async (connectionId) => {
        reads.push(connectionId);
        return lists.get(connectionId) ?? null;
      },
      read: () => readWorkspaceTree(store.read),
      prune: (connectionId, live, options) =>
        pruneGoneWorkspaces(connectionId, live, {
          ...options,
          update: store.update,
        }),
      settleMs: 1000,
      confirmMs: 5000,
    });
    return Object.assign(pruner, { reads });
  }
  const flush = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };

  test("reads the workspace Herdr reports closed or removed", () => {
    expect(
      closedWorkspaceOfEvent({
        event: "worktree.removed",
        data: {
          workspace_id: "w3",
          workspace: { workspace_id: "w3", label: "upstream-ges-child-names" },
          worktree: { path: ges.path },
        },
      }),
    ).toEqual({
      workspace_id: "w3",
      label: "upstream-ges-child-names",
      path: ges.path,
    });
    expect(
      closedWorkspaceOfEvent({
        data: { type: "workspace_closed", workspace_id: "w3" },
      }),
    ).toEqual({ workspace_id: "w3" });
    expect(
      closedWorkspaceOfEvent({
        event: "tab.closed",
        data: { workspace_id: "w3" },
      }),
    ).toBeNull();
  });

  test("a closed workspace leaves at once, its group and siblings kept", async () => {
    const store = await arranged();
    const seen: WorkspaceTree[] = [];
    const stop = onWorkspaceTreeChanged((tree) => seen.push(tree));
    const prune = pruner(store, new Map([["desktop", liveDesktop]]));
    try {
      await prune.event("desktop", {
        event: "workspace.closed",
        data: { workspace_id: "w3" },
      });
      await prune.idle();
    } finally {
      stop();
      prune.dispose();
    }
    const tree = await readWorkspaceTree(store.read);
    expect(labels(tree)).toEqual(["[upstream]", "up-colour", "notes"]);
    expect(
      tree.nodes.every((node) => node.parent === null || node.parent === "up"),
    ).toBe(true);
    expect(seen.length).toBe(1);
  });

  test("a ready connection's vanished workspaces leave once two reads agree", async () => {
    jest.useFakeTimers();
    const store = await arranged();
    const lists = new Map([["desktop", liveDesktop]]);
    const prune = pruner(store, lists);
    try {
      prune.ready("desktop");
      // The connection that is down keeps its workspaces.
      prune.ready("mac");
      expect(prune.reads).toEqual([]);
      jest.advanceTimersByTime(1000);
      await flush();
      expect(prune.reads).toEqual(["desktop", "mac"]);
      // Waiting for the second read: nothing gone yet.
      expect(labels(await readWorkspaceTree(store.read))).toContain(
        "upstream-ges-child-names",
      );
      jest.advanceTimersByTime(5000);
      await prune.idle();
      expect(labels(await readWorkspaceTree(store.read))).toEqual([
        "[upstream]",
        "up-colour",
        "notes",
      ]);
    } finally {
      prune.dispose();
      jest.useRealTimers();
    }
  });

  test("a workspace back by the second read stays", async () => {
    jest.useFakeTimers();
    const store = await arranged();
    const lists = new Map([["desktop", liveDesktop]]);
    const prune = pruner(store, lists);
    try {
      prune.ready("desktop");
      jest.advanceTimersByTime(1000);
      await flush();
      expect(prune.reads).toEqual(["desktop"]);
      lists.set("desktop", [
        ...liveDesktop,
        { workspace_id: "w8", label: ges.label, path: ges.path },
      ]);
      jest.advanceTimersByTime(5000);
      await prune.idle();
      expect(prune.reads).toEqual(["desktop", "desktop"]);
      expect(labels(await readWorkspaceTree(store.read))).toContain(
        "upstream-ges-child-names",
      );
    } finally {
      prune.dispose();
      jest.useRealTimers();
    }
  });
});
