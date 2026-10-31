import {
  applyWorkspaceTreeOp,
  autoPlaceWorkspace,
  emptyWorkspaceTree,
  findWorkspaceNode,
  parseWorkspaceTreePath,
  resolveWorkspaceTreePath,
  type WorkspaceRef,
  type WorkspaceTree,
  WorkspaceTreeError,
  type WorkspaceTreeOp,
  workspaceRefFor,
  workspaceTreeAncestors,
  workspaceTreeGroupPaths,
  workspaceTreeNodeName,
} from "../../../shared/workspaceTree";
import {
  type GuiSettings,
  readGuiSettings,
  updateGuiSettings,
} from "./gui-settings";

/** The arrangement is configuration: refuse one grown past any real use. */
export const WORKSPACE_TREE_MAX_BYTES = 512 * 1024;

type Listener = (tree: WorkspaceTree) => void;
const listeners = new Set<Listener>();

/** Called with the new arrangement after every change, whoever made it. */
export function onWorkspaceTreeChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function treeOf(settings: Pick<GuiSettings, "workspace_tree">): WorkspaceTree {
  return settings.workspace_tree ?? emptyWorkspaceTree();
}

export async function readWorkspaceTree(
  read: () => Promise<GuiSettings> = readGuiSettings,
): Promise<WorkspaceTree> {
  return treeOf(await read());
}

/**
 * Applies operations in one settings write, so two browsers rearranging at
 * once both land, and tells every listener. Throws WorkspaceTreeError when
 * one cannot apply; nothing is written then.
 */
export async function applyWorkspaceTreeOps(
  ops: readonly WorkspaceTreeOp[],
  {
    shouldCommit = () => true,
    update = updateGuiSettings,
  }: {
    shouldCommit?: () => boolean;
    update?: typeof updateGuiSettings;
  } = {},
): Promise<WorkspaceTree> {
  let changed = false;
  const settings = await update((current) => {
    const before = treeOf(current);
    let tree = before;
    for (const op of ops) tree = applyWorkspaceTreeOp(tree, op);
    if (tree === before) return current;
    if (
      Buffer.byteLength(JSON.stringify(tree), "utf8") > WORKSPACE_TREE_MAX_BYTES
    )
      throw new Error("The workspace arrangement is too large.");
    changed = true;
    const next = { ...current };
    if (tree.nodes.length) next.workspace_tree = tree;
    else delete next.workspace_tree;
    return next;
  }, shouldCommit);
  const tree = treeOf(settings);
  if (changed) for (const listener of listeners) listener(tree);
  return tree;
}

type HerdrWorkspace = {
  workspace_id: string;
  label: string;
  cwd?: string;
  worktree?: {
    checkout_path?: string;
    repo_key?: string;
    is_linked_worktree?: boolean;
  } | null;
};

function placementRef(connectionId: string, workspace: HerdrWorkspace) {
  return {
    ...workspaceRefFor(connectionId, workspace),
    ...(workspace.worktree?.repo_key
      ? { repo_key: workspace.worktree.repo_key }
      : {}),
    ...(workspace.worktree
      ? { linked: workspace.worktree.is_linked_worktree === true }
      : {}),
  };
}

/**
 * Automatic placement: a workspace made for an agent goes under the
 * workspace that agent works in (autoPlaceWorkspace says when it is left
 * alone). Returns whether the arrangement changed.
 */
export async function placeCreatedWorkspace(
  input: {
    connectionId: string;
    workspace: HerdrWorkspace | null | undefined;
    parentConnectionId?: string;
    parent: HerdrWorkspace | null | undefined;
  },
  update: typeof updateGuiSettings = updateGuiSettings,
): Promise<boolean> {
  const { workspace, parent } = input;
  if (!workspace?.workspace_id || !parent?.workspace_id) return false;
  let changed = false;
  const settings = await update((current) => {
    const before = treeOf(current);
    const tree = autoPlaceWorkspace(
      before,
      placementRef(input.connectionId, workspace),
      placementRef(input.parentConnectionId ?? input.connectionId, parent),
    );
    if (tree === before) return current;
    changed = true;
    return { ...current, workspace_tree: tree };
  });
  if (changed) {
    const tree = treeOf(settings);
    for (const listener of listeners) listener(tree);
  }
  return changed;
}

/**
 * Where an agent's group path starts from: the top level, then the group
 * its workspace sits in and each one above (for one in its usual place,
 * the main checkout the list nests it under and what holds that).
 */
function agentPathBases(
  tree: WorkspaceTree,
  asker: { ref?: WorkspaceRef; usualParent?: WorkspaceRef },
): (string | null)[] {
  const node = asker.ref ? findWorkspaceNode(tree, asker.ref) : undefined;
  const placed = node && (node.parent !== null || node.root);
  const start = placed
    ? node.parent
    : asker.usualParent
      ? (findWorkspaceNode(tree, asker.usualParent)?.id ?? null)
      : null;
  return [null, ...workspaceTreeAncestors(tree, start)];
}

/**
 * An agent putting a workspace into a group (`roamgate-review worktree|
 * workspace|place --group PATH`): the operations that move it there,
 * after any that make missing groups when `create` allows. The path is
 * group names ("gst/upstreaming" or "gst > upstreaming"; a workspace
 * holding others counts as a group), matched case-insensitively from the
 * top level, else from the agent's own group upwards. Throws
 * WorkspaceTreeError when it leads nowhere.
 */
export function agentGroupPlacementOps(
  tree: WorkspaceTree,
  input: {
    /** What goes there; without it, only whether the path leads somewhere. */
    subject?: WorkspaceRef;
    /** The agent's workspace. */
    asker?: WorkspaceRef;
    /** Its repository's main checkout, when the list nests it there. */
    askerUsualParent?: WorkspaceRef;
    group: string;
    create?: boolean;
    newId?: () => string;
  },
): { ops: WorkspaceTreeOp[]; path: string[]; created: string[] } {
  const names = parseWorkspaceTreePath(input.group);
  if (!names.length) throw new WorkspaceTreeError("The group path is empty.");
  const resolved = resolveWorkspaceTreePath(tree, names, {
    bases: agentPathBases(tree, {
      ref: input.asker,
      usualParent: input.askerUsualParent,
    }),
    create: input.create === true,
    preferConnection: (input.subject ?? input.asker)?.connection_id,
    ...(input.newId ? { newId: input.newId } : {}),
  });
  if (!resolved)
    throw new WorkspaceTreeError(
      `No group "${names.join("/")}" in the Workspaces tree: see roamgate-review groups, or add --create-group.`,
    );
  const ops: WorkspaceTreeOp[] = [...resolved.ops];
  if (input.subject) {
    if (findWorkspaceNode(tree, input.subject)?.id === resolved.node)
      throw new WorkspaceTreeError("A workspace cannot go inside itself.");
    ops.push({
      op: "move",
      subject: { workspace: input.subject },
      parent: { node: resolved.node },
    });
  }
  // Refused here, before anything is written, if it cannot apply.
  let check = tree;
  for (const op of ops) check = applyWorkspaceTreeOp(check, op);
  const created = resolved.ops.flatMap((op) =>
    op.op === "create_group" ? [op.label] : [],
  );
  // The whole path from the top, whichever base it was found from.
  const first = resolved.ops[0];
  const reached =
    first?.op === "create_group"
      ? first.parent && "node" in first.parent
        ? first.parent.node
        : null
      : resolved.node;
  const byId = new Map(check.nodes.map((node) => [node.id, node]));
  const above = workspaceTreeAncestors(tree, reached)
    .reverse()
    .map((id) => workspaceTreeNodeName(byId.get(id)!));
  return { ops, path: [...above, ...created], created };
}

/**
 * The group paths an agent can give (`roamgate-review groups`): every group
 * and every workspace holding others, from the top level, and the one the
 * agent's own workspace sits in.
 */
export function agentGroupPaths(
  tree: WorkspaceTree,
  asker: { ref?: WorkspaceRef; usualParent?: WorkspaceRef } = {},
): {
  groups: {
    path: string;
    kind: "group" | "workspace";
    connection_id?: string;
  }[];
  yours: string | null;
} {
  const paths = workspaceTreeGroupPaths(tree);
  const [, own] = agentPathBases(tree, asker);
  return {
    groups: paths.map((each) => ({
      path: each.names.join("/"),
      kind: each.kind,
      ...(each.connection_id ? { connection_id: each.connection_id } : {}),
    })),
    yours:
      own === undefined
        ? null
        : (paths.find((each) => each.node === own)?.names.join("/") ?? null),
  };
}
