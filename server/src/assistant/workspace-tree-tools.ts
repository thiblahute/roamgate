import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  applyWorkspaceTreeOp,
  findWorkspaceNode,
  liveWorkspaceKey,
  newWorkspaceTreeGroupId,
  resolveWorkspaceTree,
  WORKSPACE_TREE_LABEL_MAX,
  type WorkspaceTree,
  WorkspaceTreeError,
  type WorkspaceTreeNode,
  type WorkspaceTreeOp,
  type WorkspaceTreeParent,
  type WorkspaceTreeRootPlace,
  type WorkspaceTreeTarget,
  workspaceIdentity,
  workspaceRefFor,
  workspaceTreeRootPlace,
} from "../../../shared/workspaceTree";
import { AssistantUserError, surfaceAssistantUserError } from "./errors";
import type { WorkspaceToolResult } from "./tools";

/**
 * Ranger's tools for the user's arrangement of the Workspaces list: the same
 * operations the sidebar sends (shared/workspaceTree.ts), applied through
 * the same server store, so a browser sees Ranger's change as one push.
 * Arranging is reversible and touches no workspace, so these run without
 * the confirmation the propose_* tools need.
 */

/** A workspace as Herdr's workspace.list gives it, with Roamgate's additions. */
export type TreeToolWorkspace = {
  workspace_id: string;
  number?: number;
  label: string;
  cwd?: string;
  worktree?: {
    repo_key?: string;
    repo_name?: string;
    checkout_path?: string;
    is_linked_worktree?: boolean;
    parent_workspace_id?: string;
    git_status?: { branch?: string } | null;
  } | null;
};

export type TreeToolConnection = {
  connection_id: string;
  label: string;
  /** Only a ready connection lists its workspaces. */
  state: "ready" | "offline" | "error";
  workspaces: TreeToolWorkspace[];
};

export type WorkspaceTreeToolBackend = {
  connections(signal?: AbortSignal): Promise<TreeToolConnection[]>;
  read(): Promise<WorkspaceTree>;
  /** All the operations in one settings write; throws and writes nothing on a refusal. */
  apply(ops: WorkspaceTreeOp[]): Promise<WorkspaceTree>;
};

export type WorkspaceTreeToolKind = (typeof workspaceTreeTools)[number]["kind"];
export type WorkspaceTreeToolHandler = (
  kind: WorkspaceTreeToolKind,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<WorkspaceToolResult>;

const ROOT_PLACE = Type.Union([
  Type.Literal("top"),
  Type.Literal("list"),
  Type.Literal("bottom"),
]);

const itemFields = {
  group: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "A group: its id from workspace_tree_get, or its exact name when only one group has it.",
    }),
  ),
  workspace_id: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        "A workspace's Herdr id from workspace_tree_get. Add connection_id when several connections use that id.",
    }),
  ),
  connection_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  path: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        "A workspace's checkout path: with connection_id, the stable key that survives Herdr restarts.",
    }),
  ),
};

const ITEM = Type.Object(itemFields, {
  additionalProperties: false,
  description:
    "Exactly one group, or one workspace named by workspace_id or by path (with connection_id when ambiguous).",
});

const DESTINATION = Type.Object(
  {
    ...itemFields,
    root: Type.Optional({
      ...ROOT_PLACE,
      description:
        "The top level: top is above Herdr's list, list is in it at Herdr's position (never nested under its repository), bottom is below it.",
    }),
    usual: Type.Optional(
      Type.Literal(true, {
        description:
          "Back to the usual place: out of any group or workspace, a worktree under its repository's main checkout again.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Exactly one of: a group, a workspace (to nest under it), root, or usual.",
  },
);

const POSITION = {
  position: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 2000,
      description:
        "0-based index among the destination's children; past the end puts them last.",
    }),
  ),
  before: Type.Optional({
    ...ITEM,
    description: "Put them just before this sibling.",
  }),
  after: Type.Optional({
    ...ITEM,
    description: "Put them just after this sibling.",
  }),
};

const MAX_BATCH = 32;
const MAX_ITEMS = 64;

export const workspaceTreeTools = [
  {
    name: "workspace_tree_get",
    kind: "get",
    label: "Read the Workspaces arrangement",
    description:
      "Read the user's arrangement of Roamgate's Workspaces sidebar, across every connection: each open workspace (connection_id, workspace_id, label, checkout path, branch, the repository main checkout it usually nests under, and where it is placed: its usual place, under a group or workspace, or at the top level, with its position), the label groups, workspaces placed but not open now, and an outline of the arrangement. Read it before workspace_tree_move or workspace_tree_group, and to show the user the result. Covers every workspace whatever this turn's scope; it reads no workspace content.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "workspace_tree_move",
    kind: "move",
    label: "Arrange workspaces",
    description:
      "Move workspaces or groups in the Workspaces sidebar, as the sidebar's Move into... and drag and drop do: into a group, under another workspace (from any repository or connection), to the top level (root top, list or bottom), or back to their usual place (usual). Optionally at a position, or before or after a sibling there; several items keep their given order. Each entry of moves is one destination; all of them apply in one change, or none does when one is refused (an unknown workspace or group, or a move into itself or something under it). This only arranges the sidebar: nothing runs, nothing closes, and it can be undone, so no confirmation is needed. Returns what changed.",
    parameters: Type.Object(
      {
        moves: Type.Array(
          Type.Object(
            {
              items: Type.Array(ITEM, { minItems: 1, maxItems: MAX_ITEMS }),
              to: DESTINATION,
              ...POSITION,
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: MAX_BATCH },
        ),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "workspace_tree_group",
    kind: "group",
    label: "Arrange workspace groups",
    description:
      "Manage label groups in the Workspaces sidebar. create makes a group (at the top level by default, or under parent: a group, a workspace, or root top or bottom), optionally moving children into it in the same change: to group workspaces, create the group with them as children. rename changes its name. delete removes the group; what it held moves up one level to where the group was. collapse and expand fold it in the sidebar. Name a group by its id from workspace_tree_get or by its exact name; a group created earlier in the same call can be named by its name. All actions apply in one change, or none does when one is refused. Reversible and confirmation-free like workspace_tree_move. Returns what changed and the ids of new groups.",
    parameters: Type.Object(
      {
        actions: Type.Array(
          Type.Object(
            {
              action: Type.Union([
                Type.Literal("create"),
                Type.Literal("rename"),
                Type.Literal("delete"),
                Type.Literal("collapse"),
                Type.Literal("expand"),
              ]),
              group: Type.Optional(
                Type.String({
                  minLength: 1,
                  maxLength: 200,
                  description:
                    "The group to rename, delete, collapse or expand: its id or exact name.",
                }),
              ),
              label: Type.Optional(
                Type.String({
                  minLength: 1,
                  maxLength: WORKSPACE_TREE_LABEL_MAX,
                  description: "The name, for create and rename.",
                }),
              ),
              parent: Type.Optional({
                ...DESTINATION,
                description:
                  "For create: where the group goes (a group, a workspace, or root top or bottom). Defaults to the top level.",
              }),
              children: Type.Optional(
                Type.Array(ITEM, { minItems: 1, maxItems: MAX_ITEMS }),
              ),
              ...POSITION,
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: MAX_BATCH },
        ),
      },
      { additionalProperties: false },
    ),
  },
] as const;

/** Validates and runs one tree tool, surfacing only safe errors. */
export async function callWorkspaceTreeTool(
  name: string,
  params: unknown,
  handle: WorkspaceTreeToolHandler,
  signal?: AbortSignal,
): Promise<WorkspaceToolResult> {
  const tool = workspaceTreeTools.find((entry) => entry.name === name);
  if (!tool) throw new Error("Unknown workspace tree tool.");
  if (!Value.Check(tool.parameters, params))
    throw new AssistantUserError("Invalid workspace tree tool parameters.");
  try {
    signal?.throwIfAborted();
    const result = await handle(
      tool.kind,
      params as Record<string, unknown>,
      signal,
    );
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    surfaceAssistantUserError(
      error,
      "The Workspaces arrangement is unavailable right now.",
    );
  }
}

type Item = {
  group?: string;
  workspace_id?: string;
  connection_id?: string;
  path?: string;
};
type Destination = Item & { root?: WorkspaceTreeRootPlace; usual?: true };
type Placement = { position?: number; before?: Item; after?: Item };

type LiveEntry = {
  connection: TreeToolConnection;
  workspace: TreeToolWorkspace;
};

function pathOf(workspace: TreeToolWorkspace) {
  return workspaceIdentity(workspace).path;
}

/** The repository main checkout the usual list nests a worktree under. */
function repoParent(
  workspaces: readonly TreeToolWorkspace[],
  workspace: TreeToolWorkspace,
): TreeToolWorkspace | undefined {
  const worktree = workspace.worktree;
  if (!worktree?.is_linked_worktree || !worktree.repo_key) return undefined;
  const mains = workspaces.filter(
    (each) =>
      each.worktree?.is_linked_worktree === false &&
      each.worktree.repo_key === worktree.repo_key,
  );
  const explicit = mains.find(
    (each) => each.workspace_id === worktree.parent_workspace_id,
  );
  return explicit ?? (mains.length === 1 ? mains[0] : undefined);
}

/** The view of the tree and the live workspaces one call works with. */
class TreeView {
  constructor(
    readonly connections: TreeToolConnection[],
    public tree: WorkspaceTree,
  ) {}

  private resolved() {
    return resolveWorkspaceTree(
      this.tree,
      new Map(
        this.connections
          .filter((connection) => connection.state === "ready")
          .map((connection) => [
            connection.connection_id,
            connection.workspaces.map(workspaceIdentity),
          ]),
      ),
    );
  }

  /** The live workspace a workspace node stands for, if open. */
  liveOf(node: WorkspaceTreeNode): LiveEntry | undefined {
    if (node.kind !== "workspace") return undefined;
    const state = this.resolved().nodes.get(node.id);
    if (state?.state !== "live") return undefined;
    const connection = this.connections.find(
      (each) => each.connection_id === state.connectionId,
    );
    const workspace = connection?.workspaces.find(
      (each) => each.workspace_id === state.workspaceId,
    );
    return connection && workspace ? { connection, workspace } : undefined;
  }

  nodeName(node: WorkspaceTreeNode): string {
    if (node.kind === "group") return `group "${node.label}"`;
    const live = this.liveOf(node);
    const label =
      live?.workspace.label ?? node.ref.label ?? node.ref.path ?? "workspace";
    return `"${label}" (${node.ref.connection_id})`;
  }

  private connectionList() {
    return this.connections.map((each) => each.connection_id).join(", ");
  }

  private groupList() {
    const groups = this.tree.nodes.filter((node) => node.kind === "group");
    return groups.length
      ? `Groups: ${groups.map((node) => `"${node.kind === "group" ? node.label : ""}" (${node.id})`).join(", ")}.`
      : "There are no groups.";
  }

  findGroup(name: string): WorkspaceTreeNode {
    const groups = this.tree.nodes.filter((node) => node.kind === "group");
    const byId = groups.find((node) => node.id === name);
    if (byId) return byId;
    const wanted = name.trim().toLowerCase();
    const named = groups.filter(
      (node) => node.kind === "group" && node.label.toLowerCase() === wanted,
    );
    if (named.length === 1) return named[0]!;
    if (named.length > 1)
      throw new AssistantUserError(
        `Several groups are named "${name}" (${named.map((node) => node.id).join(", ")}); name one by its id.`,
      );
    throw new AssistantUserError(
      `Unknown group "${name}". ${this.groupList()}`,
    );
  }

  /** A workspace or group as an operation target, with a name for reports. */
  target(item: Item): { target: WorkspaceTreeTarget; name: string } {
    const asWorkspace = !!(item.workspace_id || item.path);
    if (item.group && (asWorkspace || item.connection_id))
      throw new AssistantUserError(
        "Name either a group or a workspace, not both.",
      );
    if (item.group) {
      const node = this.findGroup(item.group);
      return { target: { node: node.id }, name: this.nodeName(node) };
    }
    if (!asWorkspace)
      throw new AssistantUserError(
        "Name a workspace (workspace_id or path) or a group.",
      );
    const connections = item.connection_id
      ? this.connections.filter(
          (each) => each.connection_id === item.connection_id,
        )
      : this.connections;
    if (item.connection_id && !connections.length)
      throw new AssistantUserError(
        `Unknown connection "${item.connection_id}". Connections: ${this.connectionList()}.`,
      );
    const matches = connections.flatMap((connection) =>
      connection.workspaces
        .filter(
          (workspace) =>
            (!item.workspace_id ||
              workspace.workspace_id === item.workspace_id) &&
            (!item.path ||
              pathOf(workspace) === item.path ||
              workspace.cwd === item.path),
        )
        .map((workspace) => ({ connection, workspace })),
    );
    const named = item.path
      ? `the workspace at ${item.path}`
      : `workspace "${item.workspace_id}"`;
    if (matches.length > 1)
      throw new AssistantUserError(
        `${named} matches several workspaces (on ${[...new Set(matches.map((each) => each.connection.connection_id))].join(", ")}); add connection_id.`,
      );
    const [match] = matches;
    if (match)
      return {
        target: {
          workspace: workspaceRefFor(
            match.connection.connection_id,
            match.workspace,
          ),
        },
        name: `"${match.workspace.label}" (${match.connection.connection_id})`,
      };
    // Placed but not open now (its connection down, say): still movable.
    const stored = this.tree.nodes.find(
      (node) =>
        node.kind === "workspace" &&
        (!item.connection_id ||
          node.ref.connection_id === item.connection_id) &&
        (item.path
          ? node.ref.path === item.path
          : node.ref.workspace_id === item.workspace_id),
    );
    if (stored)
      return { target: { node: stored.id }, name: this.nodeName(stored) };
    throw new AssistantUserError(
      `Unknown workspace: no open workspace matches ${named}${item.connection_id ? ` on ${item.connection_id}` : ""}. Read workspace_tree_get for the workspaces and their identifiers.`,
    );
  }

  destination(to: Destination): {
    parent: WorkspaceTreeParent;
    name: string;
  } {
    const kinds = [
      to.root !== undefined,
      to.usual === true,
      !!(to.group || to.workspace_id || to.path),
    ].filter(Boolean).length;
    if (kinds !== 1)
      throw new AssistantUserError(
        "A destination is exactly one of: a group, a workspace, root, or usual.",
      );
    if (to.root) return { parent: { root: to.root }, name: rootName(to.root) };
    if (to.usual) return { parent: null, name: "its usual place" };
    const { target, name } = this.target(to);
    return { parent: target, name };
  }

  nodeIdOf(target: WorkspaceTreeTarget): string | undefined {
    if ("node" in target) return target.node;
    return findWorkspaceNode(this.tree, target.workspace)?.id;
  }

  /** The node to insert before for a position, before or after. */
  anchor(
    parent: WorkspaceTreeParent,
    placement: Placement,
    moving: readonly WorkspaceTreeTarget[],
    notes: string[],
  ): WorkspaceTreeTarget | undefined {
    const asked = [
      placement.position !== undefined,
      !!placement.before,
      !!placement.after,
    ].filter(Boolean).length;
    if (!asked) return undefined;
    if (asked > 1)
      throw new AssistantUserError(
        "Give at most one of position, before and after.",
      );
    if (parent === null || ("root" in parent && parent.root === "list")) {
      notes.push(
        parent === null
          ? "Workspaces in their usual place follow Herdr's order; the position was not used."
          : "Workspaces at the top level in Herdr's list follow Herdr's order; the position was not used.",
      );
      return undefined;
    }
    const parentId =
      "root" in parent ? null : (this.nodeIdOf(parent) ?? "\u0000none");
    const root = "root" in parent ? parent.root : undefined;
    const moved = new Set(
      moving.flatMap((each) => {
        const id = this.nodeIdOf(each);
        return id ? [id] : [];
      }),
    );
    const siblings = this.tree.nodes.filter(
      (node) =>
        node.parent === parentId &&
        !moved.has(node.id) &&
        (parentId !== null || workspaceTreeRootPlace(node) === root),
    );
    // A workspace is named by its reference, not its node id: a node made
    // earlier in this batch gets another id when the store applies it.
    const targetOf = (node: WorkspaceTreeNode): WorkspaceTreeTarget =>
      node.kind === "workspace" ? { workspace: node.ref } : { node: node.id };
    if (placement.position !== undefined) {
      const node = siblings[placement.position];
      return node ? targetOf(node) : undefined;
    }
    const sibling = (placement.before ?? placement.after)!;
    const { target, name } = this.target(sibling);
    const id = this.nodeIdOf(target);
    const index = siblings.findIndex((node) => node.id === id);
    if (index < 0)
      throw new AssistantUserError(
        `${name} is not directly in the destination, so nothing can go before or after it there.`,
      );
    if (placement.before) return targetOf(siblings[index]!);
    const next = siblings[index + 1];
    return next ? targetOf(next) : undefined;
  }

  /** Applies one operation to the working copy, explaining a refusal. */
  apply(op: WorkspaceTreeOp, what: string) {
    try {
      this.tree = applyWorkspaceTreeOp(this.tree, op);
    } catch (error) {
      if (error instanceof WorkspaceTreeError)
        throw new AssistantUserError(
          `Refused to ${what}: ${error.message} Nothing was changed.`,
        );
      throw error;
    }
  }

  /** Where a workspace or group sits, in words. */
  where(target: WorkspaceTreeTarget): string {
    const id = this.nodeIdOf(target);
    const node = id
      ? this.tree.nodes.find((each) => each.id === id)
      : undefined;
    if (!node) return "its usual place";
    if (node.parent) {
      const parent = this.tree.nodes.find((each) => each.id === node.parent);
      const siblings = this.tree.nodes.filter(
        (each) => each.parent === node.parent,
      );
      return `under ${parent ? this.nodeName(parent) : "a removed item"} (position ${siblings.indexOf(node)} of ${siblings.length})`;
    }
    const root = workspaceTreeRootPlace(node);
    return root ? rootName(root) : "its usual place";
  }
}

/** A place from where(), read after a verb: "in the top level", "under X". */
function at(where: string) {
  return where.startsWith("under ") ? where : `in ${where}`;
}

function rootName(root: WorkspaceTreeRootPlace) {
  return root === "top"
    ? "the top level, above the list"
    : root === "bottom"
      ? "the top level, below the list"
      : "the top level, in Herdr's list order";
}

/** The arranged view Ranger reads: workspaces, groups and an outline. */
function describe(view: TreeView) {
  const { tree, connections } = view;
  const resolved = resolveWorkspaceTree(
    tree,
    new Map(
      connections
        .filter((connection) => connection.state === "ready")
        .map((connection) => [
          connection.connection_id,
          connection.workspaces.map(workspaceIdentity),
        ]),
    ),
  );
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const parentOf = (node: WorkspaceTreeNode) => {
    const parent = node.parent ? byId.get(node.parent) : undefined;
    if (!parent) return undefined;
    if (parent.kind === "group")
      return { group: parent.id, label: parent.label };
    const live = view.liveOf(parent);
    return {
      connection_id: parent.ref.connection_id,
      workspace_id: live?.workspace.workspace_id ?? parent.ref.workspace_id,
      label: live?.workspace.label ?? parent.ref.label ?? parent.ref.path,
    };
  };
  const placementOf = (node: WorkspaceTreeNode | undefined) => {
    if (!node) return { placement: "usual" as const };
    const parent = parentOf(node);
    if (parent) {
      const siblings = tree.nodes.filter((each) => each.parent === node.parent);
      return {
        placement: "under" as const,
        parent,
        position: siblings.indexOf(node),
      };
    }
    const root = workspaceTreeRootPlace(node);
    if (!root || root === "list")
      return { placement: root ?? ("usual" as const) };
    const siblings = tree.nodes.filter(
      (each) => each.parent === null && workspaceTreeRootPlace(each) === root,
    );
    return { placement: root, position: siblings.indexOf(node) };
  };

  const workspaces = connections.flatMap((connection) =>
    connection.workspaces.map((workspace) => {
      const nodeId = resolved.nodeByWorkspace.get(
        liveWorkspaceKey(connection.connection_id, workspace.workspace_id),
      );
      const node = nodeId ? byId.get(nodeId) : undefined;
      const repo = repoParent(connection.workspaces, workspace);
      const path = pathOf(workspace);
      const branch = workspace.worktree?.git_status?.branch;
      return {
        connection_id: connection.connection_id,
        workspace_id: workspace.workspace_id,
        label: workspace.label,
        ...(path ? { path } : {}),
        ...(branch ? { branch } : {}),
        ...(workspace.worktree?.repo_name
          ? { repository: workspace.worktree.repo_name }
          : {}),
        ...(repo
          ? {
              usually_under: {
                workspace_id: repo.workspace_id,
                label: repo.label,
              },
            }
          : {}),
        ...placementOf(node),
        ...(workspace.number !== undefined
          ? { herdr_number: workspace.number }
          : {}),
      };
    }),
  );
  const groups = tree.nodes.flatMap((node) =>
    node.kind === "group"
      ? [
          {
            group: node.id,
            label: node.label,
            ...placementOf(node),
            children: tree.nodes.filter((each) => each.parent === node.id)
              .length,
            ...(node.collapsed ? { collapsed: true } : {}),
          },
        ]
      : [],
  );
  const unavailable = tree.nodes.flatMap((node) => {
    if (node.kind !== "workspace") return [];
    const state = resolved.nodes.get(node.id);
    if (!state || state.state === "live") return [];
    return [
      {
        connection_id: node.ref.connection_id,
        label: node.ref.label ?? node.ref.path,
        ...(node.ref.path ? { path: node.ref.path } : {}),
        state: state.state === "offline" ? "connection not ready" : "not open",
        ...placementOf(node),
      },
    ];
  });

  // The outline: what the user arranged, in sidebar order.
  const lines: string[] = [];
  const line = (node: WorkspaceTreeNode, depth: number) => {
    const indent = "  ".repeat(depth);
    if (node.kind === "group") {
      lines.push(
        `${indent}[group ${node.id}] ${node.label}${node.collapsed ? " (collapsed)" : ""}`,
      );
    } else {
      const live = view.liveOf(node);
      const label =
        live?.workspace.label ?? node.ref.label ?? node.ref.path ?? "?";
      const id = live
        ? `${node.ref.connection_id}/${live.workspace.workspace_id}`
        : `${node.ref.connection_id}, not open`;
      lines.push(`${indent}${label} (${id})`);
    }
    for (const child of tree.nodes.filter((each) => each.parent === node.id))
      line(child, depth + 1);
  };
  const roots = tree.nodes.filter((node) => node.parent === null);
  const section = (title: string, nodes: WorkspaceTreeNode[]) => {
    if (!nodes.length) return;
    lines.push(title);
    for (const node of nodes) line(node, 1);
  };
  section(
    "Above the list:",
    roots.filter((node) => workspaceTreeRootPlace(node) === "top"),
  );
  section(
    "In Herdr's list (its order), holding what is arranged under them:",
    roots.filter((node) => {
      const root = workspaceTreeRootPlace(node);
      return root === "list" || root === null;
    }),
  );
  section(
    "Below the list:",
    roots.filter((node) => workspaceTreeRootPlace(node) === "bottom"),
  );

  return {
    connections: connections.map((connection) => ({
      connection_id: connection.connection_id,
      label: connection.label,
      state: connection.state,
    })),
    workspaces,
    groups,
    ...(unavailable.length ? { placed_but_unavailable: unavailable } : {}),
    outline: lines.length
      ? lines.join("\n")
      : "Nothing is arranged: every workspace is in its usual place.",
    note: "A workspace with placement usual shows in Herdr's order, a worktree under its repository's main checkout (usually_under).",
  };
}

/** The tree tools over a backend: the server's store and its connections. */
export function createWorkspaceTreeToolHandler(
  backend: WorkspaceTreeToolBackend,
): WorkspaceTreeToolHandler {
  return async (kind, params, signal) => {
    const [connections, tree] = await Promise.all([
      backend.connections(signal),
      backend.read(),
    ]);
    signal?.throwIfAborted();
    const view = new TreeView(connections, tree);
    if (kind === "get") return { text: JSON.stringify(describe(view)) };

    const ops: WorkspaceTreeOp[] = [];
    const changes: string[] = [];
    const notes: string[] = [];
    const created: { group: string; label: string }[] = [];
    const moved: { target: WorkspaceTreeTarget; name: string }[] = [];
    const before = new TreeView(connections, tree);

    const move = (
      items: readonly Item[],
      parent: WorkspaceTreeParent,
      destination: string,
      placement: Placement,
    ) => {
      const subjects = items.map((item) => view.target(item));
      const anchor = view.anchor(
        parent,
        placement,
        subjects.map((each) => each.target),
        notes,
      );
      for (const subject of subjects) {
        const op: WorkspaceTreeOp = {
          op: "move",
          subject: subject.target,
          parent,
          ...(anchor ? { before: anchor } : {}),
        };
        view.apply(op, `move ${subject.name} to ${destination}`);
        ops.push(op);
        moved.push(subject);
      }
    };

    if (kind === "move") {
      for (const entry of params.moves as (Placement & {
        items: Item[];
        to: Destination;
      })[]) {
        const { parent, name } = view.destination(entry.to);
        move(entry.items, parent, name, entry);
      }
    } else {
      for (const action of params.actions as (Placement & {
        action: "create" | "rename" | "delete" | "collapse" | "expand";
        group?: string;
        label?: string;
        parent?: Destination;
        children?: Item[];
      })[]) {
        if (action.action === "create") {
          if (!action.label?.trim())
            throw new AssistantUserError("create needs a label.");
          if (action.group)
            throw new AssistantUserError(
              "create takes a label, not a group; the id is made for you.",
            );
          if (action.parent?.usual)
            throw new AssistantUserError(
              "A group has no usual place: put it in a group, under a workspace, or at root top or bottom.",
            );
          const destination = action.parent
            ? view.destination(action.parent)
            : { parent: null, name: rootName("top") };
          const anchor = view.anchor(destination.parent, action, [], notes);
          const id = newWorkspaceTreeGroupId();
          const op: WorkspaceTreeOp = {
            op: "create_group",
            id,
            label: action.label,
            parent: destination.parent,
            ...(anchor ? { before: anchor } : {}),
          };
          view.apply(op, `create group "${action.label}"`);
          ops.push(op);
          const node = view.tree.nodes.find((each) => each.id === id)!;
          const label = node.kind === "group" ? node.label : action.label;
          created.push({ group: id, label });
          changes.push(
            `Created group "${label}" (${id}) ${at(view.where({ node: id }))}.`,
          );
          if (action.children)
            move(action.children, { node: id }, `group "${label}"`, {});
          continue;
        }
        if (!action.group)
          throw new AssistantUserError(`${action.action} needs a group.`);
        if (action.children || action.parent)
          throw new AssistantUserError(
            `${action.action} takes only a group${action.action === "rename" ? " and a label" : ""}; use workspace_tree_move to move things.`,
          );
        const node = view.findGroup(action.group);
        const name = view.nodeName(node);
        if (action.action === "rename") {
          if (!action.label?.trim())
            throw new AssistantUserError("rename needs a label.");
          const op: WorkspaceTreeOp = {
            op: "rename_group",
            node: node.id,
            label: action.label,
          };
          view.apply(op, `rename ${name}`);
          ops.push(op);
          const renamed = view.tree.nodes.find((each) => each.id === node.id);
          changes.push(
            `Renamed ${name} to "${renamed?.kind === "group" ? renamed.label : action.label}".`,
          );
        } else if (action.action === "delete") {
          const children = view.tree.nodes.filter(
            (each) => each.parent === node.id,
          );
          const parent = node.parent
            ? view.tree.nodes.find((each) => each.id === node.parent)
            : undefined;
          const op: WorkspaceTreeOp = { op: "delete_group", node: node.id };
          view.apply(op, `delete ${name}`);
          ops.push(op);
          changes.push(
            children.length
              ? `Deleted ${name}; its ${children.length} item${children.length === 1 ? "" : "s"} moved up a level, ${parent ? `under ${view.nodeName(parent)}` : "to the top level (workspaces back to their usual place, groups above the list)"}.`
              : `Deleted ${name}, which was empty.`,
          );
        } else {
          const collapsed = action.action === "collapse";
          const op: WorkspaceTreeOp = {
            op: "set_collapsed",
            node: node.id,
            collapsed,
          };
          view.apply(op, `${action.action} ${name}`);
          ops.push(op);
          changes.push(`${collapsed ? "Collapsed" : "Expanded"} ${name}.`);
        }
      }
    }

    signal?.throwIfAborted();
    let after: WorkspaceTree;
    try {
      after = await backend.apply(ops);
    } catch (error) {
      if (error instanceof WorkspaceTreeError)
        throw new AssistantUserError(
          `The arrangement changed meanwhile and refused this: ${error.message} Nothing was changed; read workspace_tree_get again.`,
        );
      throw error;
    }
    const result = new TreeView(connections, after);
    // Each moved item once, where it ended up.
    const last = new Map(
      moved.map((subject) => [JSON.stringify(subject.target), subject]),
    );
    for (const subject of last.values()) {
      const from = before.where(subject.target);
      const to = result.where(subject.target);
      changes.push(
        from === to
          ? `${subject.name} stays ${at(to)}.`
          : `Moved ${subject.name} from ${from} to ${to}.`,
      );
    }
    const changed = JSON.stringify(after) !== JSON.stringify(tree);
    return {
      text: JSON.stringify({
        changed,
        changes,
        ...(created.length ? { groups_created: created } : {}),
        ...(notes.length ? { notes: [...new Set(notes)] } : {}),
      }),
    };
  };
}

/**
 * The live side for the server: each connection's workspaces, with the
 * repository parents and branches the sidebar shows. A connection that is
 * not ready, or does not answer, lists none.
 */
export async function readWorkspaceTreeConnections(manager: {
  list(): { id: string; label: string }[];
  readyRuntimeLease(id: string): {
    runtime: {
      herdr: {
        call(method: string, params?: unknown, timeout?: number): Promise<any>;
      };
      worktreeParents?: { enrichWorkspaceList(result: any): Promise<any> };
      status?: { enrichWorkspacesWithGitStatus(result: any): Promise<any> };
      remotePlatform?: string;
    };
  } | null;
}): Promise<TreeToolConnection[]> {
  return Promise.all(
    manager.list().map(async (connection): Promise<TreeToolConnection> => {
      const base = {
        connection_id: connection.id,
        label: connection.label,
        workspaces: [],
      };
      const lease = manager.readyRuntimeLease(connection.id);
      if (!lease) return { ...base, state: "offline" };
      try {
        const { runtime } = lease;
        let listed = await runtime.herdr.call("workspace.list", {}, 5000);
        if (!Array.isArray(listed?.workspaces)) throw new Error("no list");
        if (runtime.worktreeParents)
          listed = await runtime.worktreeParents.enrichWorkspaceList(listed);
        if (runtime.status && runtime.remotePlatform !== "windows")
          listed = await runtime.status
            .enrichWorkspacesWithGitStatus(listed)
            .catch(() => listed);
        return {
          ...base,
          state: "ready",
          workspaces: (listed.workspaces as unknown[]).filter(
            (each): each is TreeToolWorkspace =>
              !!each &&
              typeof (each as TreeToolWorkspace).workspace_id === "string" &&
              typeof (each as TreeToolWorkspace).label === "string",
          ),
        };
      } catch {
        return { ...base, state: "error" };
      }
    }),
  );
}
