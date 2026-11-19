import { describe, expect, test } from "bun:test";
import {
  applyWorkspaceTreeOp,
  autoPlaceWorkspace,
  emptyWorkspaceTree,
  findWorkspaceNode,
  goneWorkspaceTreeNodes,
  parseWorkspaceTree,
  parseWorkspaceTreeOp,
  parseWorkspaceTreePath,
  removeWorkspaceTreeNodes,
  resolveWorkspaceTree,
  resolveWorkspaceTreePath,
  type WorkspaceRef,
  type WorkspaceTree,
  type WorkspaceTreeOp,
  WorkspaceTreeError,
  workspaceRefFor,
  workspaceTreeAncestors,
  workspaceTreeChildren,
  workspaceTreeGroupPaths,
  workspaceTreeNodePlaced,
  workspaceTreeRootPlace,
} from "./workspaceTree";

const ocio: WorkspaceRef = {
  connection_id: "local",
  path: "/src/gstreamer.worktrees/ocio",
  label: "gstreamer-ocio",
  workspace_id: "w1",
};
const upColor: WorkspaceRef = {
  connection_id: "local",
  path: "/src/gstreamer.worktrees/up-colorspace",
  label: "up-colorspace",
  workspace_id: "w2",
};
const upRs: WorkspaceRef = {
  connection_id: "desktop",
  path: "/home/me/gst-plugins-rs.worktrees/up-ocio",
  label: "up-ocio",
  workspace_id: "w7",
};

function apply(tree: WorkspaceTree, ...ops: WorkspaceTreeOp[]) {
  return ops.reduce(applyWorkspaceTreeOp, tree);
}

function shape(tree: WorkspaceTree, parent: string | null = null): unknown[] {
  return workspaceTreeChildren(tree, parent).map((node) => {
    const name = node.kind === "group" ? `[${node.label}]` : node.ref.label;
    const children = shape(tree, node.id);
    return children.length ? { [name as string]: children } : name;
  });
}

describe("arranging workspaces", () => {
  test("moves a workspace into another, across connections", () => {
    const tree = apply(emptyWorkspaceTree(), {
      op: "move",
      subject: { workspace: upRs },
      parent: { workspace: ocio },
    });
    expect(shape(tree)).toEqual([{ "gstreamer-ocio": ["up-ocio"] }]);
    // The parent keeps its usual place: its node only holds children.
    expect(findWorkspaceNode(tree, ocio)?.parent).toBeNull();
  });

  test("groups nest at any depth and order their children", () => {
    let tree = apply(
      emptyWorkspaceTree(),
      {
        op: "create_group",
        id: "g1",
        label: "upstreaming",
        parent: { workspace: ocio },
      },
      { op: "move", subject: { workspace: upColor }, parent: { node: "g1" } },
      { op: "move", subject: { workspace: upRs }, parent: { node: "g1" } },
    );
    expect(shape(tree)).toEqual([
      { "gstreamer-ocio": [{ "[upstreaming]": ["up-colorspace", "up-ocio"] }] },
    ]);
    const rs = findWorkspaceNode(tree, upRs)!;
    const color = findWorkspaceNode(tree, upColor)!;
    // Reorder: up-ocio before up-colorspace.
    tree = apply(tree, {
      op: "move",
      subject: { node: rs.id },
      parent: { node: "g1" },
      before: { node: color.id },
    });
    expect(shape(tree)).toEqual([
      { "gstreamer-ocio": [{ "[upstreaming]": ["up-ocio", "up-colorspace"] }] },
    ]);
  });

  test("moving out returns a workspace to its usual place", () => {
    let tree = apply(emptyWorkspaceTree(), {
      op: "move",
      subject: { workspace: upColor },
      parent: { workspace: ocio },
    });
    const node = findWorkspaceNode(tree, upColor)!;
    tree = apply(tree, {
      op: "move",
      subject: { node: node.id },
      parent: null,
    });
    // Neither holds anything any more: nothing is left stored.
    expect(tree.nodes).toEqual([]);
  });

  test("refuses to move something into itself or below itself", () => {
    const tree = apply(
      emptyWorkspaceTree(),
      { op: "create_group", id: "g1", label: "a", parent: null },
      { op: "create_group", id: "g2", label: "b", parent: { node: "g1" } },
      { op: "move", subject: { workspace: ocio }, parent: { node: "g2" } },
    );
    expect(() =>
      apply(tree, {
        op: "move",
        subject: { node: "g1" },
        parent: { node: "g2" },
      }),
    ).toThrow(WorkspaceTreeError);
    expect(() =>
      apply(tree, {
        op: "move",
        subject: { node: "g1" },
        parent: { node: "g1" },
      }),
    ).toThrow(WorkspaceTreeError);
    expect(() =>
      apply(tree, {
        op: "move",
        subject: { node: "g1" },
        parent: { workspace: ocio },
      }),
    ).toThrow(WorkspaceTreeError);
  });

  test("deleting a group hands its children to its parent, in its place", () => {
    const tree = apply(
      emptyWorkspaceTree(),
      { op: "create_group", id: "top", label: "top", parent: null },
      {
        op: "create_group",
        id: "first",
        label: "first",
        parent: { node: "top" },
      },
      {
        op: "create_group",
        id: "doomed",
        label: "doomed",
        parent: { node: "top" },
      },
      {
        op: "move",
        subject: { workspace: upColor },
        parent: { node: "doomed" },
      },
      { op: "move", subject: { workspace: upRs }, parent: { node: "doomed" } },
      {
        op: "create_group",
        id: "last",
        label: "last",
        parent: { node: "top" },
      },
      { op: "delete_group", node: "doomed" },
    );
    expect(shape(tree)).toEqual([
      { "[top]": ["[first]", "up-colorspace", "up-ocio", "[last]"] },
    ]);
  });

  test("deleting a top-level group sends its workspaces back to their usual place", () => {
    const tree = apply(
      emptyWorkspaceTree(),
      { op: "create_group", id: "g", label: "g", parent: null },
      { op: "move", subject: { workspace: upColor }, parent: { node: "g" } },
      { op: "delete_group", node: "g" },
    );
    expect(tree.nodes).toEqual([]);
  });

  test("removing a gone workspace keeps its children", () => {
    let tree = apply(
      emptyWorkspaceTree(),
      { op: "create_group", id: "g", label: "g", parent: null },
      { op: "move", subject: { workspace: ocio }, parent: { node: "g" } },
      { op: "move", subject: { workspace: upRs }, parent: { workspace: ocio } },
    );
    const node = findWorkspaceNode(tree, ocio)!;
    tree = apply(tree, { op: "remove", node: node.id });
    expect(shape(tree)).toEqual([{ "[g]": ["up-ocio"] }]);
  });

  test("renames and collapses groups, and refuses empty names", () => {
    let tree = apply(emptyWorkspaceTree(), {
      op: "create_group",
      id: "g",
      label: "  up\nstreaming ",
      parent: null,
    });
    expect(tree.nodes[0]).toMatchObject({ label: "up streaming" });
    tree = apply(
      tree,
      { op: "rename_group", node: "g", label: "upstreaming" },
      { op: "set_collapsed", node: "g", collapsed: true },
    );
    expect(tree.nodes[0]).toMatchObject({
      label: "upstreaming",
      collapsed: true,
    });
    tree = apply(tree, { op: "set_collapsed", node: "g", collapsed: false });
    expect(tree.nodes[0]).not.toHaveProperty("collapsed");
    expect(() =>
      apply(tree, { op: "rename_group", node: "g", label: "  " }),
    ).toThrow(WorkspaceTreeError);
  });

  test("parsing drops what does not hold together", () => {
    const tree = parseWorkspaceTree({
      nodes: [
        { id: "a", kind: "group", parent: "b", label: "a" },
        { id: "b", kind: "group", parent: "a", label: "b" },
        { id: "orphan", kind: "group", parent: "missing", label: "o" },
        { id: "bad id!", kind: "group", parent: null, label: "x" },
        {
          id: "w",
          kind: "workspace",
          parent: null,
          ref: { connection_id: "c" },
        },
        { id: "a", kind: "group", parent: null, label: "duplicate" },
      ],
    });
    // The loop is broken, the orphan lifted, the invalid entries dropped.
    expect(tree.nodes.map((node) => [node.id, node.parent])).toEqual([
      ["a", null],
      ["b", "a"],
      ["orphan", null],
    ]);
    expect(parseWorkspaceTree("nonsense")).toEqual(emptyWorkspaceTree());
  });

  test("validates operations sent over RPC", () => {
    expect(
      parseWorkspaceTreeOp({
        op: "move",
        subject: { node: "n1" },
        parent: { workspace: { connection_id: "c", path: "/p" } },
      }),
    ).toEqual({
      op: "move",
      subject: { node: "n1" },
      parent: { workspace: { connection_id: "c", path: "/p" } },
    });
    expect(
      parseWorkspaceTreeOp({ op: "move", subject: {}, parent: null }),
    ).toBeNull();
    expect(parseWorkspaceTreeOp({ op: "drop_table" })).toBeNull();
    expect(
      parseWorkspaceTreeOp({ op: "delete_group", node: "../x" }),
    ).toBeNull();
  });
});

describe("the top level as a place of its own", () => {
  test("a workspace moved to the top level stays placed there, unlike an unplaced one", () => {
    const tree = apply(emptyWorkspaceTree(), {
      op: "move",
      subject: { workspace: ocio },
      parent: { root: "list" },
    });
    const node = findWorkspaceNode(tree, ocio)!;
    // Kept although it holds nothing: the root is an explicit placement.
    expect(node.parent).toBeNull();
    expect(node.root).toBe("list");
    expect(workspaceTreeRootPlace(node)).toBe("list");
    expect(workspaceTreeNodePlaced(node)).toBe(true);
    // An unplaced parent only holds children, and is not placed.
    const holder = apply(emptyWorkspaceTree(), {
      op: "move",
      subject: { workspace: upColor },
      parent: { workspace: upRs },
    });
    const rs = findWorkspaceNode(holder, upRs)!;
    expect(workspaceTreeRootPlace(rs)).toBeNull();
    expect(workspaceTreeNodePlaced(rs)).toBe(false);
  });

  test("moves out of a group to the top, in order, and back to the usual place", () => {
    let tree = apply(
      emptyWorkspaceTree(),
      { op: "create_group", id: "g", label: "mine", parent: null },
      { op: "move", subject: { workspace: ocio }, parent: { node: "g" } },
    );
    tree = apply(tree, {
      op: "move",
      subject: { workspace: ocio },
      parent: { root: "top" },
      before: { node: "g" },
    });
    expect(shape(tree)).toEqual(["gstreamer-ocio", "[mine]"]);
    expect(findWorkspaceNode(tree, ocio)?.root).toBe("top");
    tree = apply(tree, {
      op: "move",
      subject: { workspace: ocio },
      parent: { root: "bottom" },
    });
    expect(findWorkspaceNode(tree, ocio)?.root).toBe("bottom");
    // Into a parent: the root place is dropped.
    tree = apply(tree, {
      op: "move",
      subject: { workspace: ocio },
      parent: { node: "g" },
    });
    expect(findWorkspaceNode(tree, ocio)?.root).toBeUndefined();
    tree = apply(
      tree,
      { op: "move", subject: { workspace: ocio }, parent: { root: "list" } },
      { op: "move", subject: { workspace: ocio }, parent: null },
    );
    expect(findWorkspaceNode(tree, ocio)).toBeUndefined();
  });

  test("groups go above the list, or below it", () => {
    let tree = apply(emptyWorkspaceTree(), {
      op: "create_group",
      id: "g",
      label: "later",
      parent: { root: "bottom" },
    });
    expect(tree.nodes[0]).toMatchObject({ parent: null, root: "bottom" });
    expect(workspaceTreeRootPlace(tree.nodes[0]!)).toBe("bottom");
    tree = apply(tree, { op: "move", subject: { node: "g" }, parent: null });
    expect(tree.nodes[0]?.kind === "group" && tree.nodes[0].root).toBe(
      undefined,
    );
    expect(workspaceTreeRootPlace(tree.nodes[0]!)).toBe("top");
    // "list" means nothing for a group: it shows at the top.
    tree = apply(tree, {
      op: "move",
      subject: { node: "g" },
      parent: { root: "list" },
    });
    expect(workspaceTreeRootPlace(tree.nodes[0]!)).toBe("top");
  });

  test("survives a round trip through storage and RPC", () => {
    const tree = apply(
      emptyWorkspaceTree(),
      { op: "move", subject: { workspace: ocio }, parent: { root: "list" } },
      { op: "create_group", id: "g", label: "b", parent: { root: "bottom" } },
    );
    expect(parseWorkspaceTree(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
    // A root place under a parent is dropped, and nonsense ignored.
    expect(
      parseWorkspaceTree({
        nodes: [
          { id: "g", kind: "group", parent: null, label: "g" },
          { id: "a", kind: "workspace", parent: "g", ref: ocio, root: "top" },
          { id: "b", kind: "workspace", parent: null, ref: upColor, root: "x" },
        ],
      }).nodes,
    ).toEqual([
      { id: "g", kind: "group", parent: null, label: "g" },
      { id: "a", kind: "workspace", parent: "g", ref: ocio },
    ]);
    expect(
      parseWorkspaceTreeOp({
        op: "move",
        subject: { node: "a" },
        parent: { root: "top" },
      }),
    ).toEqual({ op: "move", subject: { node: "a" }, parent: { root: "top" } });
    expect(
      parseWorkspaceTreeOp({
        op: "move",
        subject: { node: "a" },
        parent: { root: "sideways" },
      }),
    ).toBeNull();
  });

  test("set_collapsed keeps a group's place", () => {
    const tree = apply(
      emptyWorkspaceTree(),
      { op: "create_group", id: "g", label: "b", parent: { root: "bottom" } },
      { op: "set_collapsed", node: "g", collapsed: true },
      { op: "set_collapsed", node: "g", collapsed: false },
    );
    expect(tree.nodes).toEqual([
      { id: "g", kind: "group", parent: null, label: "b", root: "bottom" },
    ]);
  });
});

describe("recognising workspaces again", () => {
  const arranged = apply(
    emptyWorkspaceTree(),
    {
      op: "create_group",
      id: "g",
      label: "upstreaming",
      parent: { workspace: ocio },
    },
    { op: "move", subject: { workspace: upColor }, parent: { node: "g" } },
    { op: "move", subject: { workspace: upRs }, parent: { node: "g" } },
    {
      op: "move",
      subject: {
        workspace: {
          connection_id: "local",
          label: "notes",
          workspace_id: "w9",
        },
      },
      parent: { node: "g" },
    },
  );

  test("matches by path after a Herdr restart renumbers the workspaces", () => {
    const resolved = resolveWorkspaceTree(
      arranged,
      new Map([
        [
          "local",
          [
            { workspace_id: "w31", label: "gstreamer-ocio", path: ocio.path },
            { workspace_id: "w30", label: "up-colorspace", path: upColor.path },
            { workspace_id: "w32", label: "notes" },
          ],
        ],
        [
          "desktop",
          [{ workspace_id: "w3", label: "up-ocio", path: upRs.path }],
        ],
      ]),
    );
    const state = (ref: WorkspaceRef) =>
      resolved.nodes.get(findWorkspaceNode(arranged, ref)!.id);
    expect(state(ocio)).toEqual({
      state: "live",
      connectionId: "local",
      workspaceId: "w31",
    });
    expect(state(upColor)).toEqual({
      state: "live",
      connectionId: "local",
      workspaceId: "w30",
    });
    expect(state(upRs)).toEqual({
      state: "live",
      connectionId: "desktop",
      workspaceId: "w3",
    });
    expect(state({ connection_id: "local", label: "notes" })).toEqual({
      state: "live",
      connectionId: "local",
      workspaceId: "w32",
    });
    // The new ids go back to the server as hints.
    expect(
      resolved.refreshes.map((each) => each.ref.workspace_id).sort(),
    ).toEqual(["w3", "w30", "w31", "w32"]);
    const refreshed = applyWorkspaceTreeOp(arranged, {
      op: "refresh",
      nodes: resolved.refreshes,
    });
    expect(findWorkspaceNode(refreshed, ocio)?.ref.workspace_id).toBe("w31");
  });

  test("a workspace whose id now belongs to another is not mistaken for it", () => {
    const resolved = resolveWorkspaceTree(
      arranged,
      new Map([
        // w2 is now a different checkout; up-colorspace is not open.
        ["local", [{ workspace_id: "w2", label: "other", path: "/src/other" }]],
        ["desktop", []],
      ]),
    );
    expect(
      resolved.nodes.get(findWorkspaceNode(arranged, upColor)!.id),
    ).toEqual({
      state: "gone",
    });
  });

  test("finds a renamed workspace without a checkout by its last id", () => {
    const resolved = resolveWorkspaceTree(
      arranged,
      new Map([["local", [{ workspace_id: "w9", label: "journal" }]]]),
    );
    const notes = findWorkspaceNode(arranged, {
      connection_id: "local",
      label: "notes",
    })!;
    expect(resolved.nodes.get(notes.id)).toEqual({
      state: "live",
      connectionId: "local",
      workspaceId: "w9",
    });
    expect(resolved.refreshes).toContainEqual({
      node: notes.id,
      ref: { connection_id: "local", label: "journal", workspace_id: "w9" },
    });
  });

  test("a connection that is down leaves its workspaces offline, in place", () => {
    const resolved = resolveWorkspaceTree(
      arranged,
      new Map([
        [
          "local",
          [{ workspace_id: "w1", label: "gstreamer-ocio", path: ocio.path }],
        ],
      ]),
    );
    expect(resolved.nodes.get(findWorkspaceNode(arranged, upRs)!.id)).toEqual({
      state: "offline",
    });
    expect(
      resolved.nodes.get(findWorkspaceNode(arranged, upColor)!.id),
    ).toEqual({
      state: "gone",
    });
    // Nothing moved: the tree is the same, still showing both where they were.
    expect(shape(arranged)).toEqual([
      {
        "gstreamer-ocio": [
          { "[upstreaming]": ["up-colorspace", "up-ocio", "notes"] },
        ],
      },
    ]);
  });
});

describe("workspaces that no longer exist", () => {
  const ges: WorkspaceRef = {
    connection_id: "local",
    path: "/src/gstreamer.worktrees/ges-child-names",
    label: "upstream-ges-child-names",
    workspace_id: "w3",
  };
  // ocio > [upstream] > up-colorspace, ges-child-names, up-ocio (desktop)
  const arranged = apply(
    emptyWorkspaceTree(),
    {
      op: "create_group",
      id: "g",
      label: "upstream",
      parent: { workspace: ocio },
    },
    { op: "move", subject: { workspace: upColor }, parent: { node: "g" } },
    { op: "move", subject: { workspace: ges }, parent: { node: "g" } },
    { op: "move", subject: { workspace: upRs }, parent: { node: "g" } },
  );
  const gesNode = findWorkspaceNode(arranged, ges)!.id;
  const local = [
    { workspace_id: "w1", label: "gstreamer-ocio", path: ocio.path },
    { workspace_id: "w2", label: "up-colorspace", path: upColor.path },
  ];

  test("are the ones a ready connection no longer lists", () => {
    expect(goneWorkspaceTreeNodes(arranged, "local", local)).toEqual([gesNode]);
    // Each connection's nodes are judged by its own list only.
    expect(
      goneWorkspaceTreeNodes(arranged, "desktop", [
        { workspace_id: "w7", label: "up-ocio", path: upRs.path },
      ]),
    ).toEqual([]);
  });

  test("leave their group, the rest in order", () => {
    const tree = removeWorkspaceTreeNodes(
      arranged,
      goneWorkspaceTreeNodes(arranged, "local", local),
    );
    expect(shape(tree)).toEqual([
      { "gstreamer-ocio": [{ "[upstream]": ["up-colorspace", "up-ocio"] }] },
    ]);
  });

  test("an empty list confirms nothing: Herdr may still be restoring", () => {
    expect(goneWorkspaceTreeNodes(arranged, "local", [])).toEqual([]);
  });

  test("one whose name is still listed is not gone, only moved", () => {
    expect(
      goneWorkspaceTreeNodes(arranged, "local", [
        ...local,
        { workspace_id: "w8", label: ges.label!, path: "/tmp" },
      ]),
    ).toEqual([]);
    // A restarted Herdr gives its id to another workspace: still gone.
    expect(
      goneWorkspaceTreeNodes(arranged, "local", [
        ...local,
        { workspace_id: "w3", label: "scratch", path: "/tmp" },
      ]),
    ).toEqual([gesNode]);
  });

  test("a closed workspace takes only its own node", () => {
    const withNotes = apply(arranged, {
      op: "move",
      subject: {
        workspace: {
          connection_id: "local",
          label: "notes",
          workspace_id: "w9",
        },
      },
      parent: { node: "g" },
    });
    expect(
      goneWorkspaceTreeNodes(withNotes, "local", local, {
        workspace_id: "w3",
      }),
    ).toEqual([gesNode]);
    // By its checkout, when its last seen id is stale.
    expect(
      goneWorkspaceTreeNodes(withNotes, "local", local, {
        workspace_id: "w40",
        path: ges.path,
      }),
    ).toEqual([gesNode]);
    // Even the last workspace of a connection.
    expect(
      goneWorkspaceTreeNodes(withNotes, "local", [], {
        workspace_id: "w9",
        label: "notes",
      }),
    ).toEqual([
      findWorkspaceNode(withNotes, { connection_id: "local", label: "notes" })!
        .id,
    ]);
  });
});

describe("automatic placement", () => {
  const gst = (path: string, linked: boolean, id: string) => ({
    connection_id: "local",
    path,
    label: path.split("/").pop(),
    workspace_id: id,
    repo_key: "gstreamer",
    linked,
  });

  test("puts a new workspace under the one that asked, across repositories", () => {
    const tree = autoPlaceWorkspace(
      emptyWorkspaceTree(),
      { ...upRs, repo_key: "gst-plugins-rs", linked: true },
      { ...ocio, repo_key: "gstreamer", linked: true },
    );
    expect(shape(tree)).toEqual([{ "gstreamer-ocio": ["up-ocio"] }]);
  });

  test("puts a worktree made from another worktree under that worktree", () => {
    const tree = autoPlaceWorkspace(
      emptyWorkspaceTree(),
      gst("/src/gstreamer.worktrees/up-colorspace", true, "w2"),
      gst("/src/gstreamer.worktrees/ocio", true, "w1"),
    );
    expect(shape(tree)).toEqual([{ ocio: ["up-colorspace"] }]);
  });

  test("leaves alone what the usual list already nests there", () => {
    const tree = autoPlaceWorkspace(
      emptyWorkspaceTree(),
      gst("/src/gstreamer.worktrees/up-colorspace", true, "w2"),
      gst("/src/gstreamer", false, "w0"),
    );
    expect(tree.nodes).toEqual([]);
  });

  test("never overrides where the user put a workspace", () => {
    const placed = apply(
      emptyWorkspaceTree(),
      { op: "create_group", id: "g", label: "mine", parent: null },
      { op: "move", subject: { workspace: upRs }, parent: { node: "g" } },
    );
    expect(autoPlaceWorkspace(placed, upRs, ocio)).toBe(placed);
  });

  test("never re-nests a worktree the user put at the top level", () => {
    const worktree = gst("/src/gstreamer.worktrees/ocio", true, "w1");
    const placed = apply(emptyWorkspaceTree(), {
      op: "move",
      subject: { workspace: worktree },
      parent: { root: "list" },
    });
    expect(
      autoPlaceWorkspace(
        placed,
        worktree,
        gst("/src/gstreamer.worktrees/up-colorspace", true, "w2"),
      ),
    ).toBe(placed);
  });

  test("builds references from what workspace.list gives", () => {
    expect(
      workspaceRefFor("local", {
        workspace_id: "w4",
        label: "ocio",
        worktree: { checkout_path: "/src/ocio" },
      }),
    ).toEqual({
      connection_id: "local",
      path: "/src/ocio",
      label: "ocio",
      workspace_id: "w4",
    });
  });
});

describe("group paths", () => {
  // gst (a workspace on desktop) > upstreaming (a group) > flushing;
  // a top-level "Reviews" group; a local workspace also named gst under it.
  const tree: WorkspaceTree = {
    version: 1,
    nodes: [
      {
        id: "gst",
        kind: "workspace",
        parent: null,
        ref: { connection_id: "desktop", path: "/src/gst", label: "gst" },
      },
      { id: "up", kind: "group", parent: "gst", label: "upstreaming" },
      {
        id: "flush",
        kind: "workspace",
        parent: "up",
        ref: { connection_id: "desktop", path: "/src/gst.worktrees/flushing" },
      },
      { id: "rev", kind: "group", parent: null, label: "Reviews" },
      {
        id: "gst-local",
        kind: "workspace",
        parent: "rev",
        ref: { connection_id: "local", label: "gst" },
      },
    ],
  };
  let ids = 0;
  const newId = () => `new${++ids}`;

  test("a path splits on / or >, and empty names drop", () => {
    expect(parseWorkspaceTreePath("gst/upstreaming")).toEqual([
      "gst",
      "upstreaming",
    ]);
    expect(parseWorkspaceTreePath(" gst > Upstreaming / ")).toEqual([
      "gst",
      "Upstreaming",
    ]);
    expect(parseWorkspaceTreePath(" / ")).toEqual([]);
  });

  test("names match case-insensitively from the top, through workspaces", () => {
    expect(resolveWorkspaceTreePath(tree, ["GST", "Upstreaming"])).toEqual({
      node: "up",
      ops: [],
      found: ["gst", "upstreaming"],
    });
    // A workspace named by its checkout's last directory.
    expect(
      resolveWorkspaceTreePath(tree, ["gst", "upstreaming", "flushing"])?.node,
    ).toBe("flush");
    expect(resolveWorkspaceTreePath(tree, ["reviews", "gst"])?.node).toBe(
      "gst-local",
    );
  });

  test("a path not found from the top is tried from each base", () => {
    expect(resolveWorkspaceTreePath(tree, ["upstreaming"])).toBeNull();
    expect(
      resolveWorkspaceTreePath(tree, ["upstreaming"], {
        bases: [null, "up", "gst"],
      })?.node,
    ).toBe("up");
    // The top level first, whatever the bases.
    expect(
      resolveWorkspaceTreePath(tree, ["gst"], { bases: [null, "rev"] })?.node,
    ).toBe("gst");
    // A base that is gone is skipped.
    expect(
      resolveWorkspaceTreePath(tree, ["upstreaming"], {
        bases: ["gone", "gst"],
      })?.node,
    ).toBe("up");
  });

  test("a workspace on the preferred connection wins a level, then groups", () => {
    const twin: WorkspaceTree = {
      version: 1,
      nodes: [
        { id: "g", kind: "group", parent: null, label: "misc" },
        {
          id: "w-desktop",
          kind: "workspace",
          parent: null,
          root: "top",
          ref: { connection_id: "desktop", label: "misc" },
        },
      ],
    };
    expect(resolveWorkspaceTreePath(twin, ["misc"])?.node).toBe("g");
    expect(
      resolveWorkspaceTreePath(twin, ["misc"], { preferConnection: "desktop" })
        ?.node,
    ).toBe("w-desktop");
  });

  test("a level with several matches takes the one the rest of the path goes on from", () => {
    const twin: WorkspaceTree = {
      version: 1,
      nodes: [
        { id: "a", kind: "group", parent: null, label: "gst" },
        { id: "b", kind: "group", parent: null, label: "gst" },
        { id: "b-up", kind: "group", parent: "b", label: "upstreaming" },
      ],
    };
    expect(resolveWorkspaceTreePath(twin, ["gst", "upstreaming"])?.node).toBe(
      "b-up",
    );
  });

  test("create makes the missing groups under the deepest match", () => {
    ids = 0;
    const made = resolveWorkspaceTreePath(
      tree,
      ["gst", "upstreaming", "soundtouch", "pc"],
      { create: true, newId },
    );
    expect(made).toEqual({
      node: "new2",
      ops: [
        {
          op: "create_group",
          id: "new1",
          label: "soundtouch",
          parent: { node: "up" },
        },
        {
          op: "create_group",
          id: "new2",
          label: "pc",
          parent: { node: "new1" },
        },
      ],
      found: ["gst", "upstreaming"],
    });
    // Nothing matches: a top-level group.
    ids = 0;
    expect(
      resolveWorkspaceTreePath(tree, ["Later"], { create: true, newId })?.ops,
    ).toEqual([
      {
        op: "create_group",
        id: "new1",
        label: "Later",
        parent: { root: "top" },
      },
    ]);
    // The ops apply as they are.
    let next = tree;
    for (const op of made!.ops) next = applyWorkspaceTreeOp(next, op);
    expect(
      resolveWorkspaceTreePath(
        next,
        ["gst/upstreaming/soundtouch/pc"].flatMap(parseWorkspaceTreePath),
      )?.node,
    ).toBe("new2");
  });

  test("create from a base when it reaches deeper than the top", () => {
    ids = 0;
    expect(
      resolveWorkspaceTreePath(tree, ["upstreaming", "new"], {
        bases: [null, "gst"],
        create: true,
        newId,
      })?.ops,
    ).toEqual([
      {
        op: "create_group",
        id: "new1",
        label: "new",
        parent: { node: "up" },
      },
    ]);
  });

  test("an empty path leads nowhere", () => {
    expect(resolveWorkspaceTreePath(tree, [" "], { create: true })).toBeNull();
  });

  test("group paths list groups and workspaces holding others", () => {
    expect(workspaceTreeGroupPaths(tree)).toEqual([
      {
        node: "gst",
        kind: "workspace",
        names: ["gst"],
        connection_id: "desktop",
      },
      { node: "up", kind: "group", names: ["gst", "upstreaming"] },
      { node: "rev", kind: "group", names: ["Reviews"] },
    ]);
  });

  test("ancestors go from a node to the top", () => {
    expect(workspaceTreeAncestors(tree, "flush")).toEqual([
      "flush",
      "up",
      "gst",
    ]);
    expect(workspaceTreeAncestors(tree, null)).toEqual([]);
  });
});
