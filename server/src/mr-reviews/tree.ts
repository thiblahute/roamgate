import {
  newWorkspaceTreeGroupId,
  resolveWorkspaceTreePath,
  type WorkspaceRef,
  type WorkspaceTree,
  type WorkspaceTreeOp,
} from "../../../shared/workspaceTree";

/**
 * Where a project's review workspace goes in the Workspaces tree: the
 * project's `tree_group` setting (a path of names: groups, or workspaces,
 * which hold children too), else a "Reviews" group under the workspace of
 * the project's clone when the tree has it, else a top-level "Reviews"
 * group. Names match case-insensitively (resolveWorkspaceTreePath, as the
 * agents' --group); missing groups are created.
 */

export const DEFAULT_GROUP = "Reviews";

export function reviewPlacementOps(
  tree: WorkspaceTree,
  target: {
    /** The review workspace. */
    ref: WorkspaceRef;
    connectionId: string;
    clonePath: string;
    /** The project's `tree_group` setting. */
    path?: string[];
  },
  newId: () => string = newWorkspaceTreeGroupId,
): WorkspaceTreeOp[] {
  const path = target.path?.map((part) => part.trim()).filter(Boolean);
  const clone = tree.nodes.find(
    (node) =>
      node.kind === "workspace" &&
      node.ref.connection_id === target.connectionId &&
      node.ref.path === target.clonePath,
  );
  const resolved = path?.length
    ? resolveWorkspaceTreePath(tree, path, {
        create: true,
        preferConnection: target.connectionId,
        newId,
      })
    : resolveWorkspaceTreePath(tree, [DEFAULT_GROUP], {
        bases: [clone?.id ?? null],
        create: true,
        newId,
      });
  return [
    ...resolved!.ops,
    {
      op: "move",
      subject: { workspace: target.ref },
      parent: { node: resolved!.node },
    },
  ];
}
