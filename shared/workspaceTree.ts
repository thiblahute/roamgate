/**
 * The user's arrangement of the Workspaces list: which workspace or label
 * group sits under which, across Herdr connections. Kept by the Roamgate
 * server (settings.json `workspace_tree`) and shared by every browser; the
 * server applies the same operations for automatic placement.
 *
 * A workspace is named by its connection and by what survives a Herdr
 * restart: its checkout path when it has one, else its label. Herdr's
 * workspace id is kept only as a hint, since a restored session may number
 * its workspaces again.
 *
 * Nodes are listed in sibling order. A workspace node whose parent is null
 * and that has no `root` place is unplaced: it stays in its usual place (its
 * repository's main checkout nests a worktree) and exists only to hold
 * children. A `root` place says the user put it at the top level: above
 * Herdr's list ("top"), in it at Herdr's position but never nested under its
 * repository ("list"), or below it ("bottom"). A group whose parent is null
 * is shown at the top of the list, or below it when its root is "bottom".
 */

export const WORKSPACE_TREE_VERSION = 1;
export const WORKSPACE_TREE_MAX_NODES = 2000;
export const WORKSPACE_TREE_LABEL_MAX = 120;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REF_FIELD_MAX = 4096;

export type WorkspaceRef = {
  connection_id: string;
  /** The checkout path on the connection's host: survives restarts. */
  path?: string;
  label?: string;
  /** Herdr's id when last seen: a hint, not an identity. */
  workspace_id?: string;
};

/** Where a node placed at the top level shows: above, in or below Herdr's list. */
export type WorkspaceTreeRootPlace = "top" | "list" | "bottom";
const ROOT_PLACES: readonly WorkspaceTreeRootPlace[] = [
  "top",
  "list",
  "bottom",
];

/** The top level, as a place to move something to. */
export type WorkspaceTreeRoot = { root: WorkspaceTreeRootPlace };

export type WorkspaceTreeGroupNode = {
  id: string;
  kind: "group";
  parent: string | null;
  label: string;
  collapsed?: boolean;
  /** Only with no parent: "bottom" shows it below the list, else above. */
  root?: "bottom";
};

export type WorkspaceTreeWorkspaceNode = {
  id: string;
  kind: "workspace";
  parent: string | null;
  ref: WorkspaceRef;
  /** Only with no parent: placed at the top level by the user. */
  root?: WorkspaceTreeRootPlace;
};

export type WorkspaceTreeNode =
  | WorkspaceTreeGroupNode
  | WorkspaceTreeWorkspaceNode;

export type WorkspaceTree = {
  version: typeof WORKSPACE_TREE_VERSION;
  nodes: WorkspaceTreeNode[];
};

/** A node by id, or a workspace that may not have a node yet. */
export type WorkspaceTreeTarget =
  | { node: string }
  | { workspace: WorkspaceRef };

/** Where a move or a new group goes: a parent, the top level, or null. */
export type WorkspaceTreeParent =
  | WorkspaceTreeTarget
  | WorkspaceTreeRoot
  | null;

export type WorkspaceTreeOp =
  | {
      /**
       * Under `parent`, before `before` (else last). A root place puts it at
       * the top level; null sends a workspace back to its usual place (and a
       * group to the top).
       */
      op: "move";
      subject: WorkspaceTreeTarget;
      parent: WorkspaceTreeParent;
      before?: WorkspaceTreeTarget | null;
    }
  | {
      op: "create_group";
      id: string;
      label: string;
      parent: WorkspaceTreeParent;
      before?: WorkspaceTreeTarget | null;
    }
  | { op: "rename_group"; node: string; label: string }
  | { op: "set_collapsed"; node: string; collapsed: boolean }
  /** Its children take its place. */
  | { op: "delete_group"; node: string }
  /** A workspace node (one that is gone, say); its children take its place. */
  | { op: "remove"; node: string }
  /** What the browsers last saw of resolved workspaces: new ids and labels. */
  | { op: "refresh"; nodes: { node: string; ref: WorkspaceRef }[] };

export class WorkspaceTreeError extends Error {}

export function isWorkspaceTreeRoot(
  parent: WorkspaceTreeParent | undefined,
): parent is WorkspaceTreeRoot {
  return !!parent && "root" in parent;
}

/**
 * Where a node at the top level shows, or null: under a parent, or a
 * workspace node in its usual place.
 */
export function workspaceTreeRootPlace(
  node: WorkspaceTreeNode,
): WorkspaceTreeRootPlace | null {
  if (node.parent !== null) return null;
  if (node.kind === "group") return node.root ?? "top";
  return node.root ?? null;
}

/** Placed by the user: under a parent, or at the top level. */
export function workspaceTreeNodePlaced(node: WorkspaceTreeNode): boolean {
  return node.parent !== null || workspaceTreeRootPlace(node) !== null;
}

function parseRootPlace(value: unknown): WorkspaceTreeRootPlace | undefined {
  return ROOT_PLACES.find((place) => place === value);
}

/** The node with `parent` and, at the top level, `root`; nothing stale kept. */
function withPlacement<T extends WorkspaceTreeNode>(
  node: T,
  parent: string | null,
  root: WorkspaceTreeRootPlace | undefined,
): T {
  const next = { ...node, parent } as T;
  delete next.root;
  if (parent !== null || !root) return next;
  if (next.kind === "group")
    return root === "bottom" ? ({ ...next, root: "bottom" } as T) : next;
  return { ...next, root } as T;
}

export function emptyWorkspaceTree(): WorkspaceTree {
  return { version: WORKSPACE_TREE_VERSION, nodes: [] };
}

function boundedString(
  value: unknown,
  max = REF_FIELD_MAX,
): string | undefined {
  return typeof value === "string" && value && value.length <= max
    ? value
    : undefined;
}

export function parseWorkspaceRef(value: unknown): WorkspaceRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const connection_id = boundedString(raw.connection_id, 256);
  if (!connection_id) return null;
  const path = boundedString(raw.path);
  const label = boundedString(raw.label, WORKSPACE_TREE_LABEL_MAX * 4);
  const workspace_id = boundedString(raw.workspace_id, 256);
  if (!path && !label && !workspace_id) return null;
  return {
    connection_id,
    ...(path ? { path } : {}),
    ...(label ? { label } : {}),
    ...(workspace_id ? { workspace_id } : {}),
  };
}

/** What makes two references the same workspace: connection, then path, label or id. */
export function workspaceRefKey(ref: WorkspaceRef): string {
  const identity = ref.path
    ? `p:${ref.path}`
    : ref.label
      ? `l:${ref.label}`
      : `i:${ref.workspace_id ?? ""}`;
  return `${ref.connection_id}\u0000${identity}`;
}

/** Validates a stored tree, dropping what does not hold together. */
export function parseWorkspaceTree(value: unknown): WorkspaceTree {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return emptyWorkspaceTree();
  const rawNodes = (value as { nodes?: unknown }).nodes;
  if (!Array.isArray(rawNodes)) return emptyWorkspaceTree();
  const nodes: WorkspaceTreeNode[] = [];
  const ids = new Set<string>();
  const refKeys = new Set<string>();
  for (const raw of rawNodes.slice(0, WORKSPACE_TREE_MAX_NODES)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!NODE_ID_RE.test(id) || ids.has(id)) continue;
    const parent =
      typeof entry.parent === "string" && NODE_ID_RE.test(entry.parent)
        ? entry.parent
        : null;
    const root = parseRootPlace(entry.root);
    if (entry.kind === "group") {
      const label = normalizeGroupLabel(entry.label);
      if (!label) continue;
      nodes.push(
        withPlacement<WorkspaceTreeGroupNode>(
          {
            id,
            kind: "group",
            parent,
            label,
            ...(entry.collapsed === true ? { collapsed: true } : {}),
          },
          parent,
          root,
        ),
      );
    } else if (entry.kind === "workspace") {
      const ref = parseWorkspaceRef(entry.ref);
      if (!ref) continue;
      const key = workspaceRefKey(ref);
      if (refKeys.has(key)) continue;
      refKeys.add(key);
      nodes.push(
        withPlacement<WorkspaceTreeWorkspaceNode>(
          { id, kind: "workspace", parent, ref },
          parent,
          root,
        ),
      );
    } else continue;
    ids.add(id);
  }
  // Parents that are missing, and loops a hand edit could leave, go back to
  // the top level.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parent && !byId.has(node.parent)) node.parent = null;
  }
  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    let cursor = node.parent ? byId.get(node.parent) : undefined;
    while (cursor) {
      if (seen.has(cursor.id)) {
        node.parent = null;
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
  }
  return prune({ version: WORKSPACE_TREE_VERSION, nodes });
}

function normalizeGroupLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip controls
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return label.slice(0, WORKSPACE_TREE_LABEL_MAX);
}

export function workspaceTreeChildren(
  tree: WorkspaceTree,
  parent: string | null,
): WorkspaceTreeNode[] {
  return tree.nodes.filter((node) => node.parent === parent);
}

export function findWorkspaceNode(
  tree: WorkspaceTree,
  ref: WorkspaceRef,
): WorkspaceTreeWorkspaceNode | undefined {
  const key = workspaceRefKey(ref);
  return tree.nodes.find(
    (node): node is WorkspaceTreeWorkspaceNode =>
      node.kind === "workspace" && workspaceRefKey(node.ref) === key,
  );
}

/** Whether `node` is `ancestor` or lies anywhere below it. */
export function workspaceTreeContains(
  tree: WorkspaceTree,
  ancestor: string,
  node: string | null,
): boolean {
  const byId = new Map(tree.nodes.map((each) => [each.id, each]));
  let cursor = node;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parent ?? null;
  }
  return false;
}

/** Workspace nodes in their usual place with nothing under them carry nothing. */
function prune(tree: WorkspaceTree): WorkspaceTree {
  const parents = new Set(
    tree.nodes.flatMap((node) => (node.parent ? [node.parent] : [])),
  );
  const nodes = tree.nodes.filter(
    (node) =>
      node.kind === "group" ||
      workspaceTreeNodePlaced(node) ||
      parents.has(node.id),
  );
  return nodes.length === tree.nodes.length ? tree : { ...tree, nodes };
}

let generatedIds = 0;
function newNodeId(tree: WorkspaceTree): string {
  const ids = new Set(tree.nodes.map((node) => node.id));
  for (;;) {
    generatedIds += 1;
    const id = `w${Date.now().toString(36)}${generatedIds.toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    if (!ids.has(id)) return id;
  }
}

/** A fresh id for a group made in a browser, so its optimistic copy matches. */
export function newWorkspaceTreeGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function nodeById(tree: WorkspaceTree, id: string): WorkspaceTreeNode {
  const node = tree.nodes.find((each) => each.id === id);
  if (!node) throw new WorkspaceTreeError("That item is no longer arranged.");
  return node;
}

/** The node a target names, made (as an unplaced workspace) when needed. */
function ensureTarget(
  tree: WorkspaceTree,
  target: WorkspaceTreeTarget,
): [WorkspaceTree, string] {
  if ("node" in target) return [tree, nodeById(tree, target.node).id];
  const ref = parseWorkspaceRef(target.workspace);
  if (!ref) throw new WorkspaceTreeError("That workspace cannot be named.");
  const existing = findWorkspaceNode(tree, ref);
  if (existing) return [tree, existing.id];
  if (tree.nodes.length >= WORKSPACE_TREE_MAX_NODES)
    throw new WorkspaceTreeError("The arrangement is full.");
  const id = newNodeId(tree);
  return [
    {
      ...tree,
      nodes: [...tree.nodes, { id, kind: "workspace", parent: null, ref }],
    },
    id,
  ];
}

function existingTarget(
  tree: WorkspaceTree,
  target: WorkspaceTreeTarget | null | undefined,
): string | null {
  if (!target) return null;
  if ("node" in target)
    return tree.nodes.some((node) => node.id === target.node)
      ? target.node
      : null;
  const ref = parseWorkspaceRef(target.workspace);
  return ref ? (findWorkspaceNode(tree, ref)?.id ?? null) : null;
}

/**
 * Puts `id` under `parent` (at the top level: in `root`), before `before`
 * when that is a sibling there.
 */
function place(
  tree: WorkspaceTree,
  id: string,
  parent: string | null,
  before: string | null,
  root?: WorkspaceTreeRootPlace,
): WorkspaceTree {
  const node = withPlacement(nodeById(tree, id), parent, root);
  const rest = tree.nodes.filter((each) => each.id !== id);
  const anchor =
    before && before !== id
      ? rest.findIndex((each) => each.id === before && each.parent === parent)
      : -1;
  if (anchor >= 0) rest.splice(anchor, 0, node);
  else {
    // After its last sibling, so the order of other levels stays put.
    let last = -1;
    rest.forEach((each, index) => {
      if (each.parent === parent) last = index;
    });
    rest.splice(last >= 0 ? last + 1 : rest.length, 0, node);
  }
  return { ...tree, nodes: rest };
}

/** Removes a node; its children take its place under its parent. */
function lift(tree: WorkspaceTree, id: string): WorkspaceTree {
  const node = nodeById(tree, id);
  // At the top level, workspaces go back to their usual place.
  const children = tree.nodes
    .filter((each) => each.parent === id)
    .map((each) => withPlacement(each, node.parent, undefined));
  const nodes = tree.nodes.flatMap((each) =>
    each.id === id ? children : each.parent === id ? [] : [each],
  );
  return { ...tree, nodes };
}

/** Applies one operation; throws WorkspaceTreeError on one that cannot apply. */
export function applyWorkspaceTreeOp(
  tree: WorkspaceTree,
  op: WorkspaceTreeOp,
): WorkspaceTree {
  switch (op.op) {
    case "move": {
      const [withSubject, subject] = ensureTarget(tree, op.subject);
      let next = withSubject;
      let parent: string | null = null;
      const root = isWorkspaceTreeRoot(op.parent) ? op.parent.root : undefined;
      if (op.parent && !isWorkspaceTreeRoot(op.parent))
        [next, parent] = ensureTarget(next, op.parent);
      if (parent && workspaceTreeContains(next, subject, parent))
        throw new WorkspaceTreeError(
          "A workspace cannot go inside itself or what is under it.",
        );
      const before = existingTarget(next, op.before);
      return prune(place(next, subject, parent, before, root));
    }
    case "create_group": {
      if (
        !NODE_ID_RE.test(op.id) ||
        tree.nodes.some((node) => node.id === op.id)
      )
        throw new WorkspaceTreeError("That group id is taken or invalid.");
      const label = normalizeGroupLabel(op.label);
      if (!label) throw new WorkspaceTreeError("A group needs a name.");
      if (tree.nodes.length >= WORKSPACE_TREE_MAX_NODES)
        throw new WorkspaceTreeError("The arrangement is full.");
      let next: WorkspaceTree = tree;
      let parent: string | null = null;
      const root = isWorkspaceTreeRoot(op.parent) ? op.parent.root : undefined;
      if (op.parent && !isWorkspaceTreeRoot(op.parent))
        [next, parent] = ensureTarget(next, op.parent);
      next = {
        ...next,
        nodes: [...next.nodes, { id: op.id, kind: "group", parent, label }],
      };
      return prune(
        place(next, op.id, parent, existingTarget(next, op.before), root),
      );
    }
    case "rename_group": {
      const node = nodeById(tree, op.node);
      if (node.kind !== "group") throw new WorkspaceTreeError("Not a group.");
      const label = normalizeGroupLabel(op.label);
      if (!label) throw new WorkspaceTreeError("A group needs a name.");
      return {
        ...tree,
        nodes: tree.nodes.map((each) =>
          each.id === op.node ? { ...node, label } : each,
        ),
      };
    }
    case "set_collapsed": {
      const node = nodeById(tree, op.node);
      if (node.kind !== "group") throw new WorkspaceTreeError("Not a group.");
      const rest: WorkspaceTreeGroupNode = { ...node };
      delete rest.collapsed;
      return {
        ...tree,
        nodes: tree.nodes.map((each) =>
          each.id === op.node
            ? op.collapsed
              ? { ...rest, collapsed: true }
              : rest
            : each,
        ),
      };
    }
    case "delete_group": {
      if (nodeById(tree, op.node).kind !== "group")
        throw new WorkspaceTreeError("Not a group.");
      return prune(lift(tree, op.node));
    }
    case "remove": {
      if (nodeById(tree, op.node).kind !== "workspace")
        throw new WorkspaceTreeError("Not a workspace.");
      return prune(lift(tree, op.node));
    }
    case "refresh": {
      const updates = new Map<string, WorkspaceRef>();
      for (const entry of op.nodes) {
        const ref = parseWorkspaceRef(entry.ref);
        if (ref) updates.set(entry.node, ref);
      }
      let changed = false;
      const nodes = tree.nodes.map((node) => {
        const ref = updates.get(node.id);
        if (node.kind !== "workspace" || !ref) return node;
        if (ref.connection_id !== node.ref.connection_id) return node;
        const merged: WorkspaceRef = {
          connection_id: node.ref.connection_id,
          ...((ref.path ?? node.ref.path)
            ? { path: ref.path ?? node.ref.path }
            : {}),
          ...((ref.label ?? node.ref.label)
            ? { label: ref.label ?? node.ref.label }
            : {}),
          ...((ref.workspace_id ?? node.ref.workspace_id)
            ? { workspace_id: ref.workspace_id ?? node.ref.workspace_id }
            : {}),
        };
        if (JSON.stringify(merged) === JSON.stringify(node.ref)) return node;
        // Another node already holds that identity: leave this one be.
        const clash = tree.nodes.some(
          (other) =>
            other.id !== node.id &&
            other.kind === "workspace" &&
            workspaceRefKey(other.ref) === workspaceRefKey(merged),
        );
        if (clash) return node;
        changed = true;
        return { ...node, ref: merged };
      });
      return changed ? { ...tree, nodes } : tree;
    }
  }
}

/** Validates an operation sent over RPC. */
export function parseWorkspaceTreeOp(value: unknown): WorkspaceTreeOp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const target = (input: unknown): WorkspaceTreeTarget | null | undefined => {
    if (input === null || input === undefined) return input as null | undefined;
    if (typeof input !== "object") return undefined;
    const entry = input as Record<string, unknown>;
    if (typeof entry.node === "string" && NODE_ID_RE.test(entry.node))
      return { node: entry.node };
    const ref = parseWorkspaceRef(entry.workspace);
    return ref ? { workspace: ref } : undefined;
  };
  const parentOf = (input: unknown): WorkspaceTreeParent | undefined => {
    const place =
      input && typeof input === "object"
        ? parseRootPlace((input as Record<string, unknown>).root)
        : undefined;
    return place ? { root: place } : target(input);
  };
  const nodeId = (input: unknown) =>
    typeof input === "string" && NODE_ID_RE.test(input) ? input : null;
  switch (raw.op) {
    case "move": {
      const subject = target(raw.subject);
      const parent = parentOf(raw.parent);
      const before = target(raw.before);
      if (!subject || parent === undefined) return null;
      return { op: "move", subject, parent, ...(before ? { before } : {}) };
    }
    case "create_group": {
      const id = nodeId(raw.id);
      const parent = parentOf(raw.parent);
      const before = target(raw.before);
      if (!id || typeof raw.label !== "string" || parent === undefined)
        return null;
      return {
        op: "create_group",
        id,
        label: raw.label,
        parent,
        ...(before ? { before } : {}),
      };
    }
    case "rename_group": {
      const node = nodeId(raw.node);
      return node && typeof raw.label === "string"
        ? { op: "rename_group", node, label: raw.label }
        : null;
    }
    case "set_collapsed": {
      const node = nodeId(raw.node);
      return node && typeof raw.collapsed === "boolean"
        ? { op: "set_collapsed", node, collapsed: raw.collapsed }
        : null;
    }
    case "delete_group":
    case "remove": {
      const node = nodeId(raw.node);
      return node ? { op: raw.op, node } : null;
    }
    case "refresh": {
      if (!Array.isArray(raw.nodes)) return null;
      const nodes = raw.nodes
        .slice(0, WORKSPACE_TREE_MAX_NODES)
        .flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const node = nodeId((entry as Record<string, unknown>).node);
          const ref = parseWorkspaceRef((entry as Record<string, unknown>).ref);
          return node && ref ? [{ node, ref }] : [];
        });
      return { op: "refresh", nodes };
    }
    default:
      return null;
  }
}

/** What a live workspace offers to be recognised by. */
export type LiveWorkspaceIdentity = {
  workspace_id: string;
  label: string;
  path?: string;
};

export function workspaceIdentity(workspace: {
  workspace_id: string;
  label: string;
  cwd?: string;
  worktree?: { checkout_path?: string } | null;
}): LiveWorkspaceIdentity {
  const path = workspace.worktree?.checkout_path || workspace.cwd || undefined;
  return {
    workspace_id: workspace.workspace_id,
    label: workspace.label,
    ...(path ? { path } : {}),
  };
}

export function workspaceRefFor(
  connectionId: string,
  workspace: Parameters<typeof workspaceIdentity>[0],
): WorkspaceRef {
  const identity = workspaceIdentity(workspace);
  return {
    connection_id: connectionId,
    ...(identity.path ? { path: identity.path } : {}),
    ...(identity.label ? { label: identity.label } : {}),
    workspace_id: identity.workspace_id,
  };
}

export type ResolvedWorkspaceNode =
  | { state: "live"; connectionId: string; workspaceId: string }
  /** Its connection is not ready: shown greyed where it was. */
  | { state: "offline" }
  /** Its connection answers but no workspace matches: shown greyed. */
  | { state: "gone" };

export type ResolvedWorkspaceTree = {
  nodes: Map<string, ResolvedWorkspaceNode>;
  /** `${connectionId}\0${workspaceId}` to its node. */
  nodeByWorkspace: Map<string, string>;
  /** Live ids or labels that differ from what the tree has. */
  refreshes: { node: string; ref: WorkspaceRef }[];
};

export function liveWorkspaceKey(connectionId: string, workspaceId: string) {
  return `${connectionId}\u0000${workspaceId}`;
}

/**
 * Matches the tree's workspaces with the live ones. `live` holds each ready
 * connection's workspaces; a connection missing from it is offline. A path
 * decides first (a restored Herdr keeps paths, not ids), then the label,
 * then the last id seen, which finds a renamed workspace without a path.
 */
export function resolveWorkspaceTree(
  tree: WorkspaceTree,
  live: ReadonlyMap<string, readonly LiveWorkspaceIdentity[]>,
): ResolvedWorkspaceTree {
  const nodes = new Map<string, ResolvedWorkspaceNode>();
  const nodeByWorkspace = new Map<string, string>();
  const refreshes: { node: string; ref: WorkspaceRef }[] = [];
  const byConnection = new Map<string, WorkspaceTreeWorkspaceNode[]>();
  for (const node of tree.nodes) {
    if (node.kind !== "workspace") continue;
    const list = byConnection.get(node.ref.connection_id) ?? [];
    list.push(node);
    byConnection.set(node.ref.connection_id, list);
  }
  for (const [connectionId, refs] of byConnection) {
    const workspaces = live.get(connectionId);
    if (!workspaces) {
      for (const node of refs) nodes.set(node.id, { state: "offline" });
      continue;
    }
    const claimed = new Set<string>();
    const match = (
      node: WorkspaceTreeWorkspaceNode,
      workspace: LiveWorkspaceIdentity,
    ) => {
      claimed.add(workspace.workspace_id);
      nodes.set(node.id, {
        state: "live",
        connectionId,
        workspaceId: workspace.workspace_id,
      });
      nodeByWorkspace.set(
        liveWorkspaceKey(connectionId, workspace.workspace_id),
        node.id,
      );
      if (
        workspace.label !== node.ref.label ||
        workspace.workspace_id !== node.ref.workspace_id ||
        (workspace.path && workspace.path !== node.ref.path)
      ) {
        refreshes.push({
          node: node.id,
          ref: {
            connection_id: connectionId,
            ...(workspace.path ? { path: workspace.path } : {}),
            ...(workspace.label ? { label: workspace.label } : {}),
            workspace_id: workspace.workspace_id,
          },
        });
      }
    };
    const free = () =>
      workspaces.filter((each) => !claimed.has(each.workspace_id));
    const pick = (
      node: WorkspaceTreeWorkspaceNode,
      candidates: LiveWorkspaceIdentity[],
    ) =>
      candidates.find(
        (each) =>
          each.label === node.ref.label &&
          each.workspace_id === node.ref.workspace_id,
      ) ??
      candidates.find((each) => each.label === node.ref.label) ??
      candidates.find((each) => each.workspace_id === node.ref.workspace_id) ??
      candidates[0];
    // A path first: the strongest identity.
    for (const node of refs) {
      if (!node.ref.path) continue;
      const found = pick(
        node,
        free().filter((each) => each.path === node.ref.path),
      );
      if (found) match(node, found);
    }
    // Then a label, for workspaces without a checkout.
    for (const node of refs) {
      if (node.ref.path || nodes.has(node.id) || !node.ref.label) continue;
      const found = pick(
        node,
        free().filter((each) => !each.path && each.label === node.ref.label),
      );
      if (found) match(node, found);
    }
    // Then the id last seen: a pathless workspace the user renamed.
    for (const node of refs) {
      if (node.ref.path || nodes.has(node.id) || !node.ref.workspace_id)
        continue;
      const found = free().find(
        (each) => !each.path && each.workspace_id === node.ref.workspace_id,
      );
      if (found) match(node, found);
    }
    for (const node of refs)
      if (!nodes.has(node.id)) nodes.set(node.id, { state: "gone" });
  }
  return { nodes, nodeByWorkspace, refreshes };
}

/** What Herdr says of a workspace it just closed or removed the worktree of. */
export type ClosedWorkspace = {
  workspace_id: string;
  label?: string;
  path?: string;
};

/**
 * The workspace nodes of `connectionId` that Herdr confirms gone. `live` is
 * that connection's list, read just now: it matches none of them. Without
 * `closed`, a node is kept while a workspace no other node holds still has
 * its name (one that lost its checkout is not gone; ids prove nothing, a
 * restarted Herdr numbers its workspaces again), and an empty list confirms
 * nothing (a Herdr still restoring its session). With
 * `closed`, only the nodes naming that workspace count: Herdr reported it
 * closed.
 */
export function goneWorkspaceTreeNodes(
  tree: WorkspaceTree,
  connectionId: string,
  live: readonly LiveWorkspaceIdentity[],
  closed?: ClosedWorkspace,
): string[] {
  if (!closed && live.length === 0) return [];
  const resolved = resolveWorkspaceTree(tree, new Map([[connectionId, live]]));
  const freeLabels = new Set(
    live
      .filter(
        (each) =>
          !resolved.nodeByWorkspace.has(
            liveWorkspaceKey(connectionId, each.workspace_id),
          ),
      )
      .map((each) => each.label),
  );
  return tree.nodes.flatMap((node) => {
    if (node.kind !== "workspace" || node.ref.connection_id !== connectionId)
      return [];
    if (resolved.nodes.get(node.id)?.state !== "gone") return [];
    if (closed) {
      const named =
        node.ref.workspace_id === closed.workspace_id ||
        (!!closed.path && node.ref.path === closed.path) ||
        (!node.ref.path && !!closed.label && node.ref.label === closed.label);
      return named ? [node.id] : [];
    }
    if (node.ref.label && freeLabels.has(node.ref.label)) return [];
    return [node.id];
  });
}

/** Takes workspace nodes out; their children take their place. */
export function removeWorkspaceTreeNodes(
  tree: WorkspaceTree,
  ids: Iterable<string>,
): WorkspaceTree {
  let next = tree;
  for (const id of ids) {
    const node = next.nodes.find((each) => each.id === id);
    if (node?.kind === "workspace")
      next = applyWorkspaceTreeOp(next, { op: "remove", node: id });
  }
  return next;
}

/**
 * Where an automatically placed workspace goes: under the workspace that
 * asked for it, unless the usual list already shows it right there (a
 * worktree made from its repository's main checkout) or it is already
 * arranged somewhere by the user.
 */
export function autoPlaceWorkspace(
  tree: WorkspaceTree,
  child: WorkspaceRef & { repo_key?: string; linked?: boolean },
  parent: WorkspaceRef & { repo_key?: string; linked?: boolean },
): WorkspaceTree {
  if (workspaceRefKey(child) === workspaceRefKey(parent)) return tree;
  const existing = findWorkspaceNode(tree, child);
  if (existing && workspaceTreeNodePlaced(existing)) return tree;
  const usuallyThere =
    child.connection_id === parent.connection_id &&
    child.linked === true &&
    parent.linked === false &&
    !!child.repo_key &&
    child.repo_key === parent.repo_key;
  if (usuallyThere) return tree;
  const strip = (each: typeof child): WorkspaceRef => ({
    connection_id: each.connection_id,
    ...(each.path ? { path: each.path } : {}),
    ...(each.label ? { label: each.label } : {}),
    ...(each.workspace_id ? { workspace_id: each.workspace_id } : {}),
  });
  return applyWorkspaceTreeOp(tree, {
    op: "move",
    subject: { workspace: strip(child) },
    parent: { workspace: strip(parent) },
  });
}

/**
 * A node's name in a group path: a group's label, a workspace's label (else
 * its checkout's last directory). Workspaces count because they hold
 * children too.
 */
export function workspaceTreeNodeName(node: WorkspaceTreeNode): string {
  return (
    node.kind === "group"
      ? node.label
      : (node.ref.label ?? node.ref.path?.split("/").pop() ?? "")
  ).trim();
}

/** A group path as typed, "gst/upstreaming" or "gst > upstreaming": its names. */
export function parseWorkspaceTreePath(text: string): string[] {
  return text
    .split(/[/>]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sameTreeName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Where a group path leads: the node its names reach, matched
 * case-insensitively level by level from each base in turn (null is the
 * top level), the first base that reaches the whole path winning. A level
 * with several matches tries a workspace on `preferConnection` first, then
 * groups, then other workspaces. With `create`, a path no base reaches is
 * completed with new groups under the deepest node any base reaches (the
 * earlier base on a tie), returned as create_group operations; without it
 * the answer is null.
 */
export function resolveWorkspaceTreePath(
  tree: WorkspaceTree,
  path: readonly string[],
  options: {
    bases?: readonly (string | null)[];
    create?: boolean;
    preferConnection?: string;
    newId?: () => string;
  } = {},
): {
  /** The node the path names, existing or made by `ops`. */
  node: string;
  /** The create_group operations that make the missing groups, in order. */
  ops: WorkspaceTreeOp[];
  /** The names that matched existing nodes, as they are spelled there. */
  found: string[];
} | null {
  const names = path.map((name) => name.trim()).filter(Boolean);
  if (!names.length) return null;
  const rank = (node: WorkspaceTreeNode) =>
    node.kind === "workspace" &&
    options.preferConnection !== undefined &&
    node.ref.connection_id === options.preferConnection
      ? 0
      : node.kind === "group"
        ? 1
        : 2;
  /** The deepest walk down `names` from `parent`: its nodes, in order. */
  const deepest = (
    parent: string | null,
    from: number,
  ): WorkspaceTreeNode[] => {
    if (from >= names.length) return [];
    const matches = workspaceTreeChildren(tree, parent)
      .filter((node) => sameTreeName(workspaceTreeNodeName(node), names[from]!))
      .sort((a, b) => rank(a) - rank(b));
    let best: WorkspaceTreeNode[] = [];
    for (const match of matches) {
      const walk = [match, ...deepest(match.id, from + 1)];
      if (walk.length > best.length) best = walk;
      if (from + best.length === names.length) break;
    }
    return best;
  };
  const bases = options.bases?.length ? options.bases : [null];
  let chosen: { base: string | null; walk: WorkspaceTreeNode[] } | null = null;
  const seen = new Set<string | null>();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    if (base !== null && !tree.nodes.some((node) => node.id === base)) continue;
    const walk = deepest(base, 0);
    if (walk.length === names.length)
      return {
        node: walk[walk.length - 1]!.id,
        ops: [],
        found: walk.map(workspaceTreeNodeName),
      };
    if (!chosen || walk.length > chosen.walk.length) chosen = { base, walk };
  }
  if (!options.create || !chosen) return null;
  const newId = options.newId ?? newWorkspaceTreeGroupId;
  const ops: WorkspaceTreeOp[] = [];
  let parent = chosen.walk.length
    ? chosen.walk[chosen.walk.length - 1]!.id
    : chosen.base;
  for (const name of names.slice(chosen.walk.length)) {
    const id = newId();
    ops.push({
      op: "create_group",
      id,
      label: name.slice(0, WORKSPACE_TREE_LABEL_MAX),
      parent: parent === null ? { root: "top" } : { node: parent },
    });
    parent = id;
  }
  return {
    node: parent!,
    ops,
    found: chosen.walk.map(workspaceTreeNodeName),
  };
}

/**
 * The paths something can be put into: every group, and every workspace
 * that holds others, by the names from the top level down, in sidebar
 * order.
 */
export function workspaceTreeGroupPaths(tree: WorkspaceTree): {
  node: string;
  kind: WorkspaceTreeNode["kind"];
  names: string[];
  connection_id?: string;
}[] {
  const parents = new Set(
    tree.nodes.flatMap((node) => (node.parent ? [node.parent] : [])),
  );
  const out: ReturnType<typeof workspaceTreeGroupPaths> = [];
  const walk = (parent: string | null, names: string[], seen: Set<string>) => {
    for (const node of workspaceTreeChildren(tree, parent)) {
      if (seen.has(node.id)) continue;
      const here = [...names, workspaceTreeNodeName(node)];
      if (node.kind === "group" || parents.has(node.id)) {
        out.push({
          node: node.id,
          kind: node.kind,
          names: here,
          ...(node.kind === "workspace"
            ? { connection_id: node.ref.connection_id }
            : {}),
        });
        walk(node.id, here, new Set([...seen, node.id]));
      }
    }
  };
  walk(null, [], new Set());
  return out;
}

/** A node and the nodes above it, nearest first. */
export function workspaceTreeAncestors(
  tree: WorkspaceTree,
  id: string | null,
): string[] {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const out: string[] = [];
  let cursor = id;
  while (cursor && byId.has(cursor) && !out.includes(cursor)) {
    out.push(cursor);
    cursor = byId.get(cursor)!.parent;
  }
  return out;
}
