/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
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
  onWorkspaceTreeChanged,
  placeCreatedWorkspace,
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
