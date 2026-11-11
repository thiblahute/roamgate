import {
  FileDiff,
  FolderTree,
  GitFork,
  GitGraph,
  History,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  X,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ReviewThread } from "../../../shared/review";
import type { ConnectionClient } from "../api";
import { connectionClientScopeKey } from "../useConnectionClient";
import { roamgateLocalStorage, subscribeLocalStorage } from "../browserStorage";
import {
  type NewReviewAnnotation,
  type ReviewAnnotation,
} from "../annotations";
import { lazyWithReload } from "../lazyWithReload";
import {
  INSPECTOR_VIEW_NAMES,
  type InspectorCommand,
  inspectorCompletions,
  inspectorViewNamed,
  opensCommandLine,
  runInspectorCommand,
} from "../inspectorCommands";
import { store } from "../store";
import {
  type InspectorCommandRegistry,
  type InspectorCommandSet,
  InspectorCommandsContext,
  InspectorViewContext,
} from "../useInspectorCommands";
import { shortcutTitle, useShortcutPreferences } from "../shortcutPreferences";
import type { GitDiffEntry, Pane, Workspace } from "../types";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
  preferencesStorageKey,
  readInspectorPreferences,
  resourceOwnerKey,
  resourceStateKey,
  writeInspectorNavigationRatio,
  readResourceFileTabs,
  writeResourceFileTabs,
  closeResourceFileTab,
  type InspectorDock,
  type InspectorSplitView,
  type InspectorView,
  type WorkspaceInspectorState,
} from "../workspaceResource";
import { AgentHistoryDrawer } from "./AgentHistoryDrawer";
import { paneHasAgentHistory } from "./agentSession";
import {
  type ActiveDiffSelection,
  DiffViewerPanel,
  type DiffViewerPanelHandle,
  type DiffViewerPanelProps,
} from "./DiffViewerPanel";
import { FileExplorerPanel } from "./FileExplorerDialog";
import {
  type ActiveFilePreviewSelection,
  FilePreviewContent,
} from "./FilePreviewContent";
import { FilePreviewTabs } from "./FilePreviewTabs";
import { workspaceInspectorLayout } from "./workspaceInspectorLayout";
import { PullRequestCard } from "./PullRequestCard";
import { InspectorSplitResizer } from "./InspectorSplitResizer";
import { CommandLine } from "./CommandLine";
import "./WorkspaceInspectorHost.css";

const DiffContentView = lazyWithReload("diff-content-view", () =>
  import("./DiffContentView").then((module) => ({
    default: module.DiffContentView,
  })),
);
const GitCommitHistory = lazyWithReload("git-commit-history", () =>
  import("./GitCommitHistory").then((module) => ({
    default: module.GitCommitHistory,
  })),
);

function changedCount(workspace?: Workspace) {
  const status = workspace?.worktree?.git_status;
  return status
    ? status.staged + status.unstaged + status.untracked + status.conflicted
    : 0;
}

function checkoutLabel(workspace?: Workspace) {
  if (!workspace) return "Unavailable checkout";
  return (
    workspace.worktree?.git_status?.branch ||
    workspace.worktree?.repo_name ||
    workspace.label ||
    workspace.workspace_id
  );
}

const INSPECTOR_RESOURCE_HORIZONTAL_PADDING = 16;
const VIEW_NOTES: Record<InspectorView, string> = {
  files: "the checkout's files",
  changes: "the working tree's changes",
  commits: "the commit history",
  history: "the agent's history",
};
const FILES_TREE_HIDDEN_KEY = "inspectorFilesTreeHidden";

export function WorkspaceInspectorHost({
  state,
  onReady,
  visible,
  workspace,
  historyPane,
  fileSelection,
  onSelectFileTab,
  previewRequestRef,
  diffSelection,
  connectionClient,
  onFileSelectionChange,
  onDiffSelectionChange,
  onOpenDiffFile,
  annotations,
  feedbackThreads,
  onCreateAnnotation,
  onShowInReview,
  onReanchorFileAnnotations,
  onReanchorDiffAnnotations,
  onEditAnnotation,
  onOpenDocument,
  onRefreshFile,
  onViewChange,
  onDockChange,
  onExpandedChange,
  onClose,
  onBack,
}: {
  state: WorkspaceInspectorState;
  onReady?: () => void;
  visible: boolean;
  workspace?: Workspace;
  historyPane?: Pane;
  fileSelection: ActiveFilePreviewSelection;
  onSelectFileTab: (path: string) => void;
  previewRequestRef: React.MutableRefObject<number>;
  diffSelection: ActiveDiffSelection;
  connectionClient: ConnectionClient;
  onFileSelectionChange: Parameters<
    typeof FileExplorerPanel
  >[0]["onPreviewChange"];
  onDiffSelectionChange: DiffViewerPanelProps["onSelectionChange"];
  onOpenDocument: (path: string, fragment?: string) => void;
  onRefreshFile: () => void;
  onOpenDiffFile: (entry: ActiveDiffSelection["entry"]) => void;
  annotations: readonly ReviewAnnotation[];
  /** The threads the annotations written as comments are, by their id. */
  feedbackThreads?: readonly ReviewThread[];
  onCreateAnnotation: (input: NewReviewAnnotation) => void;
  /** Shows a file of a checkout (absolute path) in its code review. */
  onShowInReview?: (path: string, line?: number) => void;
  onReanchorFileAnnotations: (path: string, text: string) => void;
  onReanchorDiffAnnotations: (
    path: string,
    kind: GitDiffEntry["kind"],
    patch: string,
  ) => void;
  onEditAnnotation: (id: string) => void;
  onViewChange: (view: InspectorView) => void;
  onDockChange: (dock: InspectorDock) => void;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  onBack: () => void;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  const [fileTabs, setFileTabs] = useState(() =>
    readResourceFileTabs(roamgateLocalStorage, state.scope),
  );
  useLayoutEffect(() => {
    setFileTabs(readResourceFileTabs(roamgateLocalStorage, state.scope));
  }, [fileSelection.entry?.path, state.scope]);
  // A scope can first open on Changes or History. Restore its active file when
  // entering Files, without requiring another explorer selection.
  useEffect(() => {
    if (state.view === "files" && !fileSelection.entry && fileTabs.activePath)
      onSelectFileTab(fileTabs.activePath);
  }, [state.view, fileSelection.entry, fileTabs.activePath, onSelectFileTab]);
  const onCloseFileTab = (path: string, directory = false) => {
    const current = readResourceFileTabs(roamgateLocalStorage, state.scope);
    const tabs = closeResourceFileTab(current, path, directory);
    writeResourceFileTabs(roamgateLocalStorage, state.scope, tabs);
    setFileTabs(tabs);
    if (current.activePath === tabs.activePath) return;
    previewRequestRef.current += 1;
    if (tabs.activePath) onSelectFileTab(tabs.activePath);
    else
      onFileSelectionChange?.({
        entry: null,
        preview: null,
        loading: false,
        error: null,
      });
  };
  const onPinFileTab = (path: string) => {
    const current = readResourceFileTabs(roamgateLocalStorage, state.scope);
    if (current.previewPath !== path) return;
    const tabs = { ...current, previewPath: null };
    writeResourceFileTabs(roamgateLocalStorage, state.scope, tabs);
    setFileTabs(tabs);
  };

  useLayoutEffect(() => {
    onReady?.();
  }, [onReady]);
  const filesTabRef = useRef<HTMLButtonElement | null>(null);
  const changesTabRef = useRef<HTMLButtonElement | null>(null);
  const commitsTabRef = useRef<HTMLButtonElement | null>(null);
  const historyTabRef = useRef<HTMLButtonElement | null>(null);
  const diffViewerRef = useRef<DiffViewerPanelHandle | null>(null);
  const splitId = useId();
  const [hostWidth, setHostWidth] = useState(0);
  const [fileDiffState, setFileDiffState] = useState<{
    resourceKey: string;
    entries: GitDiffEntry[];
  }>(() => ({ resourceKey: "", entries: [] }));
  /** The file tree beside a previewed file, hidden by `:files` or its button. */
  const [filesTreeHidden, setFilesTreeHidden] = useState(() => {
    try {
      return roamgateLocalStorage.getItem(FILES_TREE_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleFilesTree = () =>
    setFilesTreeHidden((hidden) => {
      try {
        roamgateLocalStorage.setItem(FILES_TREE_HIDDEN_KEY, hidden ? "0" : "1");
      } catch {
        /* Kept for this page only. */
      }
      return !hidden;
    });
  const [drillInByView, setDrillInByView] = useState<
    Record<InspectorView, boolean>
  >(() => ({
    files:
      state.view === "files" &&
      state.initialDirectory === undefined &&
      !!fileSelection.entry,
    changes: false,
    commits: false,
    history: false,
  }));
  const resourceKey = resourceOwnerKey(state.scope);
  const contentResourceKey = resourceStateKey(state.scope);
  const [commitsVisitedKey, setCommitsVisitedKey] = useState("");
  useEffect(() => {
    if (state.view === "commits") setCommitsVisitedKey(contentResourceKey);
  }, [contentResourceKey, state.view]);
  const fileDiffEntries =
    fileDiffState.resourceKey === contentResourceKey
      ? fileDiffState.entries
      : [];
  const setFileDiffEntries = useCallback(
    (entries: GitDiffEntry[]) =>
      setFileDiffState({ resourceKey: contentResourceKey, entries }),
    [contentResourceKey],
  );
  const [navigationPreferences, setNavigationPreferences] = useState(() =>
    readInspectorPreferences(roamgateLocalStorage, state.scope),
  );
  useShortcutPreferences();
  const defaultNavigationRatio = state.expanded
    ? inspectorNavigationRatioAtPosition(
        300,
        hostWidth - INSPECTOR_RESOURCE_HORIZONTAL_PADDING,
      )
    : DEFAULT_INSPECTOR_NAVIGATION_RATIO;
  const navigationRatios = {
    files: state.expanded
      ? (navigationPreferences.expandedNavigationRatios.files ??
        defaultNavigationRatio)
      : navigationPreferences.filesNavigationRatio,
    changes: state.expanded
      ? (navigationPreferences.expandedNavigationRatios.changes ??
        defaultNavigationRatio)
      : navigationPreferences.changesNavigationRatio,
  };
  const { compact, splitEnabled } = workspaceInspectorLayout(hostWidth);
  // The navigation/detail split is draggable whenever both panes fit side by
  // side, not only in the expanded layout, so docked inspectors can resize
  // the Files/Changes list too.
  const navigationIds = {
    files: `${splitId}-files-navigation`,
    changes: `${splitId}-changes-navigation`,
  };
  const detailIds = {
    files: `${splitId}-files-detail`,
    changes: `${splitId}-changes-detail`,
  };

  const setNavigationRatio = (view: InspectorSplitView, ratio: number) => {
    setNavigationPreferences((current) =>
      state.expanded
        ? {
            ...current,
            expandedNavigationRatios: {
              ...current.expandedNavigationRatios,
              [view]: ratio,
            },
          }
        : {
            ...current,
            [view === "files"
              ? "filesNavigationRatio"
              : "changesNavigationRatio"]: ratio,
          },
    );
  };
  const commitNavigationRatio = (view: InspectorSplitView, ratio: number) => {
    writeInspectorNavigationRatio(
      roamgateLocalStorage,
      state.scope,
      view,
      ratio,
      state.expanded,
    );
  };
  const splitStyle = (view: InspectorSplitView) =>
    ({
      "--workspace-inspector-navigation-width": `${navigationRatios[view] * 100}%`,
    }) as CSSProperties;
  const changeCount = changedCount(workspace);
  const historyAvailable = paneHasAgentHistory(historyPane);
  const detailAvailable =
    state.view === "files"
      ? !!fileSelection.entry
      : state.view === "changes"
        ? !!diffSelection.entry
        : false;
  const hasDetail = detailAvailable && drillInByView[state.view];
  // Compact layouts show the tree or the file, never both.
  const treeHideable = !compact && !!fileSelection.entry;
  const fileChangesEntries = fileSelection.entry
    ? fileDiffEntries.filter(
        (entry) => entry.path === fileSelection.entry?.path,
      )
    : [];
  const primaryFileChangesEntry =
    fileChangesEntries[fileChangesEntries.length - 1] ?? null;
  const fileDiffSelectionMatches = fileChangesEntries.some(
    (entry) =>
      diffSelection.entry?.path === entry.path &&
      diffSelection.entry.kind === entry.kind,
  );
  const fileChangesKey = fileChangesEntries
    .map((entry) => `${entry.kind}:${entry.status}:${entry.path}`)
    .join("|");

  useEffect(() => {
    if (state.view !== "files") return;
    if (state.initialDirectory !== undefined) {
      // Explicit directory navigation returns compact layouts to the tree,
      // while the saved preview and tabs remain available on desktop.
      if (!fileSelection.entry)
        setDrillInByView((current) => ({ ...current, files: false }));
      return;
    }
    if (fileSelection.entry)
      setDrillInByView((current) => ({ ...current, files: true }));
  }, [fileSelection.entry, state.view, state.initialDirectory]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" && state.view === "files") {
      const treeItem = hostRef.current?.querySelector<HTMLElement>(
        ".inspector-files-resource .file-row[role='treeitem'][tabindex='0']",
      );
      if (treeItem) {
        event.preventDefault();
        treeItem.focus({ preventScroll: true });
        treeItem.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    const views: InspectorView[] = historyAvailable
      ? ["files", "changes", "commits", "history"]
      : ["files", "changes", "commits"];
    const currentIndex = Math.max(0, views.indexOf(state.view));
    const nextView: InspectorView | undefined =
      event.key === "Home"
        ? views[0]
        : event.key === "End"
          ? views[views.length - 1]
          : event.key === "ArrowLeft"
            ? views[(currentIndex - 1 + views.length) % views.length]
            : event.key === "ArrowRight"
              ? views[(currentIndex + 1) % views.length]
              : undefined;
    if (!nextView) return;
    event.preventDefault();
    onViewChange(nextView);
    const refs = {
      files: filesTabRef,
      changes: changesTabRef,
      commits: commitsTabRef,
      history: historyTabRef,
    };
    refs[nextView].current?.focus();
  };

  /*
   * The `:` prompt, the inspector's one: `:` anywhere in it (the tab strip,
   * a view's tree, toolbar or content) but where it is typed text. Each
   * part of the shown view gives its commands (useInspectorCommands), then
   * come the inspector's own.
   */
  const [commandLine, setCommandLine] = useState<{
    from: HTMLElement | null;
  } | null>(null);
  const commandPartsRef = useRef(
    new Map<string, { view: InspectorView; commands: InspectorCommandSet }>(),
  );
  const tabRefs = {
    files: filesTabRef,
    changes: changesTabRef,
    commits: commitsTabRef,
    history: historyTabRef,
  };
  const viewNames = INSPECTOR_VIEW_NAMES.filter(
    (view) => view !== "history" || historyAvailable,
  );
  const activeFileTab = state.view === "files" ? fileTabs.activePath : null;
  const inspectorCommands: InspectorCommand[] = [
    {
      name: "view",
      aliases: ["v"],
      description: `go to a view: ${viewNames.join(", ")} (the tabs)`,
      complete: () => viewNames.map((view) => [view, VIEW_NOTES[view]]),
      run: (argument) => {
        const view = inspectorViewNamed(viewNames, argument);
        if (!view) {
          store.notify({
            kind: "info",
            message: argument
              ? `Not a view here: ${argument} (${viewNames.join(", ")})`
              : `Which view? :view ${viewNames.join(" | ")}`,
            autoDismissMs: 2500,
          });
          return;
        }
        onViewChange(view);
        tabRefs[view].current?.focus({ preventScroll: true });
      },
    },
    ...(state.view === "files" && treeHideable
      ? [
          {
            name: "files",
            description: "show / hide the file tree",
            run: () => {
              const navigation = document.getElementById(navigationIds.files);
              const leaving =
                !filesTreeHidden &&
                !!navigation?.contains(document.activeElement);
              toggleFilesTree();
              if (leaving)
                document
                  .getElementById(detailIds.files)
                  ?.focus({ preventScroll: true });
            },
          },
        ]
      : []),
    {
      name: "dock",
      description: "dock at right or at bottom (the dock button)",
      complete: () => [
        ["right", "dock at right"],
        ["bottom", "dock at bottom"],
      ],
      run: (argument) => {
        const word = argument.toLowerCase();
        onDockChange(
          word === "right" || word === "bottom"
            ? word
            : state.dock === "right"
              ? "bottom"
              : "right",
        );
      },
    },
    {
      name: "expand",
      description: state.expanded
        ? "restore the inspector's dock (the expand button)"
        : "expand the inspector (the expand button)",
      run: () => onExpandedChange(!state.expanded),
    },
    {
      name: "q",
      aliases: ["quit", "close"],
      description: activeFileTab
        ? "close the file's tab"
        : "close the inspector",
      run: () => {
        if (activeFileTab) onCloseFileTab(activeFileTab);
        else onClose();
      },
    },
  ];
  /**
   * The commands of the view shown, its parts' first, then the inspector's;
   * of its parts, first the one where the focus is (or was, when `:` was
   * pressed): one word means that part's.
   */
  const shownCommands = (): InspectorCommandSet => {
    const focus = commandLine?.from ?? document.activeElement;
    const focused = (part: { commands: InspectorCommandSet }) =>
      !!focus && !!part.commands.root?.()?.contains(focus);
    const parts = [...commandPartsRef.current.values()]
      .filter((part) => part.view === state.view)
      .sort((a, b) => Number(focused(b)) - Number(focused(a)));
    return {
      commands: [
        ...parts.flatMap((part) => part.commands.commands),
        ...inspectorCommands,
      ],
      line: parts.find((part) => part.commands.line)?.commands.line,
    };
  };
  const runCommand = (input: string) => {
    const { commands, line } = shownCommands();
    const problem = runInspectorCommand(commands, input, line);
    if (problem)
      store.notify({ kind: "info", message: problem, autoDismissMs: 2500 });
  };
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  const commandRegistry = useMemo<InspectorCommandRegistry>(
    () => ({
      set: (id, view, commands) => {
        if (commands) commandPartsRef.current.set(id, { view, commands });
        else commandPartsRef.current.delete(id);
      },
      run: (input) => runCommandRef.current(input),
    }),
    [],
  );
  /** Esc, Enter: the focus back where it was when `:` was pressed. */
  const leaveCommandLine = () => {
    const from = commandLine?.from;
    setCommandLine(null);
    const back = from?.isConnected ? from : tabRefs[state.view].current;
    back?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const refresh = () =>
      setNavigationPreferences(
        readInspectorPreferences(roamgateLocalStorage, state.scope),
      );
    refresh();
    return subscribeLocalStorage((key) => {
      if (key === null || key === preferencesStorageKey(state.scope)) refresh();
    });
  }, [contentResourceKey, state.scope]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostWidth(host.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <aside
      ref={hostRef}
      className={`workspace-inspector workspace-inspector-${state.dock} ${
        state.expanded ? "is-expanded" : ""
      } ${compact ? "is-compact" : ""} ${hasDetail ? "has-detail" : ""}`}
      aria-label="Workspace Inspector"
      data-view={state.view}
      onKeyDown={(event) => {
        if (event.defaultPrevented || commandLine || !opensCommandLine(event))
          return;
        event.preventDefault();
        event.stopPropagation();
        setCommandLine({
          from:
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
        });
      }}
    >
      <InspectorCommandsContext.Provider value={commandRegistry}>
        <header className="workspace-inspector-head">
          <div className="workspace-inspector-identity">
            <span className="workspace-inspector-repo">
              {workspace?.worktree?.repo_name ||
                workspace?.label ||
                "Workspace"}
            </span>
            <span className="workspace-inspector-checkout">
              {checkoutLabel(workspace)}
              {workspace?.worktree?.is_linked_worktree ? (
                <span
                  className="workspace-inspector-wt"
                  title="Linked worktree"
                >
                  <GitFork size={11} aria-hidden="true" /> Worktree
                </span>
              ) : null}
            </span>
            {workspace?.worktree?.checkout_path || workspace?.cwd ? (
              <code
                className="workspace-inspector-path"
                title={workspace.worktree?.checkout_path ?? workspace.cwd}
              >
                {workspace.worktree?.checkout_path ?? workspace.cwd}
              </code>
            ) : null}
          </div>
          <div className="workspace-inspector-tabs" role="tablist">
            <button
              ref={filesTabRef}
              type="button"
              role="tab"
              aria-selected={state.view === "files"}
              tabIndex={state.view === "files" ? 0 : -1}
              className={state.view === "files" ? "is-active" : ""}
              onClick={() => onViewChange("files")}
              onKeyDown={handleTabKeyDown}
            >
              <FolderTree size={14} /> Files
            </button>
            <button
              ref={changesTabRef}
              type="button"
              role="tab"
              aria-selected={state.view === "changes"}
              tabIndex={state.view === "changes" ? 0 : -1}
              className={state.view === "changes" ? "is-active" : ""}
              onClick={() => onViewChange("changes")}
              onKeyDown={handleTabKeyDown}
            >
              <FileDiff size={14} /> Changes
              {changeCount > 0 ? (
                <span className="workspace-inspector-count">{changeCount}</span>
              ) : null}
            </button>
            <button
              ref={commitsTabRef}
              type="button"
              role="tab"
              aria-selected={state.view === "commits"}
              tabIndex={state.view === "commits" ? 0 : -1}
              className={state.view === "commits" ? "is-active" : ""}
              onClick={() => onViewChange("commits")}
              onKeyDown={handleTabKeyDown}
            >
              <GitGraph size={14} /> Commits
            </button>
            <button
              ref={historyTabRef}
              type="button"
              role="tab"
              aria-selected={state.view === "history"}
              tabIndex={state.view === "history" ? 0 : -1}
              className={state.view === "history" ? "is-active" : ""}
              title={
                historyAvailable
                  ? "Agent history"
                  : "Select an active agent pane to view history"
              }
              disabled={!historyAvailable && state.view !== "history"}
              onClick={() => {
                if (historyAvailable) onViewChange("history");
              }}
              onKeyDown={handleTabKeyDown}
            >
              <History size={14} /> History
            </button>
          </div>
          <div className="workspace-inspector-actions">
            <button
              type="button"
              className="workspace-inspector-dock-action"
              title={
                state.dock === "right" ? "Dock at bottom" : "Dock at right"
              }
              aria-label={
                state.dock === "right"
                  ? "Dock Inspector at bottom"
                  : "Dock Inspector at right"
              }
              onClick={() =>
                onDockChange(state.dock === "right" ? "bottom" : "right")
              }
            >
              {state.dock === "right" ? (
                <PanelBottom size={15} />
              ) : (
                <PanelRight size={15} />
              )}
            </button>
            <button
              type="button"
              className="workspace-inspector-expand-action"
              title={shortcutTitle(
                state.expanded ? "Restore Inspector dock" : "Expand Inspector",
                "inspector.expand",
              )}
              aria-label={
                state.expanded ? "Restore Inspector dock" : "Expand Inspector"
              }
              aria-pressed={state.expanded}
              onClick={() => onExpandedChange(!state.expanded)}
            >
              {state.expanded ? (
                <Minimize2 size={15} />
              ) : (
                <Maximize2 size={15} />
              )}
            </button>
            <button
              type="button"
              title="Close Inspector"
              aria-label="Close Workspace Inspector"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {visible &&
        state.open &&
        workspace &&
        (state.view === "changes" || state.view === "commits") ? (
          <PullRequestCard
            key={connectionClientScopeKey(
              connectionClient,
              connectionClient.serverRuntimeGeneration,
              contentResourceKey,
              workspace.workspace_id,
              workspace.worktree?.checkout_path,
              workspace.cwd,
              workspace.worktree?.git_status?.branch,
            )}
            client={connectionClient}
            workspaceId={workspace.workspace_id}
            branch={workspace.worktree?.git_status?.branch}
          />
        ) : null}

        {!workspace ? (
          <div className="workspace-inspector-unavailable">
            <strong>Checkout unavailable</strong>
            <span>
              The workspace used to route this Inspector is no longer open.
            </span>
          </div>
        ) : (
          <div className="workspace-inspector-body">
            <InspectorViewContext.Provider value="files">
              <div
                className={`workspace-inspector-resource inspector-files-resource ${
                  state.view === "files" ? "" : "is-hidden"
                } ${splitEnabled ? "has-split-resizer" : ""} ${
                  treeHideable && filesTreeHidden ? "files-tree-hidden" : ""
                }`}
                style={splitEnabled ? splitStyle("files") : undefined}
              >
                <div
                  id={navigationIds.files}
                  className="workspace-inspector-navigation"
                >
                  <FileExplorerPanel
                    open
                    workspaceId={workspace.workspace_id}
                    resourceKey={resourceKey}
                    initialDirectory={state.initialDirectory}
                    activePath={fileSelection.entry?.path}
                    previewRequestRef={previewRequestRef}
                    keyboardActive={
                      state.view === "files" && (!compact || !hasDetail)
                    }
                    onClose={onClose}
                    onPreviewChange={(selection, meta) => {
                      if (meta?.deletedEntry) {
                        onCloseFileTab(
                          meta.deletedEntry.path,
                          meta.deletedEntry.type === "directory",
                        );
                        return;
                      }
                      if (selection.entry && meta?.userInitiated) {
                        setDrillInByView((current) => ({
                          ...current,
                          files: true,
                        }));
                      }
                      onFileSelectionChange?.(selection, meta);
                    }}
                    onPinFileTab={onPinFileTab}
                    onActiveDiffEntriesChange={setFileDiffEntries}
                  />
                </div>
                {splitEnabled ? (
                  <InspectorSplitResizer
                    ratio={navigationRatios.files}
                    resetRatio={defaultNavigationRatio}
                    navigationId={navigationIds.files}
                    detailId={detailIds.files}
                    onChange={(ratio) => setNavigationRatio("files", ratio)}
                    onCommit={(ratio) => commitNavigationRatio("files", ratio)}
                  />
                ) : null}
                <div
                  id={detailIds.files}
                  className="workspace-inspector-detail workspace-inspector-file-detail"
                  role="tabpanel"
                  aria-label={fileTabs.activePath ?? "File preview"}
                  tabIndex={-1}
                >
                  <FilePreviewTabs
                    tabs={fileTabs}
                    panelId={detailIds.files}
                    onSelect={(path) => {
                      setDrillInByView((current) => ({
                        ...current,
                        files: true,
                      }));
                      onSelectFileTab(path);
                    }}
                    onPin={onPinFileTab}
                    onClose={onCloseFileTab}
                    onEmptyFocus={() =>
                      (
                        hostRef.current?.querySelector<HTMLElement>(
                          ".inspector-files-resource .file-row[role='treeitem'][tabindex='0']",
                        ) ?? filesTabRef.current
                      )?.focus()
                    }
                  />
                  <FilePreviewContent
                    entry={fileSelection.entry}
                    preview={fileSelection.preview}
                    loading={fileSelection.loading}
                    error={fileSelection.error}
                    fragment={fileSelection.fragment}
                    line={fileSelection.line}
                    rendered={fileSelection.rendered}
                    snippet={fileSelection.snippet}
                    onOpenFile={onOpenDocument}
                    onRefresh={onRefreshFile}
                    onToggleTree={treeHideable ? toggleFilesTree : undefined}
                    treeHidden={filesTreeHidden}
                    backAction={
                      compact && drillInByView.files && fileSelection.entry
                        ? {
                            label: "Files",
                            onClick: () => {
                              setDrillInByView((current) => ({
                                ...current,
                                files: false,
                              }));
                              onBack();
                            },
                          }
                        : undefined
                    }
                    annotations={annotations}
                    onCreateAnnotation={onCreateAnnotation}
                    onShowInReview={onShowInReview}
                    onReanchorAnnotations={onReanchorFileAnnotations}
                    onOpenChanges={
                      primaryFileChangesEntry
                        ? () =>
                            diffViewerRef.current?.selectWorkingEntries(
                              fileChangesEntries,
                            )
                        : undefined
                    }
                    changesKey={fileChangesKey || undefined}
                    changesContent={
                      primaryFileChangesEntry ? (
                        <Suspense
                          fallback={
                            <div className="diff-content-state">
                              <span className="file-loading-spinner" />
                              Loading diff viewer
                            </div>
                          }
                        >
                          <DiffContentView
                            key={`${contentResourceKey}:file-changes`}
                            entry={
                              fileDiffSelectionMatches
                                ? diffSelection.entry
                                : primaryFileChangesEntry
                            }
                            file={
                              fileDiffSelectionMatches
                                ? diffSelection.file
                                : null
                            }
                            loading={
                              !fileDiffSelectionMatches || diffSelection.loading
                            }
                            error={
                              fileDiffSelectionMatches
                                ? diffSelection.error
                                : null
                            }
                            entries={fileChangesEntries}
                            files={
                              fileDiffSelectionMatches
                                ? diffSelection.files
                                : {}
                            }
                            fileErrors={
                              fileDiffSelectionMatches
                                ? diffSelection.fileErrors
                                : {}
                            }
                            resourceKey={`${contentResourceKey}:file:${fileChangesKey}`}
                            mobile={compact}
                            connectionClient={connectionClient}
                            annotations={annotations}
                            threads={feedbackThreads}
                            onCreateAnnotation={onCreateAnnotation}
                            onReanchorAnnotations={onReanchorDiffAnnotations}
                            onEditAnnotation={onEditAnnotation}
                            onSelectFile={(entry) =>
                              diffViewerRef.current?.selectWorkingEntry(entry)
                            }
                            embedded
                          />
                        </Suspense>
                      ) : undefined
                    }
                  />
                </div>
              </div>
            </InspectorViewContext.Provider>
            <InspectorViewContext.Provider value="changes">
              <div
                className={`workspace-inspector-resource inspector-changes-resource ${
                  state.view === "changes" ? "" : "is-hidden"
                } ${splitEnabled ? "has-split-resizer" : ""}`}
                style={splitEnabled ? splitStyle("changes") : undefined}
              >
                <div
                  id={navigationIds.changes}
                  className="workspace-inspector-navigation"
                >
                  <DiffViewerPanel
                    ref={diffViewerRef}
                    workspaceId={workspace.workspace_id}
                    resourceKey={resourceKey}
                    onOpenFile={onOpenDiffFile}
                    onSelectionChange={(selection, meta) => {
                      if (selection.entry && meta?.userInitiated) {
                        setDrillInByView((current) => ({
                          ...current,
                          changes: true,
                        }));
                      }
                      onDiffSelectionChange?.(selection, meta);
                    }}
                  />
                </div>
                {splitEnabled ? (
                  <InspectorSplitResizer
                    ratio={navigationRatios.changes}
                    resetRatio={defaultNavigationRatio}
                    navigationId={navigationIds.changes}
                    detailId={detailIds.changes}
                    onChange={(ratio) => setNavigationRatio("changes", ratio)}
                    onCommit={(ratio) =>
                      commitNavigationRatio("changes", ratio)
                    }
                  />
                ) : null}
                <div
                  id={detailIds.changes}
                  className="workspace-inspector-detail"
                >
                  {state.view === "changes" ? (
                    <Suspense
                      fallback={
                        <div className="diff-content-view">
                          <div className="diff-content-state">
                            <span className="file-loading-spinner" />
                            Loading Diff Viewer
                          </div>
                        </div>
                      }
                    >
                      <DiffContentView
                        key={contentResourceKey}
                        showFileSelector={false}
                        selectionRevision={diffSelection.selectionRevision}
                        entry={diffSelection.entry}
                        file={diffSelection.file}
                        loading={diffSelection.loading}
                        error={diffSelection.error}
                        entries={diffSelection.entries}
                        files={diffSelection.files}
                        fileErrors={diffSelection.fileErrors}
                        loadingKeys={diffSelection.loadingKeys}
                        summaryLoading={diffSelection.summaryLoading}
                        mobile={compact}
                        resourceKey={contentResourceKey}
                        connectionClient={connectionClient}
                        annotations={annotations}
                        threads={feedbackThreads}
                        onCreateAnnotation={onCreateAnnotation}
                        onReanchorAnnotations={onReanchorDiffAnnotations}
                        onEditAnnotation={onEditAnnotation}
                        onSelectFile={(target) =>
                          diffViewerRef.current?.selectEntry(target)
                        }
                        onNearbyFilesChange={(targets) =>
                          diffViewerRef.current?.loadNearbyEntries(targets)
                        }
                        onVisibleFileChange={(target) =>
                          diffViewerRef.current?.highlightEntry(target)
                        }
                        onOpenFile={onOpenDiffFile}
                        backAction={
                          compact && hasDetail
                            ? {
                                label: "Changed files",
                                onClick: () => {
                                  setDrillInByView((current) => ({
                                    ...current,
                                    changes: false,
                                  }));
                                  onBack();
                                },
                              }
                            : undefined
                        }
                      />
                    </Suspense>
                  ) : null}
                </div>
              </div>
            </InspectorViewContext.Provider>
            <InspectorViewContext.Provider value="commits">
              <div
                className={`workspace-inspector-resource inspector-commits-resource ${state.view === "commits" ? "" : "is-hidden"}`}
              >
                {state.view === "commits" ||
                commitsVisitedKey === contentResourceKey ? (
                  <Suspense
                    fallback={
                      <div className="workspace-inspector-unavailable">
                        Loading commits
                      </div>
                    }
                  >
                    <GitCommitHistory
                      key={connectionClientScopeKey(
                        connectionClient,
                        connectionClient.serverRuntimeGeneration,
                        contentResourceKey,
                        workspace.workspace_id,
                        workspace.worktree?.checkout_path,
                        workspace.cwd,
                        workspace.worktree?.git_status?.branch,
                      )}
                      client={connectionClient}
                      workspaceId={workspace.workspace_id}
                      resourceKey={contentResourceKey}
                      compact={compact || hostWidth < 960}
                      active={visible && state.open && state.view === "commits"}
                    />
                  </Suspense>
                ) : null}
              </div>
            </InspectorViewContext.Provider>
            <InspectorViewContext.Provider value="history">
              <div
                className={`workspace-inspector-resource inspector-history-resource ${
                  state.view === "history" ? "" : "is-hidden"
                }`}
              >
                {historyAvailable && historyPane ? (
                  <AgentHistoryDrawer
                    pane={historyPane}
                    open={visible && state.open && state.view === "history"}
                    embedded
                    wide={!compact}
                    onOpenChange={(open) => {
                      if (!open) onClose();
                    }}
                  />
                ) : (
                  <div className="workspace-inspector-unavailable">
                    <strong>No active agent session</strong>
                    <span>Select an agent pane to inspect its history.</span>
                  </div>
                )}
              </div>
            </InspectorViewContext.Provider>
          </div>
        )}
        {commandLine ? (
          <CommandLine
            kind=":"
            completions={(typed) =>
              inspectorCompletions(shownCommands().commands, typed)
            }
            onBlur={() => setCommandLine(null)}
            onSubmit={(text) => {
              leaveCommandLine();
              runCommand(text);
            }}
            onCancel={leaveCommandLine}
          />
        ) : null}
      </InspectorCommandsContext.Provider>
    </aside>
  );
}
