import { roamgateLocalStorage } from "../browserStorage";
import { refLabel } from "../compareRefs";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileDiff,
  FileText,
  Folder,
  RefreshCw,
} from "lucide-react";
import type { ConnectionClient } from "../api";
import type {
  GitDiffEntry,
  GitDiffFile,
  GitDiffKind,
  GitDiffSummary,
} from "../types";
import { useStoreSelector } from "../store";
import { connectionClientScopeKey } from "../useConnectionClient";
import { useLiveConnectionClient } from "../useReloadOnReconnect";
import { connectionStorageKey } from "../connectionStorage";
import { useInspectorCommands } from "../useInspectorCommands";
import { gitDiffCode, gitDiffCodeLabel } from "../gitDiffStatus";
import {
  lastStepCompletionKey,
  readLastStepCompletion,
  subscribeLastStepCompletion,
} from "../lastStepCompletionStore";
import {
  refreshGitDiffSummary,
  retireGitDiffSummary,
  retireGitDiffSummaryResource,
  useGitDiffSummaryState,
} from "../gitDiffSummaryStore";
import { diffAutoCollapseInfo } from "./diffAutoCollapse";
import { createDiffLoadQueue } from "./diffLoadQueue";
import { store } from "../store";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { bumpFileExplorerRefresh } from "../fileExplorerRefresh";
import {
  revealInFileManager,
  revealMenuLabel,
  useCanRevealInFileManager,
} from "../fileManager";
import {
  buildGitFileMenuItems,
  buildGitRepoMenuItems,
  countWorkingEntries,
  gitFileActionLabel,
  gitFileConfirmCopy,
  gitFolderConfirmCopy,
  type GitFileAction,
  gitRepoConfirmCopy,
  type GitFileMenuItem,
  type GitRepoMenuItem,
} from "../gitActions";
import { keyboardContextMenuPoint, treeKeyboardAction } from "./treeKeyboard";
import { ActionsMenu } from "./ActionsMenu";
import { ConfirmDialog } from "./ModalDialogs";
import { ThemedSelect } from "./ThemedSelect";
import "./DiffViewerPanel.css";
import { repoResourceKey, repoRootOf } from "../changesRepo";

export type ActiveDiffSelection = {
  selectionRevision?: number;
  entry: GitDiffEntry | null;
  file: GitDiffFile | null;
  loading: boolean;
  error: string | null;
  entries: GitDiffEntry[];
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  summaryLoading: boolean;
  loadingKeys?: string[];
  /**
   * The branch picked in Compare against (`other`, `origin/x`), when the
   * Branch scope shows one: its comments go to that base's review.
   */
  pickedBase?: string;
  /** What is shown, for the review's scope line: scope, base, repository. */
  scopeMode?: "working" | "branch-main" | "last-step";
  scopeBase?: string;
  repoName?: string;
  /** The repository shown, its branch, and the commits beyond the base. */
  root?: string;
  branch?: string;
  commits?: number;
  /** The working tree's untracked files. */
  untracked?: number;
  /** The Last step shown, as a review target. */
  step?: import("../types").LastStepTarget;
  /** Compare against: the branch picked ("": automatic) and the choices. */
  baseBranch?: string;
  baseBranches?: string[];
};

export type DiffSelectionMeta = {
  userInitiated?: boolean;
};

/** A file's reviewed chunks, as the tree shows them. */
export type ReviewProgress = {
  done: number;
  total: number;
  reviewed: boolean;
};

/** The working changes' groups, in the order the tree and the diff show. */
const STATUS_GROUPS: readonly { kind: GitDiffKind; label: string }[] = [
  { kind: "conflicted", label: "Conflicts" },
  { kind: "staged", label: "Staged" },
  { kind: "unstaged", label: "Changes" },
  { kind: "untracked", label: "Untracked" },
];

/**
 * The entries grouped by status, as `git status` does (the review in
 * Changes): each group keeps the tree's order.
 */
export function orderByStatus(entries: GitDiffEntry[]): GitDiffEntry[] {
  return STATUS_GROUPS.flatMap(({ kind }) =>
    treeOrderedDiffEntries(
      entries.filter((entry) => statusGroupOf(entry) === kind),
    ),
  ).concat(entries.filter((entry) => statusGroupOf(entry) === null));
}

/** The first status group an entry is listed in (a combined one's parts). */
function statusGroupOf(entry: GitDiffEntry): GitDiffKind | null {
  const kinds = (entry.parts ?? [entry]).map((part) => part.kind);
  return STATUS_GROUPS.find(({ kind }) => kinds.includes(kind))?.kind ?? null;
}

/** The working entries one combined diff per file stands for. */
const COMBINED_PART_KINDS: ReadonlySet<GitDiffKind> = new Set([
  "staged",
  "unstaged",
  "untracked",
]);

/** The status entries of a list, a combined entry's parts in its place. */
export function statusEntriesOf(entries: GitDiffEntry[]): GitDiffEntry[] {
  return entries.flatMap((entry) => entry.parts ?? [entry]);
}

/**
 * One entry per file for its staged, unstaged and untracked entries: its
 * combined diff against HEAD (kind "combined", the review in Changes),
 * which keeps the status entries as its `parts`. A conflict stays as is.
 */
export function combineWorkingEntries(entries: GitDiffEntry[]): GitDiffEntry[] {
  const partsByPath = new Map<string, GitDiffEntry[]>();
  const order: (GitDiffEntry | string)[] = [];
  for (const entry of entries) {
    if (!COMBINED_PART_KINDS.has(entry.kind)) {
      order.push(entry);
      continue;
    }
    const parts = partsByPath.get(entry.path);
    if (parts) parts.push(entry);
    else {
      partsByPath.set(entry.path, [entry]);
      order.push(entry.path);
    }
  }
  return order.map((each) => {
    if (typeof each !== "string") return each;
    const parts = partsByPath.get(each)!;
    const part = (kind: GitDiffKind) => parts.find((p) => p.kind === kind);
    const staged = part("staged");
    const working = part("untracked") ?? part("unstaged");
    const only = parts.length === 1 ? parts[0] : undefined;
    return {
      path: each,
      kind: "combined" as const,
      status: part("untracked")
        ? "untracked"
        : working?.status === "deleted"
          ? "deleted"
          : (staged?.status ?? working?.status ?? "modified"),
      ...(staged?.old_path || working?.old_path
        ? { old_path: staged?.old_path ?? working?.old_path }
        : {}),
      // Each part counts its own diff: the sum is not the combined one's.
      ...(only?.additions !== undefined ? { additions: only.additions } : {}),
      ...(only?.deletions !== undefined ? { deletions: only.deletions } : {}),
      ...(parts.some((p) => p.binary) ? { binary: true } : {}),
      ...(parts.some((p) => p.generated) ? { generated: true } : {}),
      ...((working ?? staged)?.file_size !== undefined
        ? { file_size: (working ?? staged)!.file_size }
        : {}),
      ...((working ?? staged)?.mtime_ms !== undefined
        ? { mtime_ms: (working ?? staged)!.mtime_ms }
        : {}),
      ...((working ?? staged)?.size !== undefined
        ? { size: (working ?? staged)!.size }
        : {}),
      parts,
    };
  });
}

const combinedSummaries = new WeakMap<GitDiffSummary, GitDiffSummary>();

/** A Working summary with one combined entry per file, the same each time. */
export function combineWorkingSummary(summary: GitDiffSummary): GitDiffSummary {
  let combined = combinedSummaries.get(summary);
  if (!combined) {
    combined = { ...summary, entries: combineWorkingEntries(summary.entries) };
    combinedSummaries.set(summary, combined);
  }
  return combined;
}

export type DiffViewerPanelHandle = {
  highlightEntry: (entry: GitDiffEntry | null) => void;
  loadNearbyEntries: (entries: GitDiffEntry[]) => void;
  selectEntry: (entry: GitDiffEntry) => void;
  selectWorkingEntry: (entry: GitDiffEntry) => void;
  selectWorkingEntries: (entries: GitDiffEntry[]) => void;
  /** The changes read again, as the Refresh button does. */
  refresh: () => void;
  /** The scope shown (the review toggle picks the review's). */
  showScope: (scope: "working" | "branch-main" | "last-step") => void;
  /** The branch the Branch scope compares against ("": automatic). */
  showBase: (branch: string) => void;
  /** The paths the diff's search (the review cursor's) has hits in. */
  markSearchMatches: (paths: readonly string[]) => void;
  /** The files' reviewed chunks (the review in Changes), for the tree. */
  markReviewProgress: (progress: ReadonlyMap<string, ReviewProgress>) => void;
  /**
   * The review's files with no change, listed in the tree's "Other
   * files" group under the changed files, with their tick.
   */
  markOtherFiles: (files: readonly OtherReviewFile[]) => void;
  /**
   * A git action on a file of the working changes, as its menu does it
   * (`:stage`, `gs`): confirmed when it destroys work. False, said, when
   * the action does not apply there.
   */
  runFileAction: (action: GitFileAction, path: string) => boolean;
};

/** A file of the review with no change, as the tree lists it. */
export type OtherReviewFile = {
  path: string;
  reviewed: boolean;
  /** Its open threads. */
  threads: number;
};

export type DiffViewerPanelProps = {
  ref?: Ref<DiffViewerPanelHandle>;
  /** One of the review's Other files picked in the tree. */
  onPickOtherFile?: (path: string) => void;
  /** The working changes in status groups (Staged, Changes, Untracked). */
  groupByStatus?: boolean;
  /**
   * Changes shows the review: every file's diff loads as it nears the
   * viewport, also on an SSH connection (upstream loads only the picked
   * file there).
   */
  review?: boolean;
  workspaceId?: string;
  resourceKey?: string;
  /** Another repository of the workspace than its own, shown instead. */
  repoRoot?: string;
  /** Drawn above the scope switch (the phone's scope line). */
  header?: ReactNode;
  onSelectionChange?: (
    selection: ActiveDiffSelection,
    meta?: DiffSelectionMeta,
  ) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
  /**
   * The review's view shown in Changes when it is not the scope's own
   * files (a commit of the commit bar, a range opened by name): listed
   * instead of the tree, a pick goes to that file.
   */
  viewFiles?: { label: string; entries: readonly GitDiffEntry[] } | null;
  onPickViewFile?: (path: string) => void;
  /** A scope picked (its switch, `:scope`, showScope). */
  onScopeChange?: (scope: "working" | "branch-main" | "last-step") => void;
};

type DiffCache = {
  /** The review's cache: bounded by the review's larger limits. */
  review?: boolean;
  summary: GitDiffSummary | null;
  selected: GitDiffEntry | null;
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  error: string | null;
};

type DiffScope = "working" | "branch-main" | "last-step";

const diffCache = new Map<string, DiffCache>();
const diffCacheRevisions = new Map<string, number>();
const diffPrefetches = new Map<string, Promise<void>>();
const diffFileRequests = new Map<string, Promise<GitDiffFile>>();
const DIFF_TREE_INDENT = 9;
const DIFF_TREE_BASE_INDENT = 6;
const diffLoadQueues = new Map<
  string,
  ReturnType<typeof createDiffLoadQueue>
>();

function diffLoadQueue(client: ConnectionClient) {
  const key = connectionClientScopeKey(client);
  let queue = diffLoadQueues.get(key);
  if (!queue) {
    queue = createDiffLoadQueue();
    diffLoadQueues.set(key, queue);
    if (diffLoadQueues.size > 8) {
      diffLoadQueues.delete(diffLoadQueues.keys().next().value!);
    }
  }
  return queue;
}

export function usesContinuousDiffReview(connectionId: string) {
  return (
    store.get().connections.find((item) => item.id === connectionId)?.type !==
    "ssh"
  );
}
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const MAX_CACHED_DIFF_FILES = 24;
const MAX_CACHED_DIFF_BYTES = 8 * 1024 * 1024;
// Enough for a whole review of a few hundred files: the review keeps every
// file it has loaded, as its cursor, folds and counts read them.
const MAX_REVIEW_CACHED_DIFF_FILES = 400;
const MAX_REVIEW_CACHED_DIFF_BYTES = 16 * 1024 * 1024;
/** Files the review loads past the nearby ones, in list order. */
export const DIFF_PREFETCH_AHEAD = 16;

/**
 * The entries after the last of `nearby` in `entries`' order: at least
 * `count`, to the end of a block of `count` (blocks start at 0), so that
 * scrolling a file further asks for nothing new until the next block, and
 * then for a whole block in one request.
 */
export function diffEntriesAhead(
  entries: readonly GitDiffEntry[],
  nearby: readonly GitDiffEntry[],
  count: number,
) {
  const keys = new Set(nearby.map(diffEntryKey));
  let last = -1;
  entries.forEach((entry, index) => {
    if (keys.has(diffEntryKey(entry))) last = index;
  });
  if (last < 0) return [];
  const end = (Math.floor((last + 1) / count) + 2) * count;
  return entries
    .slice(last + 1, end)
    .filter((entry) => !keys.has(diffEntryKey(entry)));
}
const MAX_DIFF_CACHE_CONTEXTS = 8;
const MAX_TOTAL_CACHED_DIFF_BYTES = 24 * 1024 * 1024;
const DIFF_SCOPE_KEY = "diffViewerScope";

export function comparisonBranchStorageKey(
  connectionId: string,
  resourceKey: string,
) {
  return connectionStorageKey(connectionId, `diffViewerBase:${resourceKey}`);
}

export function comparisonResourceKey(
  resourceKey: string | undefined,
  baseBranch: string,
) {
  return baseBranch
    ? JSON.stringify(["diff-comparison", resourceKey, baseBranch])
    : resourceKey;
}

/** A branch compared against, as it is named: `main`, `origin/main`. */
export const comparisonBranchLabel = refLabel;

function diffScopeStorageKey(connectionId: string, resourceKey?: string) {
  return connectionStorageKey(
    connectionId,
    resourceKey ? `${DIFF_SCOPE_KEY}:${resourceKey}` : DIFF_SCOPE_KEY,
  );
}

function loadDiffScope(
  connectionId = "legacy-default",
  resourceKey?: string,
): DiffScope {
  const scoped = roamgateLocalStorage.getItem(
    diffScopeStorageKey(connectionId, resourceKey),
  );
  const value =
    scoped ??
    (resourceKey
      ? roamgateLocalStorage.getItem(diffScopeStorageKey(connectionId))
      : null);
  if (value === "branch-main") return "branch-main";
  if (value === "last-step") return "last-step";
  return "working";
}

function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

function estimatedDiffBytes(file: GitDiffFile) {
  return file.diff.length * 2;
}

function diffCacheBytes(cache: DiffCache) {
  return Object.values(cache.files).reduce(
    (total, file) => total + estimatedDiffBytes(file),
    0,
  );
}

function pruneDiffCaches(activeKey: string) {
  const totalBytes = () =>
    Array.from(diffCache.values()).reduce(
      (total, cache) => total + diffCacheBytes(cache),
      0,
    );

  while (
    diffCache.size > MAX_DIFF_CACHE_CONTEXTS ||
    totalBytes() > MAX_TOTAL_CACHED_DIFF_BYTES
  ) {
    const oldestKey = Array.from(diffCache.keys()).find(
      (key) => key !== activeKey,
    );
    if (!oldestKey) return;
    advanceDiffCacheRevision(oldestKey);
    diffCache.delete(oldestKey);
  }
}

function setDiffCache(key: string, cache: DiffCache) {
  diffCache.delete(key);
  diffCache.set(key, cache);
  pruneDiffCaches(key);
}

function boundedDiffFiles(
  files: Record<string, GitDiffFile>,
  selected: GitDiffEntry | null,
  review = false,
) {
  const maxFiles = review
    ? MAX_REVIEW_CACHED_DIFF_FILES
    : MAX_CACHED_DIFF_FILES;
  const maxBytes = review
    ? MAX_REVIEW_CACHED_DIFF_BYTES
    : MAX_CACHED_DIFF_BYTES;
  const selectedKey = selected ? diffEntryKey(selected) : null;
  const keptNewestFirst: string[] = [];
  let cachedBytes = 0;

  if (selectedKey && files[selectedKey]) {
    keptNewestFirst.push(selectedKey);
    cachedBytes = estimatedDiffBytes(files[selectedKey]);
  }

  const keys = Object.keys(files);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (key === selectedKey) continue;
    if (keptNewestFirst.length >= maxFiles) break;
    const fileBytes = estimatedDiffBytes(files[key]);
    if (keptNewestFirst.length > 0 && cachedBytes + fileBytes > maxBytes) {
      continue;
    }
    keptNewestFirst.push(key);
    cachedBytes += fileBytes;
  }

  return Object.fromEntries(
    keptNewestFirst.reverse().map((key) => [key, files[key]]),
  );
}

export function beginDiffFileSelection(
  current: DiffCache,
  entry: GitDiffEntry,
) {
  const key = diffEntryKey(entry);
  const fileErrors = { ...current.fileErrors };
  delete fileErrors[key];
  return {
    ...current,
    selected: entry,
    files: boundedDiffFiles(current.files, entry, current.review),
    fileErrors,
    error: null,
  };
}

export function mergeResolvedDiffFile(
  current: DiffCache,
  entry: GitDiffEntry,
  file: GitDiffFile,
) {
  const key = diffEntryKey(entry);
  if (file.deferred && current.files[key] && !current.files[key].deferred)
    return current;
  const requestIsSelected =
    current.selected !== null && diffEntryKey(current.selected) === key;
  const selected = requestIsSelected ? entry : current.selected;
  return {
    ...current,
    selected,
    files: boundedDiffFiles(
      { ...current.files, [key]: file },
      selected,
      current.review,
    ),
    fileErrors: Object.fromEntries(
      Object.entries(current.fileErrors).filter(
        ([errorKey]) => errorKey !== key,
      ),
    ),
    error: requestIsSelected ? null : current.error,
  };
}

export function buildActiveDiffSelection(
  source: DiffCache,
  patch: Partial<ActiveDiffSelection>,
  fileLoadingKey: string | null,
  summaryLoading: boolean,
): ActiveDiffSelection {
  const selected = patch.entry === undefined ? source.selected : patch.entry;
  const files = patch.files === undefined ? source.files : patch.files;
  const key = selected ? diffEntryKey(selected) : "";
  return {
    entry: selected,
    file:
      patch.file === undefined
        ? key
          ? (files[key] ?? null)
          : null
        : patch.file,
    loading:
      patch.loading ??
      (summaryLoading || (!!key && fileLoadingKey === key && !files[key])),
    error: patch.error === undefined ? source.error : patch.error,
    entries:
      patch.entries === undefined
        ? treeOrderedDiffEntries(source.summary?.entries ?? [])
        : patch.entries,
    files,
    fileErrors:
      patch.fileErrors === undefined ? source.fileErrors : patch.fileErrors,
    summaryLoading:
      patch.summaryLoading === undefined
        ? summaryLoading
        : patch.summaryLoading,
  };
}

export function diffCacheKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "diff",
    resourceKey ?? "focused",
    scope,
  );
}

export function diffRuntimeContextKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "diff-runtime",
    resourceKey ?? "focused",
    workspaceId ?? "missing",
    scope,
  );
}

function diffCacheRevision(key: string): number {
  return diffCacheRevisions.get(key) ?? 0;
}

function advanceDiffCacheRevision(key: string): number {
  const next = diffCacheRevision(key) + 1;
  diffCacheRevisions.set(key, next);
  return next;
}

function retireDiffCache(key: string) {
  advanceDiffCacheRevision(key);
  diffCache.delete(key);
}

function diffFileRequestKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  revision: number,
  snapshotId?: string,
  automatic = false,
  baseBranch?: string,
) {
  return connectionClientScopeKey(
    client,
    "diff-file",
    workspaceId,
    scope,
    diffEntryKey(entry),
    revision,
    snapshotId ?? "live",
    automatic,
    baseBranch,
  );
}

export function diffSelectionStorageKey(
  connectionId: string,
  workspaceId: string,
  scope: DiffScope,
) {
  return connectionStorageKey(
    connectionId,
    `diffViewerSelected:${workspaceId}:${scope}`,
  );
}

function readStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
): GitDiffEntry | null {
  if (!workspaceId) return null;
  try {
    const raw = roamgateLocalStorage.getItem(
      diffSelectionStorageKey(connectionId, workspaceId, scope),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<GitDiffEntry>;
    if (
      typeof value.path === "string" &&
      [
        "staged",
        "unstaged",
        "untracked",
        "conflicted",
        "branch",
        "last-step",
      ].includes(value.kind ?? "") &&
      typeof value.status === "string"
    ) {
      return value as GitDiffEntry;
    }
  } catch {
    // Ignore invalid persisted UI state.
  }
  return null;
}

function writeStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
  entry: GitDiffEntry,
) {
  if (!workspaceId) return;
  roamgateLocalStorage.setItem(
    diffSelectionStorageKey(connectionId, workspaceId, scope),
    JSON.stringify(entry),
  );
}

export function clearDiffViewerResourceCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  resourceKey: string,
  storage: Pick<Storage, "removeItem"> = roamgateLocalStorage,
) {
  for (const scope of ["working", "branch-main", "last-step"] as const) {
    retireDiffCache(diffCacheKey(client, undefined, scope, resourceKey));
    storage.removeItem(
      diffSelectionStorageKey(client.connectionId, resourceKey, scope),
    );
  }
  for (const key of diffCache.keys()) {
    try {
      const parts = JSON.parse(key) as unknown[];
      if (
        parts[0] !== client.connectionId ||
        parts[1] !== client.generation ||
        typeof parts[3] !== "string"
      )
        continue;
      const resource = JSON.parse(parts[3]) as unknown[];
      if (resource[0] === "diff-comparison" && resource[1] === resourceKey)
        retireDiffCache(key);
    } catch {
      /* Ordinary resource keys are not JSON. */
    }
  }
  retireGitDiffSummaryResource(client, resourceKey);
  storage.removeItem(
    comparisonBranchStorageKey(client.connectionId, resourceKey),
  );
  storage.removeItem(diffScopeStorageKey(client.connectionId, resourceKey));
  diffPrefetches.delete(
    connectionClientScopeKey(client, "diff-prefetch", resourceKey),
  );
}

function emptyDiffCache(): DiffCache {
  return {
    summary: null,
    selected: null,
    files: {},
    fileErrors: {},
    error: null,
  };
}

function readDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const cached = diffCache.get(key);
  if (cached) {
    diffCache.delete(key);
    diffCache.set(key, cached);
    return {
      ...cached,
      files: { ...cached.files },
      fileErrors: { ...cached.fileErrors },
    };
  }
  const next = emptyDiffCache();
  setDiffCache(key, next);
  return {
    ...next,
    files: { ...next.files },
    fileErrors: { ...next.fileErrors },
  };
}

function writeDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  patch: Partial<DiffCache>,
  resourceKey = workspaceId,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const current = diffCache.get(key) ?? emptyDiffCache();
  const selected =
    patch.selected === undefined ? current.selected : patch.selected;
  setDiffCache(key, {
    ...current,
    ...patch,
    selected,
    files: boundedDiffFiles(
      patch.files ?? current.files,
      selected,
      patch.review ?? current.review,
    ),
    fileErrors: patch.fileErrors
      ? { ...patch.fileErrors }
      : { ...current.fileErrors },
  });
}

function resolveSelectedEntry(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  preferred?: GitDiffEntry | null,
  resourceKey = workspaceId,
) {
  const stored = readStoredSelection(client.connectionId, resourceKey, scope);
  const candidates = [preferred, stored].filter(Boolean) as GitDiffEntry[];
  for (const candidate of candidates) {
    const match = entries.find(
      (entry) => diffEntryKey(entry) === diffEntryKey(candidate),
    );
    if (match) return match;
  }
  return (
    entries.find((entry) => diffAutoCollapseInfo(entry) === null) ??
    entries[0] ??
    null
  );
}

function requestDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  revision: number,
  snapshotId?: string,
  wanted: () => boolean = () => true,
  priority = true,
  automatic = false,
  baseBranch?: string,
  /** Another repository of the workspace than its own. */
  root?: string,
  /** Files asked together go as one git.diff_files request (the review). */
  batched = false,
) {
  if (!client.isCurrent()) {
    return Promise.reject(new Error("connection changed during diff request"));
  }
  if (scope === "last-step" && !snapshotId) {
    return Promise.reject(
      new Error("last-step diff requires a fresh summary snapshot"),
    );
  }
  const requestKey = diffFileRequestKey(
    client,
    root ? `${workspaceId}\n${root}` : workspaceId,
    scope,
    entry,
    revision,
    snapshotId,
    automatic,
    baseBranch,
  );
  const running = diffFileRequests.get(requestKey);
  if (running) {
    if (priority) diffLoadQueue(client).prioritize(requestKey);
    return running;
  }
  const params = {
    workspace_id: workspaceId,
    mode: scope,
    snapshot_id: snapshotId,
    automatic,
    ...(scope === "branch-main" && baseBranch
      ? { base_branch: baseBranch }
      : {}),
    ...(root ? { root } : {}),
  };
  const item = { path: entry.path, old_path: entry.old_path, kind: entry.kind };
  // Files asked together go in one request (one SSH round trip on a remote
  // checkout), several of them at once.
  const queue = diffLoadQueue(client);
  const wantedNow = () => client.isCurrent() && wanted();
  const task = batched
    ? queue.requestBatched<GitDiffFile>(
        {
          key: JSON.stringify([
            workspaceId,
            root ?? "",
            scope,
            snapshotId ?? "",
            automatic,
            params.base_branch ?? "",
          ]),
          item,
          run: async (items) => {
            if (items.length === 1)
              return [
                (await client.call("git.diff_file", {
                  ...params,
                  ...(items[0] as typeof item),
                })) as GitDiffFile,
              ];
            const read = (await client.call("git.diff_files", {
              ...params,
              entries: items,
            })) as { files?: Array<GitDiffFile | { error: string }> };
            return items.map((_, index) => {
              const file = read.files?.[index];
              if (!file) return new Error("git.diff_files answered no file");
              return "error" in file ? new Error(file.error) : file;
            });
          },
        },
        wantedNow,
        priority,
        requestKey,
      )
    : queue.request(
        () =>
          client.call("git.diff_file", {
            ...params,
            ...item,
          }) as Promise<GitDiffFile>,
        wantedNow,
        priority,
        requestKey,
      );
  diffFileRequests.set(
    requestKey,
    task
      .then((file) => {
        if (!client.isCurrent()) {
          throw new Error("connection changed during diff request");
        }
        return file;
      })
      .finally(() => {
        diffFileRequests.delete(requestKey);
      }),
  );
  return diffFileRequests.get(requestKey)!;
}

function cacheDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  file: GitDiffFile,
  resourceKey: string,
  revision: number,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
  const cached = readDiffCache(client, workspaceId, scope, resourceKey);
  writeDiffCache(
    client,
    workspaceId,
    scope,
    mergeResolvedDiffFile(cached, entry, file),
    resourceKey,
  );
}

export function prefetchDiffFilesInBatches(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  resourceKey = workspaceId,
  onFile?: (entry: GitDiffEntry, file: GitDiffFile, revision: number) => void,
  onFileError?: (entry: GitDiffEntry, error: string, revision: number) => void,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const revision = diffCacheRevision(key);
  const cached = readDiffCache(client, workspaceId, scope, resourceKey);
  const snapshotId = cached.summary?.snapshot_id;
  const queue = entries.filter((entry) => !cached.files[diffEntryKey(entry)]);
  if (!queue.length) return Promise.resolve();

  return Promise.all(
    queue.map(async (entry) => {
      try {
        const file = await requestDiffFile(
          client,
          workspaceId,
          scope,
          entry,
          revision,
          snapshotId,
          () => diffCacheRevision(key) === revision,
          false,
          true,
          cached.summary?.base,
          repoRootOf(resourceKey),
        );
        if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
        cacheDiffFile(
          client,
          workspaceId,
          scope,
          entry,
          file,
          resourceKey,
          revision,
        );
        onFile?.(entry, file, revision);
      } catch (e) {
        if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
        onFileError?.(entry, (e as Error).message, revision);
      }
    }),
  ).then(() => undefined);
}

function diffStatsForEntries(entries: GitDiffEntry[]) {
  return entries.reduce(
    (total, entry) => ({
      additions: total.additions + (entry.additions ?? 0),
      deletions: total.deletions + (entry.deletions ?? 0),
      hasStats:
        total.hasStats ||
        typeof entry.additions === "number" ||
        typeof entry.deletions === "number",
    }),
    { additions: 0, deletions: 0, hasStats: false },
  );
}

type DiffTreeNode = {
  name: string;
  path: string;
  children: Map<string, DiffTreeNode>;
  entries: GitDiffEntry[];
};

function makeTreeNode(name: string, path: string): DiffTreeNode {
  return { name, path, children: new Map(), entries: [] };
}

/** Every summary entry under a tree node, so folder menus can act on the
 *  whole directory. */
function collectTreeEntries(node: DiffTreeNode): GitDiffEntry[] {
  const entries = [...node.entries];
  for (const child of node.children.values()) {
    entries.push(...collectTreeEntries(child));
  }
  return entries;
}

function buildDiffTree(entries: GitDiffEntry[]) {
  const root = makeTreeNode("", "");
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = makeTreeNode(part, path);
        node.children.set(part, child);
      }
      node = child;
    });
    node.entries.push(entry);
  }
  return root;
}

function sortDiffTreeChildren(children: Iterable<DiffTreeNode>) {
  return [...children].sort((a, b) => {
    const aFile = a.entries.length > 0;
    const bFile = b.entries.length > 0;
    if (aFile !== bFile) return aFile ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function treeOrderedDiffEntries(entries: GitDiffEntry[]) {
  const ordered: GitDiffEntry[] = [];
  const visit = (node: DiffTreeNode) => {
    for (const child of sortDiffTreeChildren(node.children.values())) {
      if (child.entries.length) {
        ordered.push(...child.entries);
      } else {
        visit(child);
      }
    }
  };
  visit(buildDiffTree(entries));
  return ordered;
}

export function expandedDirsForSelection(entry: GitDiffEntry | null) {
  return expandedDirsForEntries(entry ? [entry] : []);
}

export function expandedDirsForEntries(entries: GitDiffEntry[]) {
  const expanded = new Set<string>([""]);
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      expanded.add(parts.slice(0, index).join("/"));
    }
  }
  return expanded;
}

export function prefetchDiffViewerWorkspace(
  workspaceId: string | undefined,
  client: ConnectionClient,
  resourceKey = workspaceId,
) {
  if (!workspaceId || !client.isCurrent()) return Promise.resolve();
  const prefetchKey = connectionClientScopeKey(
    client,
    "diff-prefetch",
    resourceKey,
  );
  const running = diffPrefetches.get(prefetchKey);
  if (running) return running;

  const task = (async () => {
    const scope: DiffScope = "working";
    const cacheKey = diffCacheKey(client, workspaceId, scope, resourceKey);
    let revision = diffCacheRevision(cacheKey);
    const cached = readDiffCache(client, workspaceId, scope, resourceKey);
    // As Changes shows Working (one combined entry per file): a warmup in
    // the status entries' keys drew each file anew once the panel combined
    // them, an open comment box with it.
    const summary = combineWorkingSummary(
      await refreshGitDiffSummary(client, workspaceId, scope, resourceKey),
    );
    if (!client.isCurrent() || diffCacheRevision(cacheKey) !== revision) return;
    const selected = resolveSelectedEntry(
      client,
      workspaceId,
      scope,
      summary.entries,
      cached.selected,
      resourceKey,
    );
    const files: Record<string, GitDiffFile> = {};

    // A warmup publishes a fresh summary. Retire any batch that was still
    // loading files from the previously cached snapshot before replacing it.
    revision = advanceDiffCacheRevision(cacheKey);
    writeDiffCache(
      client,
      workspaceId,
      scope,
      {
        summary,
        selected,
        files,
        error: null,
      },
      resourceKey,
    );

    if (
      !selected ||
      !usesContinuousDiffReview(client.connectionId) ||
      diffAutoCollapseInfo(selected)
    )
      return;
    const key = diffEntryKey(selected);
    if (files[key]) return;
    const file = await requestDiffFile(
      client,
      workspaceId,
      scope,
      selected,
      revision,
      undefined,
      () => diffCacheRevision(cacheKey) === revision,
      true,
      true,
    );
    if (!client.isCurrent() || diffCacheRevision(cacheKey) !== revision) return;
    writeDiffCache(
      client,
      workspaceId,
      scope,
      {
        summary,
        selected,
        files: { ...files, [key]: file },
        error: null,
      },
      resourceKey,
    );
  })()
    .catch(() => {
      // Background warmups should never surface transient bridge errors.
    })
    .finally(() => {
      if (diffPrefetches.get(prefetchKey) === task) {
        diffPrefetches.delete(prefetchKey);
      }
    });

  diffPrefetches.set(prefetchKey, task);
  return task;
}

type DiffContextMenuState = {
  x: number;
  y: number;
  path: string;
  entries: GitDiffEntry[];
  directory?: boolean;
};

type DiffConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void;
};

export function DiffViewerPanel({
  groupByStatus = false,
  review = false,
  workspaceId,
  resourceKey,
  repoRoot,
  header,
  onSelectionChange,
  onOpenFile,
  onPickOtherFile,
  viewFiles = null,
  onPickViewFile,
  onScopeChange,
  ref,
}: DiffViewerPanelProps) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useLiveConnectionClient();
  const canReveal = useCanRevealInFileManager();
  const continuousReview =
    useStoreSelector(
      (state) =>
        state.connections.find(
          (item) => item.id === connectionClient.connectionId,
        )?.type !== "ssh",
    ) || review;
  const focusedWorkspace = workspaces.find((w) => w.focused);
  const workspace = workspaceId
    ? workspaces.find((w) => w.workspace_id === workspaceId)
    : focusedWorkspace;
  const cacheWorkspaceId = workspace?.workspace_id;
  const repositoryResourceKey = repoResourceKey(
    resourceKey ?? cacheWorkspaceId,
    repoRoot,
  );
  const preferenceKey = connectionStorageKey(
    connectionClient.connectionId,
    repositoryResourceKey ?? "focused",
  );
  const [scopePreference, setScopePreference] = useState<{
    key: string;
    value: DiffScope;
    /** Shown in place of the scope remembered, which stays remembered. */
    instead?: true;
  } | null>(null);
  const diffScope =
    scopePreference?.key === preferenceKey
      ? scopePreference.value
      : loadDiffScope(connectionClient.connectionId, repositoryResourceKey);
  const scopeChangeRef = useRef(onScopeChange);
  scopeChangeRef.current = onScopeChange;
  /**
   * The review's Working scope remembered and shown again (a reload, the
   * pane brought back) with nothing uncommitted: the branch's review shown
   * instead when it has changes, Working staying the scope remembered.
   * Settled by the first summaries read, or a scope picked.
   */
  const cleanWorking = useRef<{
    key: string;
    phase: "working" | "branch" | "done";
    /** A summary read since: one kept from before is not taken. */
    read: boolean;
    revision: number;
  } | null>(null);
  const setDiffScope = useCallback(
    (value: DiffScope) => {
      if (cleanWorking.current) cleanWorking.current.phase = "done";
      setScopePreference({ key: preferenceKey, value });
      scopeChangeRef.current?.(value);
    },
    [preferenceKey],
  );
  const [basePreference, setBasePreference] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const baseBranch =
    basePreference?.key === preferenceKey
      ? basePreference.value
      : repositoryResourceKey
        ? (roamgateLocalStorage.getItem(
            comparisonBranchStorageKey(
              connectionClient.connectionId,
              repositoryResourceKey,
            ),
          ) ?? "")
        : "";
  const cacheResourceKey =
    diffScope === "branch-main"
      ? comparisonResourceKey(repositoryResourceKey, baseBranch)
      : repositoryResourceKey;
  const setBaseBranchRef = useRef<(value: string) => void>(() => {});
  const setBaseBranch = (value: string) => {
    if (repositoryResourceKey)
      roamgateLocalStorage.setItem(
        comparisonBranchStorageKey(
          connectionClient.connectionId,
          repositoryResourceKey,
        ),
        value,
      );
    setBasePreference({ key: preferenceKey, value });
  };
  setBaseBranchRef.current = setBaseBranch;
  const completionKey = lastStepCompletionKey(
    connectionClient.connectionId,
    cacheWorkspaceId,
  );
  const subscribeToCompletion = useCallback(
    (listener: () => void) =>
      subscribeLastStepCompletion(completionKey, listener),
    [completionKey],
  );
  const readCompletion = useCallback(
    () => readLastStepCompletion(completionKey),
    [completionKey],
  );
  const completionRevision = useSyncExternalStore(
    subscribeToCompletion,
    readCompletion,
    readCompletion,
  );
  const completionRevisionRef = useRef({
    key: completionKey,
    revision: completionRevision,
  });
  const sharedSummaryState = useGitDiffSummaryState(
    connectionClient,
    cacheWorkspaceId,
    diffScope,
    repositoryResourceKey,
    baseBranch || undefined,
  );
  if (cleanWorking.current?.key !== preferenceKey)
    cleanWorking.current = {
      key: preferenceKey,
      phase:
        review &&
        diffScope === "working" &&
        scopePreference?.key !== preferenceKey
          ? "working"
          : "done",
      read: sharedSummaryState.loading,
      revision: sharedSummaryState.revision,
    };
  useEffect(() => {
    const check = cleanWorking.current;
    if (!check || check.key !== preferenceKey || check.phase === "done") return;
    const { summary, loading, error, revision } = sharedSummaryState;
    if (check.phase === "working") {
      if (diffScope !== "working") {
        check.phase = "done";
        return;
      }
      // Read now, not a summary kept from before (the tree may have changed).
      if (loading || revision > check.revision) check.read = true;
      if (loading || error || !summary || !check.read) return;
      if (summary.entries.length) {
        check.phase = "done";
        return;
      }
      check.phase = "branch";
      setScopePreference({
        key: preferenceKey,
        value: "branch-main",
        instead: true,
      });
      return;
    }
    if (diffScope !== "branch-main") {
      check.phase = "done";
      return;
    }
    if (loading || (!summary && !error)) return;
    check.phase = "done";
    // Nothing on the branch either: Working, as remembered.
    if (!summary?.entries.length) setScopePreference(null);
  }, [diffScope, preferenceKey, sharedSummaryState]);
  /**
   * The review in Changes reads the working changes as one combined diff
   * per file: the summary its diff and selection use. The tree keeps
   * the status entries (each combined entry's parts).
   */
  const combineWorking = groupByStatus && diffScope === "working";
  const shownSummary = useMemo(
    () =>
      combineWorking && sharedSummaryState.summary
        ? combineWorkingSummary(sharedSummaryState.summary)
        : sharedSummaryState.summary,
    [combineWorking, sharedSummaryState.summary],
  );
  const [cache, setCache] = useState<DiffCache>(() =>
    readDiffCache(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
      cacheResourceKey,
    ),
  );
  const summaryLoading = sharedSummaryState.loading;
  const [fileLoadingKey, setFileLoadingKey] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set([""]),
  );
  const [visibleEntryKey, setVisibleEntryKey] = useState<string | null>(null);
  const [searchMatches, setSearchMatches] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [reviewProgress, setReviewProgress] = useState<
    ReadonlyMap<string, ReviewProgress>
  >(() => new Map());
  const [foldedGroups, setFoldedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [otherFiles, setOtherFiles] = useState<readonly OtherReviewFile[]>(
    () => [],
  );
  const treeRef = useRef<HTMLDivElement>(null);
  const runtimeContextKey = diffRuntimeContextKey(
    connectionClient,
    cacheWorkspaceId,
    diffScope,
    cacheResourceKey,
  );
  const activeContextRef = useRef(runtimeContextKey);
  const previousFilesRef = useRef({
    context: runtimeContextKey,
    summary: cache.summary,
    files: {} as Record<string, GitDiffFile>,
  });
  const selectionRevisionRef = useRef(0);
  const nearbyEntryKeysRef = useRef(new Set<string>());
  const answeredKeysRef = useRef(new Set<string>());
  const explicitEntryKeysRef = useRef(new Set<string>());
  const pendingFileKeysRef = useRef(new Map<string, number>());
  const [loadingKeys, setLoadingKeys] = useState<string[]>([]);
  const selectedEntryKeyRef = useRef(
    cache.selected ? diffEntryKey(cache.selected) : "",
  );
  const selectedBatchEntryKeysRef = useRef(new Set<string>());
  const pendingWorkingEntriesRef = useRef<GitDiffEntry[]>([]);
  const preferredSummarySelectionRef = useRef<GitDiffEntry | null>(null);
  const diffScopeRef = useRef(diffScope);
  diffScopeRef.current = diffScope;
  const onSelectionChangeRef = useRef(onSelectionChange);
  const [contextMenu, setContextMenu] = useState<DiffContextMenuState | null>(
    null,
  );
  const [confirmState, setConfirmState] = useState<DiffConfirmState | null>(
    null,
  );
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef(false);

  useLayoutEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useLayoutEffect(() => {
    activeContextRef.current = runtimeContextKey;
    setVisibleEntryKey(null);
    if (previousFilesRef.current.context !== runtimeContextKey)
      previousFilesRef.current.files = {};
  }, [runtimeContextKey]);

  const isCurrentContext = (
    workspaceId: string | undefined,
    scope: DiffScope,
  ) =>
    connectionClient.isCurrent() &&
    activeContextRef.current ===
      diffRuntimeContextKey(
        connectionClient,
        workspaceId,
        scope,
        cacheResourceKey,
      );

  const updateCache = (patch: Partial<DiffCache>) => {
    setCache((current) => {
      const selected =
        patch.selected === undefined ? current.selected : patch.selected;
      const next = {
        ...current,
        ...patch,
        selected,
        files: boundedDiffFiles(patch.files ?? current.files, selected, review),
        fileErrors: patch.fileErrors
          ? { ...patch.fileErrors }
          : { ...current.fileErrors },
      };
      writeDiffCache(
        connectionClient,
        cacheWorkspaceId,
        diffScope,
        next,
        cacheResourceKey,
      );
      return next;
    });
  };

  useEffect(() => {
    const summary = shownSummary;
    if (
      !workspace?.workspace_id ||
      !summary ||
      cache.summary === summary ||
      !isCurrentContext(workspace.workspace_id, diffScope)
    ) {
      return;
    }
    const preferred = preferredSummarySelectionRef.current ?? cache.selected;
    const selected = resolveSelectedEntry(
      connectionClient,
      workspace.workspace_id,
      diffScope,
      summary.entries,
      // A status entry stands for its file's combined one, and back.
      preferred &&
        (summary.entries.find(
          (entry) =>
            entry.path === preferred.path &&
            (entry.kind === preferred.kind ||
              (entry.kind === "combined" &&
                COMBINED_PART_KINDS.has(preferred.kind)) ||
              (preferred.kind === "combined" &&
                COMBINED_PART_KINDS.has(entry.kind))),
        ) ??
          preferred),
      cacheResourceKey,
    );
    preferredSummarySelectionRef.current = null;
    advanceDiffCacheRevision(
      diffCacheKey(
        connectionClient,
        workspace.workspace_id,
        diffScope,
        cacheResourceKey,
      ),
    );
    selectedEntryKeyRef.current = selected ? diffEntryKey(selected) : "";
    setVisibleEntryKey((current) =>
      summary.entries.some((entry) => diffEntryKey(entry) === current)
        ? current
        : null,
    );
    pendingFileKeysRef.current = new Map();
    setLoadingKeys([]);
    if (previousFilesRef.current.context === runtimeContextKey) {
      previousFilesRef.current.summary = summary;
      previousFilesRef.current.files =
        cache.summary?.base === summary.base
          ? boundedDiffFiles(
              { ...previousFilesRef.current.files, ...cache.files },
              selected,
              review,
            )
          : {};
    }
    updateCache({
      summary,
      selected,
      files: {},
      fileErrors: {},
      error: null,
    });
    setExpandedDirs(expandedDirsForEntries(summary.entries));
    const pendingEntries = pendingWorkingEntriesRef.current;
    // Switching to Working, the summary kept from before is read anew at
    // once: the entries asked for wait for that one.
    if (
      diffScope === "working" &&
      pendingEntries.length &&
      previousFilesRef.current.context === runtimeContextKey
    ) {
      pendingWorkingEntriesRef.current = [];
      const currentEntries = pendingEntries.flatMap((target) => {
        const match = summary.entries.find(
          (entry) =>
            entry.path === target.path &&
            ((entry.kind === target.kind && entry.status === target.status) ||
              (entry.kind === "combined" &&
                !!entry.parts?.some((part) => part.kind === target.kind))),
        );
        return match ? [match] : [];
      });
      for (const target of currentEntries) {
        void loadFileRef.current(target, { userInitiated: true });
      }
    }
    // The shared snapshot is the synchronization boundary; cache adoption is
    // intentionally driven only when that immutable snapshot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSummary]);

  const diffSelection = useCallback(
    (
      source: DiffCache = cache,
      patch: Partial<ActiveDiffSelection> = {},
    ): ActiveDiffSelection => {
      if (previousFilesRef.current.context !== runtimeContextKey)
        return {
          ...buildActiveDiffSelection(
            emptyDiffCache(),
            {},
            null,
            summaryLoading,
          ),
          selectionRevision: selectionRevisionRef.current,
          loadingKeys: [],
        };
      const fileErrors = patch.fileErrors ?? source.fileErrors;
      const freshFiles = patch.files ?? source.files;
      const selected =
        patch.entry === undefined ? source.selected : patch.entry;
      const entryKeys = new Set(
        (source.summary?.entries ?? (selected ? [selected] : [])).map(
          diffEntryKey,
        ),
      );
      const files = boundedDiffFiles(
        Object.fromEntries(
          [
            ...Object.entries(previousFilesRef.current.files).filter(
              ([key]) => !freshFiles[key],
            ),
            ...Object.entries(freshFiles),
          ].filter(([key]) => entryKeys.has(key) && !fileErrors[key]),
        ),
        selected,
        review,
      );
      if (source.summary === previousFilesRef.current.summary)
        previousFilesRef.current.files = Object.fromEntries(
          Object.entries(files).filter(([key]) => !freshFiles[key]),
        );
      return {
        ...buildActiveDiffSelection(
          { ...source, files },
          { ...patch, files },
          fileLoadingKey,
          summaryLoading,
        ),
        selectionRevision: selectionRevisionRef.current,
        loadingKeys,
        ...(diffScope === "branch-main" && baseBranch
          ? { pickedBase: comparisonBranchLabel(baseBranch) }
          : {}),
        scopeMode: diffScope,
        ...(diffScope === "branch-main" && (baseBranch || source.summary?.base)
          ? {
              scopeBase: comparisonBranchLabel(
                baseBranch || source.summary?.base || "",
              ),
            }
          : {}),
        ...(source.summary?.repo_name
          ? { repoName: source.summary.repo_name }
          : {}),
        ...(source.summary
          ? {
              root: source.summary.root,
              untracked: source.summary.counts?.untracked ?? 0,
              baseBranches: source.summary.base_branches ?? [],
              ...(source.summary.branch
                ? { branch: source.summary.branch }
                : {}),
              ...(diffScope === "last-step" && source.summary.step
                ? { step: source.summary.step }
                : {}),
              ...(source.summary.commits !== undefined
                ? { commits: source.summary.commits }
                : {}),
            }
          : {}),
        baseBranch,
      };
    },
    [
      baseBranch,
      cache,
      diffScope,
      fileLoadingKey,
      loadingKeys,
      review,
      runtimeContextKey,
      summaryLoading,
    ],
  );

  useEffect(() => {
    onSelectionChangeRef.current?.(diffSelection(cache));
  }, [cache, diffSelection]);

  const loadSummary = async (
    previousSelected = cache.selected,
    afterCurrent = false,
    clearCurrent = false,
  ) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    preferredSummarySelectionRef.current = previousSelected;
    advanceDiffCacheRevision(
      diffCacheKey(connectionClient, workspaceId, scope, cacheResourceKey),
    );
    pendingFileKeysRef.current = new Map();
    setLoadingKeys([]);
    setFileLoadingKey(null);
    if (clearCurrent) previousFilesRef.current.files = {};
    updateCache(
      clearCurrent
        ? {
            summary: null,
            selected: null,
            files: {},
            fileErrors: {},
            error: null,
          }
        : { error: null },
    );
    try {
      await refreshGitDiffSummary(
        connectionClient,
        workspaceId,
        scope,
        repositoryResourceKey,
        { afterCurrent, baseBranch: baseBranch || undefined },
      );
    } catch (e) {
      if (isCurrentContext(workspaceId, scope)) {
        updateCache({ error: (e as Error).message });
      }
    }
  };

  useEffect(() => {
    const previous = completionRevisionRef.current;
    completionRevisionRef.current = {
      key: completionKey,
      revision: completionRevision,
    };
    if (
      !cacheWorkspaceId ||
      previous.key !== completionKey ||
      previous.revision === completionRevision
    ) {
      return;
    }

    if (diffScopeRef.current === "last-step") {
      retireGitDiffSummary(
        connectionClient,
        cacheWorkspaceId,
        "last-step",
        repositoryResourceKey,
      );
      void loadSummary(cache.selected, false, true);
      return;
    }
    retireDiffCache(
      diffCacheKey(
        connectionClient,
        cacheWorkspaceId,
        "last-step",
        repositoryResourceKey,
      ),
    );
    retireGitDiffSummary(
      connectionClient,
      cacheWorkspaceId,
      "last-step",
      repositoryResourceKey,
    );
    // Completion notifications are not debounced with pane-list refreshes, so
    // rapid quiet-to-active edges cannot leave the prior step cached forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheWorkspaceId, completionKey, completionRevision]);

  const loadFile = async (
    asked: GitDiffEntry,
    meta: DiffSelectionMeta = {},
    select = true,
  ) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    // A status entry (a tree row, a goTo) shows its file's combined diff.
    const entry =
      cache.summary?.entries.find(
        (each) =>
          each.kind === "combined" &&
          each.path === asked.path &&
          COMBINED_PART_KINDS.has(asked.kind),
      ) ?? asked;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    const key = diffEntryKey(entry);
    const cacheKey = diffCacheKey(
      connectionClient,
      workspaceId,
      scope,
      cacheResourceKey,
    );
    const revision = diffCacheRevision(cacheKey);
    if (meta.userInitiated) {
      selectionRevisionRef.current += 1;
      explicitEntryKeysRef.current.add(key);
    }
    const wanted = () =>
      isCurrentContext(workspaceId, scope) &&
      diffCacheRevision(cacheKey) === revision &&
      (selectedEntryKeyRef.current === key ||
        nearbyEntryKeysRef.current.has(key) ||
        selectedBatchEntryKeysRef.current.has(key));
    // The review's answers, until the next render shows them in `cache`.
    const answered = `${cacheKey}\n${revision}\n${key}`;
    if (
      !select &&
      (pendingFileKeysRef.current.has(key) ||
        cache.files[key] ||
        cache.fileErrors[key] ||
        answeredKeysRef.current.has(answered))
    )
      return;
    const automatic =
      !meta.userInitiated && !explicitEntryKeysRef.current.has(key);
    if (select) {
      if (meta.userInitiated) setVisibleEntryKey(null);
      selectedEntryKeyRef.current = key;
      setCache((current) => {
        const next = beginDiffFileSelection({ ...current, review }, entry);
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      const immediateFileErrors = { ...cache.fileErrors };
      delete immediateFileErrors[key];
      writeStoredSelection(
        connectionClient.connectionId,
        cacheResourceKey,
        scope,
        entry,
      );
      const cachedFile = cache.files[key];
      if (cachedFile && !cachedFile.deferred) {
        setFileLoadingKey(null);
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file: cachedFile,
            fileErrors: immediateFileErrors,
            error: null,
          }),
          meta,
        );
        return;
      }
      setFileLoadingKey(key);
      onSelectionChangeRef.current?.(
        diffSelection(cache, {
          entry,
          file: null,
          loading: true,
          error: null,
          fileErrors: immediateFileErrors,
        }),
        meta,
      );
    }
    pendingFileKeysRef.current.set(
      key,
      (pendingFileKeysRef.current.get(key) ?? 0) + 1,
    );
    setLoadingKeys(Array.from(pendingFileKeysRef.current.keys()));
    try {
      const file = await requestDiffFile(
        connectionClient,
        workspaceId,
        scope,
        entry,
        revision,
        cache.summary?.snapshot_id,
        wanted,
        select,
        automatic,
        cache.summary?.base,
        repoRootOf(repositoryResourceKey),
        review,
      );
      if (
        !isCurrentContext(workspaceId, scope) ||
        diffCacheRevision(cacheKey) !== revision
      ) {
        return;
      }
      if (review) answeredKeysRef.current.add(answered);
      setCache((current) => {
        if (diffCacheRevision(cacheKey) !== revision) return current;
        const next = mergeResolvedDiffFile({ ...current, review }, entry, file);
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      if (
        select &&
        selectedEntryKeyRef.current === key &&
        !(file.deferred && explicitEntryKeysRef.current.has(key))
      ) {
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file,
            files: boundedDiffFiles(
              { ...cache.files, [key]: file },
              entry,
              review,
            ),
            fileErrors: Object.fromEntries(
              Object.entries(cache.fileErrors).filter(
                ([errorKey]) => errorKey !== key,
              ),
            ),
            loading: false,
            error: null,
          }),
          meta,
        );
      }
    } catch (e) {
      if (!wanted() || diffCacheRevision(cacheKey) !== revision) {
        return;
      }
      const message = (e as Error).message;
      setCache((current) => {
        if (diffCacheRevision(cacheKey) !== revision) return current;
        const requestIsSelected =
          current.selected !== null && diffEntryKey(current.selected) === key;
        const next = {
          ...current,
          error: requestIsSelected ? message : current.error,
          fileErrors: { ...current.fileErrors, [key]: message },
        };
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      if (select && selectedEntryKeyRef.current === key) {
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file: null,
            loading: false,
            error: message,
            fileErrors: { ...cache.fileErrors, [key]: message },
          }),
          meta,
        );
      }
    } finally {
      if (
        isCurrentContext(workspaceId, scope) &&
        diffCacheRevision(cacheKey) === revision
      ) {
        const pending = (pendingFileKeysRef.current.get(key) ?? 1) - 1;
        if (pending > 0) pendingFileKeysRef.current.set(key, pending);
        else pendingFileKeysRef.current.delete(key);
        setLoadingKeys(Array.from(pendingFileKeysRef.current.keys()));
        setFileLoadingKey((current) => (current === key ? null : current));
      }
    }
  };

  const loadFileRef = useRef(loadFile);
  const refreshRef = useRef(() => {});
  useLayoutEffect(() => {
    loadFileRef.current = loadFile;
    refreshRef.current = () => void loadSummary(cache.selected, true);
  });
  const loadNearbyEntriesRef = useRef<(entries: GitDiffEntry[]) => void>(
    () => {},
  );
  loadNearbyEntriesRef.current = (entries) => {
    const summaryEntries = cache.summary?.entries ?? [];
    // The review reads ahead: the files after the nearby ones load too, so
    // scrolling meets them drawn.
    const ahead = review
      ? diffEntriesAhead(summaryEntries, entries, DIFF_PREFETCH_AHEAD)
      : [];
    // The review keeps wanting what it asked for (until the context
    // changes): a file scrolled past while queued is not dropped and asked
    // again.
    nearbyEntryKeysRef.current = new Set([
      ...(review ? nearbyEntryKeysRef.current : []),
      ...[...entries, ...ahead].map(diffEntryKey),
    ]);
    if (!continuousReview || !cache.summary) return;
    for (const entry of [...entries.slice(0, 12), ...ahead]) {
      const current = summaryEntries.find(
        (candidate) => diffEntryKey(candidate) === diffEntryKey(entry),
      );
      if (
        current &&
        (explicitEntryKeysRef.current.has(diffEntryKey(current)) ||
          !diffAutoCollapseInfo(current, cache.files[diffEntryKey(current)]))
      ) {
        void loadFileRef.current(current, {}, false);
      }
    }
  };
  useImperativeHandle(ref, () => {
    const selectWorkingEntries = (targets: GitDiffEntry[]) => {
      if (!targets.length) return;
      selectedBatchEntryKeysRef.current = new Set(targets.map(diffEntryKey));
      if (diffScopeRef.current === "working") {
        for (const target of targets) {
          void loadFileRef.current(target, { userInitiated: true });
        }
        return;
      }
      pendingWorkingEntriesRef.current = targets;
      setDiffScope("working");
    };
    return {
      highlightEntry: (entry) => {
        setVisibleEntryKey(entry ? diffEntryKey(entry) : null);
        if (entry)
          setExpandedDirs((current) => {
            const next = new Set(current);
            for (const path of expandedDirsForSelection(entry)) next.add(path);
            return next.size === current.size ? current : next;
          });
      },
      loadNearbyEntries: (entries) => loadNearbyEntriesRef.current(entries),
      selectEntry: (target) => {
        selectedBatchEntryKeysRef.current.clear();
        void loadFileRef.current(target, { userInitiated: true });
      },
      selectWorkingEntry: (target) => selectWorkingEntries([target]),
      selectWorkingEntries,
      refresh: () => refreshRef.current(),
      showScope: (scope) => setDiffScope(scope),
      showBase: (branch) => setBaseBranchRef.current(branch),
      runFileAction: (action, path) => runFileActionRef.current(action, path),
      markOtherFiles: (files) =>
        setOtherFiles((current) =>
          current.length === files.length &&
          files.every(
            (each, at) =>
              current[at]?.path === each.path &&
              current[at]?.reviewed === each.reviewed &&
              current[at]?.threads === each.threads,
          )
            ? current
            : files,
        ),
      markReviewProgress: (progress) =>
        setReviewProgress((current) =>
          current.size === progress.size &&
          [...progress].every(([path, each]) => {
            const was = current.get(path);
            return (
              was &&
              was.done === each.done &&
              was.total === each.total &&
              was.reviewed === each.reviewed
            );
          })
            ? current
            : new Map(progress),
        ),
      markSearchMatches: (paths) =>
        setSearchMatches((current) =>
          current.size === paths.length &&
          paths.every((path) => current.has(path))
            ? current
            : new Set(paths),
        ),
    };
  }, [setDiffScope]);

  const selectedDiffEntryKey = cache.selected
    ? diffEntryKey(cache.selected)
    : "";
  const selectedDiffFile = selectedDiffEntryKey
    ? cache.files[selectedDiffEntryKey]
    : undefined;

  const scopeInstead =
    scopePreference?.key === preferenceKey && !!scopePreference.instead;
  useEffect(() => {
    if (scopeInstead) return;
    roamgateLocalStorage.setItem(
      diffScopeStorageKey(connectionClient.connectionId, repositoryResourceKey),
      diffScope,
    );
  }, [
    repositoryResourceKey,
    connectionClient.connectionId,
    diffScope,
    scopeInstead,
  ]);

  useEffect(() => {
    const cached = readDiffCache(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
      cacheResourceKey,
    );
    previousFilesRef.current = {
      context: runtimeContextKey,
      summary: cached.summary,
      files: {},
    };
    nearbyEntryKeysRef.current.clear();
    answeredKeysRef.current.clear();
    explicitEntryKeysRef.current.clear();
    pendingFileKeysRef.current = new Map();
    setLoadingKeys([]);
    setFileLoadingKey(null);
    selectedEntryKeyRef.current = cached.selected
      ? diffEntryKey(cached.selected)
      : "";
    const pendingWorkingEntries =
      diffScope === "working" ? pendingWorkingEntriesRef.current : [];
    const preferredWorkingEntry =
      pendingWorkingEntries[pendingWorkingEntries.length - 1] ?? null;
    setCache(cached);
    setExpandedDirs(
      expandedDirsForEntries(
        cached.summary?.entries ?? (cached.selected ? [cached.selected] : []),
      ),
    );
    onSelectionChangeRef.current?.({
      entry: cached.selected,
      file: cached.selected
        ? (cached.files[diffEntryKey(cached.selected)] ?? null)
        : null,
      loading: false,
      error: cached.error,
      entries: treeOrderedDiffEntries(cached.summary?.entries ?? []),
      files: cached.files,
      fileErrors: cached.fileErrors,
      summaryLoading: false,
    });
    void loadSummary(preferredWorkingEntry ?? cached.selected);
    // Reopen against a fresh workspace snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheResourceKey, cacheWorkspaceId, connectionClient, diffScope]);

  useEffect(() => {
    if (cache.summary !== previousFilesRef.current.summary) return;
    if (cache.selected) {
      const explicit = explicitEntryKeysRef.current.has(selectedDiffEntryKey);
      if (
        explicit ||
        (continuousReview &&
          !diffAutoCollapseInfo(cache.selected, selectedDiffFile))
      ) {
        void loadFile(cache.selected);
      }
    } else {
      onSelectionChangeRef.current?.(
        diffSelection(cache, {
          entry: null,
          file: null,
          loading: false,
          error: null,
        }),
      );
    }
    // Load the selected file whenever summary refresh changes selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cacheWorkspaceId,
    connectionClient,
    diffScope,
    cache.summary,
    selectedDiffEntryKey,
    selectedDiffFile,
    continuousReview,
  ]);

  const selectedKey = cache.summary?.entries.some(
    (entry) => diffEntryKey(entry) === visibleEntryKey,
  )
    ? visibleEntryKey
    : cache.selected
      ? diffEntryKey(cache.selected)
      : null;
  useEffect(() => {
    if (!visibleEntryKey || selectedKey !== visibleEntryKey) return;
    treeRef.current
      ?.querySelector<HTMLElement>(".diff-tree-file.is-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [expandedDirs, selectedKey, visibleEntryKey]);
  /** The status entries (a combined entry's parts): the tree's rows. */
  const statusEntries = useMemo(
    () => statusEntriesOf(cache.summary?.entries ?? []),
    [cache.summary?.entries],
  );
  /** A row's entry as the diff shows it: its combined entry's key. */
  const shownKeyOf = (entry: GitDiffEntry) =>
    combineWorking && COMBINED_PART_KINDS.has(entry.kind)
      ? `combined:${entry.path}`
      : diffEntryKey(entry);
  const tree = useMemo(() => buildDiffTree(statusEntries), [statusEntries]);
  const groupTrees = useMemo(
    () =>
      groupByStatus && diffScope === "working"
        ? STATUS_GROUPS.map(({ kind, label }) => {
            const entries = statusEntries.filter(
              (entry) => entry.kind === kind,
            );
            return { kind, label, entries, tree: buildDiffTree(entries) };
          }).filter((group) => group.entries.length > 0)
        : null,
    [statusEntries, diffScope, groupByStatus],
  );
  const workingCounts = useMemo(
    () => countWorkingEntries(statusEntries),
    [statusEntries],
  );

  const clearLongPressTimer = () => {
    if (!longPressTimerRef.current) return;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
  }, []);

  const openContextMenu = (
    target: {
      path: string;
      entries: GitDiffEntry[];
      directory?: boolean;
    },
    x: number,
    y: number,
  ) => {
    if (diffScopeRef.current !== "working") return;
    clearLongPressTimer();
    setContextMenu({ x, y, ...target });
  };

  const handleEntryPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    target: {
      path: string;
      entries: GitDiffEntry[];
      directory?: boolean;
    },
  ) => {
    if (event.pointerType === "mouse") return;
    longPressTriggeredRef.current = false;
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      openContextMenu(target, event.clientX, event.clientY);
    }, LONG_PRESS_MS);
  };

  const handleEntryPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = longPressStartRef.current;
    if (!start) return;
    const dx = Math.abs(event.clientX - start.x);
    const dy = Math.abs(event.clientY - start.y);
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
      longPressStartRef.current = null;
    }
  };

  const handleEntryPointerEnd = () => {
    clearLongPressTimer();
    longPressStartRef.current = null;
  };

  const copyPath = (path: string, label: string) => {
    void copyTextFromUserGesture(path).then(
      () =>
        store.notify({
          kind: "success",
          message: `${label} copied`,
          detail: path,
          autoDismissMs: 5000,
        }),
      (error) =>
        store.notify({
          kind: "error",
          message: `Failed to copy ${label.toLowerCase()}`,
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const afterGitMutation = async (workspaceId: string) => {
    bumpFileExplorerRefresh(connectionClient, workspaceId);
    await loadSummary(cache.selected, true);
  };

  const runGitFileMenuAction = (
    item: GitFileMenuItem,
    menu: DiffContextMenuState,
  ) => {
    const actionWorkspaceId = workspace?.workspace_id;
    if (!actionWorkspaceId) return;
    const matches = menu.entries.filter((entry) =>
      item.action === "discard_unstaged"
        ? entry.kind === "unstaged"
        : item.action === "delete_untracked"
          ? entry.kind === "untracked"
          : item.action === "unstage"
            ? entry.kind === "staged"
            : entry.kind !== "staged",
    );
    const targets = menu.directory
      ? matches.length
        ? matches
        : menu.entries
      : [matches[0] ?? menu.entries[0]].filter(
          (entry): entry is GitDiffEntry => !!entry,
        );
    if (!targets.length) return;
    const execute = async () => {
      if (menu.directory && targets.length > 1) {
        await store.runGitFileActionBatch(
          actionWorkspaceId,
          item.action,
          targets,
          repoRoot,
        );
        // A failed batch can still have changed earlier files.
      } else {
        const result = await store.runGitFileAction(
          actionWorkspaceId,
          item.action,
          targets[0],
          repoRoot,
        );
        if (!result) return;
      }
      await afterGitMutation(actionWorkspaceId);
    };
    if (item.destructive) {
      const copy = menu.directory
        ? gitFolderConfirmCopy(item.action, menu.path, targets.length)
        : gitFileConfirmCopy(item.action, targets[0].path);
      if (copy) {
        setConfirmState({ ...copy, run: () => void execute() });
        return;
      }
    }
    void execute();
  };

  const runFileActionRef = useRef<
    (action: GitFileAction, path: string) => boolean
  >(() => false);
  runFileActionRef.current = (action, path) => {
    const say = (message: string) =>
      store.notify({ kind: "info", message, autoDismissMs: 3000 });
    if (diffScope !== "working") {
      say("Git actions apply to the working changes.");
      return false;
    }
    if (repoRoot) {
      say(
        "Not in another repository: stage and discard act on the checkout's files.",
      );
      return false;
    }
    const entries = statusEntries.filter((entry) => entry.path === path);
    const item = buildGitFileMenuItems(entries).find(
      (each) => each.action === action,
    );
    if (!item) {
      say(`${gitFileActionLabel(action)}: nothing to do for ${path}.`);
      return false;
    }
    runGitFileMenuAction(item, { x: 0, y: 0, path, entries });
    return true;
  };

  const runGitRepoMenuAction = (item: GitRepoMenuItem) => {
    const actionWorkspaceId = workspace?.workspace_id;
    if (!actionWorkspaceId) return;
    const execute = async () => {
      const result = await store.runGitRepoAction(
        actionWorkspaceId,
        item.action,
        workingCounts,
      );
      if (!result) return;
      await afterGitMutation(actionWorkspaceId);
    };
    if (item.destructive) {
      const copy = gitRepoConfirmCopy(item.action, item.count);
      if (copy) {
        setConfirmState({ ...copy, run: () => void execute() });
        return;
      }
    }
    void execute();
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderTreeNode = (
    node: DiffTreeNode,
    depth: number,
    group = "",
  ): ReactNode[] => {
    const items: ReactNode[] = [];
    const children = sortDiffTreeChildren(node.children.values());

    for (const child of children) {
      const isFile = child.entries.length > 0;
      const open = expandedDirs.has(child.path);
      if (!isFile) {
        items.push(
          <button
            type="button"
            className="diff-tree-row diff-tree-folder"
            style={{
              paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
            }}
            key={`${group}${child.path}`}
            onClick={() => {
              if (longPressTriggeredRef.current) {
                longPressTriggeredRef.current = false;
                return;
              }
              toggleDir(child.path);
            }}
            onContextMenu={(event) => {
              if (diffScope !== "working") return;
              event.preventDefault();
              event.stopPropagation();
              openContextMenu(
                {
                  path: child.path,
                  entries: collectTreeEntries(child),
                  directory: true,
                },
                event.clientX,
                event.clientY,
              );
            }}
            onKeyDown={(event) => {
              if (diffScope !== "working") return;
              if (
                treeKeyboardAction(event.key, event.shiftKey) !== "context-menu"
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              const point = keyboardContextMenuPoint(event.currentTarget);
              openContextMenu(
                {
                  path: child.path,
                  entries: collectTreeEntries(child),
                  directory: true,
                },
                point.x,
                point.y,
              );
            }}
            onPointerDown={(event) =>
              handleEntryPointerDown(event, {
                path: child.path,
                entries: collectTreeEntries(child),
                directory: true,
              })
            }
            onPointerMove={handleEntryPointerMove}
            onPointerUp={handleEntryPointerEnd}
            onPointerCancel={handleEntryPointerEnd}
            onPointerLeave={handleEntryPointerEnd}
          >
            <span className="diff-tree-twisty">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            <Folder size={15} />
            <span className="diff-tree-name">{child.name}</span>
          </button>,
        );
        if (open) items.push(...renderTreeNode(child, depth + 1, group));
        continue;
      }

      const primary = child.entries[0];
      const selected = child.entries.some(
        (entry) => shownKeyOf(entry) === selectedKey,
      );
      const stats = diffStatsForEntries(child.entries);
      const statusCodes = Array.from(
        new Set(child.entries.map((entry) => gitDiffCode(entry))),
      ).sort();
      items.push(
        <button
          type="button"
          key={`${group}${child.path}`}
          className={`diff-tree-row diff-tree-file ${selected ? "is-selected" : ""} ${searchMatches.has(child.path) ? "is-search-hit" : ""}`}
          aria-current={selected ? "true" : undefined}
          style={{
            paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
          }}
          onClick={() => {
            if (longPressTriggeredRef.current) {
              longPressTriggeredRef.current = false;
              return;
            }
            void loadFile(primary, { userInitiated: true });
          }}
          onContextMenu={(event) => {
            if (diffScope !== "working") return;
            event.preventDefault();
            event.stopPropagation();
            openContextMenu(child, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (diffScope !== "working") return;
            if (
              treeKeyboardAction(event.key, event.shiftKey) !== "context-menu"
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const point = keyboardContextMenuPoint(event.currentTarget);
            openContextMenu(child, point.x, point.y);
          }}
          onPointerDown={(event) => handleEntryPointerDown(event, child)}
          onPointerMove={handleEntryPointerMove}
          onPointerUp={handleEntryPointerEnd}
          onPointerCancel={handleEntryPointerEnd}
          onPointerLeave={handleEntryPointerEnd}
        >
          <span className="diff-tree-twisty" />
          <File size={15} />
          <span className="diff-tree-name">
            {searchMatches.has(child.path) ? (
              <mark>{child.name}</mark>
            ) : (
              child.name
            )}
          </span>
          <span className="diff-tree-badges">
            {statusCodes.map((code) => (
              <span
                className={`git-status-code git-status-${code.toLowerCase()}`}
                key={code}
                role="img"
                aria-label={gitDiffCodeLabel(code)}
                title={gitDiffCodeLabel(code)}
              >
                {code}
              </span>
            ))}
          </span>
          {reviewProgress.get(child.path) ? (
            <span
              className={`diff-tree-progress ${reviewProgress.get(child.path)!.reviewed ? "is-reviewed" : ""}`}
              title={
                reviewProgress.get(child.path)!.reviewed
                  ? "Reviewed"
                  : "Chunks reviewed"
              }
            >
              {reviewProgress.get(child.path)!.reviewed ? "✓ " : ""}
              {reviewProgress.get(child.path)!.done}/
              {reviewProgress.get(child.path)!.total}
            </span>
          ) : null}
          {stats.hasStats ? (
            <span className="diff-tree-stats" aria-label="Line changes">
              <span className="diff-stat-add">+{stats.additions}</span>
              <span className="diff-stat-del">-{stats.deletions}</span>
            </span>
          ) : null}
        </button>,
      );
    }
    return items;
  };

  const resolvedBase =
    diffScope === "branch-main" ? sharedSummaryState.summary?.base : undefined;
  const baseLabel = comparisonBranchLabel(baseBranch || resolvedBase || "");
  const comparisonLabel = baseLabel ? `Against ${baseLabel}` : "Against branch";
  const baseBranches = [
    ...new Set([
      ...(sharedSummaryState.summary?.base_branches ?? []),
      ...(baseBranch ? [baseBranch] : []),
    ]),
  ];
  /*
   * Changes' `:` commands in the inspector's prompt, each its toolbar's:
   * the scope switch, Refresh, and the branch compared against.
   */
  const scopes: readonly (readonly [string, DiffScope, string])[] = [
    ["working", "working", "the working tree (Working tree)"],
    ["branch", "branch-main", `the branch, ${comparisonLabel.toLowerCase()}`],
    ["last", "last-step", "the agent's last step (Last step)"],
  ];
  useInspectorCommands(
    workspace
      ? {
          commands: [
            {
              name: "scope",
              description:
                "the changes shown: working, branch or last (the scope switch)",
              complete: () => scopes.map(([word, , note]) => [word, note]),
              run: (argument) => {
                const word = argument.toLowerCase();
                const scope = scopes.find(
                  ([name]) => word && name.startsWith(word),
                );
                if (scope) {
                  setDiffScope(scope[1]);
                  return;
                }
                store.notify({
                  kind: "info",
                  message: `:scope working | branch | last${
                    argument ? `, not ${argument}` : ""
                  }`,
                  autoDismissMs: 2500,
                });
              },
            },
            ...(summaryLoading
              ? []
              : [
                  {
                    name: "reload",
                    aliases: ["e", "edit", "refresh"],
                    description: "refresh the changes (the Refresh button)",
                    run: () => void loadSummary(cache.selected, true),
                  },
                ]),
            ...(diffScope === "branch-main"
              ? [
                  {
                    name: "base",
                    description:
                      "the branch compared against, or automatic (Compare against)",
                    complete: () => [
                      ["auto", "the automatic one"] as const,
                      ...baseBranches.map(
                        (branch) =>
                          [branch, comparisonBranchLabel(branch)] as const,
                      ),
                    ],
                    run: (argument: string) => {
                      if (!argument || argument === "auto") {
                        setBaseBranch("");
                        return;
                      }
                      if (baseBranches.includes(argument)) {
                        setBaseBranch(argument);
                        return;
                      }
                      store.notify({
                        kind: "info",
                        message: `Not a branch to compare against: ${argument}`,
                        autoDismissMs: 2500,
                      });
                    },
                  },
                ]
              : []),
          ],
        }
      : null,
  );

  return (
    <aside className="diff-viewer-side" aria-label="Diff Viewer">
      {header ? <div className="diff-panel-header">{header}</div> : null}
      <div className="diff-panel-toolbar">
        <div className="diff-scope-toggle" aria-label="Diff scope">
          <button
            type="button"
            className={diffScope === "last-step" ? "is-active" : ""}
            onClick={() => setDiffScope("last-step")}
            aria-pressed={diffScope === "last-step"}
            aria-label="Last step"
            title="Last step"
          >
            <span className="diff-scope-label-full" aria-hidden="true">
              Last step
            </span>
            <span className="diff-scope-label-short" aria-hidden="true">
              Last
            </span>
          </button>
          <button
            type="button"
            className={diffScope === "working" ? "is-active" : ""}
            onClick={() => setDiffScope("working")}
            aria-pressed={diffScope === "working"}
            aria-label="Working tree"
            title="Working tree"
          >
            <span className="diff-scope-label-full" aria-hidden="true">
              Working tree
            </span>
            <span className="diff-scope-label-short" aria-hidden="true">
              Working
            </span>
          </button>
          <button
            type="button"
            className={diffScope === "branch-main" ? "is-active" : ""}
            onClick={() => setDiffScope("branch-main")}
            aria-pressed={diffScope === "branch-main"}
            aria-label={comparisonLabel}
            title={comparisonLabel}
          >
            <span className="diff-scope-label-full" aria-hidden="true">
              {comparisonLabel}
            </span>
            <span className="diff-scope-label-short" aria-hidden="true">
              {baseLabel || "Branch"}
            </span>
          </button>
        </div>
        <div
          className="diff-toolbar-actions"
          role="group"
          aria-label="Diff actions"
        >
          <button
            type="button"
            className="diff-refresh"
            title={summaryLoading ? "Refreshing..." : "Refresh"}
            aria-label={
              summaryLoading ? "Refreshing changes" : "Refresh changes"
            }
            aria-busy={summaryLoading}
            disabled={summaryLoading}
            onClick={() => void loadSummary(cache.selected, true)}
          >
            <RefreshCw
              className={summaryLoading ? "is-spinning" : ""}
              size={15}
            />
          </button>
        </div>
      </div>

      {diffScope === "branch-main" ? (
        <label className="diff-base-selector">
          <span>Compare against</span>
          <ThemedSelect
            aria-label="Comparison branch"
            value={baseBranch}
            onChange={setBaseBranch}
            options={[
              {
                value: "",
                label:
                  resolvedBase && !baseBranch
                    ? `Automatic (${comparisonBranchLabel(resolvedBase)})`
                    : "Automatic",
              },
              ...baseBranches.map((branch) => ({
                value: branch,
                label: comparisonBranchLabel(branch),
              })),
            ]}
          />
        </label>
      ) : null}

      {!workspace ? (
        <p className="modal-error">No workspace is focused.</p>
      ) : null}

      {/* A review's own files listed (a commit, a review from elsewhere):
          the scope's read, failed or not, is not what is shown. */}
      {cache.error && !viewFiles ? (
        !repoRoot && /not a git repository/i.test(cache.error) ? (
          // A workspace's folder holding repositories without being one.
          <p className="modal-error" title={cache.error}>
            This workspace's folder is not a Git repository: pick one of its
            repositories in the line above (p).
          </p>
        ) : (
          <p className="modal-error">{cache.error}</p>
        )
      ) : null}

      <div
        ref={treeRef}
        className="diff-list diff-tree"
        aria-label="Changed files"
      >
        {viewFiles ? (
          <div className="diff-tree-group diff-tree-view">
            <div className="diff-tree-row diff-tree-group-head">
              <span className="diff-tree-name" title={viewFiles.label}>
                {viewFiles.label}
              </span>
              <span className="diff-tree-count">
                {viewFiles.entries.length}
              </span>
            </div>
            {viewFiles.entries.map((entry) => (
              <button
                type="button"
                key={`view:${entry.path}`}
                className="diff-tree-row diff-tree-file"
                data-view-file={entry.path}
                style={{ paddingLeft: DIFF_TREE_BASE_INDENT }}
                title={entry.path}
                onClick={() => onPickViewFile?.(entry.path)}
              >
                <span className="diff-tree-twisty" />
                <FileText size={15} />
                <span className="diff-tree-name">{entry.path}</span>
              </button>
            ))}
          </div>
        ) : summaryLoading && !cache.summary ? (
          <DiffSkeleton />
        ) : cache.summary?.entries.length ? (
          groupTrees ? (
            groupTrees.map(({ kind, label, entries, tree: groupTree }) => (
              <div className="diff-tree-group" key={kind}>
                <button
                  type="button"
                  className="diff-tree-row diff-tree-group-head"
                  aria-expanded={!foldedGroups.has(kind)}
                  onClick={() =>
                    setFoldedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                >
                  <span className="diff-tree-twisty">
                    {foldedGroups.has(kind) ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                  </span>
                  <span className="diff-tree-name">{label}</span>
                  <span className="diff-tree-count">{entries.length}</span>
                </button>
                {foldedGroups.has(kind)
                  ? null
                  : renderTreeNode(groupTree, 0, `${kind}:`)}
              </div>
            ))
          ) : (
            renderTreeNode(tree, 0)
          )
        ) : (
          <div className="diff-empty">
            <FileDiff size={18} />
            <span>
              {diffScope === "last-step" &&
              cache.summary?.baseline_available === false
                ? "No completed agent step yet"
                : diffScope === "branch-main" &&
                    cache.summary?.baseline_available === false
                  ? "Choose a comparison branch"
                  : "No changes"}
            </span>
          </div>
        )}
        {groupByStatus && otherFiles.length ? (
          <div className="diff-tree-group diff-tree-other" key="other">
            <button
              type="button"
              className="diff-tree-row diff-tree-group-head"
              aria-expanded={!foldedGroups.has("other")}
              title="Files with no change, commented on or marked reviewed"
              onClick={() =>
                setFoldedGroups((current) => {
                  const next = new Set(current);
                  if (next.has("other")) next.delete("other");
                  else next.add("other");
                  return next;
                })
              }
            >
              <span className="diff-tree-twisty">
                {foldedGroups.has("other") ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}
              </span>
              <span className="diff-tree-name">Other files</span>
              <span className="diff-tree-count">{otherFiles.length}</span>
            </button>
            {foldedGroups.has("other")
              ? null
              : otherFiles.map((other) => (
                  <button
                    type="button"
                    key={`other:${other.path}`}
                    className="diff-tree-row diff-tree-file diff-tree-other-file"
                    data-other-file={other.path}
                    style={{ paddingLeft: DIFF_TREE_BASE_INDENT }}
                    title={other.path}
                    onClick={() => onPickOtherFile?.(other.path)}
                  >
                    <span className="diff-tree-twisty" />
                    <FileText size={15} />
                    <span className="diff-tree-name">{other.path}</span>
                    {other.threads ? (
                      <span
                        className="diff-tree-threads"
                        title={`${other.threads} open thread${other.threads === 1 ? "" : "s"}`}
                      >
                        {other.threads}
                      </span>
                    ) : null}
                    {other.reviewed ? (
                      <span
                        className="diff-tree-progress is-reviewed"
                        title="Reviewed"
                      >
                        {"\u2713"}
                      </span>
                    ) : null}
                  </button>
                ))}
          </div>
        ) : null}
      </div>
      {fileLoadingKey ? (
        <div className="diff-loading-inline">Loading diff...</div>
      ) : null}
      {contextMenu ? (
        <ActionsMenu
          x={contextMenu.x}
          y={contextMenu.y}
          header={{ title: contextMenu.path, subtitle: "Git" }}
          groups={[
            {
              label: contextMenu.directory ? "Folder" : "File",
              items: [
                ...(!contextMenu.directory &&
                onOpenFile &&
                contextMenu.entries[0]
                  ? [
                      {
                        key: "open",
                        label: "Open file",
                        action: () => onOpenFile(contextMenu.entries[0]!),
                      },
                    ]
                  : []),
                {
                  key: "copy-relative",
                  label: "Copy relative path",
                  action: () => copyPath(contextMenu.path, "Relative path"),
                },
                ...(cache.summary?.root
                  ? [
                      {
                        key: "copy-absolute",
                        label: "Copy absolute path",
                        action: () =>
                          copyPath(
                            `${cache.summary?.root}/${contextMenu.path}`,
                            "Absolute path",
                          ),
                      },
                    ]
                  : []),
                ...(canReveal && cache.summary?.root && workspace?.workspace_id
                  ? [
                      {
                        key: "reveal",
                        label: revealMenuLabel(!!contextMenu.directory),
                        action: () =>
                          void revealInFileManager(
                            connectionClient,
                            workspace.workspace_id,
                            contextMenu.path,
                            "changes",
                          ),
                      },
                    ]
                  : []),
              ],
            },
            {
              label: "Git",
              items: buildGitFileMenuItems(
                contextMenu.entries,
                contextMenu.directory,
              ).map((item) => ({
                key: item.action,
                label: item.label,
                danger: item.danger,
                action: () => runGitFileMenuAction(item, contextMenu),
              })),
            },
            {
              label: "Repository",
              items: buildGitRepoMenuItems(workingCounts).map((item) => ({
                key: item.action,
                label: item.label,
                danger: item.danger,
                disabled: item.count === 0,
                detail: String(item.count),
                action: () => runGitRepoMenuAction(item),
              })),
            },
          ]
            // Another repository than the workspace's checkout: git acts on
            // the checkout only, so its actions are not offered here.
            .filter((group) => !repoRoot || group.label !== "Git")
            .filter((group) => !repoRoot || group.label !== "Repository")
            .filter((group) => group.items.length > 0)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title ?? ""}
        message={confirmState?.message ?? ""}
        confirmLabel={confirmState?.confirmLabel ?? "Confirm"}
        danger
        onClose={() => setConfirmState(null)}
        onConfirm={() => confirmState?.run()}
      />
    </aside>
  );
}

function DiffSkeleton() {
  return (
    <div className="diff-skeleton-list">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="diff-skeleton-row" key={index}>
          <span className="diff-skeleton-badge" />
          <span className="diff-skeleton-lines">
            <span className="diff-skeleton-line diff-skeleton-line-name" />
            <span className="diff-skeleton-line diff-skeleton-line-status" />
          </span>
        </div>
      ))}
    </div>
  );
}
