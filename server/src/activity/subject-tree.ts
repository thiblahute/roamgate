import {
  findWorkspaceNode,
  type WorkspaceTree,
} from "../../../shared/workspaceTree";
import type { ExplicitGroups, SubjectGroup } from "./subjects";

/**
 * The explicit groups of the Workspaces tree holding a workspace, top
 * first: the group nodes above its node. Workspaces nested under another
 * workspace are not groups, only the groups the user made are.
 */
export function treeExplicitGroups(tree: WorkspaceTree): ExplicitGroups {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  return (workspace) => {
    const node =
      (workspace.path
        ? findWorkspaceNode(tree, {
            connection_id: workspace.connection_id,
            path: workspace.path,
          })
        : undefined) ??
      findWorkspaceNode(tree, {
        connection_id: workspace.connection_id,
        label: workspace.name,
      });
    if (!node) return null;
    const groups: SubjectGroup[] = [];
    const seen = new Set<string>();
    for (
      let parent = node.parent ? byId.get(node.parent) : undefined;
      parent && !seen.has(parent.id);
      parent = parent.parent ? byId.get(parent.parent) : undefined
    ) {
      seen.add(parent.id);
      if (parent.kind === "group")
        groups.unshift({ id: `tree:${parent.id}`, label: parent.label });
    }
    return groups.length ? groups : null;
  };
}
