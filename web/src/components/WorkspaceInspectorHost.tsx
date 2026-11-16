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
import type {
  ReviewSnapshot,
  ReviewThread,
  ReviewThreadKind,
} from "../../../shared/review";
import type { ConnectionClient } from "../api";
import { connectionClientScopeKey } from "../useConnectionClient";
import { roamgateLocalStorage, subscribeLocalStorage } from "../browserStorage";
import {
  type NewReviewAnnotation,
  type ReviewAnnotation,
  reviewAgentPanes,
} from "../annotations";
import { lazyWithReload } from "../lazyWithReload";
import { useSystemBack } from "../systemBack";
import {
  INSPECTOR_VIEW_NAMES,
  type InspectorCommand,
  inspectorCompletions,
  inspectorViewNamed,
  isTypingTarget,
  opensCommandLine,
  runInspectorCommand,
} from "../inspectorCommands";
import { useZenEscape, useZenMode } from "../useZenMode";
import { resetKeyMachines, useKeyMachine } from "../keyMachine";
import { store, useStoreSelector } from "../store";
import {
  type InspectorCommandRegistry,
  type InspectorCommandSet,
  InspectorCommandsContext,
  InspectorViewContext,
  inspectorShortcutList,
} from "../useInspectorCommands";
import { inspectorSettingCommands } from "../inspectorSettings";
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
import { ShortcutList } from "./ShortcutList";
import {
  changesFrameCommands,
  InspectorZenEnd,
  ReviewOnlyEnd,
  useChangesTreeHidden,
} from "./changesFrame";
import { useLiveClient } from "../useReloadOnReconnect";
import { ZenDock } from "./ZenIsland";
import {
  ChangesScopeBar,
  useChangesRepos,
  useChangesSeries,
  useWorkspaceRepoDirs,
} from "./ChangesScopeBar";
import { useReviewFileMarks } from "../useReviewFileMarks";
import {
  lastChangesRepo,
  rememberChangesRepo,
  repoResourceKey,
} from "../changesRepo";
import { type ChangesScope, stepTarget, WORKING_SCOPE } from "../changesReview";
import { useReviewState } from "../review";
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
/** No threads given: the review's files read from none. */
const NO_FEEDBACK_THREADS: readonly ReviewThread[] = [];

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
  onReviewCommit,
  onFocusAgentPane,
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
  onCloseReview,
  onShowReviews,
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
  /** A changed file in Files: at a line, rendered (the review's Open). */
  onOpenDiffFile: (
    entry: ActiveDiffSelection["entry"],
    at?: { line?: number; rendered?: boolean },
  ) => void;
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
   * Files' Review: the file (absolute or relative) and
   * line Changes' cursor goes to; `at` tells requests apart.
   */
  reviewGoTo?: {
    path?: string;
    line?: number;
    scope?: "working" | "branch-main" | "last-step";
    /**
     * A review shown as Changes' scope (a range or compare opened by name,
     * an older step): its session.
     */
    review?: string;
    /** The repository to show ("": the workspace's own). */
    root?: string;
    /**
     * Of a repository the workspace does not hold (its workspace gone, an
     * agent's review without one): shown here, marked "from elsewhere" (D3).
     */
    elsewhere?: boolean;
    /** Commits' Review this commit: that commit in the Branch scope. */
    commit?: string;
    at: number;
  } | null;
  /** Commits' Review this commit (plan phase 8). */
  onReviewCommit?: (sha: string) => void;
  /** The review's agent menu: Go to the agent's pane, the review kept. */
  onFocusAgentPane?: (paneId: string) => void;
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
  /**
   * The review in Changes closed (`:q`, Esc with nothing else to leave):
   * as the review toggle closes it; absent, `:q` closes the inspector.
   */
  onCloseReview?: (how: "command" | "escape") => void;
  /** `:reviews` in Changes: the reviews in progress. */
  onShowReviews?: () => void;
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
  const [changesTreeHidden, toggleChangesTree] = useChangesTreeHidden();
  /** Review only in Changes (`:only`): the diff alone, Esc brings all back. */
  const [changesOnly, toggleChangesOnly] = useZenMode();
  useZenEscape(changesOnly, toggleChangesOnly);
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
      shownRoot
        ? { root: shownRoot, own: !changesRoot || changesRoot === ownRoot }
        : undefined,
    [changesRoot, ownRoot, shownRoot],
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
    enabled: !!workspace,
  });
  const [otherFileGoTo, setOtherFileGoTo] = useState<{
    path: string;
    at: number;
  } | null>(null);
  /** The workspace's agent panes: the review's agent when none is bound. */
  const allPanes = useStoreSelector((current) => current.panes);
  const agentPanes = useMemo(
    () =>
      reviewAgentPanes(allPanes, workspace?.workspace_id ?? "").map((pane) => ({
        paneId: pane.pane_id,
        agent: pane.agent ?? "agent",
      })),
    [allPanes, workspace?.workspace_id],
  );
  const repoDirs = useWorkspaceRepoDirs(workspace?.workspace_id ?? "");
  const changesRepos = useChangesRepos(
    connectionClient.connectionId,
    workspace?.workspace_id ?? "",
    ownRoot,
    visible && state.open && state.view === "changes",
    repoDirs,
  );
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
  // A repository with only uncommitted work shows its Working scope, as
  // the review pane opens its worktree review.
  const series = useChangesSeries({
    repos: changesRepos,
    shownRoot,
    onPick: (root, worktree) => {
      if (!worktree) {
        pickChangesRepo(root);
        return;
      }
      const trimmed = root.replace(/\/+$/, "");
      setPendingGoTo({
        root: trimmed === ownRoot ? "" : trimmed,
        scope: "working",
        at: Date.now(),
      });
    },
  });
  const repoPickerOpen = series.pickerOpen;
  const setRepoPickerOpen = series.setPickerOpen;
  /**
   * A review shown as Changes' scope (a range or compare opened by name,
   * an older step), until a scope is picked (plan phase 6).
   */
  const [shownReview, setShownReview] = useState<string | null>(null);
  /** The review last shown as the scope: a scope that fails offers it back. */
  const [leftReview, setLeftReview] = useState<string | null>(null);
  useEffect(() => {
    if (shownReview) setLeftReview(shownReview);
  }, [shownReview]);
  /** A repository the workspace does not hold, shown from elsewhere (D3). */
  const [elsewhereRoot, setElsewhereRoot] = useState<string | null>(null);
  const { sessions: reviewSessions } = useReviewState();
  const shownReviewSnapshot = shownReview
    ? reviewSessions.get(shownReview)
    : undefined;
  /** The review's view Changes shows when not the scope's own files. */
  const [viewTree, setViewTree] = useState<{
    label: string;
    entries: readonly GitDiffEntry[];
  } | null>(null);
  const [viewGoTo, setViewGoTo] = useState<{
    path: string;
    at: number;
  } | null>(null);
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
      onPickRepo={series.pick}
      elsewhere={!!elsewhereRoot && elsewhereRoot === shownRoot}
      {...(workspace &&
      !changesOnly &&
      // The checkout's request, over the checkout's own review only: never
      // the workspace's pull request over another repository's review.
      (!changesRoot || changesRoot === ownRoot) &&
      !(elsewhereRoot && elsewhereRoot === shownRoot) &&
      (!shownReviewSnapshot ||
        !ownRoot ||
        shownReviewSnapshot.session.root === ownRoot)
        ? {
            request: (
              <span className="changes-request-chip">
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
                  compact
                  onRequest={setCardRequest}
                />
              </span>
            ),
          }
        : {})}
      {...(shownReviewSnapshot
        ? {
            review: {
              label: shownReviewSnapshot.session.title,
              files: viewTree?.entries.length,
            },
          }
        : {})}
      onScope={(mode) => {
        setShownReview(null);
        diffViewerRef.current?.showScope(mode);
      }}
      onBase={(branch) => {
        setShownReview(null);
        diffViewerRef.current?.showBase(branch);
      }}
      onDone={() => focusChangesDiff()}
    />
  );
  /**
   * The Local / GitLab switch (plan phase 7): the merge request's review
   * shown as Changes' review scope, on its repository; back, the checkout's
   * branch review.
   */
  /** The request the card shows, its remote as chosen there. */
  const [cardRequest, setCardRequest] = useState<string | null>(null);
  const forgeHost = useMemo(
    () => ({
      ...(cardRequest ? { requestUrl: cardRequest } : {}),
      onShowReview: (snapshot: ReviewSnapshot) => {
        const root = snapshot.session.root.replace(/\/+$/, "");
        const same = root === (shownRoot ?? "").replace(/\/+$/, "");
        setPendingGoTo({
          review: snapshot.session.id,
          ...(same ? {} : { root: root === ownRoot ? "" : root }),
          at: Date.now(),
        });
      },
      onOpenLocal: (root: string) => {
        const trimmed = root.replace(/\/+$/, "");
        setPendingGoTo({
          scope: "branch-main",
          root: trimmed === ownRoot ? "" : trimmed,
          at: Date.now(),
        });
      },
    }),
    [ownRoot, shownRoot, cardRequest],
  );
  const contentResourceKey = repoResourceKey(
    resourceStateKey(state.scope),
    changesRoot,
  );
  // Files' Review: that file's entry picked in the tree.
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
    if (pendingGoTo.root !== undefined)
      setElsewhereRoot(
        pendingGoTo.elsewhere && pendingGoTo.root ? pendingGoTo.root : null,
      );
    if (
      pendingGoTo.root !== undefined &&
      (pendingGoTo.root || ownRoot) !== shownRoot
    ) {
      pickChangesRepoRef.current(pendingGoTo.root);
      return;
    }
    if (pendingGoTo.review !== undefined) setShownReview(pendingGoTo.review);
    else if (pendingGoTo.scope) {
      setShownReview(null);
      diffViewerRef.current?.showScope(pendingGoTo.scope);
    }
    if (pendingGoTo.commit)
      setShowCommit({ sha: pendingGoTo.commit, at: pendingGoTo.at });
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
  /** Review this commit: the commit the Branch scope's bar shows. */
  const [showCommit, setShowCommit] = useState<{
    sha: string;
    at: number;
  } | null>(null);
  /**
   * A commit the Branch scope does not hold (older than the branch, on
   * another one): its own review, `SHA^..SHA`, shown as Changes' scope.
   */
  const reviewCommitApart = useCallback(
    (sha: string) => {
      void import("../reviewOpen").then(async ({ openCommitReview }) => {
        const sessionId = await openCommitReview(sha, {
          workspaceId: workspace?.workspace_id,
          ...(ownRoot ? { path: ownRoot } : {}),
        });
        if (sessionId) setPendingGoTo({ review: sessionId, at: Date.now() });
      });
    },
    [workspace?.workspace_id, ownRoot],
  );
  /** The review the scope shown is (plan phase 6): a read-only binding. */
  const changesScope = useMemo<ChangesScope>(
    () =>
      shownReview
        ? { kind: "review", sessionId: shownReview }
        : diffSelection.scopeMode === "branch-main"
          ? {
              kind: "branch",
              ...(diffSelection.pickedBase
                ? { base: diffSelection.pickedBase }
                : diffSelection.scopeBase
                  ? { automaticBase: diffSelection.scopeBase }
                  : {}),
            }
          : diffSelection.scopeMode === "last-step" && diffSelection.step
            ? { kind: "step", step: diffSelection.step }
            : WORKING_SCOPE,
    [
      shownReview,
      diffSelection.scopeMode,
      diffSelection.pickedBase,
      diffSelection.scopeBase,
      diffSelection.step,
    ],
  );
  const shownDiffEntries = useMemo(
    () => orderByStatus(diffSelection.entries),
    [diffSelection.entries],
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
    ...(state.view === "changes"
      ? [
          ...series.commands,
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
      ? changesFrameCommands({
          toggleTree: changesTreeHideable
            ? () => {
                const navigation = document.getElementById(
                  navigationIds.changes,
                );
                const leaving =
                  !changesTreeHidden &&
                  !!navigation?.contains(document.activeElement);
                toggleChangesTree();
                if (leaving)
                  document
                    .getElementById(detailIds.changes)
                    ?.focus({ preventScroll: true });
              }
            : null,
          only: changesOnly,
          toggleOnly: toggleChangesOnly,
        })
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
    ...inspectorSettingCommands((filter) => setShortcuts({ filter })),
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
    // A part with its own list and words (the review in Changes).
    const own = parts.find(
      (part) => part.commands.shortcuts || part.commands.unknown,
    );
    return {
      commands: [
        ...parts.flatMap((part) => part.commands.commands),
        ...inspectorCommands,
      ],
      line: parts.find((part) => part.commands.line)?.commands.line,
      keys: parts.flatMap((part) => part.commands.keys ?? []),
      ...(own?.commands.shortcuts ? { shortcuts: own.commands.shortcuts } : {}),
      ...(own?.commands.unknown ? { unknown: own.commands.unknown } : {}),
    };
  };
  const runCommand = (input: string) => {
    const { commands, line, unknown } = shownCommands();
    const problem = runInspectorCommand(
      commands,
      input,
      line,
      unknown ? (text) => unknown(text) : undefined,
    );
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
  /*
   * The phone's Back over the review in Changes (plan section 6): the
   * prompt, then the conversations (Changes' diff), Review only, the diff
   * back to its tree, then the view (App).
   */
  const changesShown = visible && state.open && state.view === "changes";
  /** The inspector's header can shrink into the review's row (app Zen). */
  const zenEnd =
    state.view === "changes" && state.expanded && !compact && !changesOnly;
  useSystemBack(changesShown && !!commandLine, leaveCommandLine, "popup");
  useSystemBack(changesShown && changesOnly, toggleChangesOnly, "navigation");
  useSystemBack(
    changesShown && compact && !!drillInByView.changes && !!diffSelection.entry,
    () => {
      setDrillInByView((current) => ({ ...current, changes: false }));
      onBack();
    },
    "navigation",
  );

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
      } ${compact ? "is-compact" : ""} ${hasDetail ? "has-detail" : ""} ${
        // Classes, not :has(): typing in a comment restyles nothing.
        changesOnly && state.view === "changes" ? "is-review-only" : ""
      } ${zenEnd ? "has-zen-end" : ""}`}
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
        // Changes has it as a chip in its head's row, and only for the
        // checkout's own review.
        state.view === "commits" ? (
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
            compact
            onRequest={setCardRequest}
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
                    reviewMarks={{
                      root: reviewFiles.root,
                      marks: reviewFiles.marks,
                    }}
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
                    reviewFiles={reviewFiles}
                    onReanchorAnnotations={onReanchorFileAnnotations}
                    onOpenChanges={
                      primaryFileChangesEntry
                        ? () => {
                            // Never away from a review shown (plan
                            // section 7, Files' selectWorkingEntries).
                            if (shownReview) return;
                            diffViewerRef.current?.selectWorkingEntries(
                              fileChangesEntries,
                            );
                          }
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
                    {...(changesRoot ? { repoRoot: changesRoot } : {})}
                    {...(compact ? { header: changesScopeBar() } : {})}
                    groupByStatus
                    review
                    viewFiles={viewTree}
                    onScopeChange={() => setShownReview(null)}
                    onPickViewFile={(path) =>
                      setViewGoTo({ path, at: Date.now() })
                    }
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
                          viewGoTo &&
                          (reviewGoTo?.path === undefined ||
                            viewGoTo.at > reviewGoTo.at)
                            ? viewGoTo
                            : reviewGoTo?.path === undefined
                              ? null
                              : {
                                  path: reviewGoTo.path,
                                  at: reviewGoTo.at,
                                  ...(reviewGoTo.line !== undefined
                                    ? { line: reviewGoTo.line }
                                    : {}),
                                }
                        }
                        onViewEntries={setViewTree}
                        showCommit={showCommit}
                        onCommitAbsent={reviewCommitApart}
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
                                  // The Last step's own review (D15).
                                  ...(input.kind === "last-step" &&
                                  diffSelection.step &&
                                  !input.target
                                    ? { target: stepTarget(diffSelection.step) }
                                    : {}),
                                  // Drawn only on its repository's diff.
                                  ...(changesRoot ? { root: changesRoot } : {}),
                                }
                              : input,
                            // Another repository's comments go to its
                            // review; a question asked is a discussion.
                            changesRoot || written?.kind
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
                        {...(leftReview && !shownReview
                          ? {
                              errorBack: {
                                label: "Back to the review",
                                run: () => setShownReview(leftReview),
                              },
                            }
                          : {})}
                        onNearbyFilesChange={(targets) =>
                          diffViewerRef.current?.loadNearbyEntries(targets)
                        }
                        onVisibleFileChange={(target) =>
                          diffViewerRef.current?.highlightEntry(target)
                        }
                        onOpenFile={onOpenDiffFile}
                        reviewCursor
                        reviewScope={changesScope}
                        scopeLabel={changesScopeLabel({
                          mode: diffSelection.scopeMode,
                          base: diffSelection.scopeBase,
                          repo:
                            diffSelection.repoName ??
                            workspace?.worktree?.repo_name,
                          branch:
                            diffSelection.branch ??
                            workspace?.worktree?.git_status?.branch,
                        })}
                        scopeControls={changesScopeBar()}
                        {...(changesOnly
                          ? {
                              headEnd: (
                                <ReviewOnlyEnd
                                  onShowAll={toggleChangesOnly}
                                  onCloseReview={() =>
                                    onCloseReview
                                      ? onCloseReview("command")
                                      : onClose()
                                  }
                                />
                              ),
                            }
                          : zenEnd
                            ? {
                                // The app's Zen: the inspector's
                                // header in the review's row.
                                headEnd: (
                                  <InspectorZenEnd
                                    onView={onViewChange}
                                    historyAvailable={historyAvailable}
                                    onRestore={() => onExpandedChange(false)}
                                    onClose={onClose}
                                  />
                                ),
                              }
                            : {})}
                        onGitAction={(action, path) =>
                          diffViewerRef.current?.runFileAction(action, path) ??
                          false
                        }
                        forgeHost={forgeHost}
                        onCloseReview={
                          onCloseReview ??
                          ((how) => {
                            if (how === "command") onClose();
                          })
                        }
                        {...(onShowReviews ? { onShowReviews } : {})}
                        reviewOnly={changesOnly}
                        agentPanes={agentPanes}
                        {...(onFocusAgentPane ? { onFocusAgentPane } : {})}
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
                      {...(onReviewCommit ? { onReviewCommit } : {})}
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
        {shortcuts ? (
          <ShortcutList
            className="inspector-keys"
            {...inspectorShortcutList(shownCommands())}
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
