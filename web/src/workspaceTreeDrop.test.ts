import { describe, expect, test } from "bun:test";
import {
  applyWorkspaceTreeOp,
  emptyWorkspaceTree,
  findWorkspaceNode,
  type WorkspaceRef,
  type WorkspaceTree,
  type WorkspaceTreeOp,
} from "../../shared/workspaceTree";
import {
  edgeDropPlan,
  gapDropPlan,
  gapLevel,
  type RowParent,
  type RowSlot,
  slotAtLevel,
  type WorkspaceDragItem,
} from "./workspaceTreeDrop";

const INDENT = 12;

function ref(label: string, connection = "local"): WorkspaceRef {
  return {
    connection_id: connection,
    path: `/src/${label}`,
    label,
    workspace_id: label,
  };
}

function workspaceItem(
  label: string,
  options: { connection?: string; nodeId?: string; placed?: boolean } = {},
): WorkspaceDragItem {
  const connection = options.connection ?? "local";
  return {
    kind: "workspace",
    key: `w:${connection}:${label}`,
    connectionId: connection,
    ref: ref(label, connection),
    workspaceId: label,
    nodeId: options.nodeId,
    placed: options.placed ?? false,
  };
}

function slot(
  item: RowSlot["item"],
  parent: RowParent,
  ancestors: RowSlot[] = [],
): RowSlot {
  return { item, depth: ancestors.length, parent, ancestors };
}

const LIST: RowParent = { kind: "root", place: "list" };
const context = (tree: WorkspaceTree = emptyWorkspaceTree()) => ({
  tree,
  canReorder: (connectionId: string) => connectionId === "local",
});

describe("which level a gap means", () => {
  test("between rows at one level, that level whatever the pointer", () => {
    expect(gapLevel(0, 0, 0, INDENT)).toBe(0);
    expect(gapLevel(0, 0, 300, INDENT)).toBe(0);
    expect(gapLevel(2, 2, 0, INDENT)).toBe(2);
  });

  test("between a deeper row and a shallower one, the pointer picks", () => {
    // After a row at depth 2, before one at depth 0: 6px base, 12px steps.
    expect(gapLevel(2, 0, 200, INDENT)).toBe(2);
    expect(gapLevel(2, 0, 6 + 2 * INDENT, INDENT)).toBe(2);
    expect(gapLevel(2, 0, 6 + INDENT + 1, INDENT)).toBe(1);
    expect(gapLevel(2, 0, 6 + 3, INDENT)).toBe(0);
    expect(gapLevel(2, 0, 0, INDENT)).toBe(0);
    // Never shallower than the row that follows.
    expect(gapLevel(2, 1, 0, INDENT)).toBe(1);
  });

  test("the last row of the list can go up to the top level", () => {
    expect(gapLevel(1, 0, 0, INDENT)).toBe(0);
  });

  test("a level picks the row's ancestor there", () => {
    const repo = slot(workspaceItem("gstreamer"), LIST);
    const worktree = slot(
      workspaceItem("gstreamer-ocio"),
      { kind: "usual", workspace: repo.item as WorkspaceDragItem },
      [repo],
    );
    expect(slotAtLevel(worktree, 1)).toBe(worktree);
    expect(slotAtLevel(worktree, 0)).toBe(repo);
  });
});

describe("dropping between rows", () => {
  const repo = slot(workspaceItem("gstreamer"), LIST);
  const notes = slot(workspaceItem("notes"), LIST);
  const ocio = slot(
    workspaceItem("gstreamer-ocio"),
    { kind: "usual", workspace: repo.item as WorkspaceDragItem },
    [repo],
  );

  test("a repo-nested worktree between two top-level rows goes to the top level there", () => {
    const plan = gapDropPlan(ocio, notes, "before", context());
    expect(plan).toEqual({
      ops: [
        {
          op: "move",
          subject: { workspace: ref("gstreamer-ocio") },
          parent: { root: "list" },
        },
      ],
      reorder: {
        draggedId: "gstreamer-ocio",
        targetId: "notes",
        position: "before",
      },
    });
    // Applied, the worktree is placed at the top level and stays there.
    const tree = plan!.ops.reduce(applyWorkspaceTreeOp, emptyWorkspaceTree());
    expect(findWorkspaceNode(tree, ref("gstreamer-ocio"))?.root).toBe("list");
  });

  test("the gap after a nested row, pointer to the left: the top level, after its repository", () => {
    // ocio is the last row under gstreamer, notes follows at depth 0.
    const level = gapLevel(ocio.depth, notes.depth, 2, INDENT);
    expect(level).toBe(0);
    const plan = gapDropPlan(
      slot(workspaceItem("scratch"), {
        kind: "node",
        nodeId: "g",
      }),
      slotAtLevel(ocio, level),
      "after",
      context(),
    );
    expect(plan?.ops[0]).toMatchObject({ parent: { root: "list" } });
    expect(plan?.reorder).toEqual({
      draggedId: "scratch",
      targetId: "gstreamer",
      position: "after",
    });
  });

  test("the same gap, pointer at the nested level: under that repository", () => {
    const level = gapLevel(ocio.depth, notes.depth, 200, INDENT);
    expect(level).toBe(1);
    const plan = gapDropPlan(
      slot(workspaceItem("scratch"), LIST),
      slotAtLevel(ocio, level),
      "after",
      context(),
    );
    expect(plan?.ops).toEqual([
      {
        op: "move",
        subject: { workspace: ref("scratch") },
        parent: { workspace: ref("gstreamer") },
      },
    ]);
  });

  test("a top-level row moved among top-level rows only changes Herdr's order", () => {
    expect(
      gapDropPlan(
        slot(workspaceItem("other"), LIST),
        notes,
        "after",
        context(),
      ),
    ).toEqual({
      ops: [],
      reorder: { draggedId: "other", targetId: "notes", position: "after" },
    });
  });

  test("worktrees of one repository reorder among themselves in Herdr", () => {
    const sibling = slot(
      workspaceItem("gstreamer-up"),
      { kind: "usual", workspace: repo.item as WorkspaceDragItem },
      [repo],
    );
    expect(gapDropPlan(sibling, ocio, "before", context())).toEqual({
      ops: [],
      reorder: {
        draggedId: "gstreamer-up",
        targetId: "gstreamer-ocio",
        position: "before",
      },
    });
  });

  test("between rows in a group: a sibling there, in order", () => {
    const tree = [
      { op: "create_group", id: "g", label: "mine", parent: null },
      { op: "move", subject: { workspace: ref("a") }, parent: { node: "g" } },
      { op: "move", subject: { workspace: ref("b") }, parent: { node: "g" } },
    ].reduce(
      (each, op) => applyWorkspaceTreeOp(each, op as WorkspaceTreeOp),
      emptyWorkspaceTree(),
    );
    const a = findWorkspaceNode(tree, ref("a"))!;
    const b = findWorkspaceNode(tree, ref("b"))!;
    const group = slot(
      { kind: "node", key: "node:g", nodeId: "g", placed: true },
      {
        kind: "root",
        place: "top",
      },
    );
    const rowA = slot(
      workspaceItem("a", { nodeId: a.id, placed: true }),
      { kind: "node", nodeId: "g" },
      [group],
    );
    const plan = gapDropPlan(
      slot(workspaceItem("notes"), LIST),
      rowA,
      "after",
      context(tree),
    );
    expect(plan?.ops).toEqual([
      {
        op: "move",
        subject: { workspace: ref("notes") },
        parent: { node: "g" },
        before: { node: b.id },
      },
    ]);
    const after = plan!.ops.reduce(applyWorkspaceTreeOp, tree);
    expect(
      after.nodes
        .filter((node) => node.parent === "g")
        .map((node) => (node.kind === "workspace" ? node.ref.label : "")),
    ).toEqual(["a", "notes", "b"]);
  });

  test("between groups above the list: the top level, above it", () => {
    const group = slot(
      { kind: "node", key: "node:g", nodeId: "g", placed: true },
      {
        kind: "root",
        place: "top",
      },
    );
    expect(gapDropPlan(ocio, group, "before", context())?.ops).toEqual([
      {
        op: "move",
        subject: { workspace: ref("gstreamer-ocio") },
        parent: { root: "top" },
        before: { node: "g" },
      },
    ]);
  });

  test("refuses what cannot land there", () => {
    // Inside itself.
    expect(gapDropPlan(repo, ocio, "after", context())).toBeNull();
    // Next to itself.
    expect(gapDropPlan(notes, notes, "before", context())).toBeNull();
    // A group has no place in Herdr's list.
    const group = slot(
      { kind: "node", key: "node:g", nodeId: "g", placed: true },
      {
        kind: "root",
        place: "top",
      },
    );
    expect(gapDropPlan(group, notes, "before", context())).toBeNull();
    // Another connection's list: lifted to the top level, Herdr's order
    // left alone.
    expect(
      gapDropPlan(
        slot(workspaceItem("far", { connection: "desktop" }), LIST),
        notes,
        "before",
        context(),
      ),
    ).toBeNull();
    expect(
      gapDropPlan(
        slot(workspaceItem("far", { connection: "desktop" }), {
          kind: "node",
          nodeId: "g",
        }),
        notes,
        "before",
        context(),
      ),
    ).toEqual({
      ops: [
        {
          op: "move",
          subject: { workspace: ref("far", "desktop") },
          parent: { root: "list" },
        },
      ],
    });
  });

  test("another connection's list keeps Herdr's order but still lifts to the top level", () => {
    const far = slot(workspaceItem("far", { connection: "desktop" }), LIST);
    const nested = slot(
      workspaceItem("far-wt", { connection: "desktop" }),
      { kind: "usual", workspace: far.item as WorkspaceDragItem },
      [far],
    );
    const other = slot(workspaceItem("far-2", { connection: "desktop" }), LIST);
    expect(gapDropPlan(nested, other, "before", context())).toEqual({
      ops: [
        {
          op: "move",
          subject: { workspace: ref("far-wt", "desktop") },
          parent: { root: "list" },
        },
      ],
    });
  });
});

describe("the very top and bottom of the list", () => {
  const ocio = slot(workspaceItem("gstreamer-ocio"), LIST);
  test("the top goes above the first row shown there", () => {
    expect(edgeDropPlan(ocio, "top", "g")).toEqual({
      ops: [
        {
          op: "move",
          subject: { workspace: ref("gstreamer-ocio") },
          parent: { root: "top" },
          before: { node: "g" },
        },
      ],
    });
  });
  test("the bottom goes last, below the list", () => {
    expect(edgeDropPlan(ocio, "bottom", "g").ops).toEqual([
      {
        op: "move",
        subject: { workspace: ref("gstreamer-ocio") },
        parent: { root: "bottom" },
      },
    ]);
  });
});
