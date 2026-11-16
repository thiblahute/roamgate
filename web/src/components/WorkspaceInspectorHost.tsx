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
import type { ReviewThread, ReviewThreadKind } from "../../../shared/review";
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
  isTypingTarget,
  opensCommandLine,
  runInspectorCommand,
} from "../inspectorCommands";
import { parseReviewCommand } from "../reviewNavigation";
import {
  reviewSurfaceChoice,
  reviewSurfaceMessage,
  useReviewPrefs,
  writeReviewPrefs,
} from "../reviewPrefs";
import { setVimKeys, useVimKeys, vimKeys } from "../vimKeys";
import { useZenEscape, useZenMode } from "../useZenMode";
import { resetKeyMachines, useKeyMachine } from "../keyMachine";
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
  orderByStatus,
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
import { type ShortcutRow, ShortcutList } from "./ShortcutList";
import { useLiveClient } from "../useReloadOnReconnect";
import { ZenDock } from "./ZenIsland";
import { ChangesScopeBar, useChangesRepos } from "./ChangesScopeBar";
import { useReviewFileMarks } from "../useReviewFileMarks";
import {
  lastChangesRepo,
  rememberChangesRepo,
  repoResourceKey,
} from "../changesRepo";
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
const CHANGES_TREE_HIDDEN_KEY = "inspectorChangesTreeHidden";
/** No threads given: the review's files read from none. */
const NO_FEEDBACK_THREADS: readonly ReviewThread[] = [];

/** The inspector's own keys, in its shortcut list (`?`, `:help`). */
const INSPECTOR_KEYS: readonly ShortcutRow[] = [
  ["gt gT", "next / previous view (2gt: the second view, Vim's tabs)"],
  [":", "command line, in every view; Tab / Shift+Tab complete"],
  ["?", "this list (:help WORD opens it filtered)"],
  ["← → Home End", "on the tabs: previous / next view, the first / last"],
];

/** The tree hidden beside a view's detail, remembered in the browser. */
function readTreeHidden(key: string): boolean {
  try {
    return roamgateLocalStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * What Changes shows, in a line (the review in Changes): the repository,
 * then the scope, its branch and base.
 */
export function changesScopeLabel({
  mode,
  base,
  repo,
  branch,
}: {
  mode?: "working" | "branch-main" | "last-step";
  base?: string;
  repo?: string;
  branch?: string;
}): string {
  const what =
    mode === "branch-main"
      ? `${branch ? `branch ${branch}` : "this branch"} vs ${base ?? "its base"}`
      : mode === "last-step"
        ? "Last step: what the agent's last step changed"
        : "Working tree: uncommitted changes";
  return repo ? `${repo} · ${what}` : what;
}

/** A diff entry's path (from the checkout) and a path Files gave. */
export function sameDiffPath(entryPath: string, path: string): boolean {
  const relative = entryPath.replace(/^\.?\//, "");
  return (
    path === entryPath || path === relative || path.endsWith(`/${relative}`)
  );
}

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
  connectionClient: givenClient,
  onFileSelectionChange,
  onDiffSelectionChange,
  onOpenDiffFile,
  annotations,
  feedbackThreads,
  onCreateAnnotation,
  onAddReviewImage,
  onShowInReview,
  reviewGoTo = null,
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
  /** `root`: the repository the comment is on, when not the checkout's. */
  onCreateAnnotation: (
    input: NewReviewAnnotation,
    capture?: { root?: string; kind?: ReviewThreadKind },
  ) => void;
  /** Stores an image pasted in the review's comment box in Changes. */
  onAddReviewImage?: (file: File) => Promise<string>;
  /** Shows a file of a checkout (absolute path) in its code review. */
  onShowInReview?: (path: string, line?: number) => void;
  /**
   * On "in Changes", Files' Review: the file (absolute or relative) and
   * line Changes' cursor goes to; `at` tells requests apart.
   */
  reviewGoTo?: {
    path?: string;
    line?: number;
    scope?: "working" | "branch-main";
    /** The repository to show ("": the workspace's own). */
    root?: string;
    at: number;
  } | null;
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
  // Its views load again once the connection is back.
  const connectionClient = useLiveClient(givenClient);
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
  /** Changes' tree beside the diff, hidden by `:files`. */
  const [changesTreeHidden, setChangesTreeHidden] = useState(() =>
    readTreeHidden(CHANGES_TREE_HIDDEN_KEY),
  );
  const toggleChangesTree = () =>
    setChangesTreeHidden((hidden) => {
      try {
        roamgateLocalStorage.setItem(
          CHANGES_TREE_HIDDEN_KEY,
          hidden ? "0" : "1",
        );
      } catch {
        /* Kept for this page only. */
      }
      return !hidden;
    });
  /** Review only in Changes (`:only`): the diff alone, Esc brings all back. */
  const [changesOnly, toggleChangesOnly] = useZenMode();
  useZenEscape(changesOnly, toggleChangesOnly);
  /**
   * The review in Changes (`:set reviewin=changes`, Vim keys on): its Vim
   * cursor and keys there. On classic, Changes keeps upstream's.
   */
  const reviewPrefs = useReviewPrefs();
  const vim = useVimKeys();
  const reviewInChanges = reviewSurfaceChoice(reviewPrefs) === "changes" && vim;
  /** The files in the tree's groups when Changes is the review. */
  const resourceKey = resourceOwnerKey(state.scope);
  /*
   * The repository Changes shows: the workspace's own, or another of its
   * repositories picked in the scope line (p, ( and )); the review toggle
   * shows the last one again.
   */
  const [changesRepo, setChangesRepo] = useState<{
    key: string;
    root: string | undefined;
  }>(() => ({
    key: resourceKey,
    root: lastChangesRepo(resourceKey) || undefined,
  }));
  const changesRoot =
    changesRepo.key === resourceKey
      ? changesRepo.root
      : lastChangesRepo(resourceKey) || undefined;
  const ownRootRef = useRef<{ key: string; root?: string }>({
    key: resourceKey,
  });
  if (ownRootRef.current.key !== resourceKey)
    ownRootRef.current = { key: resourceKey };
  if (!changesRoot && diffSelection.root)
    ownRootRef.current.root = diffSelection.root;
  const ownRoot =
    ownRootRef.current.root ??
    (state.scope.kind === "worktree" ? state.scope.checkoutPath : undefined);
  const shownRoot = changesRoot ?? ownRoot;
  /** Its comments only: another repository's threads of a same path stay off. */
  const changesRepoShown = useMemo(
    () =>
      reviewInChanges && shownRoot
        ? { root: shownRoot, own: !changesRoot || changesRoot === ownRoot }
        : undefined,
    [changesRoot, ownRoot, reviewInChanges, shownRoot],
  );
  /**
   * One review across Files and Changes (D16): the review's files and
   * ticks in Files' tree and preview; an Other file picked in Changes' tree.
   */
  const reviewFiles = useReviewFileMarks({
    client: connectionClient,
    workspaceId: workspace?.workspace_id,
    resourceKey,
    threads: feedbackThreads ?? NO_FEEDBACK_THREADS,
    enabled: reviewInChanges && !!workspace,
  });
  const [otherFileGoTo, setOtherFileGoTo] = useState<{
    path: string;
    at: number;
  } | null>(null);
  const changesRepos = useChangesRepos(
    connectionClient.connectionId,
    workspace?.workspace_id ?? "",
    ownRoot,
    reviewInChanges && visible && state.open && state.view === "changes",
  );
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  /**
   * The keys to Changes' diff; with `frames`, to the one drawn anew (another
   * repository's), within that many frames.
   */
  const focusChangesDiff = (frames = 1) => {
    const query = () =>
      hostRef.current?.querySelector<HTMLElement>(
        ".inspector-changes-resource .diff-content-view[data-review-cursor]",
      );
    const before = frames > 1 ? query() : null;
    let left = frames;
    const step = () => {
      const diff = query();
      if (diff && diff !== before) diff.focus({ preventScroll: true });
      else if (--left > 0) requestAnimationFrame(step);
      else
        (
          diff ??
          hostRef.current?.querySelector<HTMLElement>(
            ".inspector-changes-resource .diff-content-view",
          )
        )?.focus({ preventScroll: true });
    };
    requestAnimationFrame(step);
  };
  const pickChangesRepo = (root: string) => {
    const other = root && root !== ownRoot ? root : undefined;
    // The diff is drawn again for the repository: the keys stay on it.
    const active = document.activeElement;
    if (
      active === document.body ||
      !!active?.closest(
        ".inspector-changes-resource, [data-radix-popper-content-wrapper]",
      )
    )
      focusChangesDiff(180);
    rememberChangesRepo(resourceKey, other);
    setChangesRepo({ key: resourceKey, root: other });
  };
  const pickChangesRepoRef = useRef(pickChangesRepo);
  pickChangesRepoRef.current = pickChangesRepo;
  const stepChangesRepo = (step: number) => {
    const at = changesRepos.findIndex((repo) => repo.root === shownRoot);
    const next = changesRepos[at + step];
    if (next) pickChangesRepo(next.root);
    else
      store.notify({
        kind: "info",
        message:
          changesRepos.length < 2
            ? "This workspace has a single repository here."
            : step > 0
              ? "The last repository"
              : "The first repository",
        autoDismissMs: 1800,
      });
  };
  const changesScopeBar = () => (
    <ChangesScopeBar
      repos={changesRepos}
      root={shownRoot}
      repoName={diffSelection.repoName ?? workspace?.worktree?.repo_name}
      mode={diffSelection.scopeMode ?? "working"}
      branch={diffSelection.branch ?? workspace?.worktree?.git_status?.branch}
      base={diffSelection.scopeBase}
      baseBranch={diffSelection.baseBranch ?? ""}
      baseBranches={diffSelection.baseBranches ?? []}
      commits={diffSelection.commits}
      files={diffSelection.entries.length}
      untracked={diffSelection.untracked}
      pickerOpen={repoPickerOpen}
      onPickerOpen={setRepoPickerOpen}
      onPickRepo={pickChangesRepo}
      onScope={(mode) => diffViewerRef.current?.showScope(mode)}
      onBase={(branch) => diffViewerRef.current?.showBase(branch)}
      onDone={() => focusChangesDiff()}
    />
  );
  const contentResourceKey = repoResourceKey(
    resourceStateKey(state.scope),
    changesRoot,
  );
  // Files' Review on "in Changes": that file's entry picked in the tree.
  const lastGoTo = useRef(0);
  const [pendingGoTo, setPendingGoTo] = useState<typeof reviewGoTo>(null);
  useEffect(() => {
    if (!reviewGoTo || reviewGoTo.at === lastGoTo.current) return;
    if (Date.now() - reviewGoTo.at > 10_000) return;
    lastGoTo.current = reviewGoTo.at;
    setPendingGoTo(reviewGoTo);
  }, [reviewGoTo]);
  useEffect(() => {
    if (!pendingGoTo) return;
    if (
      pendingGoTo.root !== undefined &&
      (pendingGoTo.root || ownRoot) !== shownRoot
    ) {
      pickChangesRepoRef.current(pendingGoTo.root);
      return;
    }
    if (pendingGoTo.scope) diffViewerRef.current?.showScope(pendingGoTo.scope);
    const path = pendingGoTo.path;
    if (path === undefined) {
      setPendingGoTo(null);
      return;
    }
    const target = diffSelection.entries.find((entry) =>
      sameDiffPath(entry.path, path),
    );
    if (!target) {
      if (diffSelection.summaryLoading) return;
      store.notify({
        kind: "info",
        message: "This file has no change: it is not in Changes",
        autoDismissMs: 3000,
      });
      setPendingGoTo(null);
      return;
    }
    diffViewerRef.current?.selectWorkingEntry(target);
    setPendingGoTo(null);
  }, [
    pendingGoTo,
    diffSelection.entries,
    diffSelection.summaryLoading,
    shownRoot,
    ownRoot,
  ]);
  const shownDiffEntries = useMemo(
    () =>
      reviewInChanges
        ? orderByStatus(diffSelection.entries)
        : diffSelection.entries,
    [diffSelection.entries, reviewInChanges],
  );
  /** The shortcut list (`?`, `:help`), with what its filter starts with. */
  const [shortcuts, setShortcuts] = useState<{ filter: string } | null>(null);
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
  const repoName =
    workspace?.worktree?.repo_name || workspace?.label || "Workspace";
  const checkout = checkoutLabel(workspace);
  const detailAvailable =
    state.view === "files"
      ? !!fileSelection.entry
      : state.view === "changes"
        ? !!diffSelection.entry
        : false;
  const hasDetail = detailAvailable && drillInByView[state.view];
  // Compact layouts show the tree or the file, never both.
  const treeHideable = !compact && !!fileSelection.entry;
  const changesTreeHideable = !compact;
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

  /*
   * `gt` / `gT`: the next and previous view (Vim's tab keys), anywhere in
   * the inspector but where keys are typed text; `2gt` is the second view.
   * Read before the views (capture), which go on reading `g` as theirs.
   */
  const viewKeys = useKeyMachine(["gt", "gT"]);
  const onViewKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      commandLine ||
      shortcuts ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isTypingTarget(event.target)
    )
      return;
    const result = viewKeys.feed(event.key);
    if (result.type !== "command") return;
    if (result.key !== "gt" && result.key !== "gT") return;
    const views: InspectorView[] = historyAvailable
      ? ["files", "changes", "commits", "history"]
      : ["files", "changes", "commits"];
    const at = Math.max(0, views.indexOf(state.view));
    const next =
      result.key === "gt" && result.count
        ? views[Math.min(views.length, result.count) - 1]!
        : views[
            (at +
              (result.key === "gt" ? 1 : -(result.count ?? 1)) +
              views.length * 10) %
              views.length
          ]!;
    event.preventDefault();
    event.stopPropagation();
    // The views had begun reading the `g`: they forget it.
    resetKeyMachines();
    onViewChange(next);
    tabRefs[next].current?.focus({ preventScroll: true });
  };

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
    ...(state.view === "changes" && changesTreeHideable
      ? [
          {
            name: "files",
            description: "show / hide the changed files' tree",
            run: () => {
              const navigation = document.getElementById(navigationIds.changes);
              const leaving =
                !changesTreeHidden &&
                !!navigation?.contains(document.activeElement);
              toggleChangesTree();
              if (leaving)
                document
                  .getElementById(detailIds.changes)
                  ?.focus({ preventScroll: true });
            },
          },
        ]
      : []),
    ...(state.view === "changes" && reviewInChanges
      ? [
          {
            name: "repo",
            aliases: ["p"],
            description:
              "the workspace's repositories, searched as you type (p)",
            run: () => {
              if (changesRepos.length < 2) {
                store.notify({
                  kind: "info",
                  message: "This workspace has a single repository here.",
                  autoDismissMs: 1800,
                });
                return;
              }
              setRepoPickerOpen(true);
            },
          },
          {
            name: "nextrepo",
            description: "the next repository ())",
            run: () => stepChangesRepo(1),
          },
          {
            name: "prevrepo",
            description: "the previous repository (()",
            run: () => stepChangesRepo(-1),
          },
          ...(["working", "branch", "last"] as const).map((name) => ({
            name,
            description:
              name === "working"
                ? "the working tree: uncommitted changes"
                : name === "branch"
                  ? "the branch against its base"
                  : "the agent's last step",
            run: () =>
              diffViewerRef.current?.showScope(
                name === "working"
                  ? "working"
                  : name === "branch"
                    ? "branch-main"
                    : "last-step",
              ),
          })),
        ]
      : []),
    ...(state.view === "changes"
      ? [
          {
            name: "only",
            aliases: ["o"],
            description: changesOnly
              ? "the inspector again (o, Esc)"
              : "Review only: the diff alone (Esc brings all back)",
            run: toggleChangesOnly,
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
      name: "vim",
      description: "Vim keys in the review, comments and previews on / off",
      run: () => runSetting("vim"),
    },
    {
      name: "novim",
      description: "Vim keys off",
      listed: false,
      run: () => runSetting("novim"),
    },
    {
      name: "set",
      description: "set vim, novim, reviewin=classic|changes",
      complete: () => [
        ["vim", "Vim keys on"],
        ["novim", "Vim keys off"],
        ["reviewin=classic", "reviews open in the review pane"],
        ["reviewin=changes", "reviews open in Changes"],
      ],
      run: (argument, how) => {
        if (!runSetting(`set ${argument}`)) how.unknown();
      },
    },
    {
      name: "help",
      description: "the shortcuts and commands here (:help WORD, filtered)",
      run: (argument) => setShortcuts({ filter: argument }),
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
   * `:vim`, `:novim`, `:set ...`: the review's preferences, as the review
   * pane's prompt sets them. False when the words are not a setting.
   */
  function runSetting(words: string): boolean {
    const command = parseReviewCommand(words);
    if (command.type === "vim") {
      // The one Vim keys setting, for every editor and device.
      const on = command.on ?? !vimKeys();
      setVimKeys(on);
      store.notify({
        kind: "info",
        message: on ? "Vim keys on" : "Vim keys off",
        autoDismissMs: 1800,
      });
      return true;
    }
    if (command.type === "reviewIn") {
      if (command.surface) writeReviewPrefs({ reviewIn: command.surface });
      store.notify({
        kind: "info",
        message: reviewSurfaceMessage(command.surface ?? reviewSurfaceChoice()),
        autoDismissMs: 2500,
      });
      return true;
    }
    return false;
  }
  /**
   * The shortcut list's rows: the shown view's keys, the inspector's, then
   * every command the prompt has here.
   */
  const shortcutRows = (): ShortcutRow[] => {
    const { commands, keys } = shownCommands();
    const seen = new Set<string>();
    return [
      ...(keys ?? []),
      ...INSPECTOR_KEYS,
      ...commands
        .filter((command) => {
          if (command.listed === false || seen.has(command.name)) return false;
          seen.add(command.name);
          return true;
        })
        .map(
          (command): ShortcutRow => [
            [command.name, ...(command.aliases ?? [])]
              .map((word) => `:${word}`)
              .join(" "),
            command.description,
          ],
        ),
    ];
  };
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
      keys: parts.flatMap((part) => part.commands.keys ?? []),
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
      onKeyDownCapture={onViewKey}
      onKeyDown={(event) => {
        if (
          event.key === "?" &&
          !event.defaultPrevented &&
          !commandLine &&
          !shortcuts &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !isTypingTarget(event.target)
        ) {
          event.preventDefault();
          event.stopPropagation();
          setShortcuts({ filter: "" });
          return;
        }
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
          {/* One line: the repository when the checkout is not named after
              it, the checkout; its path in the tooltip. */}
          <div
            className="workspace-inspector-identity"
            title={workspace?.worktree?.checkout_path ?? workspace?.cwd}
          >
            {repoName !== checkout ? (
              <span className="workspace-inspector-repo">{repoName}</span>
            ) : null}
            <span className="workspace-inspector-checkout">{checkout}</span>
            {workspace?.worktree?.is_linked_worktree ? (
              <span className="workspace-inspector-wt" title="Linked worktree">
                <GitFork size={11} aria-hidden="true" /> Worktree
              </span>
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
            {/* Expanded, it is the screen's top in Zen: the way out joins it. */}
            {state.expanded ? <ZenDock iconSize={15} /> : null}
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
            compact={reviewInChanges}
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
                    {...(reviewInChanges
                      ? {
                          reviewMarks: {
                            root: reviewFiles.root,
                            marks: reviewFiles.marks,
                          },
                        }
                      : {})}
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
                    placeScope={contentResourceKey}
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
                    {...(reviewInChanges ? { reviewFiles } : {})}
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
                } ${splitEnabled ? "has-split-resizer" : ""} ${
                  changesTreeHideable && changesTreeHidden
                    ? "files-tree-hidden"
                    : ""
                } ${changesOnly ? "is-review-only" : ""}`}
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
                    {...(reviewInChanges && changesRoot
                      ? { repoRoot: changesRoot }
                      : {})}
                    {...(reviewInChanges && compact
                      ? { header: changesScopeBar() }
                      : {})}
                    groupByStatus={reviewInChanges}
                    onPickOtherFile={(path) => {
                      setOtherFileGoTo({ path, at: Date.now() });
                      setDrillInByView((current) => ({
                        ...current,
                        changes: true,
                      }));
                    }}
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
                        cursorGoTo={
                          reviewGoTo?.path === undefined
                            ? null
                            : {
                                path: reviewGoTo.path,
                                at: reviewGoTo.at,
                                ...(reviewGoTo.line !== undefined
                                  ? { line: reviewGoTo.line }
                                  : {}),
                              }
                        }
                        entry={diffSelection.entry}
                        file={diffSelection.file}
                        loading={diffSelection.loading}
                        error={diffSelection.error}
                        entries={shownDiffEntries}
                        files={diffSelection.files}
                        fileErrors={diffSelection.fileErrors}
                        loadingKeys={diffSelection.loadingKeys}
                        summaryLoading={diffSelection.summaryLoading}
                        mobile={compact}
                        resourceKey={contentResourceKey}
                        connectionClient={connectionClient}
                        annotations={annotations}
                        threads={feedbackThreads}
                        {...(changesRepoShown
                          ? { repo: changesRepoShown }
                          : {})}
                        onCreateAnnotation={(input, written) =>
                          onCreateAnnotation(
                            input.source === "diff"
                              ? {
                                  ...input,
                                  ...(input.kind === "branch" &&
                                  diffSelection.pickedBase
                                    ? { base: diffSelection.pickedBase }
                                    : {}),
                                  // Drawn only on its repository's diff.
                                  ...(reviewInChanges && changesRoot
                                    ? { root: changesRoot }
                                    : {}),
                                }
                              : input,
                            // Another repository's comments go to its
                            // review; a question asked is a discussion.
                            reviewInChanges && (changesRoot || written?.kind)
                              ? {
                                  ...(changesRoot ? { root: changesRoot } : {}),
                                  ...(written?.kind
                                    ? { kind: written.kind }
                                    : {}),
                                }
                              : undefined,
                          )
                        }
                        onReanchorAnnotations={onReanchorDiffAnnotations}
                        onEditAnnotation={onEditAnnotation}
                        onSelectFile={(target) =>
                          diffViewerRef.current?.selectEntry(target)
                        }
                        onRetry={() => diffViewerRef.current?.refresh()}
                        onNearbyFilesChange={(targets) =>
                          diffViewerRef.current?.loadNearbyEntries(targets)
                        }
                        onVisibleFileChange={(target) =>
                          diffViewerRef.current?.highlightEntry(target)
                        }
                        onOpenFile={onOpenDiffFile}
                        reviewCursor={reviewInChanges}
                        {...(reviewInChanges
                          ? {
                              scopeLabel: changesScopeLabel({
                                mode: diffSelection.scopeMode,
                                base: diffSelection.scopeBase,
                                repo:
                                  diffSelection.repoName ??
                                  workspace?.worktree?.repo_name,
                                branch:
                                  diffSelection.branch ??
                                  workspace?.worktree?.git_status?.branch,
                              }),
                              scopeControls: changesScopeBar(),
                              ...(changesOnly
                                ? {
                                    headEnd: (
                                      <div className="diff-review-only-end">
                                        <button
                                          type="button"
                                          className="diff-review-only-exit"
                                          title="Show the inspector again (:only or Esc)"
                                          onClick={toggleChangesOnly}
                                        >
                                          Show all
                                        </button>
                                        <ZenDock iconSize={14} />
                                      </div>
                                    ),
                                  }
                                : {}),
                            }
                          : {})}
                        onGitAction={(action, path) =>
                          diffViewerRef.current?.runFileAction(action, path) ??
                          false
                        }
                        {...(onAddReviewImage ? { onAddReviewImage } : {})}
                        onSearchMatchesChange={(paths) =>
                          diffViewerRef.current?.markSearchMatches(paths)
                        }
                        onReviewProgress={(progress) =>
                          diffViewerRef.current?.markReviewProgress(progress)
                        }
                        onOtherFiles={(files) =>
                          diffViewerRef.current?.markOtherFiles(
                            files.map((each) => ({
                              path: each.path,
                              reviewed: each.reviewed,
                              threads: each.threads.length,
                            })),
                          )
                        }
                        otherFileGoTo={otherFileGoTo}
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
        {changesOnly && state.view === "changes" && !reviewInChanges ? (
          <div className="inspector-review-only-hint">
            <button
              type="button"
              title="Show the inspector again (:only or Esc)"
              onClick={toggleChangesOnly}
            >
              Show all
            </button>
          </div>
        ) : null}
        {shortcuts ? (
          <ShortcutList
            className="inspector-keys"
            title="Inspector shortcuts"
            rows={shortcutRows()}
            filter={shortcuts.filter}
            onFilter={(filter) => setShortcuts({ filter })}
            placeholder="Search shortcuts and commands"
            onClose={() => {
              setShortcuts(null);
              tabRefs[state.view].current?.focus({ preventScroll: true });
            }}
          />
        ) : null}
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
