import {
  headedGroupOf,
  isSkipped,
  setWorkspaceHeaded,
  useUpstreamMarks,
} from "../mrUpstream";
import { roamgateLocalStorage, subscribeLocalStorage } from "../browserStorage";
import { useOverlayTabMarks } from "../overlayTabs";
import type { PullRequestSummary } from "../../../shared/pullRequest";
import { useWorkspacePullRequests } from "../useWorktreePullRequests";
import { shallowEqual, store, useStoreSelector } from "../store";
import type { Pane, Tab, Workspace } from "../types";
import type { ConnectionSummary } from "../api";
import { connectionLifecycleLabel } from "../connectionProfiles";
import { shortId } from "../utils";
import {
  mrReviewWorkspaceOf,
  useMrReviewWorkspaces,
} from "../mrReviewWorkspaces";
import {
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import {
  createContext,
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ContextMenuState } from "./ContextMenu";
import { ThemedSelect } from "./ThemedSelect";
import { buildWorkspaceHierarchy, worktreeCreationSource } from "../worktree";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Layers,
  Pin,
  Plus,
} from "lucide-react";
import { WorktreeLifecycleDialog } from "./WorktreeLifecycleDialog";
import {
  WORKSPACE_PINS_STORAGE_KEY,
  isWorkspacePinned,
  parseWorkspacePins,
  serializeWorkspacePins,
  setWorkspacePinned,
} from "../workspacePins";
import {
  COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  isWorktreeGroupCollapsed,
  parseCollapsedWorktreeGroups,
  serializeCollapsedWorktreeGroups,
  setWorktreeGroupCollapsed,
} from "../workspaceTreeCollapse";
import {
  shortWorkspaceName,
  workspaceBranchLine,
  workspaceChangeIndicator,
  workspaceDisplayName,
  workspacePullRequest,
} from "../workspaceTreeBadges";
import { pruneClosedWorkspacePreferenceKeys } from "../workspacePreferences";
import { connectionStorageKey } from "../connectionStorage";
import {
  AGENT_ORDER_STORAGE_KEY,
  moveAgentPane,
  sortAgentPanes,
  groupOrderedAgentPanes,
  AGENT_LIST_PREFERENCES_STORAGE_KEY,
  parseAgentListPreferences,
  type AgentSort,
  type AgentGrouping,
  parseAgentOrder,
  serializeAgentOrder,
} from "../agentOrder";
import { agentRecencyKey, useAgentRecency } from "../agentRecency";
import {
  visibleWorkspaceTabChips,
  type WorkspaceTabChip,
  workspaceTabChips,
} from "../workspaceTabChips";
import type { AgentStateKind } from "./agentSession";
import {
  WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
  type WorkspaceAgentLayout,
  parseWorkspaceAgentLayout,
} from "../workspaceAgentLayout";
import {
  type ServerAgentPane,
  type ServerSessionSource,
  openServerSession,
  useAllServerAgentSessions,
} from "../useAllServerAgentSessions";
import {
  setShowAllConnections,
  useShowAllConnections,
} from "../showAllConnections";
import { useConnectionClient } from "../useConnectionClient";
import { activePaneIdForSnapshot } from "../paneJump";
import { ConfirmDialog } from "./ModalDialogs";
import {
  AgentContextMenu,
  type AgentMenuState,
  AgentRow,
  nestedAgentPaneIds,
} from "./WorkspaceAgentRows";
import {
  exportSessionForConnection,
  groupAgentPanesByWorkspace,
  paneHasAgentHistory,
} from "./agentSession";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
  workspaceTreeItemIsTabStop,
} from "./treeKeyboard";
import { TREE_DEPTH_INDENT } from "./treeIndent";
import {
  findWorkspaceNode,
  type LiveWorkspaceIdentity,
  liveWorkspaceKey,
  newWorkspaceTreeGroupId,
  resolveWorkspaceTree,
  type WorkspaceTreeNode,
  type WorkspaceTreeParent,
  type WorkspaceTreeRootPlace,
  type WorkspaceTreeTarget,
  workspaceIdentity,
  workspaceRefFor,
  workspaceTreeContains,
  workspaceTreeNodePlaced,
  workspaceTreeRootPlace,
} from "../../../shared/workspaceTree";
import {
  applyWorkspaceTreeOps,
  getWorkspaceTree,
  onWorkspaceArrangeRequest,
  useWorkspaceTree,
  workspaceTreeLoaded,
} from "../workspaceTreeStore";
import {
  dropZone,
  EMPTY_TREE_SUMMARY,
  subtreeSummary,
  treeTaskRows,
} from "../workspaceTreeView";
import { markTaskFailureSeen, useTreeAgentTasks } from "../workspaceTreeTasks";
import { openAgentTask } from "../agentTasksOpen";
import {
  agentPresence,
  backgroundTaskLines,
  backgroundWork,
} from "../agentBackground";
import { withAgentActivity } from "../agentOrder";
import { TextInputDialog } from "./ModalDialogs";
import {
  AgentTaskLine,
  ArrangeContext,
  type ArrangeContextValue,
  ArrangeNodeMenu,
  type DragHandlers,
  dropClass,
  dropStyle,
  GroupRow,
  HostDot,
  MoveIntoDialog,
  type MoveTarget,
  moveTargetsFor,
  type NodeMenuState,
  readExpandedTaskLines,
  TreeSummaryBadge,
  UnavailableWorkspaceRow,
  useArrange,
  useLongPressMenu,
  workspaceTreeNodeLabel,
  writeExpandedTaskLines,
} from "./WorkspaceTreeArrange";
import {
  type DropPlan,
  type DropTarget,
  edgeDropPlan,
  gapDropPlan,
  gapLevel,
  type RowParent,
  type RowSlot,
  slotAtLevel,
  dragTarget,
  type WorkspaceDragItem,
} from "../workspaceTreeDrop";
import "./WorkspaceTree.css";
import "./WorkspaceAutoSyncDialog.css";

const AGENT_SORT_LABELS: Record<AgentSort, string> = {
  attention: "Attention first",
  recent: "Recently opened",
  workspace: "Workspace order",
  manual: "Manual order",
};
const EMPTY_AGENT_PANES_BY_WORKSPACE = new Map<string, Pane[]>();
const ContextMenu = lazy(() =>
  import("./ContextMenu").then((module) => ({ default: module.ContextMenu })),
);

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function AgentLayoutControl({
  value,
  onChange,
}: {
  value: WorkspaceAgentLayout;
  onChange: (value: WorkspaceAgentLayout) => void;
}) {
  return (
    <div className="workspace-agent-layout-control">
      <span>Agents</span>
      <div role="group" aria-label="Agent list layout">
        <button
          type="button"
          className={value === "compact" ? "is-active" : ""}
          aria-pressed={value === "compact"}
          onClick={() => onChange("compact")}
        >
          Compact
        </button>
        <button
          type="button"
          className={value === "nested" ? "is-active" : ""}
          aria-pressed={value === "nested"}
          onClick={() => onChange("nested")}
        >
          Nested
        </button>
        <button
          type="button"
          className={value === "separate" ? "is-active" : ""}
          aria-pressed={value === "separate"}
          onClick={() => onChange("separate")}
        >
          Separate
        </button>
      </div>
    </div>
  );
}

const AGENT_DOT_PRIORITY: AgentStateKind[] = [
  "blocked",
  "done",
  "working",
  "idle",
];

/** A row dot's state: an agent's, or idle while its side tasks run. */
type RowAgentState = Exclude<AgentStateKind, "unknown"> | "background";

/**
 * The state a row's dot shows: the most urgent of its tabs' agents. An
 * idle one whose subagents or background commands still run (`background`
 * of them) goes between working and idle.
 */
function workspaceAgentState(
  chips: readonly WorkspaceTabChip[],
  background = 0,
): RowAgentState | null {
  for (const state of AGENT_DOT_PRIORITY)
    if (chips.some((chip) => chip.status === state)) {
      if (state === "idle" && background) return "background";
      return state as Exclude<AgentStateKind, "unknown">;
    }
  return null;
}

const ROW_AGENT_STATE_LABELS: Record<RowAgentState, string> = {
  blocked: "Blocked",
  done: "Done",
  working: "Working",
  background: "Idle, running in the background",
  idle: "Idle",
};

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The hover card: everything a narrow row leaves out, one fact a line. */
function workspaceCard({
  name,
  host,
  workspace,
  paneCount,
  tabCount,
  agentState,
  background,
  review,
  pinned,
}: {
  name: string;
  host?: string;
  workspace: Workspace;
  paneCount: number;
  tabCount: number;
  agentState: RowAgentState | null;
  /** What its idle agents still run, one task a line. */
  background?: readonly string[];
  review?: string;
  pinned: boolean;
}): string {
  const worktree = workspace.worktree;
  const status = worktree?.git_status;
  const lines = [name];
  if (host) lines.push(`Host: ${host}`);
  if (status?.branch)
    lines.push(
      `Branch: ${status.branch}${status.upstream ? ` (${status.upstream})` : ""}`,
    );
  const path = worktree?.checkout_path || workspace.cwd;
  if (path) lines.push(`Path: ${path}`);
  if (status?.error) lines.push(`git status unavailable: ${status.error}`);
  else if (status) {
    const changes = [
      status.staged ? `${status.staged} staged` : null,
      status.unstaged ? `${status.unstaged} unstaged` : null,
      status.untracked ? `${status.untracked} untracked` : null,
      status.conflicted ? `${status.conflicted} conflicted` : null,
    ].filter(Boolean);
    lines.push(`Changes: ${changes.length ? changes.join(", ") : "none"}`);
    if (status.ahead || status.behind)
      lines.push(`Ahead ${status.ahead}, behind ${status.behind}`);
  }
  if (review) lines.push(review.split("\n")[0] ?? review);
  lines.push(
    `${plural(paneCount, "pane")} in ${plural(Math.max(tabCount, 1), "tab")}${
      agentState
        ? ` · agents ${ROW_AGENT_STATE_LABELS[agentState].toLowerCase()}`
        : ""
    }`,
  );
  if (background?.length)
    lines.push(
      `${background.length} running in the background:`,
      ...background.map((line) => `  ${line}`),
    );
  if (pinned) lines.push("Pinned");
  return lines.join("\n");
}

function PullRequestBadge({
  review,
}: {
  review: NonNullable<ReturnType<typeof workspacePullRequest>>;
}) {
  const Icon = {
    open: GitPullRequest,
    draft: GitPullRequestDraft,
    merged: GitMerge,
    closed: GitPullRequestClosed,
  }[review.state];
  return (
    <span
      className="git-badge workspace-review"
      data-state={review.state}
      data-stale={review.stale || undefined}
      title={review.title}
      aria-label={review.title}
      role="img"
    >
      <Icon size={12} aria-hidden="true" />
      {review.id}
    </span>
  );
}

export function WorkspaceTree({
  agentsFirst = false,
  onCreateWorkspace,
  onSelect,
  onBrowseFiles,
  onReviewChanges,
  onSelectAgent,
  onBrowseFilesForAgent,
  onReviewChangesForAgent,
  onViewAgentHistory,
}: {
  agentsFirst?: boolean;
  onCreateWorkspace: (allServers: boolean) => void;
  onSelect?: (workspace: Workspace) => void;
  onBrowseFiles?: (workspace: Workspace) => void;
  onReviewChanges?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onBrowseFilesForAgent?: (pane: Pane) => void;
  onReviewChangesForAgent?: (pane: Pane) => void;
  onViewAgentHistory?: (pane: Pane) => void;
}) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      serverRuntimeGeneration: state.serverRuntimeGeneration,
      connections: state.connections,
      lastRefresh: state.lastRefresh,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      tabs: state.tabs,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const connectionClient = useConnectionClient();
  const connectedServerCount = s.connections.filter(
    (connection) => connection.state === "ready",
  ).length;
  const reviews = useWorkspacePullRequests(connectionClient, s.workspaces);
  // The last pull requests seen for each connection: its rows keep their
  // badges while another connection is displayed.
  const reviewsByConnection = useRef(
    new Map<string, ReturnType<typeof useWorkspacePullRequests>>(),
  );
  if (Object.keys(reviews).length)
    reviewsByConnection.current.set(s.activeConnectionId, reviews);
  const agentOrderStorageKey = connectionStorageKey(
    s.activeConnectionId,
    AGENT_ORDER_STORAGE_KEY,
  );
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [menuMounted, setMenuMounted] = useState(false);
  const [agentMenu, setAgentMenu] = useState<AgentMenuState | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<Pane | null>(null);
  const [treeDragging, setTreeDragging] = useState<RowSlot | null>(null);
  const [treeDropTarget, setTreeDropTarget] = useState<DropTarget | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [moveInto, setMoveInto] = useState<{
    target: WorkspaceTreeTarget;
    label: string;
    nodeId?: string;
    key?: string;
  } | null>(null);
  const [newGroupParent, setNewGroupParent] = useState<{
    parent: WorkspaceTreeTarget | null;
  } | null>(null);
  const [expandedTaskLines, setExpandedTaskLines] = useState<string[]>(
    readExpandedTaskLines,
  );
  const [draggedAgentPaneId, setDraggedAgentPaneId] = useState<string | null>(
    null,
  );
  const [agentDropTarget, setAgentDropTarget] = useState<{
    paneId: string;
    position: "before" | "after";
  } | null>(null);
  const [agentListPreferences, setAgentListPreferences] = useState(() =>
    parseAgentListPreferences(
      roamgateLocalStorage.getItem(AGENT_LIST_PREFERENCES_STORAGE_KEY),
    ),
  );
  const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Set<string>>(
    new Set(),
  );
  const manualAgentOrder =
    agentListPreferences.sort === "manual" &&
    agentListPreferences.grouping === "none";
  const [agentPaneOrder, setAgentPaneOrder] = useState<string[]>(() =>
    parseAgentOrder(roamgateLocalStorage.getItem(agentOrderStorageKey)),
  );
  const [agentLayout, setAgentLayout] = useState<WorkspaceAgentLayout>(() =>
    parseWorkspaceAgentLayout(
      roamgateLocalStorage.getItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY),
    ),
  );
  // Shared with the pane switchers and the store, which reads every other
  // connection's topology while this scope is on.
  const allServers = useShowAllConnections();
  const setAllServers = setShowAllConnections;
  const tree = useWorkspaceTree();
  const upstreamMarks = useUpstreamMarks();
  const overlayMarks = useOverlayTabMarks();
  // Children placed from other connections need those connections read
  // even while only the active one is listed.
  const treeSpansConnections = tree.nodes.some(
    (node) =>
      node.kind === "workspace" &&
      node.ref.connection_id !== s.activeConnectionId,
  );
  const allServerSessions = useAllServerAgentSessions(
    allServers || treeSpansConnections,
  );
  const agentSort =
    allServers && agentListPreferences.sort === "manual"
      ? "workspace"
      : agentListPreferences.sort;
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState<
    string | null
  >(null);
  const lastPrunedWorkspaceRefresh = useRef(0);
  // Menus, dialogs and drags name the connection they were opened on: they
  // close when another one is shown (the tree itself stays).
  const [menusConnection, setMenusConnection] = useState(s.activeConnectionId);
  if (menusConnection !== s.activeConnectionId) {
    setMenusConnection(s.activeConnectionId);
    setMenu(null);
    setAgentMenu(null);
    setNodeMenu(null);
    setMoveInto(null);
    setNewGroupParent(null);
    setPendingClosePane(null);
    setLifecycleWorkspaceId(null);
    setTreeDragging(null);
    setTreeDropTarget(null);
    setDraggedAgentPaneId(null);
    setAgentDropTarget(null);
  }
  const pinsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    WORKSPACE_PINS_STORAGE_KEY,
  );
  const collapsedGroupsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  );
  // The connection each of these lists was read for (see their effects).
  const agentOrderKeyRef = useRef(agentOrderStorageKey);
  const pinsKeyRef = useRef(pinsStorageKey);
  const collapsedKeyRef = useRef(collapsedGroupsStorageKey);
  const [pinnedWorkspaceKeys, setPinnedWorkspaceKeys] = useState<string[]>(() =>
    parseWorkspacePins(roamgateLocalStorage.getItem(pinsStorageKey)),
  );
  const [collapsedWorktreeGroupKeys, setCollapsedWorktreeGroupKeys] = useState<
    string[]
  >(() =>
    parseCollapsedWorktreeGroups(
      roamgateLocalStorage.getItem(collapsedGroupsStorageKey),
    ),
  );
  // Other connections' pins and collapsed groups, read from this browser.
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  useEffect(
    () =>
      subscribeLocalStorage(() =>
        setPreferencesRevision((revision) => revision + 1),
      ),
    [],
  );
  const pinnedWorkspaceSet = new Set(pinnedWorkspaceKeys);
  const collapsedWorktreeGroupSet = new Set(collapsedWorktreeGroupKeys);
  const activePaneId = activePaneIdForSnapshot(s) ?? null;
  const agentsByWorkspace = useMemo(
    () => groupAgentPanesByWorkspace(s.panes),
    [s.panes],
  );
  const tabChipsByWorkspace = useMemo(
    () => workspaceTabChips(s.tabs, s.panes),
    [s.tabs, s.panes],
  );
  const defaultAgentPanes = useMemo(() => {
    const workspaceNumbers = new Map(
      s.workspaces.map((workspace) => [
        workspace.workspace_id,
        workspace.number,
      ]),
    );
    return s.panes.filter(paneHasAgentHistory).sort((left, right) => {
      const workspaceOrder =
        (workspaceNumbers.get(left.workspace_id) ?? 0) -
        (workspaceNumbers.get(right.workspace_id) ?? 0);
      return workspaceOrder || left.pane_id.localeCompare(right.pane_id);
    });
  }, [s.panes, s.workspaces]);
  const agentRecency = useAgentRecency();
  const agentPanes = useMemo(
    () =>
      sortAgentPanes(
        defaultAgentPanes,
        agentPaneOrder,
        agentListPreferences.sort,
        (pane) =>
          agentRecency.get(agentRecencyKey(s.activeConnectionId, pane)) ?? 0,
      ),
    [
      agentPaneOrder,
      defaultAgentPanes,
      agentListPreferences.sort,
      agentRecency,
      s.activeConnectionId,
    ],
  );

  const listedAgentPanes: (Pane | ServerAgentPane)[] = allServers
    ? sortAgentPanes(
        allServerSessions.panes,
        [],
        agentSort,
        (pane) =>
          agentRecency.get(agentRecencyKey(pane.connectionId, pane)) ?? 0,
      )
    : agentPanes;
  const agentGroups = groupOrderedAgentPanes(
    listedAgentPanes,
    agentListPreferences.grouping,
    new Map(
      allServers
        ? allServerSessions.panes.map((pane) => [
            pane.workspaceKey,
            `${pane.serverLabel} / ${pane.workspaceLabel}`,
          ])
        : s.workspaces.map((workspace) => [
            workspace.workspace_id,
            workspaceDisplayName(workspace),
          ]),
    ),
  );
  useEffect(() => {
    roamgateLocalStorage.setItem(
      AGENT_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify(agentListPreferences),
    );
  }, [agentListPreferences]);

  useEffect(() => {
    if (menu) setMenuMounted(true);
  }, [menu]);
  useEffect(() => {
    setMenu(null);
    setAgentMenu(null);
    setPendingClosePane(null);
    setTreeDragging(null);
    setTreeDropTarget(null);
    setNodeMenu(null);
    setDraggedAgentPaneId(null);
    setAgentDropTarget(null);
  }, [connectionClient]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
      agentLayout,
    );
  }, [agentLayout]);
  // Each list is saved under the connection it was read for: switching to
  // another connection reads that one's, never writes these over it.
  useEffect(() => {
    if (agentOrderKeyRef.current !== agentOrderStorageKey) {
      agentOrderKeyRef.current = agentOrderStorageKey;
      setAgentPaneOrder(
        parseAgentOrder(roamgateLocalStorage.getItem(agentOrderStorageKey)),
      );
      return;
    }
    roamgateLocalStorage.setItem(
      agentOrderStorageKey,
      serializeAgentOrder(agentPaneOrder),
    );
  }, [agentOrderStorageKey, agentPaneOrder]);
  useEffect(() => {
    if (pinsKeyRef.current !== pinsStorageKey) {
      pinsKeyRef.current = pinsStorageKey;
      setPinnedWorkspaceKeys(
        parseWorkspacePins(roamgateLocalStorage.getItem(pinsStorageKey)),
      );
      return;
    }
    roamgateLocalStorage.setItem(
      pinsStorageKey,
      serializeWorkspacePins(pinnedWorkspaceKeys),
    );
  }, [pinnedWorkspaceKeys, pinsStorageKey]);
  useEffect(() => {
    if (collapsedKeyRef.current !== collapsedGroupsStorageKey) {
      collapsedKeyRef.current = collapsedGroupsStorageKey;
      setCollapsedWorktreeGroupKeys(
        parseCollapsedWorktreeGroups(
          roamgateLocalStorage.getItem(collapsedGroupsStorageKey),
        ),
      );
      return;
    }
    roamgateLocalStorage.setItem(
      collapsedGroupsStorageKey,
      serializeCollapsedWorktreeGroups(collapsedWorktreeGroupKeys),
    );
  }, [collapsedGroupsStorageKey, collapsedWorktreeGroupKeys]);
  useEffect(() => {
    if (
      s.status !== "connected" ||
      s.lastRefresh === 0 ||
      s.lastRefresh <= lastPrunedWorkspaceRefresh.current
    ) {
      return;
    }
    lastPrunedWorkspaceRefresh.current = s.lastRefresh;
    setPinnedWorkspaceKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
    setCollapsedWorktreeGroupKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
  }, [s.lastRefresh, s.status, s.workspaces]);
  useEffect(() => {
    return subscribeLocalStorage((key) => {
      if (key === pinsStorageKey || key === null) {
        setPinnedWorkspaceKeys(
          parseWorkspacePins(roamgateLocalStorage.getItem(pinsStorageKey)),
        );
      }
      if (key === collapsedGroupsStorageKey || key === null) {
        setCollapsedWorktreeGroupKeys(
          parseCollapsedWorktreeGroups(
            roamgateLocalStorage.getItem(collapsedGroupsStorageKey),
          ),
        );
      }
      if (key === WORKSPACE_AGENT_LAYOUT_STORAGE_KEY || key === null) {
        setAgentLayout(
          parseWorkspaceAgentLayout(
            roamgateLocalStorage.getItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY),
          ),
        );
      }
      if (key === AGENT_LIST_PREFERENCES_STORAGE_KEY || key === null) {
        setAgentListPreferences(
          parseAgentListPreferences(
            roamgateLocalStorage.getItem(AGENT_LIST_PREFERENCES_STORAGE_KEY),
          ),
        );
      }
      if (key === agentOrderStorageKey || key === null) {
        setAgentPaneOrder(
          parseAgentOrder(roamgateLocalStorage.getItem(agentOrderStorageKey)),
        );
      }
    });
  }, [agentOrderStorageKey, collapsedGroupsStorageKey, pinsStorageKey]);

  const updatePinnedWorkspace = (workspace: Workspace, pinned: boolean) => {
    setPinnedWorkspaceKeys((current) =>
      setWorkspacePinned(current, workspace, pinned),
    );
    if (!pinned && workspace.worktree?.is_linked_worktree) {
      const parent = worktreeCreationSource(s.workspaces, workspace);
      if (parent) {
        setCollapsedWorktreeGroupKeys((current) =>
          setWorktreeGroupCollapsed(current, parent, false),
        );
      }
    }
  };
  const updateCollapsedWorktreeGroup = (
    workspace: Workspace,
    collapsed: boolean,
  ) => {
    setCollapsedWorktreeGroupKeys((current) =>
      setWorktreeGroupCollapsed(current, workspace, collapsed),
    );
  };

  const clearWorkspaceDrag = () => {
    setTreeDragging(null);
    setTreeDropTarget(null);
  };
  const clearAgentDrag = () => {
    setDraggedAgentPaneId(null);
    setAgentDropTarget(null);
  };
  const workspaceDropPosition = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  /** Herdr's own order, for workspaces in their usual place. */
  const reorderWorkspace = (
    draggedId: string,
    targetId: string,
    position: "before" | "after",
  ) => {
    const orderedIds = [...s.workspaces]
      .sort((a, b) => a.number - b.number)
      .map((candidate) => candidate.workspace_id);
    const from = orderedIds.indexOf(draggedId);
    const to = orderedIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    // workspace.move inserts before the entry currently at insert_index, so
    // an insertion point past the dragged row lands one slot earlier.
    const insertIndex = position === "before" ? to : to + 1;
    if (from < insertIndex ? insertIndex - 1 === from : insertIndex === from) {
      return;
    }
    void store.moveWorkspace(draggedId, insertIndex);
  };
  const onAgentDragStart = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    clearWorkspaceDrag();
    setDraggedAgentPaneId(pane.pane_id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pane.pane_id);
  };
  const onAgentDragOver = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedAgentPaneId || draggedAgentPaneId === pane.pane_id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const position = workspaceDropPosition(e);
    setAgentDropTarget((current) =>
      current?.paneId === pane.pane_id && current.position === position
        ? current
        : { paneId: pane.pane_id, position },
    );
  };
  const onAgentDrop = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedAgentPaneId) return;
    e.preventDefault();
    const draggedPaneId = draggedAgentPaneId;
    const position = workspaceDropPosition(e);
    clearAgentDrag();
    if (draggedPaneId === pane.pane_id) return;
    setAgentPaneOrder(
      moveAgentPane(
        agentPanes.map((candidate) => candidate.pane_id),
        draggedPaneId,
        pane.pane_id,
        position,
      ),
    );
  };

  // ----- every connection's workspaces, and the user's arrangement over them
  const otherPreferenceCache = useMemo(() => {
    void preferencesRevision;
    return new Map<
      string,
      {
        pins: ReadonlySet<string>;
        collapsed: ReadonlySet<string>;
        onCollapsedChange: (workspace: Workspace, collapsed: boolean) => void;
      }
    >();
  }, [preferencesRevision]);
  const otherPreferences = (connectionId: string) => {
    const cached = otherPreferenceCache.get(connectionId);
    if (cached) return cached;
    const groupsKey = connectionStorageKey(
      connectionId,
      COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
    );
    const groups = parseCollapsedWorktreeGroups(
      roamgateLocalStorage.getItem(groupsKey),
    );
    const preferences = {
      pins: new Set(
        parseWorkspacePins(
          roamgateLocalStorage.getItem(
            connectionStorageKey(connectionId, WORKSPACE_PINS_STORAGE_KEY),
          ),
        ),
      ),
      collapsed: new Set(groups),
      onCollapsedChange: (workspace: Workspace, collapsed: boolean) => {
        roamgateLocalStorage.setItem(
          groupsKey,
          serializeCollapsedWorktreeGroups(
            setWorktreeGroupCollapsed(
              parseCollapsedWorktreeGroups(
                roamgateLocalStorage.getItem(groupsKey),
              ),
              workspace,
              collapsed,
            ),
          ),
        );
        setPreferencesRevision((revision) => revision + 1);
      },
    };
    otherPreferenceCache.set(connectionId, preferences);
    return preferences;
  };
  const snapshotFor = (connection: ConnectionSummary) =>
    connection.state === "ready"
      ? allServerSessions.snapshots.find(
          (entry) =>
            entry.connection_id === connection.id &&
            entry.connection_generation === connection.generation,
        )
      : undefined;
  const currentLoaded = s.status === "connected" && s.lastRefresh > 0;
  type ConnectionData = {
    connection?: ConnectionSummary;
    workspaces: Workspace[];
    tabs: Tab[];
    panes: Pane[];
    useStore: boolean;
  };
  const connectionData = new Map<string, ConnectionData>();
  const activeConnection = s.connections.find(
    (connection) => connection.id === s.activeConnectionId,
  );
  const storeHasActive =
    currentLoaded &&
    (!activeConnection ||
      s.serverRuntimeGeneration === activeConnection.generation);
  // Just switched, the store has not loaded the new connection yet: its
  // snapshot stands in, so its rows neither vanish nor move meanwhile.
  const activeSnapshot =
    activeConnection && !storeHasActive ? snapshotFor(activeConnection) : null;
  if (
    (!allServers && !(activeSnapshot && !activeSnapshot.error)) ||
    storeHasActive
  ) {
    connectionData.set(s.activeConnectionId, {
      connection: activeConnection,
      workspaces: s.workspaces,
      tabs: s.tabs,
      panes: s.panes,
      useStore: true,
    });
  }
  for (const connection of s.connections) {
    if (connectionData.has(connection.id)) continue;
    const snapshot = snapshotFor(connection);
    // Overlay tabs are left out as the store leaves them out of its own.
    const overlay = overlayMarks[connection.id] ?? {};
    const shown = (tabId: string) => !Object.values(overlay).includes(tabId);
    if (snapshot && !snapshot.error)
      connectionData.set(connection.id, {
        connection,
        workspaces: snapshot.workspaces,
        tabs: snapshot.tabs.filter((tab) => shown(tab.tab_id)),
        panes: withAgentActivity(
          snapshot.panes.filter((pane) => shown(pane.tab_id)),
          snapshot.agents,
        ),
        useStore: false,
      });
  }
  const liveWorkspaces = new Map<string, LiveWorkspaceIdentity[]>();
  for (const [connectionId, data] of connectionData) {
    if (data.useStore && !currentLoaded) continue;
    liveWorkspaces.set(connectionId, data.workspaces.map(workspaceIdentity));
  }
  const resolved = resolveWorkspaceTree(tree, liveWorkspaces);
  const treeNodeById = new Map(tree.nodes.map((node) => [node.id, node]));
  const treeChildren = new Map<string | null, WorkspaceTreeNode[]>();
  for (const node of tree.nodes) {
    const list = treeChildren.get(node.parent) ?? [];
    list.push(node);
    treeChildren.set(node.parent, list);
  }
  const nodeForWorkspace = (connectionId: string, workspaceId: string) => {
    const id = resolved.nodeByWorkspace.get(
      liveWorkspaceKey(connectionId, workspaceId),
    );
    return id ? treeNodeById.get(id) : undefined;
  };
  const placedByUser = (connectionId: string, workspace: Workspace) => {
    const node = nodeForWorkspace(connectionId, workspace.workspace_id);
    return !!node && workspaceTreeNodePlaced(node);
  };
  /** Put at the top level in Herdr's list: shown there, never nested. */
  const inListByUser = (connectionId: string, workspace: Workspace) => {
    const node = nodeForWorkspace(connectionId, workspace.workspace_id);
    return !!node && workspaceTreeRootPlace(node) === "list";
  };
  const views = new Map<string, ConnectionView>();
  for (const [connectionId, data] of connectionData) {
    const current = connectionId === s.activeConnectionId;
    const connection = data.connection;
    const source: WorkspaceTreeSource | undefined =
      current && !allServers
        ? undefined
        : {
            connectionId,
            runtimeGeneration: connection?.generation ?? 0,
            serverLabel: connection?.label ?? connectionId,
            tabs: data.tabs,
          };
    const preferences =
      current &&
      pinsKeyRef.current === pinsStorageKey &&
      collapsedKeyRef.current === collapsedGroupsStorageKey
        ? {
            pins: pinnedWorkspaceSet,
            collapsed: collapsedWorktreeGroupSet,
            onCollapsedChange: updateCollapsedWorktreeGroup,
          }
        : otherPreferences(connectionId);
    const hierarchy = buildWorkspaceHierarchy(
      data.workspaces,
      preferences.pins,
    );
    const childrenByParent = new Map<string, Workspace[]>();
    for (const [parent, list] of hierarchy.childrenByParent)
      childrenByParent.set(
        parent,
        list.filter((child) => !placedByUser(connectionId, child)),
      );
    const allAgents =
      current && data.useStore
        ? agentsByWorkspace
        : groupAgentPanesByWorkspace(data.panes);
    const menuSource = source && !(current && !allServers) ? source : undefined;
    views.set(connectionId, {
      connectionId,
      label: connection?.label ?? connectionId,
      source,
      tabs: data.tabs,
      byId: new Map(
        data.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
      ),
      topLevel: data.workspaces
        .filter(
          (workspace) =>
            inListByUser(connectionId, workspace) ||
            (hierarchy.topLevel.includes(workspace) &&
              !placedByUser(connectionId, workspace)),
        )
        .sort(
          (a, b) =>
            Number(isWorkspacePinned(preferences.pins, b)) -
              Number(isWorkspacePinned(preferences.pins, a)) ||
            a.number - b.number,
        ),
      // A fixed colour per connection, whichever is displayed; none for the
      // default local one.
      showHostDot: !(connection?.is_default && connection.type !== "ssh"),
      childrenByParent,
      agentsByWorkspace:
        agentLayout === "nested" ? allAgents : EMPTY_AGENT_PANES_BY_WORKSPACE,
      allAgentsByWorkspace: allAgents,
      tabChips:
        current && data.useStore
          ? tabChipsByWorkspace
          : workspaceTabChips(data.tabs, data.panes),
      ...preferences,
      reviews: current
        ? reviews
        : (reviewsByConnection.current.get(connectionId) ?? {}),
      onContextMenu: (workspace, x, y) =>
        setMenu({
          workspace,
          x,
          y,
          ...(menuSource ? { source: menuSource } : {}),
        }),
      onAgentContextMenu: (pane, x, y) =>
        setAgentMenu({
          pane,
          x,
          y,
          ...(menuSource ? { source: menuSource } : {}),
        }),
    });
  }

  // Browsers tell the server what they matched: new ids after a Herdr
  // restart, new labels after a rename.
  const refreshSignature = JSON.stringify(resolved.refreshes);
  useEffect(() => {
    const nodes = JSON.parse(refreshSignature) as typeof resolved.refreshes;
    if (!workspaceTreeLoaded() || nodes.length === 0) return;
    const timer = setTimeout(() => {
      void applyWorkspaceTreeOps([{ op: "refresh", nodes }], { quiet: true });
    }, 2000);
    return () => clearTimeout(timer);
  }, [refreshSignature]);

  // ----- subagents, and what parent rows sum up
  const taskAgents: { connectionId: string; pane: Pane }[] = [];
  for (const view of views.values())
    for (const panes of view.allAgentsByWorkspace.values())
      for (const pane of panes)
        taskAgents.push({ connectionId: view.connectionId, pane });
  const agentTasks = useTreeAgentTasks(taskAgents);
  type SummaryItem =
    | { kind: "workspace"; view: ConnectionView; workspace: Workspace }
    | { kind: "node"; node: WorkspaceTreeNode };
  const userChildItems = (nodeId: string): SummaryItem[] =>
    (treeChildren.get(nodeId) ?? []).map((child) => {
      const state = resolved.nodes.get(child.id);
      if (child.kind === "workspace" && state?.state === "live") {
        const view = views.get(state.connectionId);
        const workspace = view?.byId.get(state.workspaceId);
        if (view && workspace) return { kind: "workspace", view, workspace };
      }
      return { kind: "node", node: child };
    });
  const summaryOptions = {
    key: (item: SummaryItem) =>
      item.kind === "node"
        ? `n:${item.node.id}`
        : `w:${item.view.connectionId}:${item.workspace.workspace_id}`,
    children: (item: SummaryItem): SummaryItem[] => {
      if (item.kind === "node") return userChildItems(item.node.id);
      const node = nodeForWorkspace(
        item.view.connectionId,
        item.workspace.workspace_id,
      );
      return [
        ...(node ? userChildItems(node.id) : []),
        ...(
          item.view.childrenByParent.get(item.workspace.workspace_id) ?? []
        ).map(
          (workspace): SummaryItem => ({
            kind: "workspace",
            view: item.view,
            workspace,
          }),
        ),
      ];
    },
    agents: (item: SummaryItem) =>
      item.kind === "node"
        ? []
        : (
            item.view.allAgentsByWorkspace.get(item.workspace.workspace_id) ??
            []
          ).map((pane) => ({ ...pane, connectionId: item.view.connectionId })),
    runningSubagents: (agent: Pane & { connectionId: string }) =>
      treeTaskRows(agentTasks(agent.connectionId, agent.pane_id), () => true)
        .running,
    backgroundRunning: (agent: Pane & { connectionId: string }) =>
      backgroundWork(agentTasks(agent.connectionId, agent.pane_id)).running,
  };

  // ----- dragging to nest, and into the gaps between rows
  const intoPlan = (subject: RowSlot, target: RowSlot): DropPlan | null => {
    const item = target.item;
    if (subject.item.key === item.key) return null;
    // A gone or offline workspace holds nothing new.
    if (item.kind === "node" && treeNodeById.get(item.nodeId)?.kind !== "group")
      return null;
    const subjectNode = subject.item.nodeId;
    const parentNode = item.nodeId;
    if (
      subjectNode &&
      parentNode &&
      workspaceTreeContains(tree, subjectNode, parentNode)
    )
      return null;
    if (target.ancestors.some((each) => each.item.key === subject.item.key))
      return null;
    return {
      ops: [
        {
          op: "move",
          subject: dragTarget(subject.item),
          parent: dragTarget(item),
        },
      ],
    };
  };
  const gapContext = {
    tree,
    canReorder: (connectionId: string) =>
      connectionId === s.activeConnectionId && currentLoaded,
  };
  const dropPlan = (
    subject: RowSlot,
    target: RowSlot,
    zone: DropTarget["zone"],
    level: number,
  ): DropPlan | null =>
    zone === "into"
      ? intoPlan(subject, target)
      : gapDropPlan(
          subject,
          zone === "before" ? target : slotAtLevel(target, level),
          zone,
          gapContext,
        );
  const applyDropPlan = (plan: DropPlan) => {
    const { ops, reorder } = plan;
    void (async () => {
      if (ops.length) await applyWorkspaceTreeOps(ops);
      if (reorder)
        reorderWorkspace(reorder.draggedId, reorder.targetId, reorder.position);
    })();
  };
  /** The depth of the next row that takes drops, 0 past the last. */
  const nextRowDepth = (row: Element) => {
    for (
      let next = row.nextElementSibling;
      next;
      next = next.nextElementSibling
    ) {
      const depth = (next as HTMLElement).dataset?.treeDepth;
      if (depth !== undefined) return Number(depth);
    }
    return 0;
  };
  const dropAt = (
    event: React.DragEvent<HTMLElement>,
    slot: RowSlot,
    expanded: boolean,
  ): { target: DropTarget; plan: DropPlan } | null => {
    const subject = treeDragging;
    if (!subject || subject.item.key === slot.item.key) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const tryZone = (zone: DropTarget["zone"]) => {
      const level =
        zone === "after"
          ? gapLevel(
              slot.depth,
              nextRowDepth(event.currentTarget),
              event.clientX - rect.left,
              TREE_DEPTH_INDENT,
            )
          : slot.depth;
      const plan = dropPlan(subject, slot, zone, level);
      return plan
        ? { target: { key: slot.item.key, zone, level }, plan }
        : null;
    };
    let zone = dropZone(offsetY, rect.height);
    // Right below an open row are its children: that gap is theirs.
    if (zone === "after" && expanded) zone = "into";
    const found = tryZone(zone);
    if (found || zone !== "into") return found;
    // It cannot nest here: the nearer gap.
    const half = offsetY < rect.height / 2 ? "before" : "after";
    return half === "after" && expanded ? null : tryZone(half);
  };
  const dragHandlers = (slot: RowSlot, expanded: boolean): DragHandlers => ({
    draggable: true,
    onDragStart: (event) => {
      if (event.target !== event.currentTarget) return;
      event.stopPropagation();
      clearAgentDrag();
      setTreeDragging(slot);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", slot.item.key);
    },
    onDragOver: (event) => {
      if (!treeDragging || treeDragging.item.key === slot.item.key) return;
      const found = dropAt(event, slot, expanded);
      if (!found) {
        setTreeDropTarget((current) =>
          current?.key === slot.item.key ? null : current,
        );
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const { target } = found;
      setTreeDropTarget((current) =>
        current?.key === target.key &&
        current.zone === target.zone &&
        current.level === target.level
          ? current
          : target,
      );
    },
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null))
        return;
      setTreeDropTarget((current) =>
        current?.key === slot.item.key ? null : current,
      );
    },
    onDrop: (event) => {
      const subject = treeDragging;
      const target =
        treeDropTarget?.key === slot.item.key ? treeDropTarget : null;
      clearWorkspaceDrag();
      if (!subject || !target) return;
      event.preventDefault();
      event.stopPropagation();
      const plan = dropPlan(subject, slot, target.zone, target.level);
      if (plan) applyDropPlan(plan);
    },
    onDragEnd: clearWorkspaceDrag,
  });

  const rowCommon: RowCommon = {
    activePaneId,
    views,
    onSelect,
    onSelectAgent,
  };
  // Plain functions, not components: rows keep their state across renders.
  const renderTreeNode = (
    node: WorkspaceTreeNode,
    depth: number,
    parent: RowParent,
    ancestors: readonly RowSlot[],
    parentName?: string,
  ) => {
    if (node.kind === "group")
      return (
        <GroupRow
          key={node.id}
          node={node}
          depth={depth}
          parent={parent}
          ancestors={ancestors}
        />
      );
    const state = resolved.nodes.get(node.id);
    if (state?.state === "live") {
      const view = views.get(state.connectionId);
      const workspace = view?.byId.get(state.workspaceId);
      if (view && workspace)
        return (
          <WorkspaceRow
            key={node.id}
            w={workspace}
            view={view}
            depth={depth}
            parent={parent}
            ancestors={ancestors}
            parentName={parentName}
          />
        );
    }
    return (
      <UnavailableWorkspaceRow
        key={node.id}
        node={node}
        state={state?.state === "gone" ? "gone" : "offline"}
        depth={depth}
        parent={parent}
        ancestors={ancestors}
      />
    );
  };
  const renderNodeChildren = (
    parentId: string,
    depth: number,
    ancestors: readonly RowSlot[],
    parentName?: string,
  ): ReactNode =>
    (treeChildren.get(parentId) ?? []).map((child) =>
      renderTreeNode(
        child,
        depth,
        { kind: "node", nodeId: parentId },
        ancestors,
        parentName,
      ),
    );
  const arrange: ArrangeContextValue = {
    tree,
    resolved,
    dragging: treeDragging,
    dropTarget: treeDropTarget,
    dragHandlers,
    renderNodeChildren,
    nodeSummary: (nodeId) => {
      const node = treeNodeById.get(nodeId);
      return node
        ? subtreeSummary<SummaryItem, Pane & { connectionId: string }>(
            { kind: "node", node },
            summaryOptions,
          )
        : EMPTY_TREE_SUMMARY;
    },
    workspaceSummary: (connectionId, workspaceId) => {
      const view = views.get(connectionId);
      const workspace = view?.byId.get(workspaceId);
      return view && workspace
        ? subtreeSummary<SummaryItem, Pane & { connectionId: string }>(
            { kind: "workspace", view, workspace },
            summaryOptions,
          )
        : EMPTY_TREE_SUMMARY;
    },
    nodeForWorkspace,
    openNodeMenu: (nodeId, x, y) => setNodeMenu({ nodeId, x, y }),
    tasks: agentTasks,
    taskLineExpanded: (key) => expandedTaskLines.includes(key),
    setTaskLineExpanded: (key, expanded) =>
      setExpandedTaskLines((current) => {
        const next = current.filter((each) => each !== key);
        if (expanded) next.push(key);
        writeExpandedTaskLines(next);
        return next;
      }),
    connectionLabel: (connectionId) =>
      s.connections.find((connection) => connection.id === connectionId)
        ?.label ?? connectionId,
    showsHostDot: (connectionId) => {
      const connection = s.connections.find((each) => each.id === connectionId);
      return !(connection?.is_default && connection.type !== "ssh");
    },
  };
  // Roots shown above the list: groups and workspaces put there, and those
  // whose place in the list is not shown here (another connection while only
  // one is listed, or one that is down). Below it: those put there.
  const listedConnections = new Set(
    allServers ? [...views.keys()] : [s.activeConnectionId],
  );
  const rootPlaceShown = (node: WorkspaceTreeNode): WorkspaceTreeRootPlace => {
    const place = workspaceTreeRootPlace(node);
    if (place === "top" || place === "bottom") return place;
    const state = resolved.nodes.get(node.id);
    return state?.state === "live" && listedConnections.has(state.connectionId)
      ? "list"
      : "top";
  };
  const rootNodes = treeChildren.get(null) ?? [];
  const topNodes = rootNodes.filter((node) => rootPlaceShown(node) === "top");
  const bottomNodes = rootNodes.filter(
    (node) => rootPlaceShown(node) === "bottom",
  );
  const renderRootNodes = (
    nodes: WorkspaceTreeNode[],
    place: WorkspaceTreeRootPlace,
  ) =>
    nodes.map((node) => renderTreeNode(node, 0, { kind: "root", place }, []));
  const LIST_ROOT: RowParent = { kind: "root", place: "list" };
  const edgeHandlers = (edge: "top" | "bottom") => {
    const key = `edge:${edge}`;
    return {
      className: `workspace-tree-drop-edge is-${edge} ${
        treeDropTarget?.key === key ? "is-target" : ""
      }`,
      "aria-hidden": true,
      onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
        if (!treeDragging) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setTreeDropTarget((current) =>
          current?.key === key ? current : { key, zone: "before", level: 0 },
        );
      },
      onDragLeave: () =>
        setTreeDropTarget((current) => (current?.key === key ? null : current)),
      onDrop: (event: React.DragEvent<HTMLDivElement>) => {
        const subject = treeDragging;
        clearWorkspaceDrag();
        if (!subject) return;
        event.preventDefault();
        applyDropPlan(edgeDropPlan(subject, edge, topNodes[0]?.id));
      },
    };
  };
  const moveTargets: MoveTarget[] = [
    {
      key: "root",
      label: "Top level",
      detail: "Not nested under anything",
      target: { root: "list" },
    },
    ...tree.nodes.flatMap((node): MoveTarget[] => {
      if (node.kind !== "group") return [];
      const path: string[] = [];
      let cursor = node.parent ? treeNodeById.get(node.parent) : undefined;
      while (cursor && path.length < 8) {
        path.unshift(workspaceTreeNodeLabel(cursor));
        cursor = cursor.parent ? treeNodeById.get(cursor.parent) : undefined;
      }
      return [
        {
          key: `n:${node.id}`,
          label: node.label,
          detail: path.length ? path.join(" / ") : "Group",
          target: { node: node.id },
          nodeId: node.id,
        },
      ];
    }),
    ...[...views.values()].flatMap((view) =>
      [...view.byId.values()].map(
        (workspace): MoveTarget => ({
          key: `w:${view.connectionId}:${workspace.workspace_id}`,
          label: workspaceDisplayName(workspace),
          detail: view.label,
          target: { workspace: workspaceRefFor(view.connectionId, workspace) },
          nodeId: nodeForWorkspace(view.connectionId, workspace.workspace_id)
            ?.id,
        }),
      ),
    ),
  ];
  const menuConnectionId = menu?.source?.connectionId ?? s.activeConnectionId;
  const menuNode = menu
    ? nodeForWorkspace(menuConnectionId, menu.workspace.workspace_id)
    : undefined;
  const arrangeItems = menu
    ? [
        {
          label: "Move into…",
          action: () =>
            setMoveInto({
              target: menuNode
                ? { node: menuNode.id }
                : {
                    workspace: workspaceRefFor(
                      menuConnectionId,
                      menu.workspace,
                    ),
                  },
              label: workspaceDisplayName(menu.workspace),
              nodeId: menuNode?.id,
              key: `w:${menuConnectionId}:${menu.workspace.workspace_id}`,
            }),
        },
        ...(() => {
          const subject: WorkspaceTreeTarget = menuNode
            ? { node: menuNode.id }
            : {
                workspace: workspaceRefFor(menuConnectionId, menu.workspace),
              };
          const move = (parent: WorkspaceTreeParent) =>
            void applyWorkspaceTreeOps([{ op: "move", subject, parent }]);
          const place = menuNode ? workspaceTreeRootPlace(menuNode) : null;
          // Already a top-level row of the list, placed there or not.
          const atTopLevel =
            place === "list" ||
            place === "top" ||
            !!views
              .get(menuConnectionId)
              ?.topLevel.some(
                (each) => each.workspace_id === menu.workspace.workspace_id,
              );
          return [
            ...(!atTopLevel
              ? [
                  {
                    label: "Move to top level",
                    action: () => move({ root: "list" }),
                  },
                ]
              : []),
            ...(menuNode && workspaceTreeNodePlaced(menuNode)
              ? [{ label: "Back to its usual place", action: () => move(null) }]
              : []),
          ];
        })(),
        {
          label: "New group inside…",
          action: () =>
            setNewGroupParent({
              parent: {
                workspace: workspaceRefFor(menuConnectionId, menu.workspace),
              },
            }),
        },
        // In a group headed upstream: this one may not be.
        ...(menuNode &&
        menuNode.kind === "workspace" &&
        headedGroupOf(tree, upstreamMarks, menuNode.parent)
          ? [
              {
                label: isSkipped(upstreamMarks, menuNode.ref)
                  ? "Headed upstream again"
                  : "Not headed upstream",
                action: () =>
                  void setWorkspaceHeaded(
                    menuNode.ref,
                    isSkipped(upstreamMarks, menuNode.ref),
                  ).catch(() => {}),
              },
            ]
          : []),
      ]
    : [];
  useEffect(
    () =>
      onWorkspaceArrangeRequest((request) => {
        if (request.type === "new-group") {
          setNewGroupParent({ parent: null });
          return;
        }
        const target: WorkspaceTreeTarget = {
          workspace: workspaceRefFor(request.connectionId, request.workspace),
        };
        setMoveInto({
          target,
          label: workspaceDisplayName(request.workspace),
          key: `w:${request.connectionId}:${request.workspace.workspace_id}`,
          nodeId: findWorkspaceNode(getWorkspaceTree(), target.workspace)?.id,
        });
      }),
    [],
  );
  const currentView = views.get(s.activeConnectionId);
  const focusedRepoWorkspace = s.workspaces.find(
    (workspace) => workspace.focused && workspace.worktree,
  );

  const workspacePanel = (
    <ArrangeContext.Provider value={arrange}>
      <RowCommonContext.Provider value={rowCommon}>
        <div
          key="workspaces"
          className="panel tree workspace-tree-panel"
          tabIndex={-1}
        >
          <div className="panel-head">
            <h2>Workspaces</h2>
            <div className="panel-actions">
              {connectedServerCount > 1 ? (
                <ThemedSelect
                  className="workspace-scope-control"
                  aria-label="Workspace server scope"
                  value={allServers ? "all" : "current"}
                  options={[
                    { value: "current", label: "Current" },
                    { value: "all", label: "All servers" },
                  ]}
                  onChange={(scope) => {
                    clearWorkspaceDrag();
                    clearAgentDrag();
                    setMenu(null);
                    setAgentMenu(null);
                    setAllServers(scope === "all");
                  }}
                />
              ) : null}
              {focusedRepoWorkspace ? (
                <button
                  type="button"
                  className="panel-add panel-action-icon"
                  title="Worktree lifecycle"
                  aria-label="Open worktree lifecycle"
                  onClick={() =>
                    setLifecycleWorkspaceId(focusedRepoWorkspace.workspace_id)
                  }
                >
                  <GitBranch size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="panel-add panel-action-icon"
                title="New group"
                aria-label="New workspace group"
                onClick={() => setNewGroupParent({ parent: null })}
              >
                <FolderPlus size={14} />
              </button>
              <button
                className="panel-add panel-action-icon"
                title="New workspace"
                onClick={() => onCreateWorkspace(allServers)}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
          <div
            className="workspace-tree-content"
            role="tree"
            aria-label="Workspaces and agents"
          >
            {treeDragging ? <div {...edgeHandlers("top")} /> : null}
            {renderRootNodes(topNodes, "top")}
            {allServers ? (
              <>
                {allServerSessions.messages.map((message) => (
                  <p key={message} className="muted" role="status">
                    {message}
                  </p>
                ))}
                {s.connections.map((connection) => {
                  const view = views.get(connection.id);
                  const snapshot = snapshotFor(connection);
                  const message =
                    connection.state !== "ready"
                      ? connectionLifecycleLabel(connection.state)
                      : snapshot?.error
                        ? snapshot.error
                        : !view
                          ? "Loading..."
                          : view.topLevel.length === 0 && view.byId.size === 0
                            ? "No workspaces."
                            : null;
                  return (
                    <ServerWorkspaceRows
                      key={JSON.stringify([
                        connection.id,
                        connection.generation,
                      ])}
                      connection={connection}
                      view={view}
                      message={message}
                    />
                  );
                })}
              </>
            ) : s.workspaces.length === 0 ? (
              <p className="muted">
                {s.status === "connected"
                  ? "No workspaces."
                  : "Connect to the bridge to load workspaces."}
              </p>
            ) : null}
            {!allServers && currentView
              ? currentView.topLevel.map((w) => (
                  <WorkspaceRow
                    key={w.workspace_id}
                    w={w}
                    view={currentView}
                    depth={0}
                    parent={LIST_ROOT}
                    ancestors={[]}
                  />
                ))
              : null}
            {renderRootNodes(bottomNodes, "bottom")}
            {treeDragging ? <div {...edgeHandlers("bottom")} /> : null}
          </div>
          <AgentLayoutControl value={agentLayout} onChange={setAgentLayout} />
        </div>
        <ArrangeNodeMenu
          state={nodeMenu}
          onClose={() => setNodeMenu(null)}
          onMoveInto={(target, label) =>
            setMoveInto({
              target,
              label,
              nodeId: "node" in target ? target.node : undefined,
              key: "node" in target ? `n:${target.node}` : undefined,
            })
          }
          onNewGroup={(parent) => setNewGroupParent({ parent })}
        />
        <MoveIntoDialog
          subject={moveInto}
          targets={
            moveInto
              ? moveTargetsFor(tree, moveInto.nodeId, moveInto.key, moveTargets)
              : []
          }
          onClose={() => setMoveInto(null)}
        />
        <TextInputDialog
          open={!!newGroupParent}
          title="New Group"
          label="Name"
          placeholder="upstreaming"
          submitLabel="Create"
          onClose={() => setNewGroupParent(null)}
          onSubmit={(label) => {
            const parent = newGroupParent?.parent ?? null;
            setNewGroupParent(null);
            if (!label.trim()) return;
            void applyWorkspaceTreeOps([
              {
                op: "create_group",
                id: newWorkspaceTreeGroupId(),
                label,
                parent,
              },
            ]);
          }}
        />
      </RowCommonContext.Provider>
    </ArrangeContext.Provider>
  );
  const agentsPanel =
    agentLayout === "separate" ? (
      <div key="agents" className="panel agents-panel">
        <div className="panel-head">
          <h2>Agents</h2>
          <div className="panel-actions agent-list-controls">
            <ThemedSelect
              className="agent-list-control"
              icon={<ArrowDownWideNarrow size={15} aria-hidden="true" />}
              align="end"
              aria-label="Agent sort order"
              title={`Sort agents: ${AGENT_SORT_LABELS[agentSort]}`}
              value={agentSort}
              options={Object.entries(AGENT_SORT_LABELS)
                .filter(([value]) => !allServers || value !== "manual")
                .map(([value, label]) => ({ value, label }))}
              onChange={(sort) => {
                clearAgentDrag();
                setAgentListPreferences((current) => ({
                  ...current,
                  sort: sort as AgentSort,
                }));
              }}
            />
            <ThemedSelect
              className={`agent-list-control ${agentListPreferences.grouping !== "none" ? "is-active" : ""}`}
              icon={<Layers size={15} aria-hidden="true" />}
              align="end"
              aria-label="Agent grouping"
              title={`Group agents: ${{ none: "No grouping", status: "Status", workspace: "Workspace", agent: "Agent type" }[agentListPreferences.grouping]}`}
              value={agentListPreferences.grouping}
              options={[
                { value: "none", label: "No grouping" },
                { value: "status", label: "Status" },
                { value: "workspace", label: "Workspace" },
                { value: "agent", label: "Agent type" },
              ]}
              onChange={(grouping) => {
                clearAgentDrag();
                setAgentListPreferences((current) => ({
                  ...current,
                  grouping: grouping as AgentGrouping,
                }));
              }}
            />
          </div>
        </div>
        <div className="agents-list">
          {listedAgentPanes.length > 0 ? (
            agentGroups.map((group) => {
              const groupKey = `${agentListPreferences.grouping}:${group.key}`;
              const collapsed = collapsedAgentGroups.has(groupKey);
              return (
                <div key={groupKey} className="agent-list-group">
                  {agentListPreferences.grouping !== "none" ? (
                    <button
                      type="button"
                      className="agent-group-toggle"
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setCollapsedAgentGroups((current) => {
                          const next = new Set(current);
                          if (next.has(groupKey)) next.delete(groupKey);
                          else next.add(groupKey);
                          return next;
                        })
                      }
                    >
                      {collapsed ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                      <span>{group.label}</span>
                      <span className="muted">{group.panes.length}</span>
                    </button>
                  ) : null}
                  {(!collapsed || agentListPreferences.grouping === "none") &&
                    group.panes.map((pane) => {
                      const source = "connectionId" in pane ? pane : null;
                      const current =
                        !source || source.connectionId === s.activeConnectionId;
                      const workspace = s.workspaces.find(
                        (candidate) =>
                          candidate.workspace_id === pane.workspace_id,
                      );
                      return (
                        <AgentRow
                          key={
                            source
                              ? JSON.stringify([
                                  source.workspaceKey,
                                  pane.pane_id,
                                ])
                              : pane.pane_id
                          }
                          pane={pane}
                          selected={
                            current &&
                            (pane.pane_id === activePaneId ||
                              (!activePaneId && pane.focused))
                          }
                          showPaneId
                          variant="standalone"
                          background={backgroundWork(
                            agentTasks(
                              source?.connectionId ?? s.activeConnectionId,
                              pane.pane_id,
                            ),
                          )}
                          workspaceLabel={
                            source?.workspaceLabel ??
                            (workspace
                              ? workspaceDisplayName(workspace)
                              : pane.workspace_id)
                          }
                          serverLabel={source?.serverLabel}
                          tabLabel={source?.tabLabel}
                          onActivate={
                            source
                              ? () => {
                                  void openServerSession(
                                    source,
                                    source.workspace_id,
                                    source.pane_id,
                                  ).then((opened) => {
                                    if (opened && current)
                                      onSelectAgent?.(pane);
                                  });
                                }
                              : undefined
                          }
                          onSelect={onSelectAgent}
                          onOpenMenu={(x, y) =>
                            setAgentMenu({
                              pane,
                              x,
                              y,
                              source: source ?? undefined,
                            })
                          }
                          drag={
                            !allServers && manualAgentOrder
                              ? {
                                  isDragging:
                                    draggedAgentPaneId === pane.pane_id,
                                  dropPosition:
                                    agentDropTarget?.paneId === pane.pane_id
                                      ? agentDropTarget.position
                                      : null,
                                  onDragStart: (event) =>
                                    onAgentDragStart(pane, event),
                                  onDragOver: (event) =>
                                    onAgentDragOver(pane, event),
                                  onDrop: (event) => onAgentDrop(pane, event),
                                  onDragEnd: clearAgentDrag,
                                }
                              : undefined
                          }
                        />
                      );
                    })}
                </div>
              );
            })
          ) : (
            <p className="muted">
              {allServers && allServerSessions.loading
                ? "Loading..."
                : "No agent sessions."}
            </p>
          )}
        </div>
      </div>
    ) : null;

  return (
    <>
      {agentsFirst ? agentsPanel : workspacePanel}
      {agentsFirst ? workspacePanel : agentsPanel}
      <Suspense fallback={null}>
        {(menu || menuMounted) && (
          <ContextMenu
            state={menu}
            reviewStatus={
              menu ? reviews[menu.workspace.workspace_id] : undefined
            }
            pinnedWorkspaceKeys={pinnedWorkspaceSet}
            onPinnedChange={updatePinnedWorkspace}
            onBrowseFiles={onBrowseFiles}
            onReviewChanges={onReviewChanges}
            arrangeItems={arrangeItems}
            onClose={() => setMenu(null)}
          />
        )}
      </Suspense>
      <AgentContextMenu
        state={agentMenu}
        onClose={() => setAgentMenu(null)}
        onFocus={(pane) => {
          if (agentMenu?.source) {
            const current =
              agentMenu.source.connectionId === s.activeConnectionId;
            void openServerSession(
              agentMenu.source,
              pane.workspace_id,
              pane.pane_id,
            ).then((opened) => {
              if (opened && current) onSelectAgent?.(pane);
            });
          } else {
            void store.focusPane(pane.pane_id);
            onSelectAgent?.(pane);
          }
        }}
        onBrowseFiles={onBrowseFilesForAgent}
        onReviewChanges={onReviewChangesForAgent}
        onViewHistory={onViewAgentHistory}
        onExportSession={(pane) =>
          exportSessionForConnection(pane, connectionClient)
        }
        onClosePane={(pane) => {
          if (store.guardPaneClose(pane.pane_id)) setPendingClosePane(pane);
        }}
      />
      <ConfirmDialog
        open={!!pendingClosePane}
        title="Close Agent Pane"
        message={
          pendingClosePane
            ? `Close pane "${shortId(pendingClosePane.pane_id)}"?${terminalComposerCloseWarning(
                terminalComposerDraftPaneIds(
                  s.activeConnectionId,
                  s.connectionGeneration,
                  [pendingClosePane.pane_id],
                ).length,
              )}`
            : "Close this pane?"
        }
        confirmLabel="Close"
        danger
        onClose={() => setPendingClosePane(null)}
        onConfirm={() => {
          if (pendingClosePane) {
            store.closePane(pendingClosePane.pane_id);
          }
        }}
      />
      <WorktreeLifecycleDialog
        open={!!lifecycleWorkspaceId}
        workspaceId={lifecycleWorkspaceId}
        onClose={() => setLifecycleWorkspaceId(null)}
      />
    </>
  );
}

type WorkspaceTreeSource = ServerSessionSource & { tabs: Tab[] };

/** One connection's workspaces as the list shows them. */
type ConnectionView = {
  connectionId: string;
  label: string;
  /** Absent for the active connection when only it is listed. */
  source?: WorkspaceTreeSource;
  tabs: Tab[];
  byId: ReadonlyMap<string, Workspace>;
  /** At the top of Herdr's list: in their usual place, or put there. */
  topLevel: Workspace[];
  /** Its rows carry a coloured dot: any but the default local one. */
  showHostDot: boolean;
  childrenByParent: Map<string, Workspace[]>;
  /** Agents nested under workspaces (the nested layout), else none. */
  agentsByWorkspace: ReadonlyMap<string, Pane[]>;
  /** Every agent, for the summaries. */
  allAgentsByWorkspace: ReadonlyMap<string, Pane[]>;
  tabChips: ReadonlyMap<string, WorkspaceTabChip[]>;
  pins: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onCollapsedChange: (workspace: Workspace, collapsed: boolean) => void;
  reviews: Record<string, PullRequestSummary>;
  onContextMenu: (workspace: Workspace, x: number, y: number) => void;
  onAgentContextMenu: (pane: Pane, x: number, y: number) => void;
};

/** What every row needs and no row owns. */
type RowCommon = {
  activePaneId: string | null;
  views: ReadonlyMap<string, ConnectionView>;
  onSelect?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
};

const RowCommonContext = createContext<RowCommon>({
  activePaneId: null,
  views: new Map(),
});

function ServerWorkspaceRows({
  connection,
  view,
  message,
}: {
  connection: ConnectionSummary;
  view?: ConnectionView;
  message: string | null;
}) {
  if (message || !view) {
    return (
      <p
        className="muted workspace-server-message"
        data-connection-id={connection.id}
        role="status"
      >
        {connection.label}: {message ?? "Loading..."}
      </p>
    );
  }
  return (
    <>
      {view.topLevel.map((workspace) => (
        <WorkspaceRow
          key={workspace.workspace_id}
          w={workspace}
          view={view}
          depth={0}
          parent={{ kind: "root", place: "list" }}
          ancestors={[]}
        />
      ))}
    </>
  );
}

function workspaceSubtreeContainsActiveItem(
  workspace: Workspace,
  childrenByParent: ReadonlyMap<string, Workspace[]>,
  agentsByWorkspace: ReadonlyMap<string, Pane[]>,
  activePaneId: string | null,
): boolean {
  if (workspace.focused) return true;
  const agents = agentsByWorkspace.get(workspace.workspace_id) ?? [];
  if (
    agents.some(
      (pane) =>
        pane.pane_id === activePaneId || (!activePaneId && pane.focused),
    )
  ) {
    return true;
  }
  return (childrenByParent.get(workspace.workspace_id) ?? []).some((child) =>
    workspaceSubtreeContainsActiveItem(
      child,
      childrenByParent,
      agentsByWorkspace,
      activePaneId,
    ),
  );
}

const TAB_CHIP_STATUS_LABELS: Record<AgentStateKind, string> = {
  blocked: "Blocked",
  done: "Done",
  working: "Working",
  idle: "Idle",
  unknown: "No agent",
};

function WorkspaceTabChips({
  chips,
  workspaceFocused,
  onOpen,
}: {
  chips: readonly WorkspaceTabChip[];
  workspaceFocused: boolean;
  onOpen: (chip: WorkspaceTabChip) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { visible, hidden } = visibleWorkspaceTabChips(chips, availableWidth);
  const stop = (event: { stopPropagation: () => void }) =>
    event.stopPropagation();
  return (
    <span
      ref={ref}
      className="workspace-tab-chips"
      role="group"
      aria-label="Tabs"
    >
      {visible.map((chip) => {
        const status = TAB_CHIP_STATUS_LABELS[chip.status];
        const name = chip.label.trim() || `Tab ${chip.number}`;
        return (
          <button
            key={chip.tabId}
            type="button"
            className={`workspace-tab-chip is-${chip.status} ${
              workspaceFocused && chip.focused ? "is-active" : ""
            }`}
            title={`${chip.number}: ${name} · ${status}`}
            aria-label={`Tab ${chip.number}, ${name}, ${status}`}
            onPointerDown={stop}
            onPointerMove={stop}
            onPointerUp={stop}
            onPointerCancel={stop}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpen(chip);
            }}
          >
            {chip.number}
          </button>
        );
      })}
      {hidden > 0 ? (
        <span
          className="workspace-tab-chip-more"
          title={`${hidden} more tabs`}
          aria-label={`${hidden} more tabs`}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

function WorkspaceRow({
  w,
  view,
  depth,
  parent,
  ancestors,
  parentName,
}: {
  w: Workspace;
  view: ConnectionView;
  depth: number;
  parent: RowParent;
  ancestors: readonly RowSlot[];
  /** The name of the row it sits under, which its own may repeat. */
  parentName?: string;
}) {
  const common = useContext(RowCommonContext);
  const arrange = useArrange();
  const { source, childrenByParent, agentsByWorkspace } = view;
  const { activePaneId, onSelect, onSelectAgent } = common;
  const children = childrenByParent.get(w.workspace_id) ?? [];
  const review = workspacePullRequest(view.reviews[w.workspace_id]);
  const agents = agentsByWorkspace.get(w.workspace_id) ?? [];
  const tabChips = view.tabChips.get(w.workspace_id) ?? [];
  const tabCount = tabChips.length;
  const tabChipsVisible = tabCount > 1;
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      pendingFocusWorkspaceId: state.pendingFocusWorkspaceId,
      tabs: state.tabs,
    }),
    shallowEqual,
  );
  const current = !source || source.connectionId === s.activeConnectionId;
  const workspaceFocused = current && w.focused;
  const tabs = source?.tabs ?? s.tabs;
  const paneIdsToShow = nestedAgentPaneIds(agents, tabs);
  const isChild = depth > 0;
  const node = arrange?.nodeForWorkspace(view.connectionId, w.workspace_id);
  const hasUserChildren =
    !!node && !!arrange?.tree.nodes.some((each) => each.parent === node.id);
  const hasChildren = children.length > 0 || hasUserChildren;
  const hasNestedItems = hasChildren || agents.length > 0;
  const hasActiveAgent =
    current &&
    agents.some(
      (pane) =>
        pane.pane_id === activePaneId || (!activePaneId && pane.focused),
    );
  const hiddenDescendantActive =
    current &&
    children.some((child) =>
      workspaceSubtreeContainsActiveItem(
        child,
        childrenByParent,
        agentsByWorkspace,
        activePaneId,
      ),
    );
  const collapsed =
    hasNestedItems && isWorktreeGroupCollapsed(view.collapsed, w);
  const pinned = isWorkspacePinned(view.pins, w);
  const isPendingFocus =
    current && s.pendingFocusWorkspaceId === w.workspace_id && !w.focused;
  const openMenu = (x: number, y: number) => {
    view.onContextMenu(w, x, y);
  };
  const { triggered: longPressTriggered, handlers: longPress } =
    useLongPressMenu(openMenu);
  const selectWorkspace = () => {
    if (source) {
      void openServerSession(source, w.workspace_id).then((opened) => {
        if (opened && current) onSelect?.(w);
      });
    } else {
      store.focusWorkspace(w.workspace_id);
      onSelect?.(w);
    }
  };
  const activateAgent = (pane: Pane) => {
    if (source) {
      return openServerSession(source, pane.workspace_id, pane.pane_id).then(
        (opened) => {
          if (opened && current) onSelectAgent?.(pane);
          return opened;
        },
      );
    }
    void store.focusPane(pane.pane_id);
    onSelectAgent?.(pane);
    return Promise.resolve(true);
  };
  const dragKey = `w:${view.connectionId}:${w.workspace_id}`;
  const slot: RowSlot = {
    item: {
      kind: "workspace",
      key: dragKey,
      connectionId: view.connectionId,
      ref: workspaceRefFor(view.connectionId, w),
      workspaceId: w.workspace_id,
      nodeId: node?.id,
      placed: !!node && workspaceTreeNodePlaced(node),
    },
    depth,
    parent,
    ancestors,
  };
  const childAncestors = [...ancestors, slot];
  const drag = arrange?.dragHandlers(slot, hasNestedItems && !collapsed);
  const summary =
    arrange && (hasUserChildren || (collapsed && hasNestedItems))
      ? arrange.workspaceSummary(view.connectionId, w.workspace_id)
      : null;
  const fullName = workspaceDisplayName(w);
  const name = shortWorkspaceName(fullName, parentName);
  // A project's review workspace (Reviews): reused for each request, it
  // shows the request checked out instead of a detached commit.
  const reviewWorkspace = mrReviewWorkspaceOf(
    useMrReviewWorkspaces(),
    view.connectionId,
    w.workspace_id,
  );
  const branch = reviewWorkspace
    ? (reviewWorkspace.current?.label ?? "no request checked out")
    : workspaceBranchLine(w, name);
  const gitStatus = w.worktree?.git_status;
  const change = workspaceChangeIndicator(gitStatus);
  // What its agents idle at Herdr's still run: subagents, workflows,
  // background commands, from the list's own task reads.
  const backgroundWorks = (view.allAgentsByWorkspace.get(w.workspace_id) ?? [])
    .map((pane) => ({
      pane,
      work: backgroundWork(
        arrange?.tasks(view.connectionId, pane.pane_id) ?? [],
      ),
    }))
    .filter(
      ({ pane, work }) =>
        agentPresence(pane.agent_status, work) === "background",
    );
  const agentState = workspaceAgentState(tabChips, backgroundWorks.length);
  const serverLabel = source?.serverLabel ?? view.label;
  const showHostDot = view.showHostDot;
  const paneCount = w.pane_count;
  const card = workspaceCard({
    name: fullName,
    host: source || showHostDot ? serverLabel : undefined,
    workspace: w,
    paneCount,
    tabCount: Math.max(tabCount, w.tab_count),
    agentState,
    background: backgroundWorks.flatMap(({ work }) =>
      backgroundTaskLines(work),
    ),
    review: review?.title,
    pinned,
  });
  const hasSubLine = !!branch || !!review || tabChipsVisible;

  return (
    <>
      <div
        className={`tree-row clickable-row workspace-row ${workspaceFocused ? "is-focused" : ""} ${
          hasActiveAgent ? "has-active-agent" : ""
        } ${isChild ? "is-child" : ""} ${pinned ? "is-pinned" : ""} ${
          isPendingFocus ? "is-loading" : ""
        } ${hasSubLine ? "has-sub-line" : ""} ${
          arrange?.dragging?.item.key === dragKey ? "is-dragging" : ""
        } ${dropClass(arrange, dragKey)}`}
        style={{
          paddingLeft: 6 + depth * TREE_DEPTH_INDENT,
          ...dropStyle(arrange, dragKey),
        }}
        role="treeitem"
        aria-label={fullName}
        data-tree-depth={depth}
        data-connection-id={source?.connectionId}
        {...drag}
        tabIndex={
          workspaceTreeItemIsTabStop({
            workspaceFocused,
            directAgentActive: hasActiveAgent,
            collapsed,
            hiddenDescendantActive,
          })
            ? 0
            : -1
        }
        aria-level={depth + 1}
        aria-selected={workspaceFocused}
        aria-expanded={hasNestedItems ? !collapsed : undefined}
        onClick={(e) => {
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          selectWorkspace();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const action = treeKeyboardAction(event.key, event.shiftKey);
          if (!action) return;
          if (
            action === "next" ||
            action === "previous" ||
            action === "first" ||
            action === "last"
          ) {
            event.preventDefault();
            focusTreeItem(event.currentTarget, action);
            return;
          }
          if (action === "expand") {
            event.preventDefault();
            if (hasNestedItems && collapsed) {
              view.onCollapsedChange(w, false);
            } else {
              focusTreeItem(event.currentTarget, "next");
            }
            return;
          }
          if (action === "collapse") {
            event.preventDefault();
            if (hasNestedItems && !collapsed) {
              view.onCollapsedChange(w, true);
            } else {
              focusTreeItem(event.currentTarget, "previous");
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (action === "activate") {
            selectWorkspace();
          } else {
            const point = keyboardContextMenuPoint(event.currentTarget);
            openMenu(point.x, point.y);
          }
        }}
        {...longPress}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
        title={card}
        data-tooltip-card=""
      >
        {hasNestedItems ? (
          <button
            type="button"
            className="workspace-group-toggle"
            tabIndex={-1}
            title={collapsed ? "Expand workspace" : "Collapse workspace"}
            aria-label={collapsed ? "Expand workspace" : "Collapse workspace"}
            aria-expanded={!collapsed}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openMenu(event.clientX, event.clientY);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              view.onCollapsedChange(w, !collapsed);
            }}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span className="twisty" aria-hidden="true" />
        )}
        {showHostDot ? (
          <HostDot connectionId={view.connectionId} label={serverLabel} />
        ) : null}
        <span className="ws-text">
          <strong className="ws-label">
            {reviewWorkspace ? (
              <GitPullRequest
                size={11}
                className="ws-review-mark"
                aria-label="Review workspace"
              >
                <title>
                  {`Reviews: ${reviewWorkspace.project}'s review worktree, checked out on each request you review`}
                </title>
              </GitPullRequest>
            ) : null}
            {name}
          </strong>
          {hasSubLine ? (
            <span className="ws-sub">
              {branch ? (
                <span
                  className="ws-branch"
                  {...(reviewWorkspace?.current
                    ? { title: `Checked out: ${reviewWorkspace.current.label}` }
                    : {})}
                >
                  {reviewWorkspace ? (
                    <GitPullRequest size={10} aria-hidden="true" />
                  ) : (
                    <GitBranch size={10} aria-hidden="true" />
                  )}
                  <span>{branch}</span>
                </span>
              ) : null}
              {review ? <PullRequestBadge review={review} /> : null}
              {tabChipsVisible ? (
                <WorkspaceTabChips
                  chips={tabChips}
                  workspaceFocused={workspaceFocused}
                  onOpen={(chip) => {
                    if (current) {
                      void store.focusTab(chip.tabId).then(() => onSelect?.(w));
                      return;
                    }
                    if (source) {
                      void openServerSession(
                        source,
                        w.workspace_id,
                        chip.paneId,
                      );
                    }
                  }}
                />
              ) : null}
            </span>
          ) : null}
        </span>
        {summary ? <TreeSummaryBadge summary={summary} /> : null}
        {pinned ? (
          <Pin
            className="workspace-pin"
            size={11}
            fill="currentColor"
            aria-label="Pinned"
          />
        ) : null}
        {isPendingFocus ? (
          <span className="row-spinner" aria-label="Loading workspace" />
        ) : null}
        {change || agentState ? (
          <span className="ws-status">
            {change ? (
              <span className={`ws-change is-${change.kind}`}>
                {change.text}
              </span>
            ) : null}
            {agentState ? (
              <span
                className={`ws-agent-dot is-${agentState}`}
                role="img"
                aria-label={ROW_AGENT_STATE_LABELS[agentState]}
              />
            ) : null}
          </span>
        ) : null}
      </div>
      {!collapsed ? (
        <>
          {agents.map((pane) => (
            <Fragment key={pane.pane_id}>
              <AgentRow
                pane={pane}
                depth={depth + 1}
                showPaneId={paneIdsToShow.has(pane.pane_id)}
                selected={
                  current &&
                  (pane.pane_id === activePaneId ||
                    (!activePaneId && pane.focused))
                }
                tabLabel={
                  source
                    ? (tabs.find(
                        (tab) =>
                          tab.tab_id === pane.tab_id &&
                          tab.workspace_id === pane.workspace_id,
                      )?.label ?? "")
                    : undefined
                }
                onActivate={
                  source
                    ? () => {
                        void activateAgent(pane);
                      }
                    : undefined
                }
                onSelect={onSelectAgent}
                onOpenMenu={(x, y) => view.onAgentContextMenu(pane, x, y)}
                background={backgroundWork(
                  arrange?.tasks(view.connectionId, pane.pane_id) ?? [],
                )}
              />
              <AgentTaskLine
                connectionId={view.connectionId}
                pane={pane}
                depth={depth + 1}
                onOpenTask={(task) => {
                  markTaskFailureSeen(view.connectionId, pane.pane_id, task.id);
                  void activateAgent(pane).then((opened) => {
                    if (opened) openAgentTask(pane.pane_id, task.id);
                  });
                }}
              />
            </Fragment>
          ))}
          {node && arrange
            ? arrange.renderNodeChildren(
                node.id,
                depth + 1,
                childAncestors,
                fullName,
              )
            : null}
          {children.map((child) => (
            <WorkspaceRow
              key={child.workspace_id}
              w={child}
              view={view}
              depth={depth + 1}
              parent={{
                kind: "usual",
                workspace: slot.item as WorkspaceDragItem,
              }}
              ancestors={childAncestors}
              parentName={fullName}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
