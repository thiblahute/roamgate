/**
 * Where a row dragged in the Workspaces list lands. A drop on a row's middle
 * nests it there; a drop in the gap between two rows makes it a sibling at
 * the level of the rows around that gap, the pointer's horizontal position
 * choosing between a deeper row and a shallower one as tree editors do.
 */
import {
  type WorkspaceRef,
  type WorkspaceTree,
  type WorkspaceTreeOp,
  type WorkspaceTreeRootPlace,
  type WorkspaceTreeTarget,
  workspaceTreeChildren,
} from "../../shared/workspaceTree";
import type { DropZone } from "./workspaceTreeView";

/** Something being dragged, or a row it may drop on. */
export type TreeDragItem =
  | {
      kind: "workspace";
      key: string;
      connectionId: string;
      ref: WorkspaceRef;
      workspaceId: string;
      nodeId?: string;
      /** Placed by the user (under a parent or at the top level). */
      placed: boolean;
    }
  | { kind: "node"; key: string; nodeId: string; placed: boolean };

export type WorkspaceDragItem = Extract<TreeDragItem, { kind: "workspace" }>;

/** What holds a row: the top level, an arranged node, or its repository. */
export type RowParent =
  | {
      kind: "root";
      /** "list": Herdr's list, in Herdr's order; else above or below it. */
      place: WorkspaceTreeRootPlace;
    }
  | { kind: "node"; nodeId: string }
  /** The usual list nests it (a worktree under its main checkout). */
  | { kind: "usual"; workspace: WorkspaceDragItem };

/** A row as shown, with the rows above it in the tree. */
export type RowSlot = {
  item: TreeDragItem;
  depth: number;
  parent: RowParent;
  /** Its ancestors' rows, from the top level down. */
  ancestors: readonly RowSlot[];
};

/** A drop target: a row's zone and, in a gap, the level chosen. */
export type DropTarget = { key: string; zone: DropZone; level: number };

/** Herdr's own order, for rows in Herdr's list. */
export type DropReorder = {
  draggedId: string;
  targetId: string;
  position: "before" | "after";
};

export type DropPlan = { ops: WorkspaceTreeOp[]; reorder?: DropReorder };

/**
 * The level a gap after a row of `depth` means, before a row of `nextDepth`
 * (0 at the end of the list). Between a deeper row and a shallower one, the
 * pointer picks: each indent step left of the row's own indentation goes one
 * level up. `offsetX` is from the row's left edge.
 */
export function gapLevel(
  depth: number,
  nextDepth: number,
  offsetX: number,
  indent: number,
  base = 6,
): number {
  const shallowest = Math.min(depth, Math.max(0, nextDepth));
  const pointed = Math.floor((offsetX - base) / indent);
  return Math.max(shallowest, Math.min(depth, pointed));
}

/** The row at `level` in a slot's line of ancestors, the slot itself at its own. */
export function slotAtLevel(slot: RowSlot, level: number): RowSlot {
  if (level >= slot.depth) return slot;
  return slot.ancestors[Math.max(0, level)] ?? slot;
}

export function dragTarget(item: TreeDragItem): WorkspaceTreeTarget {
  if (item.kind === "node" || item.nodeId)
    return { node: item.nodeId as string };
  return { workspace: item.ref };
}

export type GapContext = {
  tree: WorkspaceTree;
  /** Whether Herdr's order on a connection can be changed from here. */
  canReorder: (connectionId: string) => boolean;
};

/** What dropping `subject` in the gap before or after `anchor` does. */
export function gapDropPlan(
  subject: RowSlot,
  anchor: RowSlot,
  position: "before" | "after",
  context: GapContext,
): DropPlan | null {
  const item = subject.item;
  if (anchor.item.key === item.key) return null;
  // Not inside itself.
  if (anchor.ancestors.some((each) => each.item.key === item.key)) return null;
  const subjectTarget = dragTarget(item);
  const parent = anchor.parent;
  const anchorNode = anchor.item.nodeId;
  /** The sibling it goes before, in the tree's order under `parentId`. */
  const beforeIn = (parentId: string | null): WorkspaceTreeTarget | null => {
    if (!anchorNode) return null;
    if (position === "before") return { node: anchorNode };
    const siblings = workspaceTreeChildren(context.tree, parentId).filter(
      (node) => node.id !== item.nodeId,
    );
    const at = siblings.findIndex((node) => node.id === anchorNode);
    const next = at >= 0 ? siblings[at + 1] : undefined;
    return next ? { node: next.id } : null;
  };
  if (parent.kind === "node") {
    const before = beforeIn(parent.nodeId);
    return {
      ops: [
        {
          op: "move",
          subject: subjectTarget,
          parent: { node: parent.nodeId },
          ...(before ? { before } : {}),
        },
      ],
    };
  }
  if (parent.kind === "usual") {
    const holder = parent.workspace;
    const sameHolder =
      subject.parent.kind === "usual" &&
      subject.parent.workspace.key === holder.key;
    if (sameHolder) {
      // Already beside it: only Herdr's order can change.
      return item.kind === "workspace" &&
        anchor.item.kind === "workspace" &&
        context.canReorder(item.connectionId)
        ? {
            ops: [],
            reorder: {
              draggedId: item.workspaceId,
              targetId: anchor.item.workspaceId,
              position,
            },
          }
        : null;
    }
    // Under the same workspace as the user's: shown before its usual ones.
    return {
      ops: [{ op: "move", subject: subjectTarget, parent: dragTarget(holder) }],
    };
  }
  if (parent.place !== "list") {
    const before = beforeIn(null);
    return {
      ops: [
        {
          op: "move",
          subject: subjectTarget,
          parent: { root: parent.place },
          ...(before ? { before } : {}),
        },
      ],
    };
  }
  // Herdr's list: a workspace of that connection takes the top level there,
  // at that position in Herdr's order.
  if (item.kind !== "workspace" || anchor.item.kind !== "workspace")
    return null;
  // Another connection's list: the top level still, at its own connection's
  // place in Herdr's order.
  const sameConnection = item.connectionId === anchor.item.connectionId;
  const alreadyThere =
    subject.parent.kind === "root" && subject.parent.place === "list";
  const ops: WorkspaceTreeOp[] = alreadyThere
    ? []
    : [{ op: "move", subject: subjectTarget, parent: { root: "list" } }];
  const reorder =
    sameConnection && context.canReorder(item.connectionId)
      ? {
          draggedId: item.workspaceId,
          targetId: anchor.item.workspaceId,
          position,
        }
      : undefined;
  if (!ops.length && !reorder) return null;
  return { ops, ...(reorder ? { reorder } : {}) };
}

/**
 * The very top or bottom of the list: the top level, above or below
 * everything. `first` is the node shown first at the top, if any.
 */
export function edgeDropPlan(
  subject: RowSlot,
  edge: "top" | "bottom",
  first: string | undefined,
): DropPlan {
  const before =
    edge === "top" && first && first !== subject.item.nodeId
      ? { before: { node: first } }
      : {};
  return {
    ops: [
      {
        op: "move",
        subject: dragTarget(subject.item),
        parent: { root: edge },
        ...before,
      },
    ],
  };
}
