/**
 * The user's arrangement of the Workspaces list: label groups, workspaces
 * that are gone or on a connection that is down, the menu and dialog that
 * move things, and the subagent rows under an agent. WorkspaceTree.tsx
 * renders workspace rows and provides the context.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Folder,
  FolderOpen,
  ListTree,
  RotateCcw,
  Users,
  Workflow,
  X,
} from "lucide-react";
import {
  newWorkspaceTreeGroupId,
  type ResolvedWorkspaceTree,
  type WorkspaceTree,
  type WorkspaceTreeGroupNode,
  type WorkspaceTreeNode,
  type WorkspaceTreeParent,
  type WorkspaceTreeTarget,
  type WorkspaceTreeWorkspaceNode,
  isWorkspaceTreeRoot,
  workspaceTreeContains,
  workspaceTreeNodePlaced,
  workspaceTreeRootPlace,
} from "../../../shared/workspaceTree";
import { roamgateLocalStorage } from "../browserStorage";
import { formatDuration } from "../agentTasksView";
import type { Pane } from "../types";
import { applyWorkspaceTreeOps } from "../workspaceTreeStore";
import type { DropTarget, RowParent, RowSlot } from "../workspaceTreeDrop";
import {
  type AgentTaskSummary,
  summaryIsEmpty,
  summaryLabel,
  type TreeSummary,
  treeTaskLineLabel,
  treeTaskRows,
} from "../workspaceTreeView";
import { taskFailureSeen } from "../workspaceTreeTasks";
import { observeClampedContextMenu } from "./contextMenuPosition";
import { TextInputDialog } from "./ModalDialogs";
import { CloseButton } from "./CloseButton";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
} from "./treeKeyboard";
import { TREE_DEPTH_INDENT } from "./treeIndent";
import { connectionDotColor } from "../workspaceTreeBadges";
import "./WorkspaceTreeArrange.css";

export type { TreeDragItem } from "../workspaceTreeDrop";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

export type DragHandlers = {
  draggable: boolean;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

/** One choice in "Move into…": the top level, a group or a workspace. */
export type MoveTarget = {
  key: string;
  label: string;
  detail?: string;
  target: NonNullable<WorkspaceTreeParent>;
  /** Its node, when it has one: what may not go inside its own subject. */
  nodeId?: string;
};

export type ArrangeContextValue = {
  tree: WorkspaceTree;
  resolved: ResolvedWorkspaceTree;
  dragging: RowSlot | null;
  dropTarget: DropTarget | null;
  /** `expanded`: its children show right below it. */
  dragHandlers: (slot: RowSlot, expanded: boolean) => DragHandlers;
  renderNodeChildren: (
    parentId: string,
    depth: number,
    ancestors: readonly RowSlot[],
    parentName?: string,
  ) => ReactNode;
  nodeSummary: (nodeId: string) => TreeSummary;
  workspaceSummary: (connectionId: string, workspaceId: string) => TreeSummary;
  nodeForWorkspace: (
    connectionId: string,
    workspaceId: string,
  ) => WorkspaceTreeNode | undefined;
  openNodeMenu: (nodeId: string, x: number, y: number) => void;
  tasks: (connectionId: string, paneId: string) => AgentTaskSummary[];
  taskLineExpanded: (key: string) => boolean;
  setTaskLineExpanded: (key: string, expanded: boolean) => void;
  connectionLabel: (connectionId: string) => string;
  /** Whether rows of a connection carry its coloured dot. */
  showsHostDot: (connectionId: string) => boolean;
};

export const ArrangeContext = createContext<ArrangeContextValue | null>(null);

export function useArrange(): ArrangeContextValue | null {
  return useContext(ArrangeContext);
}

export function dropClass(
  arrange: ArrangeContextValue | null,
  key: string,
): string {
  const target = arrange?.dropTarget;
  if (!target || target.key !== key) return "";
  return `drop-${target.zone}`;
}

/** Where the drop line starts: the indentation of the level it lands at. */
export function dropStyle(
  arrange: ArrangeContextValue | null,
  key: string,
): React.CSSProperties {
  const target = arrange?.dropTarget;
  if (!target || target.key !== key || target.zone === "into") return {};
  return {
    "--drop-indent": `${4 + target.level * TREE_DEPTH_INDENT}px`,
  } as React.CSSProperties;
}

/** A connection's dot before a row's name, its name in the tooltip. */
export function HostDot({
  connectionId,
  label,
}: {
  connectionId: string;
  label: string;
}) {
  return (
    <span
      className="workspace-host-dot"
      style={{ background: connectionDotColor(connectionId) }}
      title={label}
      role="img"
      aria-label={`Server: ${label}`}
    />
  );
}

/** Long press opens a row's menu on touch screens. */
export function useLongPressMenu(open: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const triggered = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => clear, []);
  return {
    triggered,
    handlers: {
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse") return;
        triggered.current = false;
        clear();
        start.current = { x: event.clientX, y: event.clientY };
        const { clientX, clientY } = event;
        timer.current = setTimeout(() => {
          triggered.current = true;
          open(clientX, clientY);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        const at = start.current;
        if (!at) return;
        if (
          Math.abs(event.clientX - at.x) > LONG_PRESS_MOVE_PX ||
          Math.abs(event.clientY - at.y) > LONG_PRESS_MOVE_PX
        )
          clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
    },
  };
}

/** What a parent row says of its subtree, in the agent status colours. */
export function TreeSummaryBadge({ summary }: { summary: TreeSummary }) {
  if (summaryIsEmpty(summary)) return null;
  const label = summaryLabel(summary);
  return (
    <span className="workspace-tree-summary" title={label} aria-label={label}>
      {summary.working ? (
        <span className="is-working">{summary.working}</span>
      ) : null}
      {summary.background ? (
        <span className="is-background">
          <span className="background-work-dot" aria-hidden="true" />
          {summary.background}
        </span>
      ) : null}
      {summary.waiting ? (
        <span className={summary.blocked ? "is-blocked" : "is-done"}>
          {summary.waiting}
        </span>
      ) : null}
      {summary.subagents ? (
        <span className="is-subagents">
          <Bot size={10} aria-hidden="true" />
          {summary.subagents}
        </span>
      ) : null}
    </span>
  );
}

function rowKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  {
    expandable,
    collapsed,
    setCollapsed,
    activate,
    openMenu,
  }: {
    expandable: boolean;
    collapsed: boolean;
    setCollapsed: (collapsed: boolean) => void;
    activate: () => void;
    openMenu: (x: number, y: number) => void;
  },
) {
  if (event.target !== event.currentTarget) return;
  const action = treeKeyboardAction(event.key, event.shiftKey);
  if (!action) return;
  event.preventDefault();
  if (
    action === "next" ||
    action === "previous" ||
    action === "first" ||
    action === "last"
  ) {
    focusTreeItem(event.currentTarget, action);
  } else if (action === "expand") {
    if (expandable && collapsed) setCollapsed(false);
    else focusTreeItem(event.currentTarget, "next");
  } else if (action === "collapse") {
    if (expandable && !collapsed) setCollapsed(true);
    else focusTreeItem(event.currentTarget, "previous");
  } else if (action === "activate") {
    event.stopPropagation();
    activate();
  } else {
    event.stopPropagation();
    const point = keyboardContextMenuPoint(event.currentTarget);
    openMenu(point.x, point.y);
  }
}

/** A label group: a parent with no workspace behind it. */
export function GroupRow({
  node,
  depth,
  parent,
  ancestors,
}: {
  node: WorkspaceTreeGroupNode;
  depth: number;
  parent: RowParent;
  ancestors: readonly RowSlot[];
}) {
  const arrange = useArrange()!;
  const hasChildren = arrange.tree.nodes.some(
    (each) => each.parent === node.id,
  );
  const collapsed = !!node.collapsed;
  const setCollapsed = (value: boolean) =>
    void applyWorkspaceTreeOps([
      { op: "set_collapsed", node: node.id, collapsed: value },
    ]);
  const openMenu = (x: number, y: number) =>
    arrange.openNodeMenu(node.id, x, y);
  const { triggered, handlers } = useLongPressMenu(openMenu);
  const key = `node:${node.id}`;
  const slot: RowSlot = {
    item: { kind: "node", key, nodeId: node.id, placed: true },
    depth,
    parent,
    ancestors,
  };
  const drag = arrange.dragHandlers(slot, hasChildren && !collapsed);
  return (
    <>
      <div
        className={`tree-row clickable-row workspace-tree-group ${
          depth > 0 ? "is-child" : ""
        } ${arrange.dragging?.item.key === key ? "is-dragging" : ""} ${dropClass(arrange, key)}`}
        style={{
          paddingLeft: 6 + depth * TREE_DEPTH_INDENT,
          ...dropStyle(arrange, key),
        }}
        data-tree-depth={depth}
        role="treeitem"
        tabIndex={-1}
        aria-level={depth + 1}
        aria-expanded={hasChildren ? !collapsed : undefined}
        aria-label={`Group ${node.label}`}
        data-tree-node={node.id}
        {...drag}
        {...handlers}
        onClick={(event) => {
          if (triggered.current) {
            triggered.current = false;
            event.preventDefault();
            return;
          }
          if (hasChildren) setCollapsed(!collapsed);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
        onKeyDown={(event) =>
          rowKeyDown(event, {
            expandable: hasChildren,
            collapsed,
            setCollapsed,
            activate: () => hasChildren && setCollapsed(!collapsed),
            openMenu,
          })
        }
      >
        {hasChildren ? (
          <button
            type="button"
            className="workspace-group-toggle"
            tabIndex={-1}
            aria-label={collapsed ? "Expand group" : "Collapse group"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setCollapsed(!collapsed);
            }}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span className="twisty" aria-hidden="true" />
        )}
        {collapsed || !hasChildren ? (
          <Folder size={13} className="workspace-tree-group-icon" />
        ) : (
          <FolderOpen size={13} className="workspace-tree-group-icon" />
        )}
        <strong className="ws-label" title={node.label}>
          {node.label}
        </strong>
        <TreeSummaryBadge summary={arrange.nodeSummary(node.id)} />
      </div>
      {!collapsed
        ? arrange.renderNodeChildren(
            node.id,
            depth + 1,
            [...ancestors, slot],
            node.label,
          )
        : null}
    </>
  );
}

/** A workspace that is gone, or on a connection that is down: kept, greyed. */
export function UnavailableWorkspaceRow({
  node,
  state,
  depth,
  parent,
  ancestors,
}: {
  node: WorkspaceTreeWorkspaceNode;
  state: "offline" | "gone";
  depth: number;
  parent: RowParent;
  ancestors: readonly RowSlot[];
}) {
  const arrange = useArrange()!;
  const openMenu = (x: number, y: number) =>
    arrange.openNodeMenu(node.id, x, y);
  const { handlers } = useLongPressMenu(openMenu);
  const key = `node:${node.id}`;
  const label =
    node.ref.label ||
    node.ref.path?.split("/").filter(Boolean).pop() ||
    node.ref.workspace_id ||
    "Workspace";
  const server = arrange.connectionLabel(node.ref.connection_id);
  const why =
    state === "offline" ? `${server} is not connected` : "No longer open";
  const remove = () =>
    void applyWorkspaceTreeOps([{ op: "remove", node: node.id }]);
  const slot: RowSlot = {
    item: {
      kind: "node",
      key,
      nodeId: node.id,
      placed: workspaceTreeNodePlaced(node),
    },
    depth,
    parent,
    ancestors,
  };
  const hasChildren = arrange.tree.nodes.some(
    (each) => each.parent === node.id,
  );
  return (
    <>
      <div
        className={`tree-row workspace-tree-unavailable ${
          depth > 0 ? "is-child" : ""
        } ${dropClass(arrange, key)}`}
        style={{
          paddingLeft: 6 + depth * TREE_DEPTH_INDENT,
          ...dropStyle(arrange, key),
        }}
        data-tree-depth={depth}
        role="treeitem"
        tabIndex={-1}
        aria-level={depth + 1}
        aria-disabled="true"
        aria-label={`${label}, ${why}`}
        title={[label, server, node.ref.path, why].filter(Boolean).join("\n")}
        data-tooltip-card=""
        data-tree-node={node.id}
        {...arrange.dragHandlers(slot, hasChildren)}
        {...handlers}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            remove();
            return;
          }
          rowKeyDown(event, {
            expandable: false,
            collapsed: false,
            setCollapsed: () => undefined,
            activate: () => undefined,
            openMenu,
          });
        }}
      >
        <span className="twisty" aria-hidden="true" />
        {arrange.showsHostDot(node.ref.connection_id) ? (
          <HostDot connectionId={node.ref.connection_id} label={server} />
        ) : null}
        <strong className="ws-label">{label}</strong>
        <span className="workspace-tree-unavailable-why">
          {state === "offline" ? "offline" : "gone"}
        </span>
        <button
          type="button"
          className="workspace-tree-remove"
          tabIndex={-1}
          title="Remove from the list"
          aria-label={`Remove ${label} from the list`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            remove();
          }}
        >
          <X size={12} />
        </button>
      </div>
      {arrange.renderNodeChildren(
        node.id,
        depth + 1,
        [...ancestors, slot],
        label,
      )}
    </>
  );
}

function TaskKindIcon({ task }: { task: AgentTaskSummary }) {
  if (task.kind === "teammate") return <Users size={12} aria-hidden="true" />;
  if (task.kind === "workflow")
    return <Workflow size={12} aria-hidden="true" />;
  return <Bot size={12} aria-hidden="true" />;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

const TASK_STATE_LABEL = {
  running: "running",
  idle: "idle",
  failed: "failed",
} as const;

/**
 * Under an agent: "▸ 3 subagents · 1 running", and once opened its live
 * subagents, teammates and workflows. Clicking one opens it in the Tasks
 * sheet.
 */
export function AgentTaskLine({
  connectionId,
  pane,
  depth,
  onOpenTask,
}: {
  connectionId: string;
  pane: Pane;
  depth: number;
  onOpenTask: (task: AgentTaskSummary) => void;
}) {
  const arrange = useArrange();
  const tasks = arrange?.tasks(connectionId, pane.pane_id) ?? [];
  const { rows, done } = treeTaskRows(tasks, (task) =>
    taskFailureSeen(connectionId, pane.pane_id, task.id),
  );
  const key = `${connectionId}\u0000${pane.pane_id}`;
  const expanded = arrange?.taskLineExpanded(key) ?? false;
  const now = useNow(expanded && rows.some((row) => row.state === "running"));
  if (!arrange || rows.length === 0) return null;
  const indent = TREE_DEPTH_INDENT + depth * TREE_DEPTH_INDENT;
  const label = treeTaskLineLabel(rows);
  const toggle = () => arrange.setTaskLineExpanded(key, !expanded);
  return (
    <>
      <div
        className="agent-task-line"
        role="treeitem"
        tabIndex={-1}
        aria-level={depth + 1}
        aria-expanded={expanded}
        aria-label={label}
        style={{ marginLeft: indent }}
        onClick={toggle}
        onKeyDown={(event) =>
          rowKeyDown(event, {
            expandable: true,
            collapsed: !expanded,
            setCollapsed: (collapsed) =>
              arrange.setTaskLineExpanded(key, !collapsed),
            activate: toggle,
            openMenu: () => undefined,
          })
        }
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="agent-task-line-label">{label}</span>
        {done ? (
          <button
            type="button"
            className="agent-task-line-done"
            tabIndex={-1}
            title="Open the Tasks sheet"
            onClick={(event) => {
              event.stopPropagation();
              const first = tasks.find(
                (task) => task.kind !== "command" && task.kind !== "monitor",
              );
              if (first) onOpenTask(first);
            }}
          >
            {done} done
          </button>
        ) : null}
      </div>
      {expanded
        ? rows.map(({ task, state }) => {
            const started = task.startedAt
              ? Date.parse(task.startedAt)
              : Number.NaN;
            const elapsed =
              state === "running" && Number.isFinite(started)
                ? formatDuration(now - started)
                : "";
            const name = task.name && task.name !== task.title ? task.name : "";
            return (
              <div
                key={task.id}
                className={`agent-task-row is-${state}`}
                role="treeitem"
                tabIndex={-1}
                aria-level={depth + 2}
                aria-label={`${task.title}, ${TASK_STATE_LABEL[state]}${task.rewound ? ", started in a rewound part" : ""}`}
                title={`${task.title}${name ? ` (${name})` : ""}${task.rewound ? "\nStarted in a rewound part of the conversation" : ""}`}
                style={{ marginLeft: indent + TREE_DEPTH_INDENT }}
                onClick={() => onOpenTask(task)}
                onKeyDown={(event) =>
                  rowKeyDown(event, {
                    expandable: false,
                    collapsed: false,
                    setCollapsed: () => undefined,
                    activate: () => onOpenTask(task),
                    openMenu: () => undefined,
                  })
                }
              >
                <TaskKindIcon task={task} />
                <span className="agent-task-row-title">
                  {task.title}
                  {name ? <span className="muted"> · {name}</span> : null}
                </span>
                {task.rewound ? (
                  <RotateCcw
                    size={11}
                    className="agent-task-row-rewound"
                    aria-hidden="true"
                  />
                ) : null}
                {state === "failed" ? (
                  <CircleAlert size={12} aria-hidden="true" />
                ) : null}
                <span className="agent-task-row-state">
                  {elapsed || TASK_STATE_LABEL[state]}
                </span>
              </div>
            );
          })
        : null}
    </>
  );
}

const EXPANDED_TASK_LINES_KEY = "roamgate.workspaceTree.expandedTaskLines";

export function readExpandedTaskLines(): string[] {
  try {
    const value = JSON.parse(
      roamgateLocalStorage.getItem(EXPANDED_TASK_LINES_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((each): each is string => typeof each === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeExpandedTaskLines(keys: readonly string[]) {
  try {
    roamgateLocalStorage.setItem(
      EXPANDED_TASK_LINES_KEY,
      JSON.stringify(keys.slice(-300)),
    );
  } catch {
    // Kept for this page when storage is unavailable.
  }
}

export type NodeMenuState = { nodeId: string; x: number; y: number };

type MenuItem = { label: string; danger?: boolean; action: () => void };

/** The menu of a group or an unavailable workspace. */
export function ArrangeNodeMenu({
  state,
  onClose,
  onMoveInto,
  onNewGroup,
}: {
  state: NodeMenuState | null;
  onClose: () => void;
  onMoveInto: (target: WorkspaceTreeTarget, label: string) => void;
  onNewGroup: (parent: WorkspaceTreeTarget | null) => void;
}) {
  const arrange = useArrange();
  const ref = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<WorkspaceTreeGroupNode | null>(null);
  const node = state
    ? arrange?.tree.nodes.find((each) => each.id === state.nodeId)
    : undefined;
  useEffect(() => {
    if (!state) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!state || !menu) return;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
    return observeClampedContextMenu(menu, { left: state.x, top: state.y });
  }, [state]);
  const renameDialog = (
    <TextInputDialog
      open={!!renaming}
      title="Rename Group"
      label="Name"
      initialValue={renaming?.label ?? ""}
      submitLabel="Rename"
      onClose={() => setRenaming(null)}
      onSubmit={(label) => {
        if (renaming && label.trim())
          void applyWorkspaceTreeOps([
            { op: "rename_group", node: renaming.id, label },
          ]);
        setRenaming(null);
      }}
    />
  );
  if (!state || !node) return renameDialog;
  const items: MenuItem[] = [];
  const title =
    node.kind === "group"
      ? node.label
      : node.ref.label || node.ref.path || "Workspace";
  if (node.kind === "group") {
    items.push(
      { label: "Rename group…", action: () => setRenaming(node) },
      {
        label: "New group inside…",
        action: () => onNewGroup({ node: node.id }),
      },
    );
  }
  items.push({
    label: "Move into…",
    action: () => onMoveInto({ node: node.id }, title),
  });
  const move = (parent: WorkspaceTreeParent) =>
    void applyWorkspaceTreeOps([
      { op: "move", subject: { node: node.id }, parent },
    ]);
  const place = workspaceTreeRootPlace(node);
  if (node.kind === "group") {
    if (place !== "top")
      items.push({ label: "Move to the top", action: () => move(null) });
    if (place !== "bottom")
      items.push({
        label: "Move to the bottom",
        action: () => move({ root: "bottom" }),
      });
  } else {
    if (place !== "list" && place !== "top")
      items.push({
        label: "Move to top level",
        action: () => move({ root: "list" }),
      });
    if (workspaceTreeNodePlaced(node))
      items.push({
        label: "Back to its usual place",
        action: () => move(null),
      });
  }
  if (node.kind === "group")
    items.push({
      label: "Delete group",
      danger: true,
      action: () =>
        void applyWorkspaceTreeOps([{ op: "delete_group", node: node.id }]),
    });
  else
    items.push({
      label: "Remove from the list",
      danger: true,
      action: () =>
        void applyWorkspaceTreeOps([{ op: "remove", node: node.id }]),
    });
  return (
    <>
      <div
        ref={ref}
        className="context-menu context-menu--grouped"
        role="menu"
        style={{ position: "fixed", left: state.x, top: state.y, zIndex: 1000 }}
      >
        <div className="context-menu-header">
          <span>{node.kind === "group" ? "Group" : "Workspace"}</span>
          <strong title={title}>{title}</strong>
          {node.kind === "group" ? (
            <small>Items keep their place when it is deleted</small>
          ) : null}
        </div>
        <div className="context-menu-group">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
              onClick={() => {
                onClose();
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {renameDialog}
    </>
  );
}

/** The workspaces and groups something may go into, minus itself and below. */
export function moveTargetsFor(
  tree: WorkspaceTree,
  subjectNodeId: string | undefined,
  subjectKey: string | undefined,
  targets: readonly MoveTarget[],
): MoveTarget[] {
  const subjectNode = subjectNodeId
    ? tree.nodes.find((node) => node.id === subjectNodeId)
    : undefined;
  return targets.filter((target) => {
    if (subjectKey && target.key === subjectKey) return false;
    if (isWorkspaceTreeRoot(target.target)) {
      // Already at the top level, above or in the list.
      const place = subjectNode ? workspaceTreeRootPlace(subjectNode) : null;
      return place !== "top" && place !== "list";
    }
    if (!subjectNodeId || !target.nodeId) return true;
    return !workspaceTreeContains(tree, subjectNodeId, target.nodeId);
  });
}

/** "Move into…": choose a group or workspace, or make a group for it. */
export function MoveIntoDialog({
  subject,
  targets,
  onClose,
}: {
  subject: { target: WorkspaceTreeTarget; label: string } | null;
  targets: readonly MoveTarget[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [naming, setNaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!subject) return;
    setQuery("");
    setCursor(0);
    setNaming(false);
    inputRef.current?.focus();
  }, [subject]);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return targets.filter((target) => {
      const text = `${target.label} ${target.detail ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [query, targets]);
  if (!subject) return null;
  const choose = (target: MoveTarget) => {
    onClose();
    void applyWorkspaceTreeOps([
      { op: "move", subject: subject.target, parent: target.target },
    ]);
  };
  if (naming)
    return (
      <TextInputDialog
        open
        title="New Group"
        label="Name"
        initialValue={query.trim()}
        placeholder="upstreaming"
        submitLabel="Create and move"
        onClose={onClose}
        onSubmit={(label) => {
          if (!label.trim()) return;
          const id = newWorkspaceTreeGroupId();
          onClose();
          void applyWorkspaceTreeOps([
            { op: "create_group", id, label, parent: null },
            { op: "move", subject: subject.target, parent: { node: id } },
          ]);
        }}
      />
    );
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal compact-modal workspace-move-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${subject.label} into`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((at) => Math.min(at + 1, shown.length));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((at) => Math.max(at - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const target = shown[cursor];
            if (target) choose(target);
            else setNaming(true);
          }
        }}
      >
        <div className="modal-head">
          <h2>Move into…</h2>
          <CloseButton onClick={onClose} />
        </div>
        <p className="muted workspace-move-subject">{subject.label}</p>
        <input
          ref={inputRef}
          type="search"
          className="workspace-move-search"
          placeholder="Top level, group or workspace"
          aria-label="Find a group or workspace"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setCursor(0);
          }}
        />
        <ul className="workspace-move-list" role="listbox">
          {shown.map((target, index) => (
            <li key={target.key}>
              <button
                type="button"
                role="option"
                aria-selected={index === cursor}
                className={index === cursor ? "is-cursor" : ""}
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(target)}
              >
                {isWorkspaceTreeRoot(target.target) ? (
                  <ListTree size={13} aria-hidden="true" />
                ) : "node" in target.target ? (
                  <Folder size={13} aria-hidden="true" />
                ) : null}
                <span>{target.label}</span>
                {target.detail ? (
                  <small className="muted">{target.detail}</small>
                ) : null}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              role="option"
              aria-selected={cursor === shown.length}
              className={cursor === shown.length ? "is-cursor" : ""}
              onMouseEnter={() => setCursor(shown.length)}
              onClick={() => setNaming(true)}
            >
              <FolderOpen size={13} aria-hidden="true" />
              <span>New group…</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}

export function workspaceTreeNodeLabel(node: WorkspaceTreeNode): string {
  return node.kind === "group"
    ? node.label
    : node.ref.label || node.ref.path || "Workspace";
}
