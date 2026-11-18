import { imageMimeForPath } from "../../../shared/filePreview";
import { roamgateLocalStorage, subscribeLocalStorage } from "../browserStorage";
import { shortcutMatches } from "../shortcutPreferences";
import { useSystemBack } from "../systemBack";
import type { SelectedLineRange } from "@pierre/diffs";
import {
  ChevronDown,
  Columns2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  MessageSquare,
  MessageSquareOff,
  MessageSquarePlus,
  MessageSquareText,
  Search,
  WrapText,
  X,
} from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  COMMIT_MESSAGE_PATH,
  REVIEW_USER,
  type ReviewComment,
  type ReviewThread,
  type ReviewThreadKind,
} from "../../../shared/review";
import { reviewCall, useReviewState } from "../review";
import {
  latestAnswerAt,
  reviewAgent,
  sharedThreadDelivery,
  type ThreadDelivery,
} from "../reviewDelivery";
import { keepReviewDraft } from "../reviewDrafts";
import { newClientId } from "../reviewPending";
import {
  authorLabel,
  type FileExpansion,
  fileLines,
  type GapState,
} from "../reviewModel";
import {
  type ChangesGap,
  expandPatch,
  parsePatch,
  patchMatches,
  revealLine,
  withGaps,
} from "../changesExpand";
import { editorKey, editorPlaceholder } from "../reviewSave";
import { feedbackNote, HELD_FOR_SEND } from "../workspaceFeedback";
import { useReviewSessionCall, writeReviewSession } from "../reviewSessionCall";
import { usePendingWrites } from "../usePendingWrites";
import { useReviewStatusLine } from "../reviewStatusLine";
import { plural } from "./MrThreadCard";
import { PendingStatus, ReviewMessageBar } from "./ReviewMessageBar";
import type { ConnectionClient } from "../api";
import {
  diffReviewLineLabel,
  findDiffReviewSelection,
  type DiffReviewAnnotation,
  type NewReviewAnnotation,
  type ReviewAnnotation,
} from "../annotations";
import type {
  FilePreview,
  GitDiffEntry,
  GitDiffFile,
  GitDiffKind,
} from "../types";
import { connectionClientScopeKey } from "../useConnectionClient";
import { store, useStoreSelector } from "../store";
import { gitDiffCode, gitDiffCodeLabel } from "../gitDiffStatus";
import { requestFilePreview } from "./fileExplorerResources";
import {
  AnnotationComposerPopover,
  type AnnotationComposerDraft,
} from "./AnnotationComposerPopover";
import {
  diffAutoCollapseInfo,
  type DiffAutoCollapseInfo,
} from "./diffAutoCollapse";
import {
  readDiffCollapseState,
  writeDiffCollapseState,
  expandDiffEntryOnActivate,
  diffSectionCollapsed,
  nearestDiffEntryKeys,
  visibleDiffEntryKey,
} from "./diffContentState";
import {
  DiffSurface,
  DiffSurfaceScroll,
  type DiffSurfaceInstance,
  diffSurfaceOptions,
  type DiffSurfaceOptions,
} from "./DiffSurface";
import {
  FileThread,
  type FileThreadView,
  fileStopKey,
  fileStops,
  nestThreads,
  type ReviewThreadLook,
  reviewsUndelivered,
  threadWrites,
  ThreadsList,
  type Undelivered,
  useFileThreadView,
} from "./FileThreads";
import { conversationOrder, ThreadsChip, UnresolvedNav } from "./ThreadsPanel";
import { preloadReviewCommentEditor } from "./ReviewCommentEditorLazy";
import {
  changesDraftSession,
  type ComposerDelivery,
  ReviewDiffComposer,
  saveOpenComposer,
  suggestionBlock,
} from "./ReviewDiffComposer";
import {
  markThreadLines,
  cursorThreadPlace,
  type PlacedThread,
  placeDiffThreads,
  threadReadingOrder,
  threadsAtCursor,
} from "../changesThreads";
import { repoFeedback, type ShownRepo } from "../changesRepo";
import { latestComment } from "../reviewNavigation";
import {
  type ChangesScope,
  scopeReview,
  stepTarget,
  useChangesAgent,
  useScopeByValue,
  WORKING_SCOPE,
} from "../changesReview";
import type { ReviewProgress } from "./DiffViewerPanel";
import {
  fileNoteAsDiff,
  type OtherFile,
  otherFileMarks,
  otherReviewFiles,
} from "../reviewFiles";
import {
  changesReviewView,
  type ChunkSpan,
  chunkSpans,
  markChunks,
  reviewedLayout,
} from "../changesReviewed";
import { nextUnreviewedHunk, reviewedState } from "../reviewNavigation";
import {
  fileToggleChanges,
  fileToggleNotice,
  hunkToggle,
  hunkToggleNotice,
  pickHunks,
} from "../reviewToggle";
import type { GitFileAction } from "../gitActions";
import { ChangesAgentBar } from "./ChangesAgentBar";
import { ReviewMenu } from "./ReviewMenu";
import { plainDiffError } from "./diffErrors";
import {
  ChangesForgeHead,
  ChangesForgeSection,
  type ForgeHost,
  openMergeRequest,
  useForgeMode,
} from "./ChangesForge";
import {
  adoptable,
  agentsKeptReason,
  type ForgeRelocation,
  forgeName,
  forgeOutside,
  placeForgeThread,
  useForgePoll,
  useForgeRelocations,
} from "../changesForge";
import { NoteBody } from "./ReviewNoteBody";
import {
  stepNotice,
  stepUnresolved,
  unresolvedPosition,
} from "../unresolvedThreads";
import { usePendingFeedback } from "../feedbackPending";
import { useInspectorCommands } from "../useInspectorCommands";
import { oneCommitTitle } from "../changesViews";
import { useChangesViews, type ViewsSource } from "../useChangesViews";
import { ChangesCommitBar } from "./ChangesCommitBar";
import type { InspectorCommand } from "../inspectorCommands";
import { CommandLine } from "./CommandLine";
import {
  type CommentMode,
  type DiffCursor,
  GO_TO_FRESH_MS,
  goToMatches,
  useDiffCursor,
} from "./useDiffCursor";
import { notAReviewCommand, reviewCommands } from "../reviewCommands";
import { CHANGES_REVIEW_KEYS } from "../reviewShortcuts";
import { readReviewPlace, writeReviewPlace } from "../reviewPlace";
import { SPLIT_MIN_WIDTH } from "../reviewPrefs";
import "./DiffContentView.css";
import "./ReviewCard.css";

export { highlightedPatch } from "./DiffSurface";

type DiffViewMode = "split" | "unified";

/** Where Files opens a file: at a line, rendered (Markdown, a page). */
export type OpenFileAt = { line?: number; rendered?: boolean };

/** The files the Files preview renders: the review's Rendered. */
const RENDERED_FILE = /\.(md|markdown|mdx|html?|svg)$/i;
type AppTheme = "dark" | "light";

const DIFF_VIEW_MODE_KEY = "diffViewMode";
const DESKTOP_DIFF_WRAP_KEY = "desktopDiffWrap";
const MOBILE_DIFF_WRAP_KEY = "mobileDiffWrap";
const EMPTY_DIFF_REVIEW_ANNOTATIONS: readonly DiffReviewAnnotation[] = [];
type ImagePreviewState = {
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
};

type ImagePreviewTarget = {
  key: string;
  file: GitDiffFile;
};

function startImagePreviewRequest(
  target: ImagePreviewTarget,
  client: ConnectionClient,
  isCurrent: () => boolean,
  onComplete: (key: string, state: ImagePreviewState) => void,
  loadPreview?: (path: string) => Promise<FilePreview>,
) {
  void (
    loadPreview
      ? loadPreview(target.file.path)
      : requestFilePreview(target.file.workspace_id, target.file.path, {
          client,
          refresh: true,
        })
  )
    .then((preview) => {
      if (!isCurrent()) return;
      onComplete(target.key, { preview, loading: false, error: null });
    })
    .catch((error) => {
      if (!isCurrent()) return;
      onComplete(target.key, {
        preview: null,
        loading: false,
        error: (error as Error).message,
      });
    });
}

type DiffSearchGroup = {
  key: string;
};

type DiffAnnotationRequest = {
  x: number;
  y: number;
  path: string;
  kind: GitDiffKind;
  side: "old" | "new";
  line: number;
  endSide?: "old" | "new";
  endLine?: number;
  quote: string;
  hunk: string;
};

type DiffSection = {
  key: string;
  active: boolean;
  entry: GitDiffEntry;
  file: GitDiffFile | null;
  imagePreview: boolean;
  autoCollapse: DiffAutoCollapseInfo | null;
  collapsed: boolean;
  error: string | null;
};

export type DiffHunkTarget = {
  oldLine: number | null;
  newLine: number | null;
};

export function nextDiffHunkIndex(
  current: number,
  delta: -1 | 1,
  count: number,
) {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export function diffHunkTargets(patch: string): DiffHunkTarget[] {
  const targets: DiffHunkTarget[] = [];
  const lines = patch.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let target: DiffHunkTarget | null = null;

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      if (target) targets.push(target);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      target = { oldLine: null, newLine: null };
      continue;
    }
    if (!target) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      target.newLine ??= newLine;
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      target.oldLine ??= oldLine;
      oldLine += 1;
    } else if (!line.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  if (target) targets.push(target);
  return targets;
}

function deepQuerySelector(
  root: ParentNode,
  selectors: string[],
): HTMLElement | null {
  for (const selector of selectors) {
    const match = root.querySelector<HTMLElement>(selector);
    if (match) return match;
  }
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const match = deepQuerySelector(element.shadowRoot, selectors);
    if (match) return match;
  }
  return null;
}

/** The view mode chosen (Split, Unified, S), or null when none was. */
function storedDiffViewMode(): DiffViewMode | null {
  const stored = roamgateLocalStorage.getItem(DIFF_VIEW_MODE_KEY);
  return stored === "unified" || stored === "split" ? stored : null;
}

function loadDiffViewMode(): DiffViewMode {
  return storedDiffViewMode() ?? "split";
}

/** A phone's Wrap as chosen; null: never chosen (the review wraps then). */
function loadMobileDiffWrap(): boolean | null {
  const stored = roamgateLocalStorage.getItem(MOBILE_DIFF_WRAP_KEY);
  return stored === "true" ? true : stored === "false" ? false : null;
}

function loadDesktopDiffWrap() {
  return roamgateLocalStorage.getItem(DESKTOP_DIFF_WRAP_KEY) !== "false";
}

function currentDocumentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => currentDocumentTheme());

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(currentDocumentTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

export function diffContentEntries(
  entries: GitDiffEntry[],
  entry: GitDiffEntry | null,
) {
  return entries.length ? entries : entry ? [entry] : [];
}

export function diffRenderableFile(file: GitDiffFile | null) {
  return file?.deferred ? null : file;
}

export function isImageDiff(path: string, diff: string) {
  return imageMimeForPath(path) !== null && (!diff || isBinaryDiffText(diff));
}

function isBinaryDiffText(diff: string) {
  return /^Binary files\b/m.test(diff) || /^GIT binary patch\b/m.test(diff);
}

function imagePreviewKey(client: ConnectionClient, file: GitDiffFile) {
  return connectionClientScopeKey(
    client,
    "diff-image-preview",
    file.workspace_id,
    file.path,
  );
}

function isEditableSearchTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".diff-search")) return false;
  if (target.closest(".cm-editor")) return true;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function literalSearchPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

export function diffSearchGroups(
  entries: GitDiffEntry[],
  files: Record<string, GitDiffFile>,
  query: string,
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { groups: [] as DiffSearchGroup[], count: 0 };
  }
  const pattern = literalSearchPattern(normalizedQuery);
  const groups: DiffSearchGroup[] = [];
  for (const entry of entries) {
    const key = diffEntryKey(entry);
    const diff = files[key]?.diff;
    if (!diff || isBinaryDiffText(diff)) continue;
    if (pattern.test(diff)) groups.push({ key });
  }
  return { groups, count: groups.length };
}

function searchEntryKey(groups: DiffSearchGroup[], index: number) {
  return index < 0 ? null : (groups[index]?.key ?? null);
}

function DiffImagePreview({
  state,
  path,
}: {
  state?: ImagePreviewState;
  path: string;
}) {
  if (!state || state.loading) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          Loading image preview
        </div>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state is-error">{state.error}</div>
      </div>
    );
  }
  if (!state.preview?.image_data_url) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state">Image preview unavailable.</div>
      </div>
    );
  }
  return (
    <div className="diff-image-preview">
      <img
        className="diff-image-preview-img"
        src={state.preview.image_data_url}
        alt={path}
      />
    </div>
  );
}

/**
 * The agent saying it works on a thread (its review_working), on the
 * thread's card: a mark, what it does, since when.
 */
function ReviewWorking({
  agentName,
  message,
  at,
}: {
  agentName: string;
  message: string | undefined;
  at: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return (
    <div className="review-working" role="status">
      <span className="review-working-mark" aria-hidden="true" />
      <span>
        <strong>{agentName}</strong> is working on this
        {message ? `: ${message}` : "..."}
      </span>
      <span className="review-working-time">
        {Number.isFinite(seconds)
          ? seconds < 60
            ? `${seconds} s`
            : `${Math.floor(seconds / 60)} min`
          : ""}
      </span>
    </div>
  );
}

/**
 * The threads the diff's comments are (a comment written here is a thread
 * of its review), drawn under their lines as the Files preview draws its.
 */
type DiffThreads = {
  byId: ReadonlyMap<string, ReviewThread>;
  api: ReturnType<typeof threadWrites>;
  view: FileThreadView;
  undelivered: Undelivered;
  /** The threads on parts of a message, by that message (drawn in it). */
  nested: ReadonlyMap<string, ReviewThread[]>;
  /** Drawn as the review in Changes draws them. */
  review?: ReviewThreadLook;
};

const NO_MARKS: Readonly<Record<string, string>> = {};
const NO_OTHER_FILES: readonly OtherFile[] = [];
const NO_ANNOTATIONS: readonly ReviewAnnotation[] = [];
const NO_THREADS: ReviewThread[] = [];
/** How long Go to it waits for a thread's view, file and lines to land. */
const THREAD_GO_TO_MS = 15_000;
const NO_FORGE_HOST: ForgeHost = {};
const NO_NESTED: ReadonlyMap<string, ReviewThread[]> = new Map();

const DiffThreadsContext = createContext<DiffThreads | null>(null);

/** The id of the comment box drawn as an annotation under its line. */
const COMPOSER_ID = "\u0000composer";

/**
 * The review's comment box in Changes, what the annotation of
 * COMPOSER_ID draws; hidden comments and the threads only the unresolved
 * ones: what `t` and `gH` set.
 */
type DiffDrawing = {
  composer: ReactNode;
  composerKey: string;
  hideComments: boolean;
  openOnly: boolean;
  /** A section's hidden gap: its count and buttons (GAP_ID). */
  gap: (key: string, index: number) => ReactNode;
};

/** The ids of the annotations drawing a gap's controls: its index after. */
const GAP_ID = "\u0000gap:";

const DiffDrawingContext = createContext<DiffDrawing | null>(null);

/**
 * A thread of the scope's review written elsewhere than in Changes (an
 * agent, say): on a line of a file, not on a message, a chat, a
 * rendered page or a terminal.
 */
function scopeLineThread(thread: ReviewThread): boolean {
  const { anchor } = thread;
  return (
    !!anchor.path &&
    anchor.line !== undefined &&
    !anchor.message &&
    !anchor.chat &&
    !anchor.render &&
    !anchor.terminal
  );
}

/**
 * A thread of the scope's review on the whole review (a merge request's
 * discussion on the request), not on a message, a chat, a rendered page or
 * a terminal.
 */
function scopeGeneralThread(thread: ReviewThread): boolean {
  const { anchor } = thread;
  return (
    !anchor.path &&
    !anchor.message &&
    !anchor.chat &&
    !anchor.render &&
    !anchor.terminal
  );
}

/** Such a thread as a comment of the scope's diff (its sections' kind). */
function scopeNote(thread: ReviewThread, kind: GitDiffKind): ReviewAnnotation {
  const note = feedbackNote(thread);
  if (note.source !== "diff" || thread.anchor.feedback !== undefined)
    return note;
  return {
    ...note,
    kind,
    ...(thread.anchor.commit
      ? {
          commit: {
            sha: thread.anchor.commit,
            ...(thread.anchor.commitSubject
              ? { subject: thread.anchor.commitSubject }
              : {}),
            ...(thread.anchor.commitParent
              ? { parent: thread.anchor.commitParent }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The section a comment is drawn in: its own entry's (`kind:path`). A
 * comment on the combined diff (the review in Changes) shown on the
 * per-entry diffs goes on the entry that numbers its side alike: the new
 * side (the working tree) on the unstaged or untracked entry, the old side
 * (HEAD) on the staged one, else on any entry of its file.
 */
export function annotationSectionKey(
  annotation: Pick<DiffReviewAnnotation, "kind" | "path" | "side">,
  shownKeys: ReadonlySet<string>,
): string {
  const own = `${annotation.kind}:${annotation.path}`;
  if (annotation.kind !== "combined" || shownKeys.has(own)) return own;
  const order =
    annotation.side === "old"
      ? ["staged", "unstaged", "untracked", "conflicted"]
      : ["unstaged", "untracked", "staged", "conflicted"];
  return (
    order
      .map((kind) => `${kind}:${annotation.path}`)
      .find((key) => shownKeys.has(key)) ?? own
  );
}

/**
 * The threads of the comments on the files a diff view shows, in their
 * order: what its Comments panel lists.
 */
export function diffViewThreads(
  annotations: readonly ReviewAnnotation[],
  threads: readonly ReviewThread[],
  entries: readonly GitDiffEntry[],
  /**
   * By path alone: the review's threads belong to the combined diff, not to
   * the staged or unstaged entry they were written on.
   */
  byPath = false,
): ReviewThread[] {
  const byId = new Map(threads.map((each) => [each.id, each]));
  const shown = new Set(
    entries.map((each) => (byPath ? each.path : `${each.kind}:${each.path}`)),
  );
  const paths = new Set(entries.map((each) => each.path));
  return annotations.flatMap((note) => {
    const thread =
      note.source === "diff" &&
      (byPath || note.kind !== "combined"
        ? shown.has(byPath ? note.path : `${note.kind}:${note.path}`)
        : // On the combined diff, shown on its file's entries.
          paths.has(note.path))
        ? byId.get(note.id)
        : undefined;
    return thread ? [thread] : [];
  });
}

/**
 * Where the Comments panel says a thread of another view is: on a commit
 * (its short sha), or on all the changes.
 */
export function otherViewNote(
  threads: readonly ReviewThread[],
): (thread: ReviewThread) => string | undefined {
  const ids = new Set(threads.map((thread) => thread.id));
  return (thread) => {
    if (!ids.has(thread.id)) return undefined;
    const { commit } = thread.anchor;
    return commit ? `on commit ${commit.slice(0, 8)}` : "on all the changes";
  };
}

/**
 * The comments on a file and no line of it (the review in Changes), at
 * the file's head above its lines.
 */
function DiffFileThreads({ ids }: { ids: string }) {
  const threads = useContext(DiffThreadsContext);
  const drawing = useContext(DiffDrawingContext);
  if (!threads || !ids || drawing?.hideComments) return null;
  const shown = ids
    .split("\u0000")
    .map((id) => threads.byId.get(id))
    .filter(
      (thread): thread is ReviewThread =>
        !!thread && !(drawing?.openOnly && thread.resolved),
    );
  if (!shown.length) return null;
  return (
    <div className="diff-file-threads">
      {shown.map((thread) => (
        <div key={thread.id} className="chat-review diff-review-thread">
          <FileThread
            thread={thread}
            api={threads.api}
            view={threads.view}
            undelivered={threads.undelivered}
            nested={threads.nested}
            {...(threads.review ? { review: threads.review } : {})}
          />
        </div>
      ))}
    </div>
  );
}

/** A comment under its line: its thread, or a note not saved yet. */
function DiffAnnotation({
  annotation,
  onEdit,
}: {
  annotation: DiffReviewAnnotation;
  onEdit?: (id: string) => void;
}) {
  const threads = useContext(DiffThreadsContext);
  const drawing = useContext(DiffDrawingContext);
  const pending = usePendingFeedback();
  if (annotation.id === COMPOSER_ID) return <>{drawing?.composer}</>;
  if (annotation.id.startsWith(GAP_ID))
    return (
      <>
        {drawing?.gap(
          `${annotation.kind}:${annotation.path}`,
          Number(annotation.id.slice(GAP_ID.length)),
        )}
      </>
    );
  const thread = threads?.byId.get(annotation.id);
  if (
    drawing &&
    thread &&
    (drawing.hideComments || (drawing.openOnly && thread.resolved))
  )
    return null;
  if (threads && thread)
    return (
      <div className="chat-review diff-review-thread">
        <FileThread
          thread={thread}
          api={threads.api}
          view={threads.view}
          undelivered={threads.undelivered}
          nested={threads.nested}
          {...(threads.review ? { review: threads.review } : {})}
        />
      </div>
    );
  const waiting = drawing ? pending.get(annotation.id) : undefined;
  if (waiting)
    return (
      <div
        className="chat-review diff-review-thread diff-review-pending"
        data-pending-id={annotation.id}
      >
        <div className="chat-thread is-draft">
          <div className="rc-text">{annotation.comment}</div>
          <PendingStatus
            error={waiting.error}
            onRetry={waiting.retry}
            onDiscard={waiting.discard}
          />
        </div>
      </div>
    );
  return (
    <button
      type="button"
      className={`diff-review-annotation ${annotation.stale ? "is-stale" : ""}`}
      title="Open review comment"
      onClick={(event) => {
        event.stopPropagation();
        onEdit?.(annotation.id);
      }}
    >
      <MessageSquareText size={13} />
      <span>{annotation.comment || "Review comment"}</span>
    </button>
  );
}

type DiffFileSectionProps = {
  section: DiffSection;
  loading: boolean;
  nearby: boolean;
  imagePreviewState?: ImagePreviewState;
  options: DiffSurfaceOptions;
  currentSearchMatch: boolean;
  embedded: boolean;
  mobile: boolean;
  annotations: readonly DiffReviewAnnotation[];
  annotationSelectionActive: boolean;
  onToggle: (key: string, collapsed: boolean) => void;
  onSelectFile?: (entry: GitDiffEntry) => void;
  onOpenFile?: (entry: GitDiffEntry, at?: OpenFileAt) => void;
  openFileLabel?: string;
  /**
   * The review's header (the review in Changes): Open, and Rendered on a
   * file the Files preview renders; none without a Files preview to open
   * in.
   */
  reviewHeader?: boolean;
  onRequestAnnotation?: (request: DiffAnnotationRequest) => void;
  onEditAnnotation?: (id: string) => void;
  /** The review cursor's: Pierre's instance of the file, drawn or gone. */
  onInstance?: (key: string, instance: DiffSurfaceInstance | null) => void;
  /**
   * The review cursor's: a click on a line; true when it was the cursor's
   * line already (a second click), for a comment to open there.
   */
  onLineClick?: (
    key: string,
    line: number,
    side: "deletions" | "additions",
    shift: boolean,
  ) => boolean;
  /** The review cursor's Visual lines here (undefined: no cursor). */
  cursorSelection?: SelectedLineRange | null;
  /** The review cursor's search has a hit in this file. */
  searchHit?: boolean;
  /** Each chunk's staged state and reviewed mark (the review in Changes). */
  chunkSpans?: readonly ChunkSpan[];
  /** The lines with a thread ("old:N" / "new:N", by commas): marked. */
  threadMarks?: string;
  /**
   * The file is reviewed (every chunk) and folded to its header;
   * `onShowReviewed` shows it again.
   */
  reviewedFolded?: boolean;
  onShowReviewed?: (path: string) => void;
  /** The ids of the threads on the file and no line, drawn at its head. */
  fileThreadIds?: string;
};

const DiffFileSection = memo(function DiffFileSection({
  section,
  loading,
  nearby,
  imagePreviewState,
  options: givenOptions,
  currentSearchMatch,
  embedded,
  mobile,
  annotations,
  annotationSelectionActive,
  onToggle,
  onSelectFile,
  onOpenFile,
  openFileLabel = "Open in Files",
  reviewHeader = false,
  onRequestAnnotation,
  onEditAnnotation,
  onInstance,
  onLineClick,
  cursorSelection,
  searchHit = false,
  chunkSpans,
  threadMarks,
  reviewedFolded = false,
  onShowReviewed,
  fileThreadIds,
}: DiffFileSectionProps) {
  /**
   * A commit's message is words, not a change: drawn once, one column,
   * even side by side.
   */
  const message = section.entry.path === COMMIT_MESSAGE_PATH;
  const options = useMemo(
    () =>
      message && givenOptions.diffStyle !== "unified"
        ? { ...givenOptions, diffStyle: "unified" as const }
        : givenOptions,
    [givenOptions, message],
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const measuredHeightRef = useRef<number | null>(null);
  const placeholderHeight =
    measuredHeightRef.current ??
    Math.max(
      120,
      ((options.diffStyle === "split"
        ? Math.max(section.entry.additions ?? 0, section.entry.deletions ?? 0)
        : (section.entry.additions ?? 0) + (section.entry.deletions ?? 0)) +
        8) *
        20,
    );
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !section.file || section.collapsed) return;
    const measure = () => {
      if (!body.isConnected) return;
      const height = body.getBoundingClientRect().height;
      if (height > 0) measuredHeightRef.current = height;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => {
      measure();
      observer.disconnect();
    };
  }, [nearby, section.collapsed, section.file]);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const selectLines = useMemo(
    () =>
      onRequestAnnotation
        ? (range: SelectedLineRange | null) => {
            if (!section.file || !range) return false;
            const target = findDiffReviewSelection(
              section.file.diff,
              range,
              options.diffStyle === "unified" ? "unified" : "split",
            );
            if (!target) return false;
            onRequestAnnotation({
              x: pointerPositionRef.current.x + 6,
              y: pointerPositionRef.current.y + 8,
              path: section.entry.path,
              kind: section.entry.kind,
              ...target,
            });
            return true;
          }
        : undefined,
    [
      onRequestAnnotation,
      options.diffStyle,
      section.entry.kind,
      section.entry.path,
      section.file,
    ],
  );
  const sectionKey = section.key;
  const surfaceInstance = useMemo(
    () =>
      onInstance
        ? (instance: DiffSurfaceInstance | null) =>
            onInstance(sectionKey, instance)
        : undefined,
    [onInstance, sectionKey],
  );
  const decorateChunks = useMemo(
    () =>
      chunkSpans || threadMarks !== undefined
        ? (node: HTMLElement) => {
            const root = node.shadowRoot ?? node;
            if (chunkSpans) markChunks(root, chunkSpans);
            if (threadMarks !== undefined)
              markThreadLines(
                root,
                new Set(threadMarks ? threadMarks.split(",") : []),
              );
          }
        : undefined,
    [chunkSpans, threadMarks],
  );
  const lineClick = useMemo(
    () =>
      onLineClick
        ? (
            line: number,
            side: "deletions" | "additions",
            event: PointerEvent,
          ) => {
            // A second click on the cursor's line: a comment there.
            if (onLineClick(sectionKey, line, side, event.shiftKey))
              selectLines?.({ start: line, end: line, side });
          }
        : undefined,
    [onLineClick, sectionKey, selectLines],
  );
  const toggle = () => {
    // A reviewed file folded on its own opens.
    if (reviewedFolded) {
      onShowReviewed?.(section.entry.path);
      return;
    }
    onToggle(section.key, section.collapsed);
    if (section.collapsed && (!section.file || !section.active))
      onSelectFile?.(section.entry);
  };

  const statusCode = gitDiffCode(section.entry);
  const metaNote = [
    section.autoCollapse?.label ?? null,
    section.file?.truncated ? "truncated" : null,
    section.collapsed && section.autoCollapse ? "auto-collapsed" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      className={`diff-file-section ${message ? "is-commit-message" : ""} ${embedded ? "is-embedded" : ""} ${currentSearchMatch ? "is-search-current" : ""} ${searchHit ? "is-cursor-search-hit" : ""}`}
      data-diff-entry-key={section.key}
      aria-current={currentSearchMatch ? "true" : undefined}
      onPointerDownCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMoveCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
    >
      {embedded ? null : (
        <header className="diff-file-section-head">
          {mobile ? null : (
            <button
              type="button"
              className="diff-file-collapse"
              onClick={toggle}
              aria-expanded={!section.collapsed && !reviewedFolded}
              aria-label={`${section.collapsed || reviewedFolded ? "Expand" : "Collapse"} ${section.entry.path}`}
              title={
                section.collapsed || reviewedFolded ? "Expand" : "Collapse"
              }
            >
              {section.collapsed || reviewedFolded ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          )}
          <button
            type="button"
            className="diff-file-section-title is-toggle"
            onClick={toggle}
            aria-expanded={!section.collapsed && !reviewedFolded}
          >
            <strong>{section.entry.path}</strong>
            <span
              className={`git-status-code git-status-${statusCode.toLowerCase()}`}
              role="img"
              aria-label={gitDiffCodeLabel(statusCode)}
              title={gitDiffCodeLabel(statusCode)}
            >
              {statusCode}
            </span>
            {metaNote ? (
              <span className="diff-file-section-meta">{metaNote}</span>
            ) : null}
            {reviewedFolded ? (
              <span className="diff-file-section-meta diff-file-reviewed">
                ✓ reviewed
              </span>
            ) : null}
          </button>
          {reviewedFolded ? (
            <button
              type="button"
              className="diff-file-show-reviewed"
              title="Show the reviewed file again, until it is unmarked"
              onClick={() => onShowReviewed?.(section.entry.path)}
            >
              Show
            </button>
          ) : null}
          {reviewHeader ? (
            onOpenFile ? (
              <>
                <button
                  type="button"
                  className="diff-file-open"
                  title="Open the file in the preview (gf), at the cursor line when it is in this file"
                  onClick={() => onOpenFile(section.entry)}
                >
                  Open
                </button>
                {RENDERED_FILE.test(section.entry.path) ? (
                  <button
                    type="button"
                    className="diff-file-open"
                    title="Show rendered: the file as the Files preview renders it, at the cursor line, with this review's comments on it"
                    onClick={() =>
                      onOpenFile(section.entry, { rendered: true })
                    }
                  >
                    Rendered
                  </button>
                ) : null}
              </>
            ) : null
          ) : (
            <button
              type="button"
              className="diff-file-open"
              aria-label={openFileLabel}
              title={openFileLabel}
              onClick={() => onOpenFile?.(section.entry)}
              disabled={!onOpenFile}
            >
              <FolderOpen size={14} />
              <span>{openFileLabel}</span>
            </button>
          )}
        </header>
      )}
      {fileThreadIds && !reviewedFolded ? (
        <DiffFileThreads ids={fileThreadIds} />
      ) : null}
      {section.collapsed && section.autoCollapse ? (
        <div className="diff-content-state diff-skipped-state">
          <span>{section.autoCollapse.label}; diff skipped.</span>
          <button type="button" onClick={toggle}>
            View diff
          </button>
        </div>
      ) : null}
      {/* Pierre virtualizes cached text itself; keep its measured row heights. */}
      {section.collapsed ? null : !nearby &&
        (!section.file || section.imagePreview) ? (
        <div
          className="diff-file-placeholder"
          style={{ height: placeholderHeight }}
          aria-hidden="true"
        />
      ) : (
        <div
          ref={bodyRef}
          className="diff-file-section-body"
          // Folded reviewed: kept drawn (its lines stay the cursor's, which
          // steps over them), only hidden.
          hidden={reviewedFolded}
          style={!section.file ? { minHeight: placeholderHeight } : undefined}
        >
          {mobile ? (
            <div className="diff-file-path-banner" title={section.entry.path}>
              {section.entry.path}
            </div>
          ) : null}
          {section.error ? (
            <div className="diff-content-state is-error">
              <span>{section.error}</span>
              {onSelectFile ? (
                <button
                  type="button"
                  onClick={() => onSelectFile(section.entry)}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {!section.file && !section.error ? (
            <div className="diff-content-state">
              {loading ? <span className="file-loading-spinner" /> : null}
              {loading ? (
                "Loading diff"
              ) : onSelectFile ? (
                <button
                  type="button"
                  onClick={() => onSelectFile(section.entry)}
                >
                  Load diff
                </button>
              ) : (
                "Select this file to load its diff."
              )}
            </div>
          ) : null}
          {section.file && !section.file.diff && !section.imagePreview ? (
            <div className="diff-content-state">No textual diff available.</div>
          ) : null}
          {section.imagePreview && section.file ? (
            <DiffImagePreview
              state={imagePreviewState}
              path={section.entry.path}
            />
          ) : null}
          {section.file?.truncated ? (
            <div className="diff-truncated">Diff truncated at 512 KB.</div>
          ) : null}
          {section.file?.diff && !section.imagePreview ? (
            <DiffSurface
              patch={section.file.diff}
              path={section.entry.path}
              options={options}
              annotations={annotations}
              renderAnnotation={(annotation) => (
                <DiffAnnotation
                  annotation={annotation}
                  onEdit={onEditAnnotation}
                />
              )}
              onSelectLines={selectLines}
              selectionActive={annotationSelectionActive}
              onInstance={surfaceInstance}
              onLineClick={lineClick}
              {...(decorateChunks ? { decorate: decorateChunks } : {})}
              {...(cursorSelection !== undefined
                ? { selectedLines: cursorSelection }
                : {})}
            />
          ) : null}
        </div>
      )}
    </article>
  );
}, areDiffFileSectionPropsEqual);

function areDiffFileSectionPropsEqual(
  previous: Readonly<DiffFileSectionProps>,
  next: Readonly<DiffFileSectionProps>,
) {
  return (
    previous.section.key === next.section.key &&
    previous.section.active === next.section.active &&
    previous.section.entry === next.section.entry &&
    previous.section.file === next.section.file &&
    previous.section.imagePreview === next.section.imagePreview &&
    previous.section.collapsed === next.section.collapsed &&
    previous.section.error === next.section.error &&
    previous.section.autoCollapse?.reason ===
      next.section.autoCollapse?.reason &&
    previous.section.autoCollapse?.label === next.section.autoCollapse?.label &&
    previous.loading === next.loading &&
    previous.nearby === next.nearby &&
    previous.imagePreviewState === next.imagePreviewState &&
    previous.options === next.options &&
    previous.currentSearchMatch === next.currentSearchMatch &&
    previous.embedded === next.embedded &&
    previous.mobile === next.mobile &&
    previous.annotations === next.annotations &&
    previous.annotationSelectionActive === next.annotationSelectionActive &&
    previous.onToggle === next.onToggle &&
    previous.onSelectFile === next.onSelectFile &&
    previous.onOpenFile === next.onOpenFile &&
    previous.openFileLabel === next.openFileLabel &&
    previous.reviewHeader === next.reviewHeader &&
    previous.onRequestAnnotation === next.onRequestAnnotation &&
    previous.onEditAnnotation === next.onEditAnnotation &&
    previous.onInstance === next.onInstance &&
    previous.onLineClick === next.onLineClick &&
    sameRange(previous.cursorSelection, next.cursorSelection) &&
    previous.searchHit === next.searchHit &&
    previous.chunkSpans === next.chunkSpans &&
    previous.threadMarks === next.threadMarks &&
    previous.reviewedFolded === next.reviewedFolded &&
    previous.onShowReviewed === next.onShowReviewed &&
    previous.fileThreadIds === next.fileThreadIds
  );
}

function sameRange(
  a: SelectedLineRange | null | undefined,
  b: SelectedLineRange | null | undefined,
) {
  if (!a || !b) return a === b;
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.side === b.side &&
    a.endSide === b.endSide
  );
}

function DiffContentViewInner({
  selectionRevision = 0,
  cursorGoTo = null,
  scopeControls,
  headEnd,
  errorBack,
  entry,
  file,
  loading,
  error,
  entries = [],
  files = {},
  fileErrors = {},
  loadingKeys = [],
  summaryLoading = false,
  mobile = false,
  resourceKey = "default",
  connectionClient,
  annotations: givenAnnotations = NO_ANNOTATIONS,
  threads: givenThreads,
  repo,
  onSelectFile,
  onRetry,
  onNearbyFilesChange,
  onVisibleFileChange,
  onOpenFile,
  openFileLabel = "Open in Files",
  loadImagePreview,
  onCreateAnnotation,
  onReanchorAnnotations,
  onEditAnnotation,
  embedded = false,
  showFileSelector = true,
  backAction,
  reviewCursor = false,
  onSearchMatchesChange,
  onReviewProgress,
  onOtherFiles,
  otherFileGoTo = null,
  onAddReviewImage,
  onGitAction,
  reviewScope = WORKING_SCOPE,
  viewBar,
  viewKey,
  viewCommands,
  viewCommit,
  viewSingleCommit = false,
  onSearchElsewhere,
  readViewFile,
  forge: forgeView,
  forgeHost,
  agentPanes = NO_AGENT_PANES,
  onFocusAgentPane,
  onThreadsElsewhere,
  onShowThreadView,
  onCloseReview,
  onShowReviews,
  reviewOnly = false,
  placeKey,
  placeSettled = true,
}: {
  selectionRevision?: number;
  /** The scope line as controls (the review in Changes). */
  scopeControls?: ReactNode;
  /** A scope that cannot load: the way back to the review it replaced. */
  errorBack?: { label: string; run: () => void };
  /** At the toolbar's end (Review only: Show all, Zen's way out). */
  headEnd?: ReactNode;
  /** Files' Review: the cursor to that file and line. */
  cursorGoTo?: { path: string; line?: number; at: number } | null;
  entry: GitDiffEntry | null;
  file: GitDiffFile | null;
  loading: boolean;
  error: string | null;
  entries?: GitDiffEntry[];
  files?: Record<string, GitDiffFile>;
  fileErrors?: Record<string, string>;
  loadingKeys?: readonly string[];
  summaryLoading?: boolean;
  mobile?: boolean;
  resourceKey?: string;
  connectionClient: ConnectionClient;
  annotations?: readonly ReviewAnnotation[];
  /** The threads the comments written here are, by the annotations' ids. */
  threads?: readonly ReviewThread[];
  /**
   * The repository shown (the review in Changes): only its comments and
   * threads are drawn, walked, counted and listed.
   */
  repo?: ShownRepo;
  onSelectFile?: (entry: GitDiffEntry) => void;
  /** Read the changes again, offered on an error reading them. */
  onRetry?: () => void;
  onNearbyFilesChange?: (entries: GitDiffEntry[]) => void;
  onVisibleFileChange?: (entry: GitDiffEntry | null) => void;
  /** Opens a file in Files: at a line, rendered (the review's Open). */
  onOpenFile?: (entry: GitDiffEntry, at?: OpenFileAt) => void;
  openFileLabel?: string;
  loadImagePreview?: (path: string) => Promise<FilePreview>;
  /**
   * A comment written. `kind` is what the review's editor
   * wrote: a review comment, or a question for the agent (C, `:ask`; held
   * for Send when the review has no agent).
   */
  onCreateAnnotation?: (
    annotation: NewReviewAnnotation,
    written?: { kind?: ReviewThreadKind },
  ) => void;
  onReanchorAnnotations?: (
    path: string,
    kind: GitDiffKind,
    patch: string,
  ) => void;
  onEditAnnotation?: (id: string) => void;
  embedded?: boolean;
  showFileSelector?: boolean;
  backAction?: { label: string; onClick: () => void };
  /**
   * The review's cursor and keys (with Vim keys on or off: they only
   * change the comment editor); off (an embedded diff), its own keys.
   */
  reviewCursor?: boolean;
  /** The files with a hit of the cursor's search, for the tree to mark. */
  onSearchMatchesChange?: (paths: readonly string[]) => void;
  /** The files' reviewed chunks, for the tree (the review in Changes). */
  onReviewProgress?: (progress: ReadonlyMap<string, ReviewProgress>) => void;
  /**
   * The review's files with no change ("Other files"), for the tree:
   * each with its tick and its open threads.
   */
  onOtherFiles?: (files: readonly OtherFile[]) => void;
  /** One of the Other files picked in the tree: shown; `at` tells apart. */
  otherFileGoTo?: { path: string; at: number } | null;
  /** Stores an image pasted in the review's comment box; Markdown for it. */
  onAddReviewImage?: (file: File) => Promise<string>;
  /** A git action on a file of the working changes (`:stage`, `gs`). */
  onGitAction?: (action: GitFileAction, path: string) => boolean;
  /**
   * The review the scope shown is, found by a read-only
   * lookup; the worktree review when absent.
   */
  reviewScope?: ChangesScope;
  /** What the page does for the Local / GitLab switch. */
  forgeHost?: ForgeHost;
  /**
   * The workspace's agent panes: the review's agent when it has none
   * bound (the first).
   */
  agentPanes?: readonly { paneId: string; agent: string }[];
  /** Go to the agent's pane (the agent's menu); the review is kept. */
  onFocusAgentPane?: (paneId: string) => void;
  /**
   * gn / gN past this view's threads: the next unresolved one in another
   * view of the review (a commit, one rewritten out of it), shown there;
   * false when there is none.
   */
  /**
   * Go to it on a thread written on another view (a commit's, all the
   * changes'): that view shown; false when there is none to show.
   */
  onShowThreadView?: (thread: ReviewThread) => boolean;
  onThreadsElsewhere?: (
    direction: 1 | -1,
    drawn: ReadonlySet<string>,
  ) => boolean;
  /**
   * The review closed (`:q`, Esc with nothing else to leave), as the review
   * toggle closes it; the review is kept.
   */
  onCloseReview?: (how: "command" | "escape") => void;
  /** `:reviews`: the reviews in progress. */
  onShowReviews?: () => void;
  /** Review only is on: Esc leaves it first (the inspector's). */
  reviewOnly?: boolean;
} & ViewProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const { sessions: reviewSessions } = useReviewState();
  // Only the shown repository's: another one's file of the same path never
  // gets its threads.
  const repoRoot = repo?.root;
  const repoOwn = repo?.own;
  // A question held for Send (no agent to ask) is drawn on its line too,
  // saying so.
  const heldRoot =
    reviewCursor && !embedded
      ? (file?.root ?? Object.values(files)[0]?.root)
      : null;
  const shownScope = useScopeByValue(reviewScope);
  // The scope's review's threads the host does not give: a question held
  // for Send, and threads written elsewhere than in Changes (the review
  // pane, an agent's review_add) on the scope's lines.
  const held = useMemo(() => {
    const own = scopeReview(
      [...reviewSessions.values()],
      connectionClient.connectionId,
      heldRoot,
      shownScope,
    );
    const given = new Set((givenThreads ?? []).map((thread) => thread.id));
    return (own?.threads ?? [])
      .filter(
        (thread) =>
          !given.has(thread.id) &&
          (thread.held !== undefined
            ? thread.anchor.feedback !== undefined
            : thread.anchor.feedback === undefined &&
              (scopeLineThread(thread) ||
                // A merge request's: on the whole request too.
                (!!forgeView && scopeGeneralThread(thread)))),
      )
      .flatMap((thread) => {
        // A forge discussion: on its line, found again, on the whole
        // request, or not in this commit's view.
        if (!forgeView) return [thread];
        const placed = placeForgeThread(thread, {
          viewCommit,
          headSha: forgeView.headSha,
          relocations: forgeView.relocations,
        });
        return placed ? [placed] : [];
      });
  }, [
    connectionClient.connectionId,
    givenThreads,
    heldRoot,
    reviewSessions,
    shownScope,
    forgeView,
    viewCommit,
  ]);
  const scopeNoteKind: GitDiffKind =
    reviewScope.kind === "working"
      ? "combined"
      : reviewScope.kind === "step"
        ? "last-step"
        : "branch";
  const scoped = useMemo(
    () =>
      repoFeedback(
        held.length
          ? [
              ...givenAnnotations,
              ...held
                .filter((thread) => thread.anchor.path)
                .map((thread) => scopeNote(thread, scopeNoteKind)),
            ]
          : givenAnnotations,
        held.length ? [...(givenThreads ?? []), ...held] : (givenThreads ?? []),
        (sessionId) => reviewSessions.get(sessionId)?.session.root,
        repoRoot === undefined ? undefined : { root: repoRoot, own: !!repoOwn },
      ),
    [
      givenAnnotations,
      givenThreads,
      held,
      repoOwn,
      repoRoot,
      reviewSessions,
      scopeNoteKind,
    ],
  );
  // With the review's views (the commit bar), a comment shows in the view
  // it was written on: a commit's, or all the changes'.
  const viewed = useMemo(() => {
    const hidden = new Set<string>();
    // Hidden as written on another view (a commit's, all the changes'):
    // still listed in the Comments panel, which shows that view.
    const otherView = new Set<string>();
    // A step's review is drawn on that step only: not on the
    // working tree, the branch or another step.
    for (const thread of scoped.threads) {
      const target = reviewSessions.get(thread.sessionId)?.session.target;
      if (
        target?.kind === "step" &&
        !(
          shownScope.kind === "step" &&
          shownScope.step.before === target.before &&
          shownScope.step.after === target.after
        ) &&
        !(
          shownScope.kind === "review" &&
          shownScope.sessionId === thread.sessionId
        )
      )
        hidden.add(thread.id);
    }
    // A forge discussion's view is its head's (placeForgeThread).
    const forgeIds = new Set(
      forgeView
        ? scoped.threads
            .filter((thread) => thread.kind === "merge-request")
            .map((thread) => thread.id)
        : [],
    );
    for (const note of scoped.annotations) {
      if (note.source !== "diff" || viewCommit === undefined) continue;
      if (forgeIds.has(note.id)) continue;
      const own = note.commit?.sha ?? null;
      const shows =
        own === null
          ? viewCommit === null || viewSingleCommit
          : viewCommit !== null &&
            (own === viewCommit ||
              viewCommit.startsWith(own) ||
              own.startsWith(viewCommit));
      if (shows) continue;
      if (!hidden.has(note.id)) otherView.add(note.id);
      hidden.add(note.id);
    }
    if (!hidden.size) return { ...scoped, otherView: NO_THREADS };
    return {
      annotations: scoped.annotations.filter((note) => !hidden.has(note.id)),
      threads: scoped.threads.filter((thread) => !hidden.has(thread.id)),
      otherView: scoped.threads.filter((thread) => otherView.has(thread.id)),
    };
  }, [
    scoped,
    viewCommit,
    viewSingleCommit,
    reviewSessions,
    shownScope,
    forgeView,
  ]);
  const threads = givenThreads || held.length ? viewed.threads : undefined;
  // One review across Files and Changes: a comment written in Files
  // is drawn on its file's combined diff, at its source line.
  const annotations = useMemo(() => {
    if (!reviewCursor || embedded) return viewed.annotations;
    if (!viewed.annotations.some((note) => note.source === "file"))
      return viewed.annotations;
    const byId = new Map(viewed.threads.map((thread) => [thread.id, thread]));
    return viewed.annotations.map((note) =>
      fileNoteAsDiff(note, byId.get(note.id)),
    );
  }, [embedded, reviewCursor, viewed]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectFileRef = useRef(onSelectFile);
  const openFileRef = useRef(onOpenFile);
  /** The review's Open goes to the cursor's line (the review in Changes). */
  const reviewOpensAtRef = useRef(false);
  reviewOpensAtRef.current = reviewCursor && !embedded;
  const nearbyFilesChangeRef = useRef(onNearbyFilesChange);
  nearbyFilesChangeRef.current = onNearbyFilesChange;
  const visibleFileChangeRef = useRef(onVisibleFileChange);
  visibleFileChangeRef.current = onVisibleFileChange;
  const lastVisibleEntryKeyRef = useRef<string | null>(null);
  const connectionType = useStoreSelector(
    (state) =>
      state.connections.find(
        (connection) => connection.id === connectionClient.connectionId,
      )?.type,
  );
  // The review draws every file, on SSH too (upstream draws only the picked
  // file there).
  const continuous = !embedded && (reviewCursor || connectionType !== "ssh");
  const [nearbyKeys, setNearbyKeys] = useState<readonly string[]>([]);
  const updateNearbyRef = useRef<(() => void) | null>(null);
  const scrollAnchorRef = useRef<{
    key: string;
    offset: number;
    top: number;
  } | null>(null);
  const userScrollUntilRef = useRef(0);
  const scrollbarPointerActiveRef = useRef(false);
  const lastNavigationRef = useRef<{ key: string; revision: number } | null>(
    null,
  );
  const lastActivationRef = useRef<{ key: string; revision: number } | null>(
    null,
  );
  const restoreScrollAnchor = useCallback(() => {
    const anchor = scrollAnchorRef.current;
    if (!continuous || !anchor || scrollbarPointerActiveRef.current) return;
    const scroller = sectionRef.current?.querySelector<HTMLElement>(
      ".pierre-diff-scroll",
    );
    const article = Array.from(
      scroller?.querySelectorAll<HTMLElement>("[data-diff-entry-key]") ?? [],
    ).find((candidate) => candidate.dataset.diffEntryKey === anchor.key);
    if (scroller && article) {
      const top =
        article.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      const userScrolling = performance.now() <= userScrollUntilRef.current;
      // During a gesture compensate only layout changes, preserving native movement.
      const adjustment = userScrolling
        ? top - anchor.top
        : top - scroller.scrollTop + anchor.offset;
      if (userScrolling) anchor.offset = scroller.scrollTop - anchor.top;
      anchor.top = top;
      if (Math.abs(adjustment) > 0.5) scroller.scrollTop += adjustment;
    }
  }, [continuous]);
  const [viewMode, setShownViewMode] = useState<DiffViewMode>(() =>
    loadDiffViewMode(),
  );
  /** A view mode chosen (Split, Unified, S, `:diff`): remembered. */
  const setViewMode = useCallback(
    (update: DiffViewMode | ((mode: DiffViewMode) => DiffViewMode)) =>
      setShownViewMode((current) => {
        const next = typeof update === "function" ? update(current) : update;
        roamgateLocalStorage.setItem(DIFF_VIEW_MODE_KEY, next);
        return next;
      }),
    [],
  );
  /** S, `:diff`: side by side, or unified. */
  const toggleSplit = () =>
    setViewMode((mode) => (mode === "split" ? "unified" : "split"));
  // The review in Changes with no mode chosen: side by side when Changes
  // is wide enough for it, unified below (its width, not the window's).
  useLayoutEffect(() => {
    if (!reviewCursor || embedded || storedDiffViewMode()) return;
    const width = sectionRef.current?.getBoundingClientRect().width ?? 0;
    setShownViewMode(width >= SPLIT_MIN_WIDTH ? "split" : "unified");
  }, [reviewCursor, embedded]);
  const [desktopWrap, setDesktopWrap] = useState(() => loadDesktopDiffWrap());
  const [mobileWrapChoice, setMobileWrapChoice] = useState(() =>
    loadMobileDiffWrap(),
  );
  // A review on a phone wraps until told otherwise: scrolling its lines
  // sideways on a phone is unusable.
  const mobileWrapDefault = reviewCursor && !embedded;
  const mobileWrap = mobileWrapChoice ?? mobileWrapDefault;
  const toggleMobileWrap = () =>
    setMobileWrapChoice((choice) => !(choice ?? mobileWrapDefault));
  useEffect(
    () =>
      subscribeLocalStorage((key) => {
        if (key === null || key === DIFF_VIEW_MODE_KEY)
          setShownViewMode(loadDiffViewMode());
        if (key === null || key === DESKTOP_DIFF_WRAP_KEY)
          setDesktopWrap(loadDesktopDiffWrap());
        if (key === null || key === MOBILE_DIFF_WRAP_KEY)
          setMobileWrapChoice(loadMobileDiffWrap());
      }),
    [],
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingAnnotation, setPendingAnnotation] =
    useState<DiffAnnotationRequest | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [searchIndex, setSearchIndex] = useState(-1);
  const [hunkIndex, setHunkIndex] = useState(-1);
  const hunkIndexRef = useRef(-1);
  const hunkNavigationRevisionRef = useRef(0);
  const [imagePreviews, setImagePreviews] = useState<
    Record<string, ImagePreviewState>
  >({});
  const requestedImagePreviewsRef = useRef(new Map<string, GitDiffFile>());
  const imagePreviewRequestSeqRef = useRef(0);
  const imagePreviewRequestByKeyRef = useRef(new Map<string, number>());
  const [manualCollapseStates, setManualCollapseStates] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map(readDiffCollapseState(resourceKey)));
  const theme = useDocumentTheme();
  const effectiveViewMode: DiffViewMode = mobile ? "unified" : viewMode;
  const splitView = effectiveViewMode === "split";
  const wrapEnabled = mobile ? mobileWrap : desktopWrap;
  const activeEntryKey = entry ? diffEntryKey(entry) : "";
  useEffect(() => {
    if (!activeEntryKey) return;
    const previous = lastActivationRef.current;
    if (
      previous?.key === activeEntryKey &&
      previous.revision === selectionRevision
    )
      return;
    lastActivationRef.current = {
      key: activeEntryKey,
      revision: selectionRevision,
    };
    const explicit = selectionRevision > (previous?.revision ?? 0);
    setManualCollapseStates((current) => {
      if (!explicit) return current;
      const next = expandDiffEntryOnActivate(
        current,
        activeEntryKey,
        diffAutoCollapseInfo(entry!, file) !== null,
        explicit,
      );
      if (next !== current) writeDiffCollapseState(resourceKey, next);
      return next;
    });
  }, [activeEntryKey, entry, file, resourceKey, selectionRevision]);
  const filesByKey = useMemo(() => {
    const merged = { ...files };
    if (entry && file) merged[diffEntryKey(entry)] = file;
    return merged;
  }, [entry, file, files]);
  const visibleEntries = useMemo(
    () => diffContentEntries(entries, entry),
    [entries, entry],
  );
  const annotationsByPath = useMemo(() => {
    const grouped = new Map<string, DiffReviewAnnotation[]>();
    const shownKeys = new Set(visibleEntries.map(diffEntryKey));
    for (const annotation of annotations) {
      if (annotation.source !== "diff") continue;
      const key = annotationSectionKey(annotation, shownKeys);
      const pathAnnotations = grouped.get(key);
      if (pathAnnotations) pathAnnotations.push(annotation);
      else grouped.set(key, [annotation]);
    }
    return grouped;
  }, [annotations, visibleEntries]);
  // The comments' threads, in the file's views: drawn under their lines,
  // listed in the Comments panel, as in the Files preview.
  const threadView = useFileThreadView(() => sectionRef.current);
  const [threadsOpen, setThreadsOpen] = useState(false);
  // The phone's Back closes the conversations first.
  useSystemBack(
    reviewCursor && !embedded && threadsOpen,
    () => setThreadsOpen(false),
    "popup",
  );
  /** The review's comment box and thread keys, "in Changes". */
  const reviewEditor = reviewCursor && !embedded;
  useEffect(() => {
    if (reviewEditor) preloadReviewCommentEditor();
  }, [reviewEditor]);
  /** `t`: every comment hidden (their margin markers stay). */
  const [hideComments, setHideComments] = useState(false);
  /** A suggestion asked for with `s`, the comment box's first words. */
  const [composerSeed, setComposerSeed] = useState<string | undefined>();
  /**
   * What the comment box writes: a review comment or a question for the
   * agent; null: as the review the first comment opens says.
   */
  const [composerKind, setComposerKind] = useState<ReviewThreadKind | null>(
    null,
  );
  const [overallOpen, setOverallOpen] = useState(false);
  /** `:review` alone: the agent review's focus, asked first (Start). */
  const [focusBar, setFocusBar] = useState<string | null>(null);
  const changesAgent = useChangesAgent(
    connectionClient.connectionId,
    reviewEditor
      ? (Object.values(filesByKey)[0]?.root ?? file?.root ?? repo?.root)
      : null,
    Object.values(filesByKey)[0]?.workspace_id ?? file?.workspace_id,
    reviewScope,
    agentPanes,
  );
  /**
   * Why git actions are refused here: the review shown is of another
   * repository than the inspector's checkout (a series repository, a merge
   * request's review worktree, a review from elsewhere), where stage and
   * discard would act on the wrong files. Null: they act here.
   */
  const gitElsewhere = (() => {
    if (!reviewEditor) return null;
    const scopeRoot =
      reviewScope.kind === "review"
        ? changesAgent.snapshot?.session.root
        : undefined;
    const other =
      repo && !repo.own
        ? repo.root
        : scopeRoot &&
            repo?.root &&
            scopeRoot.replace(/\/+$/, "") !== repo.root.replace(/\/+$/, "")
          ? scopeRoot
          : null;
    if (!other) return null;
    const name = other.replace(/\/+$/, "").split("/").pop() || other;
    return `Not on this review: it is of ${name}, not this checkout; stage and discard act on the checkout's files.`;
  })();
  // The Local / GitLab switch (gm, :switch).
  const forgeMode = useForgeMode({
    connectionId: connectionClient.connectionId,
    snapshot: reviewEditor ? changesAgent.snapshot : null,
    open: changesAgent.open,
    host: forgeHost ?? NO_FORGE_HOST,
  });
  // ---- The review's threads ----------------------------------------------

  /** The checkout's review the comments here are in, once there is one. */
  const ownSnapshot = reviewEditor ? changesAgent.snapshot : null;
  const ownSessionId = ownSnapshot?.session.id ?? "";
  const ownCall = useReviewSessionCall(
    connectionClient.connectionId,
    ownSessionId,
  );
  /** What the review last said: a write not saved, a review pass done. */
  const [reviewStatus, setReviewStatus] = useState("");
  // Replies on their way: shown at once, pending, until the review has them.
  const pendingWrites = usePendingWrites({
    threads: (reviewEditor && threads) || NO_THREADS,
    sessionId: changesDraftSession(resourceKey),
    call: ownCall,
    setStatus: setReviewStatus,
    notify: (message) =>
      store.notify({ kind: "info", message, autoDismissMs: 3000 }),
  });
  const drawnThreads =
    reviewEditor && threads ? pendingWrites.threads : threads;
  const setStatusWith = useCallback(
    (update: (current: string) => string) => setReviewStatus(update),
    [],
  );
  /** What the agent group said, on the review's line when it has no bar. */
  const agentSaid = changesAgent.agentName ? "" : changesAgent.status;
  const startAgentReview = (focus: string) => {
    setFocusBar(null);
    changesAgent.review(focus);
    sectionRef.current?.focus({ preventScroll: true });
  };
  const workingAgentName = ownSnapshot
    ? reviewAgent(ownSnapshot, agentPanes).agentName
    : "Agent";
  const statusLine = useReviewStatusLine({
    session: ownSnapshot?.session ?? null,
    threads: drawnThreads ?? NO_THREADS,
    agentName: workingAgentName,
    draftSession: changesDraftSession(resourceKey),
    status: reviewStatus,
    setStatus: setStatusWith,
  });
  // Resolved or reopened, a thread folds as its new state does: a fold
  // flipped by hand is for the state it was flipped in.
  const resolvedBefore = useRef(new Map<string, boolean>());
  useEffect(() => {
    if (!reviewEditor) return;
    const changed = new Set<string>();
    for (const thread of drawnThreads ?? []) {
      const resolved = !!thread.resolved;
      const before = resolvedBefore.current.get(thread.id);
      if (before !== undefined && before !== resolved) changed.add(thread.id);
      resolvedBefore.current.set(thread.id, resolved);
    }
    if ([...changed].some((id) => threadView.flipped.has(id)))
      threadView.setFlipped(
        new Set([...threadView.flipped].filter((id) => !changed.has(id))),
      );
    // Only on new threads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnThreads, reviewEditor]);
  // A new answer in a discussion shows the comments: it is never missed.
  const latestAnswer = reviewEditor ? latestAnswerAt(drawnThreads ?? []) : "";
  const seenAnswer = useRef(latestAnswer);
  useEffect(() => {
    if (latestAnswer <= seenAnswer.current) return;
    seenAnswer.current = latestAnswer;
    setHideComments(false);
  }, [latestAnswer]);
  /** The thread dd or Delete deleted last: what u brings back. */
  const lastDeleted = useRef<ReviewThread | null>(null);
  // The workspace's agent pane when the review has none bound: the page
  // writes the comment to it.
  const ownAgent = ownSnapshot ? reviewAgent(ownSnapshot, agentPanes) : null;
  /** What a new comment is. */
  const commentKind: ReviewThreadKind = ownAgent?.commentKind ?? "draft";
  /** How the review's comments go out: the editors' save policy. */
  const ownDelivery: ComposerDelivery = {
    gitlab: !!ownSnapshot?.session.gitlab,
    talk: ownAgent?.talk ?? false,
    agentNamed: !!ownSnapshot?.session.agent.name,
    holdForSend: ownAgent?.holdForSend ?? false,
  };
  /** An editor's placeholder. */
  const placeholderOf = (editor: {
    kind: ReviewThreadKind;
    replyTo?: string;
    commentId?: string;
    overall?: boolean;
  }) =>
    editorPlaceholder(editor, {
      ...ownDelivery,
      agentName: ownAgent?.agentName ?? "Agent",
    });
  /**
   * How a thread's comments go to its agent: the checkout's review's way,
   * or, for a thread of another review (a rendered file's), that review's.
   */
  const deliveryOf = (
    thread: ReviewThread,
  ): { delivery: ThreadDelivery; canSend: boolean; gitlab: boolean } => {
    const snapshot = reviewSessions.get(thread.sessionId);
    const session = snapshot?.session ?? ownSnapshot?.session;
    if (snapshot && thread.sessionId !== ownSessionId && ownAgent) {
      const own = snapshot.session;
      return {
        delivery: {
          ...sharedThreadDelivery(own, ownAgent.agentName),
          retry: () =>
            void reviewCall(connectionClient.connectionId, "review.retry", {
              session_id: own.id,
            }).catch((error) =>
              setReviewStatus(
                error instanceof Error ? error.message : String(error),
              ),
            ),
        },
        canSend: false,
        gitlab: own.gitlab,
      };
    }
    // The checkout's review talks to the workspace's agent pane when it
    // names none of its own (told to it: useChangesAgent), as the review
    // pane's did.
    const agent = snapshot
      ? reviewAgent(
          snapshot,
          thread.sessionId === ownSessionId ? agentPanes : NO_AGENT_PANES,
        )
      : null;
    return {
      delivery: {
        review: session ?? ({ agent: {} } as ThreadDelivery["review"]),
        talk: agent?.talk ?? false,
        held: agent?.held ?? false,
        undeliveredReason: agent?.undeliveredReason ?? null,
        agentName: agent?.agentName ?? "Agent",
        retry: () =>
          thread.sessionId === ownSessionId
            ? changesAgent.retryDelivery()
            : changesAgent.send(),
      },
      canSend:
        !!agent?.agentAllowed && (!!session?.agent.name || !!agent.agentPaneId),
      gitlab: !!session?.gitlab,
    };
  };
  const forgeOfThread = (thread: ReviewThread) => {
    const target = reviewSessions.get(thread.sessionId)?.session.target;
    return target?.kind === "mr" && /\/pull\/\d+/.test(target.url)
      ? "GitHub"
      : "GitLab";
  };
  /** The rewrite of a comment opened, its thread unfolded. */
  const openEditor = (thread: ReviewThread, commentId: string) => {
    if (threadView.folded(thread)) threadView.unfold([thread.id]);
    threadView.setEditing(commentId);
  };
  /** A reply to a thread opened, the thread unfolded. */
  const openReply = (thread: ReviewThread) => {
    if (threadView.folded(thread)) threadView.unfold([thread.id]);
    threadView.setReplying(thread.id);
  };
  /** What every review editor in Changes shares. */
  const composerBase = () => ({
    delivery: ownDelivery,
    draftSession: changesDraftSession(resourceKey),
    notify: say,
    ...(onAddReviewImage ? { onAddImage: onAddReviewImage } : {}),
  });
  /** A thread's place, as its editor names it. */
  const threadAnchor = (thread: ReviewThread) => ({
    path: thread.anchor.path ?? "",
    line: thread.anchor.line ?? 0,
    side: thread.anchor.side ?? "new",
    text: thread.anchor.text ?? "",
  });
  /** A write that did not take, said in the review's status. */
  const notSaved = (error: unknown) =>
    setReviewStatus(
      `Not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  /** The keys back where the editor was opened from: the panel, the diff. */
  const backFromComposer = (inPanel: boolean) => {
    if (!inPanel) return focusDiffAfterEditor();
    requestAnimationFrame(() =>
      sectionRef.current
        ?.querySelector<HTMLElement>(".threads-panel")
        ?.focus({ preventScroll: true }),
    );
  };
  /** A reply or a rewrite in the review's editor, under its thread. */
  const threadComposer = (
    thread: ReviewThread,
    comment: ReviewComment | null,
    /** Closes a reply written elsewhere than under its thread (the panel). */
    done?: () => void,
  ) => (
    <ReviewDiffComposer
      key={comment ? `edit:${comment.id}` : `reply:${thread.id}`}
      anchor={threadAnchor(thread)}
      suggestable={null}
      {...(comment
        ? { commentId: comment.id, initial: comment.body }
        : { replyTo: thread.id })}
      placeholder={placeholderOf(
        comment
          ? { kind: thread.kind, commentId: comment.id }
          : { kind: "discussion", replyTo: thread.id },
      )}
      kind={comment ? thread.kind : "discussion"}
      {...composerBase()}
      onSave={(text, plan) => {
        const api = threadWrites(connectionClient.connectionId);
        if (comment && plan.kind === "write" && plan.action === "delete") {
          // Emptied: the comment goes.
          threadView.setEditing(null);
          if (thread.comments.length > 1) api.removeComment(thread, comment);
          else deleteThread(thread);
        } else if (comment) {
          threadView.setEditing(null);
          void api.edit(thread, comment, text).catch(notSaved);
        } else {
          if (done) done();
          else threadView.setReplying(null);
          if (thread.sessionId === ownSessionId)
            pendingWrites.sendWrite(
              {
                id: newClientId(),
                sessionId: thread.sessionId,
                replyTo: thread.id,
                kind: "discussion",
                anchor: thread.anchor,
                text,
                at: new Date().toISOString(),
              },
              editorKey({
                at: 0,
                file: 0,
                kind: "discussion",
                anchor: thread.anchor,
                replyTo: thread.id,
                text: "",
                version: 0,
              }),
            );
          else void api.reply(thread, text, newClientId());
        }
        backFromComposer(!!done);
      }}
      onClose={() => {
        if (comment) threadView.setEditing(null);
        else if (done) done();
        else threadView.setReplying(null);
        backFromComposer(!!done);
      }}
      notify={(message) =>
        store.notify({ kind: "info", message, autoDismissMs: 2500 })
      }
    />
  );
  /** Deletes a thread, said with how to bring it back. */
  const deleteThread = (thread: ReviewThread) => {
    lastDeleted.current = thread;
    threadWrites(connectionClient.connectionId).remove(thread);
    store.notify({
      kind: "info",
      message: "Comment deleted (u undoes)",
      autoDismissMs: 2500,
    });
  };
  const pendingOf = (
    thread: ReviewThread,
    comment: ReviewComment,
    index: number,
  ) =>
    pendingWrites.pendingById.get(comment.id) ??
    (index === 0 ? pendingWrites.pendingById.get(thread.id) : undefined);
  const forge = forgeName(ownSnapshot?.session);
  /** Why "Make it mine" failed, by thread: shown on the thread. */
  const [adoptFailures, setAdoptFailures] = useState<
    Readonly<Record<string, string>>
  >({});
  /** "Make it mine": the agent's words become the user's forge draft. */
  const adoptBar = (thread: ReviewThread) => {
    if (thread.sessionId !== ownSessionId) return null;
    if (!adoptable(ownSnapshot?.session, thread)) return null;
    const failure = adoptFailures[thread.id];
    return (
      <div className="chat-thread-bar">
        {failure ? (
          <span className="rc-kind rc-failed" role="alert">
            Not made yours: {failure}
          </span>
        ) : null}
        <button
          type="button"
          title={`Its text becomes your draft on ${forge}; you submit your review there. Edit it there or here after.`}
          onClick={() => {
            setAdoptFailures((failures) => {
              const kept = { ...failures };
              delete kept[thread.id];
              return kept;
            });
            // Read back after, as every write on the review.
            ownCall("review.adopt", { thread_id: thread.id }).catch(
              (error: unknown) =>
                setAdoptFailures((failures) => ({
                  ...failures,
                  [thread.id]:
                    error instanceof Error ? error.message : String(error),
                })),
            );
          }}
        >
          Make it mine
        </button>
      </div>
    );
  };
  /** A draft reply to a forge discussion, or its rewrite, in the editor. */
  const forgeComposer = (
    thread: ReviewThread,
    comment: ReviewComment | null,
  ) => (
    <ReviewDiffComposer
      key={comment ? `edit:${comment.id}` : `reply:${thread.id}`}
      anchor={threadAnchor(thread)}
      suggestable={null}
      {...(comment
        ? { commentId: comment.id, initial: comment.body }
        : { replyTo: thread.id })}
      placeholder={editorPlaceholder(
        comment
          ? { kind: "merge-request", commentId: comment.id }
          : { kind: "merge-request", replyTo: thread.id, publicReply: true },
        {
          ...ownDelivery,
          agentName: ownAgent?.agentName ?? "Agent",
          forge,
        },
      )}
      kind="merge-request"
      {...composerBase()}
      onSave={(text, plan) => {
        if (comment) threadView.setEditing(null);
        else threadView.setReplying(null);
        if (plan.kind === "write" && plan.action !== "none") {
          const params =
            plan.action === "reply"
              ? { comment_id: thread.id, text }
              : plan.action === "delete"
                ? { comment_id: comment?.id }
                : { comment_id: comment?.id, text };
          const method =
            plan.action === "reply"
              ? "review.reply"
              : plan.action === "delete"
                ? "review.delete"
                : "review.edit";
          void writeReviewSession(
            connectionClient.connectionId,
            thread.sessionId,
            method,
            params,
          ).catch(notSaved);
        }
        focusDiffAfterEditor();
      }}
      onClose={() => {
        if (comment) threadView.setEditing(null);
        else threadView.setReplying(null);
        focusDiffAfterEditor();
      }}
    />
  );
  const agentWorking = ownSnapshot?.session.agent.working;
  const reviewLook: ReviewThreadLook | undefined = reviewEditor
    ? {
        // New-side lines of each file shown, for what suggestions replace.
        newLines: (path: string) =>
          cursorHandle.current.model.newLinesByPath.get(path) ?? new Map(),
        working: (thread) =>
          agentWorking?.threadId === thread.id ? (
            <ReviewWorking
              agentName={workingAgentName}
              message={agentWorking.message}
              at={agentWorking.at}
            />
          ) : null,
        forge: {
          outdatedLine: (thread) =>
            forgeView?.relocations.get(thread.id)?.wasLine,
          editor: forgeComposer,
        },
        partEditor: (thread, part, done) => (
          <ReviewDiffComposer
            key={`part:${part.comment}:${part.quote}`}
            anchor={{ ...threadAnchor(thread), message: part }}
            suggestable={null}
            kind="discussion"
            {...composerBase()}
            placeholder={placeholderOf({ kind: "discussion" })}
            onSave={(text) => {
              done();
              void threadWrites(connectionClient.connectionId)
                .addPart(thread, part, text, newClientId())
                .catch(notSaved);
              focusDiffAfterEditor();
            }}
            onClose={() => {
              done();
              focusDiffAfterEditor();
            }}
          />
        ),
        messageClass: (thread, comment, index) =>
          pendingOf(thread, comment, index) ? " is-pending" : "",
        messageEditor: (thread, comment) =>
          threadView.editing === comment.id
            ? threadComposer(thread, comment)
            : null,
        messageBar: (thread, comment, index) => {
          const { delivery, canSend, gitlab } = deliveryOf(thread);
          return (
            <ReviewMessageBar
              thread={thread}
              comment={comment}
              index={index}
              delivery={delivery}
              canSend={canSend}
              sendLabel={gitlab ? `Send to ${delivery.agentName}` : "Send"}
              onSend={() => changesAgent.send()}
              forge={forgeOfThread(thread)}
              {...(() => {
                const pending = pendingOf(thread, comment, index);
                return pending ? { pending } : {};
              })()}
              onRetryWrite={pendingWrites.retryWrite}
              onDiscardWrite={pendingWrites.discardWrite}
              onEdit={() => openEditor(thread, comment.id)}
              onDelete={() => deleteThread(thread)}
            />
          );
        },
        threadBar: (thread) => {
          if (pendingWrites.pendingById.has(thread.id)) return null;
          if (thread.kind !== "discussion" && thread.comments.length < 2)
            return adoptBar(thread);
          if (threadView.replying === thread.id)
            return threadComposer(thread, null);
          return (
            <div className="chat-thread-bar">
              <button
                type="button"
                onClick={() => {
                  threadView.setEditing(null);
                  threadView.setReplying(thread.id);
                }}
              >
                Reply
              </button>
              <button
                type="button"
                onClick={() =>
                  threadWrites(connectionClient.connectionId).resolve(thread)
                }
              >
                {thread.resolved ? "Reopen" : "Resolve"}
              </button>
              {thread.resolved ? (
                <button
                  type="button"
                  onClick={() => threadView.toggleFold(thread)}
                >
                  Fold
                </button>
              ) : null}
            </div>
          );
        },
      }
    : undefined;
  const shownThreads = useMemo(
    () =>
      diffViewThreads(
        annotations,
        drawnThreads ?? [],
        visibleEntries,
        reviewEditor,
      ),
    [annotations, reviewEditor, drawnThreads, visibleEntries],
  );
  const diffThreads: DiffThreads | null = (() => {
    if (!drawnThreads?.length) return null;
    return {
      byId: new Map(drawnThreads.map((each) => [each.id, each])),
      api: threadWrites(connectionClient.connectionId),
      view: threadView,
      nested: reviewEditor ? nestThreads(drawnThreads).nested : NO_NESTED,
      undelivered: reviewsUndelivered(
        [...new Set(drawnThreads.map((each) => each.sessionId))].map((id) =>
          reviewSessions.get(id),
        ),
      ),
      ...(reviewLook ? { review: reviewLook } : {}),
    };
  })();
  /** A thread of the Comments panel, shown under its line. */
  const goToThread = useCallback(
    (thread: ReviewThread) => {
      if (threadView.folded(thread)) threadView.toggleFold(thread);
      requestAnimationFrame(() =>
        sectionRef.current
          ?.querySelector(
            `.chat-thread[data-thread-id="${CSS.escape(thread.id)}"]`,
          )
          ?.scrollIntoView({ block: "center" }),
      );
    },
    [threadView],
  );
  const changedFileCount = entries.length || visibleEntries.length;
  // Context revealed around the hunks (the review in Changes): Roamgate's
  // expansion, written into the patch Pierre draws (changesExpand.ts).
  const [expansions, setExpansions] = useState<
    ReadonlyMap<string, { source: string; expansion: FileExpansion }>
  >(() => new Map());
  const gapRowRef = useRef<(key: string, index: number) => ReactNode>(
    () => null,
  );
  const expandedCache = useRef(
    new Map<
      string,
      {
        source: GitDiffFile;
        expansion: FileExpansion | undefined;
        file: GitDiffFile;
        gaps: ChangesGap[];
      }
    >(),
  );
  /** A file's patch with its revealed context, and its hidden gaps. */
  const expandedFile = (key: string, file: GitDiffFile | null) => {
    if (!reviewCursor || embedded || !file?.diff) return null;
    const kept = expansions.get(key);
    const expansion = kept?.source === file.diff ? kept.expansion : undefined;
    const cached = expandedCache.current.get(key);
    if (cached?.source === file && cached.expansion === expansion)
      return cached;
    const expanded = expandPatch(file.diff, expansion);
    const entry = {
      source: file,
      expansion,
      file:
        expanded.patch === file.diff ? file : { ...file, diff: expanded.patch },
      // A commit's message is drawn whole: nothing hidden around it.
      gaps: file.path === COMMIT_MESSAGE_PATH ? [] : expanded.gaps,
    };
    expandedCache.current.set(key, entry);
    return entry;
  };
  const renderedSections = useMemo<DiffSection[]>(
    () =>
      visibleEntries.map((visibleEntry) => {
        const key = diffEntryKey(visibleEntry);
        const diffFile = filesByKey[key] ?? null;
        const shownFile = diffRenderableFile(diffFile);
        const renderableFile = shownFile
          ? (expandedFile(key, shownFile)?.file ?? shownFile)
          : shownFile;
        const imagePreview =
          !!renderableFile &&
          isImageDiff(visibleEntry.path, renderableFile.diff);
        const autoCollapse = diffAutoCollapseInfo(visibleEntry, diffFile);
        const defaultCollapsed = autoCollapse !== null;
        const active = key === activeEntryKey;
        return {
          key,
          active,
          entry: visibleEntry,
          file: renderableFile,
          imagePreview,
          autoCollapse,
          collapsed: diffSectionCollapsed({
            continuous,
            embedded,
            active,
            manual: manualCollapseStates.get(key),
            autoCollapsed: defaultCollapsed,
          }),
          error: fileErrors[key] ?? null,
        };
      }),
    // expandedFile reads expansions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeEntryKey,
      continuous,
      embedded,
      expansions,
      fileErrors,
      filesByKey,
      manualCollapseStates,
      reviewCursor,
      visibleEntries,
    ],
  );
  /** Each section's gaps still hidden, by its key. */
  const gapsByKey = useMemo(() => {
    const byKey = new Map<string, ChangesGap[]>();
    for (const section of renderedSections) {
      const gaps = expandedCache.current.get(section.key)?.gaps;
      if (gaps?.length && !section.collapsed) byKey.set(section.key, gaps);
    }
    return byKey;
  }, [renderedSections]);
  const renderedSectionsRef = useRef(renderedSections);
  renderedSectionsRef.current = renderedSections;
  const nearbyKeySet = useMemo(() => new Set(nearbyKeys), [nearbyKeys]);
  const imagePreviewTargets = useMemo(
    () =>
      renderedSections.flatMap((section) =>
        !section.collapsed &&
        (!continuous || nearbyKeySet.has(section.key)) &&
        section.imagePreview &&
        section.file
          ? [
              {
                key: imagePreviewKey(connectionClient, section.file),
                file: section.file,
              },
            ]
          : [],
      ),
    [connectionClient, continuous, nearbyKeySet, renderedSections],
  );
  const searchResult = useMemo(
    () => diffSearchGroups(visibleEntries, filesByKey, deferredSearchQuery),
    [deferredSearchQuery, filesByKey, visibleEntries],
  );
  const searchMatchCount = searchResult.count;
  const currentSearchEntryKey = searchEntryKey(
    searchResult.groups,
    searchIndex,
  );
  const hasSearchableDiff = useMemo(
    () => Object.values(filesByKey).some((candidate) => !!candidate.diff),
    [filesByKey],
  );
  const hunkTargets = useMemo(
    () => diffHunkTargets(file?.diff ?? ""),
    [file?.diff],
  );
  const handleSelectFile = useCallback((target: GitDiffEntry) => {
    selectFileRef.current?.(target);
  }, []);
  const handleOpenFile = useCallback(
    (target: GitDiffEntry, at?: OpenFileAt) => {
      // The review's Open: at the cursor line when it is in that file (a
      // removed line's old number is near enough).
      const where = reviewOpensAtRef.current
        ? cursorHandle.current.where()
        : null;
      const line =
        where?.path === target.path ? (where.new ?? where.old) : null;
      openFileRef.current?.(target, {
        ...at,
        ...(line !== null && line !== undefined ? { line } : {}),
      });
    },
    [],
  );
  const handleRequestAnnotation = useCallback(
    (target: DiffAnnotationRequest) => setPendingAnnotation(target),
    [],
  );
  const closeAnnotationComposer = useCallback(
    () => setPendingAnnotation(null),
    [],
  );
  const saveAnnotation = useCallback(
    (comment: string, kind?: ReviewThreadKind) => {
      if (!pendingAnnotation || !onCreateAnnotation) return;
      const note: NewReviewAnnotation = {
        source: "diff",
        path: pendingAnnotation.path,
        kind: pendingAnnotation.kind,
        side: pendingAnnotation.side,
        line: pendingAnnotation.line,
        ...(pendingAnnotation.endSide === undefined
          ? {}
          : { endSide: pendingAnnotation.endSide }),
        ...(pendingAnnotation.endLine === undefined
          ? {}
          : { endLine: pendingAnnotation.endLine }),
        quote: pendingAnnotation.quote,
        hunk: pendingAnnotation.hunk,
        comment,
      };
      if (kind) onCreateAnnotation(note, { kind });
      else onCreateAnnotation(note);
      setPendingAnnotation(null);
    },
    [onCreateAnnotation, pendingAnnotation],
  );
  const annotationComposerDraft: AnnotationComposerDraft | null =
    pendingAnnotation
      ? {
          x: pendingAnnotation.x,
          y: pendingAnnotation.y,
          title: `${pendingAnnotation.path} · ${diffReviewLineLabel(pendingAnnotation)}`,
          quote: pendingAnnotation.quote,
        }
      : null;
  const goToHunk = useCallback(
    (delta: -1 | 1) => {
      if (!hunkTargets.length) return;
      const nextIndex = nextDiffHunkIndex(
        hunkIndexRef.current,
        delta,
        hunkTargets.length,
      );
      const target = hunkTargets[nextIndex];
      hunkIndexRef.current = nextIndex;
      setHunkIndex(nextIndex);
      const navigationRevision = ++hunkNavigationRevisionRef.current;

      let attempts = 0;
      const reveal = () => {
        if (hunkNavigationRevisionRef.current !== navigationRevision) return;
        const section = sectionRef.current;
        if (!section) return;
        const activeArticle = Array.from(
          section.querySelectorAll<HTMLElement>(".diff-file-section"),
        ).find(
          (candidate) => candidate.dataset.diffEntryKey === activeEntryKey,
        );
        const selectors = [
          target.newLine === null
            ? ""
            : `[data-line='${target.newLine}'][data-line-type='change-addition']`,
          target.oldLine === null
            ? ""
            : `[data-line='${target.oldLine}'][data-line-type='change-deletion']`,
          target.newLine === null
            ? ""
            : `[data-line='${target.newLine}'][data-line-type^='change-']`,
          target.oldLine === null
            ? ""
            : `[data-line='${target.oldLine}'][data-line-type^='change-']`,
        ].filter(Boolean);
        const line = activeArticle
          ? deepQuerySelector(activeArticle, selectors)
          : null;
        if (line) {
          userScrollUntilRef.current = performance.now() + 150;
          line.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        attempts += 1;
        if (attempts === 8) {
          const scroller = section.querySelector<HTMLElement>(
            ".pierre-diff-scroll",
          );
          if (scroller) {
            userScrollUntilRef.current = performance.now() + 150;
            const targetLine = target.newLine ?? target.oldLine ?? 1;
            const maxTargetLine = Math.max(
              1,
              ...hunkTargets.map(
                (candidate) => candidate.newLine ?? candidate.oldLine ?? 1,
              ),
            );
            const ratio = (targetLine - 1) / Math.max(1, maxTargetLine - 1);
            const availableHeight = activeArticle
              ? Math.max(0, activeArticle.scrollHeight - scroller.clientHeight)
              : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            scroller.scrollTo({
              top: (activeArticle?.offsetTop ?? 0) + ratio * availableHeight,
              behavior: "auto",
            });
          }
        }
        if (attempts < 24) requestAnimationFrame(reveal);
      };
      requestAnimationFrame(reveal);
    },
    [activeEntryKey, hunkTargets],
  );
  const completeImagePreview = useCallback(
    (key: string, state: ImagePreviewState) => {
      setImagePreviews((current) => ({ ...current, [key]: state }));
    },
    [],
  );
  const pierreOptions = useMemo<DiffSurfaceOptions>(
    () =>
      diffSurfaceOptions({
        diffStyle: effectiveViewMode === "split" ? "split" : "unified",
        wrap: wrapEnabled,
        themeType: theme,
        // The review's own gap rows say what is hidden there: Pierre's
        // separator only marks the gap.
        ...(reviewCursor && !embedded
          ? { hunkSeparators: "simple" as const }
          : {}),
        onPostRender: () => {
          if (performance.now() <= userScrollUntilRef.current)
            restoreScrollAnchor();
        },
      }),
    [
      effectiveViewMode,
      restoreScrollAnchor,
      theme,
      wrapEnabled,
      reviewCursor,
      embedded,
    ],
  );

  /*
   * The review's Vim cursor, on the files drawn as diffs; only where the
   * inspector shows Changes "in Changes" with Vim keys on.
   */
  const cursorSections = useMemo(
    () =>
      renderedSections.map((section) => ({
        key: section.key,
        path: section.entry.path,
        patch:
          !section.collapsed && !section.imagePreview && section.file?.diff
            ? section.file.diff
            : null,
      })),
    [renderedSections],
  );
  const inspectorRunRef = useRef<((input: string) => void) | null>(null);
  const reviewHandlers = useRef<{
    comment: (
      key: string,
      range: SelectedLineRange,
      mode: CommentMode,
    ) => boolean;
    threadKey: (key: string, count: number | null) => boolean;
    move: (direction: 1 | -1, count: number) => number | null;
    markFile: () => void;
  }>({
    comment: () => false,
    threadKey: () => false,
    move: () => null,
    markFile: () => {},
  });
  // The rows of folded reviewed chunks (set once they are known, below).
  const foldedRowsRef = useRef<ReadonlySet<number>>(new Set());
  // Unfolds what hides a row (a search's hit): set with the folds, below.
  const revealRowRef = useRef<(row: number) => void>(() => {});
  const cursor = useDiffCursor({
    enabled: reviewCursor && !embedded,
    sections: cursorSections,
    split: effectiveViewMode === "split",
    rootRef: sectionRef,
    onToggleSplit: toggleSplit,
    onReload: onRetry,
    ...(onSearchElsewhere ? { searchElsewhere: onSearchElsewhere } : {}),
    runCommand: (input) => {
      if (!inspectorRunRef.current) return false;
      inspectorRunRef.current(input);
      return true;
    },
    notify: (message) =>
      store.notify({ kind: "info", message, autoDismissMs: 2000 }),
    selectionRevision,
    selectedKey: activeEntryKey || null,
    onScrollTo: () => {
      userScrollUntilRef.current = performance.now() + 150;
    },
    goTo: cursorGoTo,
    skipRow: (row: number) => foldedRowsRef.current.has(row),
    revealRow: (row: number) => revealRowRef.current(row),
    ...(reviewEditor
      ? {
          onComment: (
            key: string,
            range: SelectedLineRange,
            mode: CommentMode,
          ) => reviewHandlers.current.comment(key, range, mode),
          threadKey: (key: string, count: number | null) =>
            reviewHandlers.current.threadKey(key, count),
          threadMove: (direction: 1 | -1, count: number) =>
            reviewHandlers.current.move(direction, count),
          onMarkFile: () => reviewHandlers.current.markFile(),
        }
      : {}),
  });
  const cursorHandle = useRef<DiffCursor>(cursor);
  cursorHandle.current = cursor;
  // The review's place: the cursor's file and line, kept in the browser
  // per review and back after a reload or when the review shows again.
  // Read once the review's rows are drawn, before any is written.
  const placeId = reviewEditor
    ? (ownSnapshot?.session.id ?? placeKey ?? null)
    : null;
  const placeRead = useRef<string | null>(null);
  const here = cursor.active ? cursor.where() : null;
  const placeRows = cursor.model.rows.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cursor's line
  useEffect(() => {
    if (!placeId || !cursor.active || !placeRows) return;
    if (placeRead.current !== placeId) {
      if (!placeSettled) return;
      if (cursorGoTo && Date.now() - cursorGoTo.at < GO_TO_FRESH_MS) {
        // Sent to a line (Files' Review, a thread): that line, not the
        // place left.
        placeRead.current = placeId;
        return;
      }
      const place = readReviewPlace(placeId);
      const line = place?.new ?? place?.old ?? null;
      const section = place?.path
        ? cursorSections.find((each) => each.path === place.path)
        : undefined;
      if (
        section &&
        line !== null &&
        !cursorHandle.current.goTo(
          section.key,
          line,
          place?.new != null ? "new" : "old",
        )
      )
        // Its file not drawn yet: tried again as it is.
        return;
      // Its file is not in the view (gone, another commit): left as it is,
      // once the view has settled.
      if (place?.path && !section && (loading || summaryLoading)) return;
      placeRead.current = placeId;
      // Gone back there: written once the cursor is on it. Else the review
      // is the latest one moved in from now on, as the pane keeps it.
      if (section && line !== null) return;
    }
    if (!here) return;
    writeReviewPlace(placeId, {
      ...(readReviewPlace(placeId) ?? { commit: null }),
      path: here.path,
      old: here.old,
      new: here.new,
    });
  }, [placeId, placeRows, placeSettled, here?.path, here?.old, here?.new]);
  // The review's reviewed marks on the rows shown.
  const reviewLayout = useMemo(
    () => reviewedLayout(cursor.model),
    [cursor.model],
  );
  const reviewedMarks = changesAgent.snapshot?.session.reviewed ?? NO_MARKS;
  const ownReviewId = changesAgent.snapshot?.session.id;
  // The commit shown keeps its own marks (its sha).
  const reviewView = changesReviewView(viewCommit);
  const reviewState = useMemo(
    () => reviewedState(reviewLayout.files, reviewView, reviewedMarks),
    [reviewLayout, reviewedMarks, reviewView],
  );
  /**
   * The review's files with no change: commented on or ticked in
   * Files (or here), listed under the changed files with their threads.
   */
  const otherFiles = useMemo(
    () =>
      reviewEditor
        ? otherReviewFiles(
            // The worktree review's own: an older rendered file's review
            // keeps its threads (shown in Files, and here on a change).
            (drawnThreads ?? NO_THREADS).filter(
              (thread) => thread.sessionId === ownReviewId,
            ),
            reviewedMarks,
            new Set(entries.map((each) => each.path)),
          )
        : NO_OTHER_FILES,
    [drawnThreads, entries, ownReviewId, reviewEditor, reviewedMarks],
  );
  /**
   * The threads the Comments panel lists, and the head counts: those on
   * the files shown, then the Other files'; in the review, those on the
   * whole review too (drawn above the diff).
   */
  const listedThreads = useMemo(() => {
    const general = reviewEditor
      ? (drawnThreads ?? []).filter((thread) => !thread.anchor.path)
      : [];
    if (!otherFiles.length && !general.length) return shownThreads;
    const listed = new Set(shownThreads.map((thread) => thread.id));
    const more = [
      ...otherFiles.flatMap((other) => other.threads),
      ...general,
    ].filter((thread) => {
      if (listed.has(thread.id)) return false;
      listed.add(thread.id);
      return true;
    });
    return [...shownThreads, ...more];
  }, [drawnThreads, otherFiles, reviewEditor, shownThreads]);
  const otherFileOf = (thread: ReviewThread) =>
    otherFiles.find((other) => other.threads.includes(thread))?.path;
  /** Shows an Other file's block (its threads), from the panel or the tree. */
  const showOtherFile = (path: string) =>
    sectionRef.current
      ?.querySelector<HTMLElement>(`[data-other-file="${CSS.escape(path)}"]`)
      ?.scrollIntoView?.({ block: "start" });
  const otherFilesRef = useRef(onOtherFiles);
  otherFilesRef.current = onOtherFiles;
  useEffect(() => {
    if (reviewEditor) otherFilesRef.current?.(otherFiles);
  }, [otherFiles, reviewEditor]);
  /** Each combined section's staged lines, as the server told them. */
  const stagedLinesByKey = useMemo(() => {
    const staged = new Map<string, GitDiffFile["staged"]>();
    for (const [key, each] of Object.entries(filesByKey))
      if (key.startsWith("combined:")) staged.set(key, each.staged);
    return staged;
  }, [filesByKey]);
  const chunkSpansByKey = useMemo(
    () => chunkSpans(cursor.model, reviewLayout, reviewState, stagedLinesByKey),
    [cursor.model, reviewLayout, reviewState, stagedLinesByKey],
  );
  const cursorMatching = useMemo(
    () => new Set(cursor.matchingPaths),
    [cursor.matchingPaths],
  );
  const reviewProgressRef = useRef(onReviewProgress);
  reviewProgressRef.current = onReviewProgress;
  useEffect(() => {
    if (!reviewEditor) return;
    const progress = new Map<string, ReviewProgress>();
    reviewLayout.files.forEach((info, index) => {
      if (!info.hunks.length) return;
      progress.set(info.path, {
        done: reviewState.hunks[index]?.size ?? 0,
        total: info.hunks.length,
        reviewed: reviewState.files.has(index),
      });
    });
    reviewProgressRef.current?.(progress);
  }, [reviewEditor, reviewLayout, reviewState]);
  const searchMatchesChangeRef = useRef(onSearchMatchesChange);
  searchMatchesChangeRef.current = onSearchMatchesChange;
  useEffect(() => {
    searchMatchesChangeRef.current?.(cursor.matchingPaths);
  }, [cursor.matchingPaths]);
  const cursorLineClick = useCallback(
    (
      key: string,
      line: number,
      side: "deletions" | "additions",
      shift: boolean,
    ) => {
      sectionRef.current?.focus({ preventScroll: true });
      // Hidden, a click on a commented line shows the comments.
      if (revealHiddenRef.current(key, line, side)) {
        cursorLineClickRef.current(key, line, side, shift);
        return false;
      }
      const taken = cursorLineClickRef.current(key, line, side, shift);
      // A click on a folded reviewed chunk's line shows the chunk.
      requestAnimationFrame(() => peekFoldedRef.current());
      return taken;
    },
    [],
  );
  const peekFoldedRef = useRef(() => {});
  const revealHiddenRef = useRef<
    (key: string, line: number, side: "deletions" | "additions") => boolean
  >(() => false);
  // The cursor's keys keep the focus: a browser can hand it to the page's
  // first control after a key the cursor took (seen in Chrome after zz and
  // after the review toggle's chord); with no key or press since, it comes
  // back to the diff. A key or a press elsewhere moves it as usual.
  const cursorKeyRef = useRef<KeyboardEvent | null>(null);
  useEffect(() => {
    const section = sectionRef.current;
    if (!cursor.active || !section) return;
    let lastKey: KeyboardEvent | null = null;
    let pressed = false;
    const onKey = (event: KeyboardEvent) => {
      lastKey = event;
      pressed = false;
    };
    const onPress = () => {
      pressed = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof HTMLElement) || pressed) return;
      if (lastKey === null || lastKey !== cursorKeyRef.current) return;
      const slot = section.closest(".workspace-inspector-slot") ?? section;
      if (slot.contains(next)) return;
      // A picker the key opened (p: the repositories) has the keys.
      if (next.closest("[data-radix-popper-content-wrapper], [role='dialog']"))
        return;
      setTimeout(() => {
        if (document.activeElement === next && section.isConnected)
          section.focus({ preventScroll: true });
      }, 0);
    };
    const doc = section.ownerDocument;
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onPress, true);
    section.addEventListener("focusout", onFocusOut);
    return () => {
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onPress, true);
      section.removeEventListener("focusout", onFocusOut);
    };
  }, [cursor.active]);
  const cursorActiveRef = useRef(cursor.active);
  cursorActiveRef.current = cursor.active;
  const cursorLineClickRef = useRef(cursor.onLineClick);
  cursorLineClickRef.current = cursor.onLineClick;

  // ---- The review's threads and comment box ------------------------------

  const drawingSections = useMemo(
    () =>
      renderedSections.map((section) => ({
        key: section.key,
        path: section.entry.path,
      })),
    [renderedSections],
  );
  const pendingNotes = usePendingFeedback();
  const diffNotes = useMemo(() => {
    const notes = annotations.filter(
      (note): note is DiffReviewAnnotation => note.source === "diff",
    );
    if (!reviewEditor) return notes;
    // A comment on its way to the server is drawn too: Sending..., or why
    // it did not get there.
    const known = new Set(notes.map((note) => note.id));
    for (const { note } of pendingNotes.values())
      if (
        note.source === "diff" &&
        !known.has(note.id) &&
        (repoRoot === undefined ||
          repoFeedback([note], [], () => undefined, {
            root: repoRoot,
            own: !!repoOwn,
          }).annotations.length > 0)
      )
        notes.push(note);
    return notes;
  }, [annotations, pendingNotes, repoOwn, repoRoot, reviewEditor]);
  /** The threads drawn inside the message they comment on a part of. */
  const partThreadIds = useMemo(
    () =>
      new Set(
        [...(diffThreads?.nested.values() ?? [])]
          .flat()
          .map((thread) => thread.id),
      ),
    [diffThreads],
  );
  const placement = useMemo(
    () =>
      reviewEditor
        ? placeDiffThreads(
            diffNotes.filter((note) => !partThreadIds.has(note.id)),
            diffThreads?.byId ?? new Map(),
            drawingSections,
            cursor.model.rows,
          )
        : null,
    [
      cursor.model.rows,
      diffNotes,
      diffThreads,
      drawingSections,
      partThreadIds,
      reviewEditor,
    ],
  );
  const readingOrder = useMemo<PlacedThread[]>(
    () =>
      placement ? threadReadingOrder(placement.placed, drawingSections) : [],
    [drawingSections, placement],
  );
  /** Each file's lines with a thread, marked in their margin. */
  const threadMarksByKey = useMemo(() => {
    const marks = new Map<string, string[]>();
    for (const placed of readingOrder) {
      const list = marks.get(placed.key) ?? [];
      list.push(`${placed.side}:${placed.line}`);
      marks.set(placed.key, list);
    }
    return new Map(
      [...marks].map(([key, list]) => [key, [...new Set(list)].join(",")]),
    );
  }, [readingOrder]);
  // Reviewed chunks fold to one line unless a thread is on them or they
  // are peeked at (za, a click on the line).
  const [peekedChunks, setPeekedChunks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const foldedSpansByKey = useMemo(() => {
    // The same spans when nothing folds: Pierre is not drawn again for it.
    let any = false;
    const folded = new Map<string, ChunkSpan[]>();
    for (const [key, spans] of chunkSpansByKey) {
      let changed = false;
      const next = spans.map((span) => {
        if (!span.reviewed || peekedChunks.has(`${key}\n${span.id}`))
          return span;
        const talked = readingOrder.some((placed) => {
          if (placed.key !== key) return false;
          const range = placed.side === "old" ? span.removed : span.added;
          return !!range && placed.line >= range[0] && placed.line <= range[1];
        });
        if (talked) return span;
        changed = true;
        return { ...span, folded: true };
      });
      if (changed) any = true;
      folded.set(key, changed ? next : spans);
    }
    return any ? folded : chunkSpansByKey;
  }, [chunkSpansByKey, peekedChunks, readingOrder]);
  // Reviewed files fold to their header until shown again (Show, a click
  // on the name, gn to a thread there); shown, a file stays open until it
  // is unmarked.
  const [shownReviewed, setShownReviewed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const reviewedPaths = useMemo(
    () =>
      new Set(
        reviewLayout.files
          .filter((_, index) => reviewState.files.has(index))
          .map((info) => info.path),
      ),
    [reviewLayout, reviewState],
  );
  // Files' Review or a tree pick to a folded file: open before the cursor
  // goes there (its lines must be the cursor's when it moves).
  const goToDone = useRef<number | null>(null);
  const goToReveal =
    cursorGoTo && goToDone.current !== cursorGoTo.at ? cursorGoTo.path : null;
  // A file picked in the tree, the same way: open as the cursor goes to it.
  const pickDone = useRef(selectionRevision);
  const pickReveal =
    selectionRevision > 0 && pickDone.current !== selectionRevision
      ? (entry?.path ?? null)
      : null;
  const foldedFiles = useMemo(() => {
    const folded = new Set<string>();
    if (!reviewEditor) return folded;
    for (const path of reviewedPaths)
      if (
        !shownReviewed.has(path) &&
        path !== goToReveal &&
        path !== pickReveal
      )
        folded.add(path);
    return folded;
  }, [goToReveal, pickReveal, reviewEditor, reviewedPaths, shownReviewed]);
  /** The chunks a reviewed file shown again was opened with (its peeks). */
  const shownChunks = useRef(new Map<string, string[]>());
  useEffect(() => {
    // Unmarked: the next mark folds it again, its chunks too.
    const dropped = [...shownChunks.current.keys()].filter(
      (path) => !reviewedPaths.has(path),
    );
    if (dropped.length) {
      const ids = new Set(
        dropped.flatMap((path) => shownChunks.current.get(path) ?? []),
      );
      for (const path of dropped) shownChunks.current.delete(path);
      setPeekedChunks((current) => {
        const next = new Set([...current].filter((id) => !ids.has(id)));
        return next.size === current.size ? current : next;
      });
    }
    setShownReviewed((current) => {
      const kept = [...current].filter((path) => reviewedPaths.has(path));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [reviewedPaths]);
  const reviewedPathsRef = useRef(reviewedPaths);
  reviewedPathsRef.current = reviewedPaths;
  const chunkSpansRef = useRef(chunkSpansByKey);
  chunkSpansRef.current = chunkSpansByKey;
  /**
   * Shows a reviewed file (only a reviewed one: kept open till unmarked),
   * its chunks' lines too (za folds one back).
   */
  const showReviewed = useCallback((path: string) => {
    if (!reviewedPathsRef.current.has(path)) return;
    if (!shownChunks.current.has(path)) {
      const ids: string[] = [];
      for (const [key, spans] of chunkSpansRef.current)
        if (key.slice(key.indexOf(":") + 1) === path)
          for (const span of spans)
            if (span.reviewed) ids.push(`${key}\n${span.id}`);
      shownChunks.current.set(path, ids);
      if (ids.length)
        setPeekedChunks((current) => new Set([...current, ...ids]));
    }
    setShownReviewed((current) =>
      current.has(path) ? current : new Set(current).add(path),
    );
  }, []);
  // Picked in the tree, or gone to from Files' Review: a folded reviewed
  // file shows.
  const pickedPath = selectionRevision > 0 ? (entry?.path ?? null) : null;
  useEffect(() => {
    if (pickedPath) showReviewed(pickedPath);
    pickDone.current = selectionRevision;
  }, [pickedPath, selectionRevision, showReviewed]);
  // Once its file's lines are read (file by file): whether it is reviewed
  // is that view's then. Not taken from another view's file of that path.
  const goToRowPath = (() => {
    const wanted = cursorGoTo?.path;
    if (!wanted || goToDone.current === cursorGoTo.at) return null;
    return (
      cursor.model.rows.find((row) => goToMatches(wanted, row.path))?.path ??
      null
    );
  })();
  useEffect(() => {
    if (!cursorGoTo?.path || goToDone.current === cursorGoTo.at) return;
    if (!goToRowPath && Date.now() - cursorGoTo.at < GO_TO_FRESH_MS) return;
    showReviewed(goToRowPath ?? cursorGoTo.path);
    goToDone.current = cursorGoTo.at;
  }, [cursorGoTo?.path, cursorGoTo?.at, goToRowPath, showReviewed]);
  // The cursor steps over a folded chunk's lines but its first, and over
  // every line of a folded reviewed file.
  foldedRowsRef.current = (() => {
    const hidden = new Set<number>();
    if (foldedFiles.size)
      cursor.model.rows.forEach((row, at) => {
        if (foldedFiles.has(row.path)) hidden.add(at);
      });
    for (const spans of foldedSpansByKey.values())
      for (const span of spans)
        if (span.folded)
          for (let at = span.rows[0] + 1; at <= span.rows[1]; at++)
            hidden.add(at);
    return hidden;
  })();
  // A chunk or file folded under the cursor: the cursor goes on past it
  // (back before it at the end).
  useEffect(() => {
    const at = cursorHandle.current.rowIndex();
    const hidden = foldedRowsRef.current;
    if (!hidden.has(at)) return;
    const rows = cursor.model.rows.length;
    let next = at + 1;
    while (next < rows && hidden.has(next)) next += 1;
    if (next >= rows) {
      next = at - 1;
      while (next >= 0 && hidden.has(next)) next -= 1;
    }
    if (next >= 0) cursorHandle.current.goToLine(next + 1);
  }, [foldedSpansByKey, foldedFiles]);
  /** The reviewed chunk at a row of the cursor's model, folded or peeked. */
  const reviewedSpanAt = (row: number) => {
    for (const [key, spans] of foldedSpansByKey)
      for (const span of spans)
        if (span.reviewed && row >= span.rows[0] && row <= span.rows[1])
          return { key, span };
    return null;
  };
  const togglePeek = (row: number): boolean => {
    const found = reviewedSpanAt(row);
    if (!found) return false;
    const id = `${found.key}\n${found.span.id}`;
    setPeekedChunks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    return true;
  };
  revealRowRef.current = (row) => {
    const path = cursor.model.rows[row]?.path;
    // A folded reviewed file shows, its chunks with it; else the folded
    // chunk the row is in.
    if (path && foldedFiles.has(path)) {
      showReviewed(path);
      return;
    }
    const found = reviewedSpanAt(row);
    if (!found?.span.folded) return;
    const id = `${found.key}\n${found.span.id}`;
    setPeekedChunks((current) =>
      current.has(id) ? current : new Set(current).add(id),
    );
  };
  peekFoldedRef.current = () => {
    const at = cursorHandle.current.rowIndex();
    const found = reviewedSpanAt(at);
    if (found?.span.folded && found.span.rows[0] === at) togglePeek(at);
  };
  revealHiddenRef.current = (key, line, side) => {
    if (!hideComments) return false;
    const marked = threadMarksByKey.get(key)?.split(",") ?? [];
    const own = `${side === "deletions" ? "old" : "new"}:${line}`;
    if (!marked.includes(own)) return false;
    setHideComments(false);
    return true;
  };
  /** What each file's Pierre draws under its lines: threads, notes, the box. */
  const drawnByKey = useMemo(() => {
    if (!placement) return annotationsByPath;
    const grouped = new Map<string, DiffReviewAnnotation[]>();
    const add = (key: string, note: DiffReviewAnnotation) => {
      const list = grouped.get(key);
      if (list) list.push(note);
      else grouped.set(key, [note]);
    };
    const spots = new Map(
      placement.placed.map((spot) => [spot.thread.id, spot]),
    );
    const gone = new Set(placement.unplaced.map((thread) => thread.id));
    for (const note of diffNotes) {
      if (gone.has(note.id)) continue;
      const spot = spots.get(note.id);
      // On the file and no line: drawn at the file's head (DiffFileThreads).
      if (spot && spot.line <= 0 && reviewEditor) continue;
      if (spot) add(spot.key, { ...note, side: spot.side, line: spot.line });
      // Not a thread (yet): a note kept in this browser, where it was.
      else if (!diffThreads?.byId.has(note.id))
        add(`${note.kind}:${note.path}`, note);
    }
    // The gaps still hidden, under the line above each (0: atop the file).
    // Side by side, from the old side: its row is drawn across both
    // (.diff-gap); on the new side when a
    // comment (or the box) is drawn under that row, which it would cover.
    const composerAt =
      pendingAnnotation &&
      `${pendingAnnotation.kind}:${pendingAnnotation.path}`;
    const commented = (key: string, side: string, line: number) =>
      (grouped.get(key) ?? []).some(
        (note) => note.side === side && note.line === line,
      ) ||
      (composerAt === key &&
        pendingAnnotation!.side === side &&
        (pendingAnnotation!.endLine ?? pendingAnnotation!.line) === line);
    for (const [key, gaps] of gapsByKey) {
      const section = renderedSections.find((each) => each.key === key);
      if (!section) continue;
      for (const gap of gaps) {
        const across =
          splitView &&
          gap.across &&
          !commented(key, gap.across.side, gap.across.line) &&
          !commented(key, gap.anchor.side, gap.anchor.line)
            ? gap.across
            : null;
        const at = across ?? gap.anchor;
        add(key, {
          id: `${GAP_ID}${gap.gap}`,
          source: "diff",
          path: section.entry.path,
          kind: section.entry.kind,
          side: at.side,
          line: at.line,
          hunk: "",
          quote: "",
          comment: "",
          createdAt: 0,
        });
      }
    }
    if (pendingAnnotation) {
      const atEnd =
        pendingAnnotation.endLine !== undefined &&
        (pendingAnnotation.endSide ?? pendingAnnotation.side) ===
          pendingAnnotation.side;
      add(`${pendingAnnotation.kind}:${pendingAnnotation.path}`, {
        id: COMPOSER_ID,
        source: "diff",
        path: pendingAnnotation.path,
        kind: pendingAnnotation.kind,
        side: pendingAnnotation.side,
        line: atEnd ? pendingAnnotation.endLine! : pendingAnnotation.line,
        hunk: pendingAnnotation.hunk,
        quote: "",
        comment: "",
        createdAt: 0,
      });
    }
    return grouped;
  }, [
    annotationsByPath,
    diffNotes,
    diffThreads,
    gapsByKey,
    pendingAnnotation,
    placement,
    renderedSections,
    reviewEditor,
    splitView,
  ]);

  /** gH, :unresolved: only the unresolved threads drawn, or all again. */
  const toggleOpenOnly = () => {
    const on = !threadView.openOnly;
    threadView.setOpenOnly(on);
    say(
      on
        ? "Only the unresolved threads (gH shows them all)"
        : "All the threads, resolved ones folded",
    );
  };
  const spotAtCursor = () => {
    const where = cursorHandle.current.where();
    return where
      ? {
          key: where.key,
          old: where.old,
          new: where.new,
          side: where.side,
        }
      : null;
  };
  /** The unresolved threads, and the one the cursor is on (from 1). */
  const unresolvedTotal = readingOrder.filter(
    (each) => !each.thread.resolved,
  ).length;
  const unresolvedAt = (() => {
    const spot = spotAtCursor();
    const here = spot
      ? threadsAtCursor(readingOrder, spot).find(
          (each) => !each.thread.resolved,
        )
      : undefined;
    return here
      ? unresolvedPosition(
          readingOrder.map((each) => each.thread),
          here.thread.id,
        )
      : null;
  })();
  /**
   * A thread being gone to (the Comments panel's Go to it, n / N to one
   * whose lines are not drawn): its view shown, its file opened and read,
   * the lines around it revealed, then shown (showThread). Taken up again
   * as each of those lands (below, once the folds are known).
   */
  const threadGoToRef = useRef<{
    id: string;
    at: number;
    /** Its view (a commit's, all the changes') asked for. */
    view: boolean;
    /** The sections opened or read for it. */
    opened: Set<string>;
    /** The lines hidden around it asked for. */
    revealed: boolean;
  } | null>(null);
  const [, setThreadGoToTurn] = useState(0);
  const goToAnyThread = (thread: ReviewThread) => {
    threadGoToRef.current = {
      id: thread.id,
      at: Date.now(),
      view: false,
      opened: new Set(),
      revealed: false,
    };
    setThreadGoToTurn((turn) => turn + 1);
    // Taken up once more when it is given up, to say so.
    setTimeout(
      () => setThreadGoToTurn((turn) => turn + 1),
      THREAD_GO_TO_MS + 50,
    );
  };
  /** Whether a thread's line is among the rows drawn (its file open, read). */
  const spotDrawn = (spot: PlacedThread) =>
    cursorHandle.current.model.rows.some(
      (row) =>
        row.key === spot.key &&
        (spot.side === "old" ? row.old : row.new) === spot.line,
    );
  /** Shows a thread to be read: unfolded, its line in view. */
  const showThread = (spot: PlacedThread) => {
    // Its file folded, not read, or its view another: opened on the way.
    if (!spotDrawn(spot)) {
      goToAnyThread(spot.thread);
      return;
    }
    // In a folded reviewed file: the file opens;
    // its lines are the cursor's again at once.
    if (foldedFiles.has(spot.path)) {
      showReviewed(spot.path);
      const hidden = new Set(foldedRowsRef.current);
      cursorHandle.current.model.rows.forEach((row, at) => {
        if (row.path === spot.path) hidden.delete(at);
      });
      foldedRowsRef.current = hidden;
    }
    const folded = threadView.folded(spot.thread);
    if (folded) threadView.unfold([spot.thread.id]);
    cursorHandle.current.goTo(spot.key, spot.line, spot.side);
    // j / k are on its first message, as n / N land in the review.
    const first = spot.thread.comments[0];
    if (first) threadView.setCursor(`m:${first.id}`);
    requestAnimationFrame(() =>
      sectionRef.current
        ?.querySelector(`[data-chat-stop="m:${CSS.escape(first?.id ?? "")}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  };

  // ---- Message stops: j / k into the messages and their parts ------------

  /** The outermost thread card a stop is drawn in. */
  const topThreadOf = (stop: HTMLElement): string | undefined => {
    let id: string | undefined;
    for (
      let card = stop.closest<HTMLElement>(".chat-thread[data-thread-id]");
      card;
      card =
        card.parentElement?.closest<HTMLElement>(
          ".chat-thread[data-thread-id]",
        ) ?? null
    )
      id = card.dataset.threadId;
    return id;
  };
  /** Every message (and part of one) drawn under the cursor's line. */
  const stopsHere = (): HTMLElement[] => {
    const root = sectionRef.current;
    const spot = spotAtCursor();
    if (!root || !spot || hideComments) return [];
    const ids = new Set(
      threadsAtCursor(readingOrder, spot)
        .filter((each) => !(threadView.openOnly && each.thread.resolved))
        .map((each) => each.thread.id),
    );
    return fileStops(root).filter((stop) => {
      const id = topThreadOf(stop);
      return !!id && ids.has(id);
    });
  };
  const stopOfKey = (key: string | null): HTMLElement | undefined => {
    const root = sectionRef.current;
    return key && root
      ? fileStops(root).find((stop) => fileStopKey(stop) === key)
      : undefined;
  };
  /** The thread j / k are on: the nearest card around the stop. */
  const focusedThread = (): ReviewThread | undefined => {
    const stop = stopOfKey(threadView.cursor);
    const id = stop?.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId;
    return id ? diffThreads?.byId.get(id) : undefined;
  };
  /** After k came up onto a line with messages: on its last one. */
  const enterLast = useRef(false);
  const whereKey = (() => {
    const at = cursorHandle.current.where();
    return at ? `${at.key}:${at.old}:${at.new}:${at.side}` : "";
  })();
  useEffect(() => {
    if (!reviewEditor) return;
    if (enterLast.current) {
      enterLast.current = false;
      const stops = stopsHere();
      const last = stops[stops.length - 1];
      if (last) {
        threadView.setCursor(fileStopKey(last));
        last.scrollIntoView?.({ block: "nearest" });
        return;
      }
    }
    // Off the line: off its messages (one still drawn elsewhere stays).
    const stop = stopOfKey(threadView.cursor);
    if (threadView.cursor && stop && !stopsHere().includes(stop))
      threadView.setCursor(null);
    // Only a move of the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whereKey]);
  /** The messages of the threads above the diff, as j / k stop on them. */
  const generalStops = (): HTMLElement[] => {
    const block = sectionRef.current?.querySelector<HTMLElement>(
      ".diff-review-general",
    );
    return block && !hideComments ? fileStops(block) : [];
  };
  /**
   * n / N: the next or previous message of every thread, the review's own
   * first, then the lines' in their order; around past either end.
   */
  const walkMessages = (direction: 1 | -1) => {
    const shown = (thread: ReviewThread) =>
      !(threadView.openOnly && thread.resolved);
    const placed = readingOrder.filter((each) => shown(each.thread));
    const general = generalThreads.filter(
      (thread) => shown(thread) && thread.kind !== "merge-request",
    );
    const order = [
      ...general.map((thread) => ({ thread, spot: null })),
      ...placed.map((spot) => ({ thread: spot.thread, spot })),
    ];
    const stops = order.flatMap((entry, at) =>
      entry.thread.comments.map((comment) => ({ ...entry, comment, at })),
    );
    if (!stops.length) {
      say("No comment here.");
      return;
    }
    const current = threadView.cursor?.startsWith("m:")
      ? threadView.cursor.slice(2)
      : null;
    const selected = current
      ? stops.findIndex((stop) => stop.comment.id === current)
      : -1;
    let next: number;
    if (selected >= 0) next = selected + direction;
    else {
      // From the cursor's line: the first message from it on, or the last
      // before it.
      const spot = spotAtCursor();
      const place = spot
        ? cursorThreadPlace(placed, drawingSections, spot, 1)
        : { index: 0, on: false };
      const onLine = spot ? threadsAtCursor(placed, spot) : [];
      const from =
        general.length +
        (place.on && onLine[0] ? placed.indexOf(onLine[0]) : place.index);
      next =
        direction === 1
          ? stops.findIndex((stop) => stop.at >= from)
          : stops.filter((stop) => stop.at < from).length - 1;
      if (direction === 1 && next < 0) next = stops.length;
    }
    if (next >= stops.length) next = 0;
    if (next < 0) next = stops.length - 1;
    const stop = stops[next]!;
    if (stop.spot) showThread(stop.spot);
    else if (threadView.folded(stop.thread))
      threadView.unfold([stop.thread.id]);
    threadView.setCursor(`m:${stop.comment.id}`);
    requestAnimationFrame(() =>
      stopOfKey(`m:${stop.comment.id}`)?.scrollIntoView?.({
        block: "nearest",
      }),
    );
  };
  reviewHandlers.current.move = (direction, count) => {
    if (direction === 1) enterLast.current = false;
    // On the review's own messages, above the diff: j / k go through them,
    // j past the last one down to the first line.
    const above = generalStops();
    const on = above.findIndex(
      (stop) => fileStopKey(stop) === threadView.cursor,
    );
    if (on >= 0) {
      const to = on + direction * count;
      if (to >= 0 && to < above.length)
        threadView.setCursor(fileStopKey(above[to]!));
      else if (direction === 1) {
        threadView.setCursor(null);
        cursorHandle.current.moveTo(0);
      }
      return 0;
    }
    if (
      direction === -1 &&
      above.length &&
      !threadView.cursor &&
      cursorHandle.current.rowIndex() === 0
    ) {
      threadView.setCursor(fileStopKey(above[above.length - 1]!));
      return 0;
    }
    const stops = stopsHere();
    const at = threadView.cursor
      ? stops.findIndex((stop) => fileStopKey(stop) === threadView.cursor)
      : -1;
    let index = at;
    let left = count;
    while (left > 0) {
      if (direction === 1 && index + 1 < stops.length) index += 1;
      else if (direction === -1 && index >= 0) index -= 1;
      else break;
      left -= 1;
    }
    if (index === at && left === count) {
      // Nothing to step through here: k up onto a line with messages
      // lands on its last one.
      if (direction === -1) enterLast.current = true;
      return null;
    }
    const stop = stops[index];
    threadView.setCursor(stop ? fileStopKey(stop) : null);
    stop?.scrollIntoView?.({ block: "nearest" });
    if (left > 0 && direction === -1) enterLast.current = true;
    return left;
  };
  const say = (message: string) =>
    store.notify({ kind: "info", message, autoDismissMs: 2500 });

  reviewHandlers.current.comment = (key, range, mode) => {
    // A security merge request (or one not read yet) is kept from agents.
    const kept = agentsKeptReason(ownSnapshot);
    if (kept && (mode === "new" || mode === "ask")) {
      say(kept);
      return true;
    }
    // j / k are on a message: c on one of its parts comments on that part,
    // else it answers the thread (C asks anew, on the line).
    const stop = mode === "new" ? undefined : stopOfKey(threadView.cursor);
    const owner = focusedThread();
    if (stop && owner) {
      if (stop.dataset.part !== undefined) {
        const message =
          stop.closest<HTMLElement>(".chat-thread-body")?.dataset.messageId;
        if (message) {
          const add = stop.querySelector(":scope > .rc-part-add");
          threadView.setPartDraft({
            thread: owner.id,
            comment: message,
            quote: (stop.textContent ?? "")
              .replace(add?.textContent ?? "", "")
              .trim()
              .slice(0, 4000),
          });
          return true;
        }
      }
      // Your review comment no one answered has no reply: c rewrites it,
      // as on its line (and as the classic pane's c did).
      const lone = owner.kind !== "discussion" && owner.comments.length < 2;
      const first = owner.comments[0];
      if (lone && first?.author === REVIEW_USER) {
        openEditor(owner, first.id);
        return true;
      }
      if (!lone) {
        openReply(owner);
        return true;
      }
    }
    const section = renderedSectionsRef.current.find(
      (candidate) => candidate.key === key,
    );
    if (!section?.file?.diff || !onCreateAnnotation) return false;
    const target = findDiffReviewSelection(
      section.file.diff,
      range,
      effectiveViewMode === "split" ? "split" : "unified",
    );
    if (!target) return false;
    // A suggestion is of a line of the new version.
    if (mode === "suggest" && target.side === "old") {
      say("Suggestions apply to lines of the new version.");
      return true;
    }
    const spot = target.endLine === undefined ? spotAtCursor() : null;
    const here = spot ? threadsAtCursor(readingOrder, spot) : [];
    // A line being discussed: c, C and :ask answer there, as the review
    // pane's do.
    if (mode !== "suggest") {
      const open = here.find(
        (each) => !each.thread.resolved && each.thread.kind === "discussion",
      );
      if (open) {
        openReply(open.thread);
        return true;
      }
    }
    // Your review comment on the line: c rewrites it.
    if (mode === "comment" && commentKind === "draft") {
      const draft = here.find(
        (each) =>
          each.thread.kind === "draft" &&
          each.thread.comments[0]?.author === REVIEW_USER,
      );
      const first = draft?.thread.comments[0];
      if (draft && first) {
        openEditor(draft.thread, first.id);
        return true;
      }
    }
    setComposerKind(
      mode === "new" || mode === "ask"
        ? "discussion"
        : mode === "suggest"
          ? "draft"
          : ownSnapshot
            ? commentKind
            : null,
    );
    setComposerSeed(
      mode === "suggest" &&
        target.side === "new" &&
        target.endLine === undefined
        ? suggestionBlock(target.quote)
        : undefined,
    );
    setPendingAnnotation({
      x: 0,
      y: 0,
      path: section.entry.path,
      kind: section.entry.kind,
      ...target,
    });
    return true;
  };

  /** Writes reviewed marks; says how it went when it did not. */
  const writeMarks = (
    changes: Record<string, string | null>,
    said: () => string,
  ) => {
    changesAgent.markReviewed(changes).then(
      () => say(said()),
      (error) =>
        say(
          `Not marked: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  };
  const reviewedFileCount = reviewState.files.size;
  const reviewedChunkRows = (file: number, hunk: number) =>
    reviewState.hunks[file]?.has(hunk) ?? false;
  /** Option+V, v: the cursor's file reviewed, every chunk of it, or not. */
  const toggleFile = () => {
    const unit = reviewLayout.units[cursorHandle.current.rowIndex()];
    const info = unit ? reviewLayout.files[unit.file] : undefined;
    if (!unit || !info) return;
    const marking = !reviewState.files.has(unit.file);
    const to = marking
      ? nextUnreviewedHunk(
          reviewLayout.units,
          (file, hunk) => file === unit.file || reviewedChunkRows(file, hunk),
          cursorHandle.current.rowIndex(),
          1,
        )
      : null;
    writeMarks(
      fileToggleChanges(info, marking, reviewView, reviewedMarks),
      () =>
        fileToggleNotice(marking, reviewedFileCount, reviewLayout.files.length),
    );
    if (to !== null) cursorHandle.current.moveTo(to);
  };
  /** r (no thread): the cursor's chunk, or those V covers, reviewed or not. */
  const toggleChunks = () => {
    const cursorRow = cursorHandle.current.rowIndex();
    const selection = cursorHandle.current.selection();
    const picked = pickHunks(
      reviewLayout.units,
      cursorRow,
      selection,
      (at) => reviewLayout.units[at] ?? null,
    );
    if (!picked.size) {
      toggleFile();
      return true;
    }
    cursorHandle.current.clearSelection();
    const toggle = hunkToggle(
      picked,
      reviewLayout.files,
      reviewState.hunks,
      reviewView,
      reviewedMarks,
    );
    const isPicked = (file: number, hunk: number) =>
      picked.get(file)?.has(hunk) ?? false;
    const to = toggle.marking
      ? nextUnreviewedHunk(
          reviewLayout.units,
          (file, hunk) => isPicked(file, hunk) || reviewedChunkRows(file, hunk),
          Math.max(selection ?? cursorRow, cursorRow),
          1,
        )
      : null;
    writeMarks(toggle.changes, () =>
      hunkToggleNotice(toggle, reviewedFileCount, reviewLayout.files.length),
    );
    if (to !== null) cursorHandle.current.moveTo(to);
    return true;
  };
  /** gu / gU: the next or previous chunk not reviewed, in any file. */
  const jumpUnreviewed = (direction: 1 | -1) => {
    const cursorRow = cursorHandle.current.rowIndex();
    const to = nextUnreviewedHunk(
      reviewLayout.units,
      reviewedChunkRows,
      cursorRow,
      direction,
    );
    if (to === null) {
      const unit = reviewLayout.units[cursorRow];
      say(
        unit && !reviewedChunkRows(unit.file, unit.hunk)
          ? "This is the last chunk not reviewed."
          : "Every chunk shown is reviewed.",
      );
      return true;
    }
    cursorHandle.current.moveTo(to);
    return true;
  };
  reviewHandlers.current.markFile = toggleFile;

  // ---- Context expansion: zo x, zO X, zR, the gaps' buttons ---------------

  /** Files read for their context, by section key and patch. */
  const expandLines = useRef(new Map<string, Promise<string[] | null>>());
  /** Reveals lines in a section's gaps, the file read once. */
  const expandGaps = (
    key: string,
    changes: readonly { gap: number; change: (state: GapState) => GapState }[],
  ) => {
    const source = filesByKey[key]?.diff;
    const path = filesByKey[key]?.path;
    if (!source || !path || !changes.length) return;
    const known = expansions.get(key);
    const cacheKey = `${key}\u0000${source}`;
    let lines =
      known?.source === source
        ? Promise.resolve<string[] | null>(known.expansion.lines)
        : expandLines.current.get(cacheKey);
    if (!lines) {
      lines = (readViewFile ?? changesAgent.readFile)(path).then(
        (text) => {
          const read = fileLines(text);
          if (patchMatches(source, read)) return read;
          say("This file reads otherwise in the checkout: no more lines here.");
          return null;
        },
        (error) => {
          say(
            `Cannot show more lines: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        },
      );
      expandLines.current.set(cacheKey, lines);
    }
    void lines.then((read) => {
      if (!read) {
        expandLines.current.delete(cacheKey);
        return;
      }
      setExpansions((current) => {
        const kept = current.get(key);
        const next = new Map(current);
        next.set(key, {
          source,
          expansion: withGaps(
            kept?.source === source ? kept.expansion : undefined,
            read,
            changes,
          ),
        });
        return next;
      });
    });
  };
  /** zo / x (more), zO / X (all) around the cursor's hunk, zR the file. */
  const expandAroundCursor = (mode: "more" | "all" | "file", count: number) => {
    const row =
      cursorHandle.current.model.rows[cursorHandle.current.rowIndex()];
    if (!row) return true;
    const gaps = gapsByKey.get(row.key) ?? [];
    if (mode === "file") {
      expandGaps(
        row.key,
        gaps.map((gap) => ({
          gap: gap.gap,
          change: (state: GapState) => ({ ...state, all: true }),
        })),
      );
      return true;
    }
    const source = filesByKey[row.key]?.diff;
    const hunks = source ? (parsePatch(source)?.file.hunks.length ?? 0) : 0;
    const before = gaps.find((gap) => gap.gap === row.hunk);
    const after = gaps.find((gap) => gap.gap === row.hunk + 1);
    const changes: { gap: number; change: (state: GapState) => GapState }[] =
      [];
    if (before)
      changes.push({
        gap: before.gap,
        change: (state) =>
          mode === "all"
            ? { ...state, all: true }
            : { ...state, bottom: state.bottom + 20 * count },
      });
    if (after && after.gap <= hunks)
      changes.push({
        gap: after.gap,
        change: (state) =>
          mode === "all"
            ? { ...state, all: true }
            : { ...state, top: state.top + 20 * count },
      });
    expandGaps(row.key, changes);
    return true;
  };
  /** A gap's controls, drawn under the line above it. */
  const gapRow = (key: string, index: number): ReactNode => {
    const info = gapsByKey.get(key)?.find((gap) => gap.gap === index);
    if (!info) return null;
    const change = (update: (state: GapState) => GapState) => () =>
      expandGaps(key, [{ gap: info.gap, change: update }]);
    return (
      <div className="rd-expand diff-gap" data-gap={info.gap}>
        <span className="note">
          {info.hidden === null
            ? "more lines"
            : `${info.hidden} hidden line${info.hidden === 1 ? "" : "s"}`}
        </span>
        {info.canDown ? (
          <button
            type="button"
            className="btn ghost"
            title="Show 20 more lines below the hunk above"
            onClick={change((state) => ({ ...state, top: state.top + 20 }))}
          >
            {"\u2193 20"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost"
          title={
            info.hidden === null
              ? "Show the rest of the file"
              : "Show every hidden line here"
          }
          onClick={change((state) => ({ ...state, all: true }))}
        >
          {info.hidden === null ? "Show the rest" : `Show all ${info.hidden}`}
        </button>
        {info.canUp ? (
          <button
            type="button"
            className="btn ghost"
            title="Show 20 more lines above the hunk below"
            onClick={change((state) => ({
              ...state,
              bottom: state.bottom + 20,
            }))}
          >
            {"\u2191 20"}
          </button>
        ) : null}
      </div>
    );
  };
  gapRowRef.current = gapRow;
  /**
   * A thread on unchanged code the diff hides: the lines around it are
   * shown (three each side), so it is read in place. Once per thread.
   */
  const revealedFor = useRef(new Set<string>());
  const expandGapsRef = useRef(expandGaps);
  expandGapsRef.current = expandGaps;
  useEffect(() => {
    if (!placement) return;
    const byKey = new Map<
      string,
      { gap: number; change: (state: GapState) => GapState }[]
    >();
    for (const thread of placement.unplaced) {
      const { path, line, endLine, side = "new" } = thread.anchor;
      if (!path || !line || side !== "new") continue;
      const section = renderedSectionsRef.current.find(
        (each) => each.entry.path === path && !each.collapsed,
      );
      const source = section ? filesByKey[section.key]?.diff : undefined;
      if (!section || !source) continue;
      const once = `${thread.id}\u0000${source}`;
      if (revealedFor.current.has(once)) continue;
      const reveal = revealLine(source, endLine ?? line);
      if (!reveal) continue;
      revealedFor.current.add(once);
      byKey.set(section.key, [...(byKey.get(section.key) ?? []), reveal]);
    }
    for (const [key, changes] of byKey) expandGapsRef.current(key, changes);
  }, [filesByKey, placement]);

  reviewHandlers.current.threadKey = (key, count) => {
    const spot = spotAtCursor();
    const here = spot ? threadsAtCursor(readingOrder, spot) : [];
    // The thread j / k are on, else the first one on the line.
    const focused = focusedThread();
    const first = focused
      ? { thread: focused }
      : here.length
        ? here[0]
        : undefined;
    switch (key) {
      case "Escape":
        // Nothing else to leave: the review closes (it is kept), past
        // Review only, which Esc leaves first.
        if (reviewOnly || !onCloseReview) return false;
        onCloseReview("escape");
        return true;
      case "Tab":
      case "S-Tab":
      case "gn":
      case "gN":
      case "n":
      case "N": {
        const direction = key === "gn" || key === "n" || key === "Tab" ? 1 : -1;
        // n / N, Tab / Shift+Tab: message by message through every thread,
        // the review's own (above the diff) first.
        if (key !== "gn" && key !== "gN" && !hideComments) {
          walkMessages(direction);
          return true;
        }
        if (key === "Tab" || key === "S-Tab") key = direction === 1 ? "n" : "N";
        // n / N go message to message: within the thread j / k are on first.
        if ((key === "n" || key === "N") && focused) {
          const current = (threadView.cursor ?? "").split(":")[1];
          const index = focused.comments.findIndex(
            (comment) => comment.id === current,
          );
          const next = index >= 0 ? focused.comments[index + direction] : null;
          if (next && !threadView.folded(focused)) {
            threadView.setCursor(`m:${next.id}`);
            requestAnimationFrame(() =>
              stopOfKey(`m:${next.id}`)?.scrollIntoView?.({ block: "nearest" }),
            );
            return true;
          }
        }
        const order = readingOrder.map((each) => each.thread);
        // n / N go thread to thread, resolved ones too; gn / gN skip them.
        const walk =
          key === "n" || key === "N"
            ? order.map((t) => ({ ...t, resolved: false }))
            : order;
        const place = spot
          ? cursorThreadPlace(readingOrder, drawingSections, spot, direction)
          : { index: direction === 1 ? 0 : readingOrder.length, on: false };
        const step = stepUnresolved(walk, place, direction);
        // Past the last one here: another view's (a commit's), before
        // wrapping around this one.
        if (
          (key === "gn" || key === "gN") &&
          (!step || step.wrapped) &&
          onThreadsElsewhere?.(direction, new Set(order.map((t) => t.id)))
        )
          return true;
        if (!step) {
          say(
            key === "gn" || key === "gN"
              ? "No unresolved comment here."
              : "No comment here.",
          );
          return true;
        }
        if (key === "gn" || key === "gN" || step.wrapped)
          say(stepNotice(step, direction));
        showThread(readingOrder[step.index]!);
        return true;
      }
      case "gH":
        toggleOpenOnly();
        return true;
      case "g;": {
        const latest = latestComment(readingOrder.map((each) => each.thread));
        if (!latest) {
          say("No comment yet.");
          return true;
        }
        const spotOf = readingOrder.find(
          (each) => each.thread.id === latest.thread.id,
        );
        if (spotOf) showThread(spotOf);
        return true;
      }
      case "zz":
      case "z.":
      case "zt":
      case "zb": {
        // The message j / k are on, placed on the screen as Vim places a
        // line; on a line, the cursor's row (false).
        const stop = threadView.cursor ? stopOfKey(threadView.cursor) : null;
        if (!stop) return false;
        userScrollUntilRef.current = performance.now() + 150;
        stop.scrollIntoView?.({
          block: key === "zt" ? "start" : key === "zb" ? "end" : "center",
        });
        return true;
      }
      case "za":
        // A thread's fold first, else a reviewed chunk's.
        if (!first) {
          if (togglePeek(cursorHandle.current.rowIndex())) return true;
          say("No comment to fold on this line.");
          return true;
        }
        threadView.toggleFold(first.thread);
        return true;
      case "r":
        // A thread here (resolved ones too) before the chunk.
        if (
          first &&
          diffThreads &&
          (focused ||
            (cursorHandle.current.selection() === null && here.length))
        ) {
          const thread =
            focused ??
            here.find((each) => each.thread.kind !== "merge-request")?.thread ??
            first.thread;
          if (thread.kind === "merge-request") {
            // Resolving on the forge is public: here it is only folded.
            const open =
              (thread.anchor.path
                ? !thread.resolved && !forgeView?.relocations.has(thread.id)
                : !thread.resolved) !== threadView.flipped.has(thread.id);
            threadView.toggleFold(thread);
            if (open)
              say(
                `Folded here; ${forge} discussions are resolved on ${forge}.`,
              );
            return true;
          }
          diffThreads.api.resolve(thread);
          return true;
        }
        return toggleChunks();
      case "v":
        toggleFile();
        return true;
      case "gu":
      case "gU":
        return jumpUnreviewed(key === "gu" ? 1 : -1);
      case "e": {
        // The message selected, else your last on the line, else your
        // latest anywhere (the cursor goes there): rewritten in place.
        const editable = (thread: ReviewThread, comment: ReviewComment) =>
          comment.author === REVIEW_USER &&
          thread.kind !== "merge-request" &&
          (thread.kind === "discussion" || comment === thread.comments[0]);
        const edit = (thread: ReviewThread, comment: ReviewComment) => {
          openEditor(thread, comment.id);
          return true;
        };
        const selected = threadView.cursor?.startsWith("m:")
          ? threadView.cursor.slice(2)
          : null;
        const message = selected
          ? focused?.comments.find((comment) => comment.id === selected)
          : undefined;
        if (focused && message) {
          if (editable(focused, message)) return edit(focused, message);
          say(
            `That message is ${authorLabel(message.author)}'s; e edits yours.`,
          );
          return true;
        }
        const mine = (thread: ReviewThread) =>
          thread.comments.filter((comment) => editable(thread, comment)).pop();
        for (const each of [...here].reverse()) {
          const comment = mine(each.thread);
          if (comment) return edit(each.thread, comment);
        }
        let latest: { spot: PlacedThread; comment: ReviewComment } | null =
          null;
        for (const spot of readingOrder) {
          const comment = mine(spot.thread);
          if (
            comment &&
            (!latest || comment.updatedAt > latest.comment.updatedAt)
          )
            latest = { spot, comment };
        }
        if (!latest) {
          say("You have not written anything here yet.");
          return true;
        }
        cursorHandle.current.goTo(
          latest.spot.key,
          latest.spot.line,
          latest.spot.side,
        );
        return edit(latest.spot.thread, latest.comment);
      }
      case "dd": {
        // Your comment on the line (or a review comment), not the agent's.
        const thread = here
          .map((each) => each.thread)
          .filter(
            (each) =>
              each.kind === "draft" || each.comments[0]?.author === REVIEW_USER,
          )
          .pop();
        if (!thread || !diffThreads) {
          say("No comment on this line.");
          return true;
        }
        deleteThread(thread);
        return true;
      }
      case "u": {
        const thread = lastDeleted.current;
        if (!thread) return false;
        lastDeleted.current = null;
        void diffThreads?.api.restore(thread);
        return true;
      }
      case "gl": {
        // The last message of the thread j / k are on, or of the first
        // open one on the line: where its latest answer is.
        const thread =
          first?.thread ?? here.find((each) => !each.thread.resolved)?.thread;
        const last = thread?.comments[thread.comments.length - 1];
        if (!thread || !last) {
          say("No thread here.");
          return true;
        }
        if (threadView.folded(thread)) {
          say("That thread is folded (za opens it).");
          return true;
        }
        threadView.setCursor(`m:${last.id}`);
        requestAnimationFrame(() =>
          stopOfKey(`m:${last.id}`)?.scrollIntoView?.({ block: "nearest" }),
        );
        return true;
      }
      case "gs": {
        // Stage the file at the cursor: a two-key chord, never `s` alone.
        const path = cursorHandle.current.where()?.path;
        if (!path || !onGitAction) return false;
        if (gitElsewhere) {
          say(gitElsewhere);
          return true;
        }
        onGitAction("stage", path);
        return true;
      }
      case "zo":
      case "x":
        return expandAroundCursor("more", count ?? 1);
      case "zO":
      case "X":
        return expandAroundCursor("all", 1);
      case "zR":
        return expandAroundCursor("file", 1);
      case "T":
        // The review's list, with none too (it says so), as the pane's.
        setThreadsOpen((open) => !open);
        return true;
      case "t":
        setHideComments((hidden) => !hidden);
        return true;
      case "gf": {
        // The file at the cursor in Files (a request's review worktree is
        // checked out for browsing first, on demand).
        const path = cursorHandle.current.where()?.path;
        const target = path
          ? visibleEntries.find((each) => each.path === path)
          : undefined;
        if (!target || !onOpenFile) return false;
        handleOpenFile(target);
        return true;
      }
      case "O":
        // The merge request's changes on its forge, in a new tab.
        openMergeRequest(ownSnapshot);
        return true;
      case "gm":
        // The local review and the merge request's, both ways.
        forgeMode.switchMode();
        return true;
      default:
        // The review's views: < > gc (the commit bar).
        return viewKey ? viewKey(key) : false;
    }
  };

  /**
   * Comments on the whole review, or on code this view does not show (not
   * found by their text), drawn above the diff; the forge's discussions
   * under their own heading.
   */
  /**
   * Comments on a file shown and no line of it (or its line 0): at the
   * file's head, in its first section.
   */
  const fileThreads = useMemo(() => {
    const byPath = new Map<string, ReviewThread[]>();
    if (!reviewEditor || !diffThreads || !placement) return byPath;
    const shownPaths = new Set(visibleEntries.map((each) => each.path));
    const placed = new Set(
      placement.placed
        .filter((spot) => spot.line > 0)
        .map((spot) => spot.thread.id),
    );
    for (const thread of diffThreads.byId.values()) {
      const { path, line } = thread.anchor;
      if (
        !path ||
        (line !== undefined && line !== 0) ||
        placed.has(thread.id) ||
        partThreadIds.has(thread.id) ||
        !shownPaths.has(path)
      )
        continue;
      byPath.set(path, [...(byPath.get(path) ?? []), thread]);
    }
    return byPath;
  }, [diffThreads, partThreadIds, placement, reviewEditor, visibleEntries]);
  /** Each section's file threads, by its key: the file's first section. */
  const fileThreadsKey = useMemo(() => {
    const byKey = new Map<string, string>();
    const done = new Set<string>();
    for (const entry of visibleEntries) {
      const list = fileThreads.get(entry.path);
      if (!list || done.has(entry.path)) continue;
      done.add(entry.path);
      byKey.set(
        diffEntryKey(entry),
        list.map((thread) => thread.id).join("\u0000"),
      );
    }
    return byKey;
  }, [fileThreads, visibleEntries]);
  const generalThreads = useMemo<ReviewThread[]>(() => {
    if (!reviewEditor || !diffThreads || !placement) return [];
    const seen = new Set<string>();
    const found: ReviewThread[] = [];
    const add = (thread: ReviewThread) => {
      if (seen.has(thread.id) || partThreadIds.has(thread.id)) return;
      seen.add(thread.id);
      found.push(thread);
    };
    const onFiles = new Set(
      [...fileThreads.values()].flat().map((thread) => thread.id),
    );
    for (const thread of placement.unplaced)
      if (!onFiles.has(thread.id)) add(thread);
    const placed = new Set(placement.placed.map((spot) => spot.thread.id));
    for (const thread of diffThreads.byId.values())
      if (!thread.anchor.path && !placed.has(thread.id)) add(thread);
    return found;
  }, [diffThreads, fileThreads, partThreadIds, placement, reviewEditor]);
  // The review's overall comment, above the diff:
  // written in the review's editor, kept as you leave it.
  const summary = changesAgent.summary;
  const saveSummary = (text: string, send: boolean) =>
    void changesAgent
      .saveOverall(text, send)
      .catch(() =>
        keepReviewDraft(changesDraftSession(resourceKey), "overall", text),
      );
  const overallMark =
    ownSnapshot?.session.agent.name && summary.trim()
      ? summary.trim() === ownSnapshot.session.summarySent?.trim()
        ? `\u2192 ${ownAgent?.agentName ?? "Agent"}`
        : ownAgent?.held
          ? `held for ${ownAgent.agentName}`
          : `for ${ownAgent?.agentName ?? "Agent"}, not sent`
      : null;
  const overallBlock =
    reviewEditor && (overallOpen || summary.trim()) ? (
      <div className="diff-review-overall chat-review">
        {overallOpen ? (
          <ReviewDiffComposer
            key="overall"
            anchor={{ path: "", line: 0, side: "new", text: "" }}
            suggestable={null}
            initial={summary}
            overall
            kind="discussion"
            {...composerBase()}
            placeholder={placeholderOf({ kind: "discussion", overall: true })}
            onSave={(text, plan) => {
              setOverallOpen(false);
              if (plan.kind === "overall") saveSummary(text, plan.send);
              focusDiffAfterEditor();
            }}
            onClose={() => {
              setOverallOpen(false);
              focusDiffAfterEditor();
            }}
          />
        ) : (
          <div className="rc talk">
            <NoteBody text={summary} />
            <div className="rc-bar">
              <span>Overall comment</span>
              {overallMark ? (
                <span className="rc-kind">{overallMark}</span>
              ) : null}
              <span className="spacer" />
              <button
                type="button"
                className="btn ghost"
                onClick={() => setOverallOpen(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => saveSummary("", false)}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    ) : null;
  // A merge request's review: the forge's section above the diff.
  const forgeShown =
    reviewEditor && forgeView && ownSnapshot?.session.gitlab
      ? viewed.threads.filter((thread) => thread.kind === "merge-request")
      : null;
  const forgeSection =
    forgeShown && ownSnapshot ? (
      <ChangesForgeSection
        snapshot={ownSnapshot}
        forge={forge}
        shown={forgeShown}
        placed={
          new Set(
            (placement?.placed ?? [])
              .filter((spot) => spot.thread.kind === "merge-request")
              .map((spot) => spot.thread.id),
          ).size
        }
        general={
          hideComments
            ? []
            : generalThreads.filter(
                (thread) =>
                  thread.kind === "merge-request" &&
                  !(threadView.openOnly && thread.resolved),
              )
        }
        outside={forgeOutside(ownSnapshot.threads, viewCommit)}
        onAllChanges={forgeView!.onAllChanges}
        renderThread={(thread) =>
          diffThreads ? (
            <div className="chat-review diff-review-thread">
              <FileThread
                thread={thread}
                api={diffThreads.api}
                view={diffThreads.view}
                undelivered={diffThreads.undelivered}
                nested={diffThreads.nested}
                top
                {...(diffThreads.review ? { review: diffThreads.review } : {})}
              />
            </div>
          ) : null
        }
      />
    ) : null;
  const generalBlock =
    reviewEditor &&
    diffThreads &&
    !hideComments &&
    generalThreads.some(
      (thread) => !forgeSection || thread.kind !== "merge-request",
    ) ? (
      <div className="diff-review-general" data-testid="diff-review-general">
        {(
          [
            [
              "Comments on the review, or on code not shown here",
              generalThreads.filter((each) => each.kind !== "merge-request"),
            ],
            [
              "GitLab",
              forgeSection
                ? []
                : generalThreads.filter(
                    (each) => each.kind === "merge-request",
                  ),
            ],
          ] as const
        ).map(([title, list]) => {
          const shown = list.filter(
            (thread) => !(threadView.openOnly && thread.resolved),
          );
          return shown.length ? (
            <section key={title} className="diff-review-general-part">
              <h3>{title}</h3>
              {shown.map((thread) => (
                <div key={thread.id} className="chat-review diff-review-thread">
                  <FileThread
                    thread={thread}
                    api={diffThreads.api}
                    view={diffThreads.view}
                    undelivered={diffThreads.undelivered}
                    nested={diffThreads.nested}
                    {...(diffThreads.review
                      ? { review: diffThreads.review }
                      : {})}
                  />
                </div>
              ))}
            </section>
          ) : null;
        })}
      </div>
    ) : null;

  /**
   * The review's files with no change, under the changed files: each
   * with its tick (a tick only: no chunks to count) and its threads, on
   * the file as a whole, saying the line each is on. Open in Files shows
   * the file's text with them at their lines.
   */
  const otherFilesBlock =
    reviewEditor && otherFiles.length ? (
      <section
        className="diff-other-files"
        data-testid="diff-other-files"
        aria-label="Other files"
      >
        <h3>Other files</h3>
        {otherFiles.map((other) => {
          const shown = other.threads.filter(
            (thread) => !(threadView.openOnly && thread.resolved),
          );
          return (
            <div
              key={other.path}
              className="diff-other-file"
              data-other-file={other.path}
            >
              <div className="diff-other-file-head">
                <span className="diff-other-file-name">{other.path}</span>
                <span className="diff-other-file-note">no change</span>
                <button
                  type="button"
                  className={`diff-other-file-tick ${other.reviewed ? "is-reviewed" : ""}`}
                  aria-pressed={other.reviewed}
                  title={
                    other.reviewed
                      ? "Reviewed: unmark it"
                      : "Mark this file reviewed"
                  }
                  onClick={() =>
                    writeMarks(
                      otherFileMarks(other.path, !other.reviewed),
                      () =>
                        other.reviewed
                          ? `${other.path} no longer reviewed`
                          : `${other.path} reviewed`,
                    )
                  }
                >
                  {other.reviewed ? "\u2713 Reviewed" : "Mark reviewed"}
                </button>
                {onOpenFile ? (
                  <button
                    type="button"
                    className="diff-other-file-open"
                    onClick={() =>
                      onOpenFile({
                        path: other.path,
                        kind: "unstaged",
                        status: "M",
                        additions: 0,
                        deletions: 0,
                      } as GitDiffEntry)
                    }
                  >
                    {openFileLabel}
                  </button>
                ) : null}
              </div>
              {diffThreads && !hideComments
                ? shown.map((thread) => (
                    <div
                      key={thread.id}
                      className="chat-review diff-review-thread"
                    >
                      {thread.anchor.line ? (
                        <span className="diff-other-file-line">
                          line {thread.anchor.line}
                          {thread.anchor.endLine &&
                          thread.anchor.endLine > thread.anchor.line
                            ? `-${thread.anchor.endLine}`
                            : ""}
                        </span>
                      ) : null}
                      <FileThread
                        thread={thread}
                        api={diffThreads.api}
                        view={diffThreads.view}
                        undelivered={diffThreads.undelivered}
                        nested={diffThreads.nested}
                        {...(diffThreads.review
                          ? { review: diffThreads.review }
                          : {})}
                      />
                    </div>
                  ))
                : null}
            </div>
          );
        })}
      </section>
    ) : null;
  // Picked in the tree's Other files: shown.
  const showOtherFileRef = useRef(showOtherFile);
  showOtherFileRef.current = showOtherFile;
  useEffect(() => {
    if (otherFileGoTo) showOtherFileRef.current(otherFileGoTo.path);
  }, [otherFileGoTo]);

  // Back to the diff once the editor is gone: its Vim `:w` / `:q` hand the
  // focus back to the editor after they ran.
  const focusDiffAfterEditor = () => {
    sectionRef.current?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected)
        sectionRef.current?.focus({ preventScroll: true });
    });
  };
  const closeReviewComposer = () => {
    setPendingAnnotation(null);
    setComposerSeed(undefined);
    setComposerKind(null);
    focusDiffAfterEditor();
  };
  const composerNode: ReactNode =
    reviewEditor && pendingAnnotation ? (
      <ReviewDiffComposer
        key={`${pendingAnnotation.kind}:${pendingAnnotation.path}:${pendingAnnotation.side}:${pendingAnnotation.line}:${pendingAnnotation.endLine ?? ""}:${composerKind ?? ""}`}
        anchor={{
          path: pendingAnnotation.path,
          line: pendingAnnotation.line,
          side: pendingAnnotation.side,
          text: pendingAnnotation.quote.split("\n", 1)[0] ?? "",
        }}
        suggestable={
          pendingAnnotation.side === "new" &&
          pendingAnnotation.endLine === undefined
            ? pendingAnnotation.quote
            : null
        }
        {...(composerSeed !== undefined ? { initial: composerSeed } : {})}
        // With no review yet, where the comment goes is the first comment's
        // to find (it opens the review): kept on Esc, as what may reach
        // the agent is.
        kind={composerKind ?? (ownSnapshot ? commentKind : "discussion")}
        {...composerBase()}
        {...(composerKind || ownSnapshot
          ? {
              placeholder: placeholderOf({ kind: composerKind ?? commentKind }),
            }
          : {})}
        onSave={(text, plan) => {
          if (plan.kind !== "write" || plan.action !== "add") {
            closeReviewComposer();
            return;
          }
          if (hideComments && plan.showComments) setHideComments(false);
          // A new question with no agent to ask: held in the workspace's
          // threads, said so.
          if (plan.held) say(HELD_FOR_SEND);
          saveAnnotation(text, composerKind ?? undefined);
          setComposerSeed(undefined);
          setComposerKind(null);
          focusDiffAfterEditor();
        }}
        onClose={closeReviewComposer}
        coarse={
          typeof window !== "undefined" &&
          !!window.matchMedia?.("(pointer: coarse)").matches
        }
      />
    ) : null;
  // The box is drawn anew only as it opens or closes (or its target moves):
  // its words are typed into the editor, not rendered here.
  const composerRef = useRef<ReactNode>(null);
  composerRef.current = composerNode;
  const composerKey = pendingAnnotation
    ? `${pendingAnnotation.kind}:${pendingAnnotation.path}:${pendingAnnotation.side}:${pendingAnnotation.line}:${pendingAnnotation.endLine ?? ""}:${composerSeed ?? ""}:${composerKind ?? ""}`
    : "";
  const drawing = useMemo<DiffDrawing | null>(
    () =>
      reviewEditor
        ? {
            get composer() {
              return composerRef.current;
            },
            composerKey,
            hideComments,
            openOnly: threadView.openOnly,
            gap: (key: string, index: number) => gapRowRef.current(key, index),
          }
        : null,
    [composerKey, hideComments, reviewEditor, threadView.openOnly],
  );

  useEffect(() => {
    hunkIndexRef.current = -1;
    hunkNavigationRevisionRef.current += 1;
    setHunkIndex(-1);
    // The review's comment box stays through a reload (it keeps its words
    // as it goes); the popover closes as it did.
    if (!reviewEditor) setPendingAnnotation(null);
  }, [activeEntryKey, file?.diff, reviewEditor]);

  useEffect(() => {
    if (!onReanchorAnnotations) return;
    for (const section of renderedSections) {
      if (section.file?.diff && !section.file.truncated) {
        onReanchorAnnotations(
          section.entry.path,
          section.entry.kind,
          section.file.diff,
        );
      }
    }
  }, [onReanchorAnnotations, renderedSections]);

  useEffect(() => {
    selectFileRef.current = onSelectFile;
  }, [onSelectFile]);
  useEffect(() => {
    openFileRef.current = onOpenFile;
  }, [onOpenFile]);
  useEffect(() => {
    roamgateLocalStorage.setItem(DESKTOP_DIFF_WRAP_KEY, String(desktopWrap));
  }, [desktopWrap]);
  useEffect(() => {
    if (mobileWrapChoice !== null)
      roamgateLocalStorage.setItem(
        MOBILE_DIFF_WRAP_KEY,
        String(mobileWrapChoice),
      );
  }, [mobileWrapChoice]);
  useEffect(() => {
    requestedImagePreviewsRef.current.clear();
    imagePreviewRequestByKeyRef.current.clear();
    imagePreviewRequestSeqRef.current += 1;
    setImagePreviews({});
  }, [connectionClient, resourceKey]);
  useEffect(() => {
    const activeKeys = new Set(imagePreviewTargets.map((target) => target.key));
    for (const key of requestedImagePreviewsRef.current.keys()) {
      if (!activeKeys.has(key)) requestedImagePreviewsRef.current.delete(key);
    }
    for (const key of imagePreviewRequestByKeyRef.current.keys()) {
      if (!activeKeys.has(key)) imagePreviewRequestByKeyRef.current.delete(key);
    }
    setImagePreviews((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([key]) => activeKeys.has(key)),
      );
      return Object.keys(retained).length === Object.keys(current).length
        ? current
        : retained;
    });

    const requests = imagePreviewTargets.flatMap((target) => {
      if (requestedImagePreviewsRef.current.get(target.key) === target.file) {
        return [];
      }
      requestedImagePreviewsRef.current.set(target.key, target.file);
      const requestSeq = ++imagePreviewRequestSeqRef.current;
      imagePreviewRequestByKeyRef.current.set(target.key, requestSeq);
      return [{ target, requestSeq }];
    });
    if (!requests.length) return;

    setImagePreviews((current) => ({
      ...current,
      ...Object.fromEntries(
        requests.map(({ target }) => [
          target.key,
          { preview: null, loading: true, error: null },
        ]),
      ),
    }));

    for (const { target, requestSeq } of requests) {
      startImagePreviewRequest(
        target,
        connectionClient,
        () =>
          connectionClient.isCurrent() &&
          imagePreviewRequestByKeyRef.current.get(target.key) === requestSeq,
        completeImagePreview,
        loadImagePreview,
      );
    }
  }, [
    completeImagePreview,
    connectionClient,
    imagePreviewTargets,
    loadImagePreview,
  ]);

  useEffect(() => {
    if (!continuous || !visibleEntries.length) {
      setNearbyKeys([]);
      nearbyFilesChangeRef.current?.([]);
      lastVisibleEntryKeyRef.current = null;
      visibleFileChangeRef.current?.(null);
      return;
    }
    const scroller = sectionRef.current?.querySelector<HTMLElement>(
      ".pierre-diff-scroll",
    );
    if (!scroller) return;
    const candidates = new Set<HTMLElement>();
    const articles = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-diff-entry-key]"),
    );
    let frame = 0;
    const update = () => {
      if (
        !scrollbarPointerActiveRef.current &&
        performance.now() > userScrollUntilRef.current
      )
        restoreScrollAnchor();
      const viewport = scroller.getBoundingClientRect();
      const sectionsByKey = new Map(
        renderedSectionsRef.current.map((section) => [section.key, section]),
      );
      const positions = [...candidates].flatMap((article) => {
        const key = article.dataset.diffEntryKey!;
        const section = sectionsByKey.get(key);
        if (!section) return [];
        const bounds = article.getBoundingClientRect();
        return [{ key, top: bounds.top, bottom: bounds.bottom }];
      });
      const visibleKey = visibleDiffEntryKey(positions, viewport);
      if (lastVisibleEntryKeyRef.current !== visibleKey) {
        lastVisibleEntryKeyRef.current = visibleKey;
        visibleFileChangeRef.current?.(
          visibleKey ? (sectionsByKey.get(visibleKey)?.entry ?? null) : null,
        );
      }
      const keys = nearestDiffEntryKeys(
        positions.filter(
          (position) => !sectionsByKey.get(position.key)?.collapsed,
        ),
        viewport,
      );
      setNearbyKeys((current) =>
        current.length === keys.length &&
        current.every((key, index) => key === keys[index])
          ? current
          : keys,
      );
      nearbyFilesChangeRef.current?.(
        keys.flatMap((key) => {
          const section = sectionsByKey.get(key);
          return section ? [section.entry] : [];
        }),
      );
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    updateNearbyRef.current = schedule;
    const observer = new IntersectionObserver(
      (changes) => {
        for (const change of changes) {
          if (change.isIntersecting)
            candidates.add(change.target as HTMLElement);
          else candidates.delete(change.target as HTMLElement);
        }
        schedule();
      },
      { root: scroller, rootMargin: "1000px 0px" },
    );
    for (const article of articles) observer.observe(article);
    const rememberUserScroll = () => {
      userScrollUntilRef.current = performance.now() + 150;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === scroller) {
        scrollbarPointerActiveRef.current = true;
        rememberUserScroll();
      }
    };
    const onPointerEnd = () => {
      if (!scrollbarPointerActiveRef.current) return;
      scrollbarPointerActiveRef.current = false;
      rememberUserScroll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key) &&
        !isEditableSearchTarget(event.target)
      )
        rememberUserScroll();
    };
    const onScroll = () => {
      if (
        scrollAnchorRef.current &&
        !scrollbarPointerActiveRef.current &&
        performance.now() > userScrollUntilRef.current
      ) {
        // Pierre compensates for line-height changes; keep our file anchor until user input.
        schedule();
        return;
      }
      rememberUserScroll();
      const viewport = scroller.getBoundingClientRect();
      const atViewportTop = (article: HTMLElement) => {
        const bounds = article.getBoundingClientRect();
        return bounds.top <= viewport.top && bounds.bottom > viewport.top;
      };
      const first =
        [...candidates].find(atViewportTop) ?? articles.find(atViewportTop);
      if (first)
        scrollAnchorRef.current = {
          key: first.dataset.diffEntryKey!,
          offset: viewport.top - first.getBoundingClientRect().top,
          top:
            first.getBoundingClientRect().top -
            viewport.top +
            scroller.scrollTop,
        };
      schedule();
    };
    const resizeObserver = new ResizeObserver(() => {
      restoreScrollAnchor();
      schedule();
    });
    const content = scroller.querySelector<HTMLElement>(
      ".pierre-diff-scroll-content",
    );
    if (content) resizeObserver.observe(content);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", rememberUserScroll, { passive: true });
    scroller.addEventListener("touchmove", rememberUserScroll, {
      passive: true,
    });
    scroller.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    scroller.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", rememberUserScroll);
      scroller.removeEventListener("touchmove", rememberUserScroll);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      scrollbarPointerActiveRef.current = false;
      scroller.removeEventListener("keydown", onKeyDown);
      if (frame) cancelAnimationFrame(frame);
      updateNearbyRef.current = null;
      lastVisibleEntryKeyRef.current = null;
    };
  }, [continuous, restoreScrollAnchor, visibleEntries]);

  useEffect(() => {
    updateNearbyRef.current?.();
  }, [renderedSections]);

  useLayoutEffect(
    () => restoreScrollAnchor(),
    [filesByKey, restoreScrollAnchor],
  );

  useEffect(() => {
    if (!activeEntryKey || !sectionRef.current) return;
    const previous = lastNavigationRef.current;
    if (
      previous?.key === activeEntryKey &&
      previous.revision === selectionRevision
    )
      return;
    lastNavigationRef.current = {
      key: activeEntryKey,
      revision: selectionRevision,
    };
    scrollAnchorRef.current = null;
    userScrollUntilRef.current = 0;
    const frame = requestAnimationFrame(() => {
      const target = Array.from(
        sectionRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? [],
      ).find((element) => element.dataset.diffEntryKey === activeEntryKey);
      const scroller = target?.closest<HTMLElement>(".pierre-diff-scroll");
      if (target && scroller)
        scrollAnchorRef.current = {
          key: activeEntryKey,
          offset: 0,
          top:
            target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop,
        };
      target?.scrollIntoView({ block: "start" });
      updateNearbyRef.current?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeEntryKey, selectionRevision]);

  useEffect(() => {
    setSearchIndex(searchMatchCount ? 0 : -1);
  }, [deferredSearchQuery, searchMatchCount]);

  useEffect(() => {
    if (!currentSearchEntryKey || !sectionRef.current) return;
    setManualCollapseStates((current) => {
      if (current.get(currentSearchEntryKey) === false) return current;
      const next = new Map(current);
      next.set(currentSearchEntryKey, false);
      writeDiffCollapseState(resourceKey, next);
      return next;
    });
    requestAnimationFrame(() => {
      const target = Array.from(
        sectionRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? [],
      ).find(
        (element) => element.dataset.diffEntryKey === currentSearchEntryKey,
      );
      userScrollUntilRef.current = performance.now() + 150;
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [currentSearchEntryKey, resourceKey]);

  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const goToSearchMatch = useCallback(
    (delta: number) => {
      if (!searchMatchCount) return;
      setSearchIndex((index) => {
        const base = index < 0 ? 0 : index;
        return (base + delta + searchMatchCount) % searchMatchCount;
      });
    },
    [searchMatchCount],
  );

  const toggleSectionCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      if (!collapsed && scrollAnchorRef.current?.key === key) {
        scrollAnchorRef.current.offset = 0;
      }
      setManualCollapseStates((current) => {
        const next = new Map(current);
        next.set(key, !collapsed);
        writeDiffCollapseState(resourceKey, next);
        return next;
      });
    },
    [resourceKey],
  );

  useEffect(() => {
    if (embedded || mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".shortcut-modal"))
        return;
      if (!shortcutMatches(e, "preview.search")) return;
      const section = sectionRef.current;
      if (!section || section.offsetParent === null) return;
      // The review's cursor has the keys: Ctrl-f is its page down.
      if (
        cursorActiveRef.current &&
        e.ctrlKey &&
        !e.metaKey &&
        e.target instanceof Node &&
        section.contains(e.target)
      )
        return;
      if (isEditableSearchTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      // The review finds with its own search, `/`.
      if (cursorActiveRef.current) cursorHandle.current.openSearchPrompt();
      else focusSearch();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [embedded, mobile, focusSearch]);

  // A thread gone to (goToAnyThread): one step each time something lands,
  // until it is shown, or found gone, or given up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each render
  useEffect(() => {
    const pending = threadGoToRef.current;
    if (!pending) return;
    const done = () => {
      threadGoToRef.current = null;
    };
    const thread =
      scoped.threads.find((each) => each.id === pending.id) ??
      drawnThreads?.find((each) => each.id === pending.id);
    if (!thread) return done();
    if (Date.now() - pending.at > THREAD_GO_TO_MS) {
      done();
      say("This comment's line could not be shown.");
      return;
    }
    const spot = readingOrder.find((each) => each.thread.id === pending.id);
    const gone = !!placement?.unplaced.some((each) => each.id === pending.id);
    if (!spot && !gone) {
      // Not in this view: its own (a commit's, all the changes') shown.
      if (pending.view) return;
      if (onShowThreadView?.(thread)) {
        pending.view = true;
        return;
      }
      done();
      goToThread(thread);
      return;
    }
    const section =
      renderedSections.find((each) => each.key === spot?.key) ??
      renderedSections.find((each) => each.entry.path === thread.anchor.path);
    if (!section) {
      done();
      goToThread(thread);
      return;
    }
    // Its file folded (by hand, as large) or not read yet: opened, read.
    if (section.collapsed || !section.file) {
      if (!pending.opened.has(section.key)) {
        pending.opened.add(section.key);
        if (section.collapsed) toggleSectionCollapsed(section.key, true);
        if (!section.file) handleSelectFile(section.entry);
      }
      return;
    }
    if (spot && !gone) {
      // Drawn once its lines are the cursor's.
      if (!spotDrawn(spot)) return;
      done();
      showThread(spot);
      // Its card in sight too, once drawn under the lines just shown.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          sectionRef.current
            ?.querySelector(
              `.chat-thread[data-thread-id="${CSS.escape(thread.id)}"]`,
            )
            ?.scrollIntoView?.({ block: "nearest" }),
        ),
      );
      return;
    }
    // Not found on its line: maybe among the lines the diff hides, shown;
    // else gone, and the nearest line of its file is gone to.
    const { side = "new" } = thread.anchor;
    const line = thread.anchor.endLine ?? thread.anchor.line ?? 0;
    const shownPatch =
      expandedCache.current.get(section.key)?.file.diff ?? section.file.diff;
    const hidden =
      side === "new" && line > 0 && shownPatch
        ? revealLine(shownPatch, line)
        : null;
    if (hidden) {
      if (!pending.revealed) {
        pending.revealed = true;
        expandGaps(section.key, [hidden]);
      }
      return;
    }
    done();
    const rows = cursorHandle.current.model.rows;
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    rows.forEach((row, at) => {
      if (row.key !== section.key) return;
      const number =
        (side === "old" ? row.old : row.new) ??
        (side === "old" ? row.new : row.old);
      if (number === null) return;
      const away = Math.abs(number - (thread.anchor.line ?? 0));
      if (away < distance) {
        distance = away;
        best = at;
      }
    });
    if (best >= 0) cursorHandle.current.moveTo(best);
    say(
      `This comment's line is no longer in the diff: ${best >= 0 ? "on the nearest line" : "its file is shown"}.`,
    );
  });

  const diffList = visibleEntries.length ? (
    <DiffSurfaceScroll
      className={`pierre-diff-scroll ${mobile ? "is-compact" : ""} ${continuous ? "is-continuous" : ""}`}
    >
      {renderedSections.map((section) => (
        <DiffFileSection
          key={section.key}
          section={section}
          loading={
            !section.file &&
            (loadingKeys.includes(section.key) ||
              (loading && activeEntryKey === section.key))
          }
          nearby={!continuous || nearbyKeySet.has(section.key)}
          imagePreviewState={
            section.file
              ? imagePreviews[imagePreviewKey(connectionClient, section.file)]
              : undefined
          }
          options={pierreOptions}
          currentSearchMatch={currentSearchEntryKey === section.key}
          embedded={embedded}
          mobile={mobile}
          annotations={
            drawnByKey.get(section.key) ?? EMPTY_DIFF_REVIEW_ANNOTATIONS
          }
          annotationSelectionActive={
            pendingAnnotation?.path === section.entry.path &&
            pendingAnnotation.kind === section.entry.kind
          }
          onToggle={toggleSectionCollapsed}
          onSelectFile={onSelectFile ? handleSelectFile : undefined}
          onOpenFile={onOpenFile ? handleOpenFile : undefined}
          openFileLabel={openFileLabel}
          reviewHeader={reviewEditor}
          onRequestAnnotation={
            onCreateAnnotation ? handleRequestAnnotation : undefined
          }
          onEditAnnotation={onEditAnnotation}
          {...(cursor.active
            ? {
                onInstance: cursor.onInstance,
                onLineClick: cursorLineClick,
                cursorSelection: cursor.selectionIn(section.key),
                searchHit: cursorMatching.has(section.entry.path),
                ...(reviewEditor
                  ? {
                      chunkSpans: foldedSpansByKey.get(section.key),
                      threadMarks: threadMarksByKey.get(section.key) ?? "",
                      reviewedFolded: foldedFiles.has(section.entry.path),
                      onShowReviewed: showReviewed,
                      fileThreadIds:
                        fileThreadsKey.get(section.key) ?? undefined,
                    }
                  : {}),
              }
            : {})}
        />
      ))}
    </DiffSurfaceScroll>
  ) : null;

  /** The review's `:` commands in Changes (reviewCommands.ts). */
  const changesReviewCommands = reviewCommands(
    {
      close: () => onCloseReview?.("command"),
      save: () => {
        if (saveOpenComposer(sectionRef.current) !== false) say("Review saved");
      },
      split: () => toggleSplit(),
      comments: () => setHideComments((hidden) => !hidden),
      ask: () => cursorHandle.current.comment("ask"),
      suggest: () => cursorHandle.current.comment("suggest"),
      overall: () => setOverallOpen(true),
      threads: () => setThreadsOpen(true),
      unresolved: () => toggleOpenOnly(),
      unreviewed: () => reviewHandlers.current.threadKey("gu", null),
      send: () => changesAgent.send(),
      hold: () => {
        if (changesAgent.talk) changesAgent.toggleHold();
        else
          say(
            `Comments are not going to ${changesAgent.agentName ?? "Agent"}.`,
          );
      },
      review: (focus) => {
        if (focus) changesAgent.review(focus);
        else setFocusBar("");
      },
      open: () => openMergeRequest(ownSnapshot),
      switchMode: () => forgeMode.switchMode(),
      reviews: () => onShowReviews?.(),
      single: () => say("This review has a single commit."),
      reload: () => onRetry?.(),
    },
    Boolean(viewCommands),
  );

  /*
   * The diff's `:` commands in the inspector's prompt (Changes, a commit's
   * diff), each a button of its bar; the Files preview's embedded diff has
   * the preview's.
   */
  const diffCommands: InspectorCommand[] = [
    // The review moves with { } and n N, and finds with `/`.
    ...(hunkTargets.length && !reviewEditor
      ? [
          {
            name: "next",
            description: "the next change (the down arrow)",
            run: () => goToHunk(1),
          },
          {
            name: "previous",
            aliases: ["prev"],
            description: "the previous change (the up arrow)",
            run: () => goToHunk(-1),
          },
        ]
      : []),
    ...(!mobile && hasSearchableDiff && !reviewEditor
      ? [
          {
            name: "find",
            aliases: ["search"],
            description: "find in the loaded files (:find WORDS, the field)",
            run: (argument: string) => {
              if (argument) setSearchQuery(argument);
              focusSearch();
            },
          },
        ]
      : []),
    // With the review, the review's `:diff` (`:s`, `:split`, `:unified`).
    ...(!mobile && !reviewEditor
      ? [
          {
            name: "diff",
            aliases: ["s"],
            description: "side by side / unified (Split, Unified)",
            run: toggleSplit,
          },
          {
            name: "split",
            description: "side by side (Split)",
            run: () => setViewMode("split"),
          },
          {
            name: "unified",
            description: "one column (Unified)",
            run: () => setViewMode("unified"),
          },
        ]
      : []),
    {
      name: "wrap",
      description: "wrap the long lines, or not (Wrap)",
      run: () =>
        mobile ? toggleMobileWrap() : setDesktopWrap((value) => !value),
    },
    ...(reviewEditor && onGitAction
      ? (
          [
            [
              "stage",
              "stage the file at the cursor, or the files V selected (gs)",
              "stage",
            ],
            ["unstage", "unstage them", "unstage"],
            [
              "discard",
              "discard their unstaged changes (asks first)",
              "discard_unstaged",
            ],
            [
              "delete",
              "delete their untracked files (asks first)",
              "delete_untracked",
            ],
          ] as const
        ).map(([name, description, action]) => ({
          name,
          description,
          run: () => {
            // Another repository's review: the checkout's git acts on the
            // checkout only.
            if (gitElsewhere) {
              say(gitElsewhere);
              return;
            }
            const paths = cursorHandle.current.selectedPaths();
            if (!paths.length) {
              say("No file under the cursor.");
              return;
            }
            // Destructive actions ask once per file, as the menus do.
            for (const path of paths) onGitAction(action, path);
          },
        }))
      : []),
    // The review's own words.
    ...(reviewEditor ? changesReviewCommands : []),
    ...(!reviewEditor && listedThreads.length
      ? [
          {
            name: "conversations",
            aliases: ["threads", "conv"],
            description: "the comments (the comments chip)",
            run: () => setThreadsOpen((open) => !open),
          },
        ]
      : []),
  ];
  inspectorRunRef.current = useInspectorCommands(
    embedded
      ? null
      : {
          commands: viewCommands
            ? [...diffCommands, ...viewCommands]
            : diffCommands,
          ...(cursor.active ? { line: cursor.goToLine } : {}),
          // The review's list and words.
          ...(reviewEditor
            ? {
                shortcuts: {
                  title: "Review shortcuts",
                  rows: CHANGES_REVIEW_KEYS,
                },
                unknown: notAReviewCommand,
              }
            : {}),
        },
  );

  /** On a phone (or a narrow inspector), the review's head in two rows. */
  const phoneRow = mobile && reviewEditor;
  const headBack =
    mobile && backAction ? (
      <button
        type="button"
        className="diff-content-back"
        title={backAction.label}
        aria-label={backAction.label}
        onClick={backAction.onClick}
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
    ) : null;
  const headTitle = embedded ? null : (
    <div className="diff-content-title">
      {scopeControls ? (
        scopeControls
      ) : (
        <strong>
          {changedFileCount
            ? plural(changedFileCount, "changed file")
            : "Diff Viewer"}
        </strong>
      )}
    </div>
  );
  const headControls = (
    <>
      {/* The review's commit bar joins the head's row (no row of its own). */}
      {reviewEditor ? viewBar : null}
      {!embedded && showFileSelector && visibleEntries.length > 1 ? (
        <label className="diff-file-index">
          <span>File</span>
          <select
            aria-label="Jump to changed file"
            value={activeEntryKey}
            onChange={(event) => {
              const target = visibleEntries.find(
                (candidate) =>
                  diffEntryKey(candidate) === event.currentTarget.value,
              );
              if (target) handleSelectFile(target);
            }}
          >
            {!activeEntryKey ? <option value="">Choose a file</option> : null}
            {visibleEntries.map((candidate) => (
              <option
                key={diffEntryKey(candidate)}
                value={diffEntryKey(candidate)}
              >
                {candidate.path} ({candidate.kind})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {mobile && !reviewEditor ? (
        <button
          type="button"
          className={`diff-wrap-toggle ${mobileWrap ? "is-active" : ""}`}
          onClick={toggleMobileWrap}
          aria-pressed={mobileWrap}
        >
          Wrap
        </button>
      ) : null}
      {reviewEditor ? (
        <ChangesAgentBar
          agent={changesAgent}
          overallOpen={overallOpen}
          onOverall={setOverallOpen}
          onAsk={() => cursorHandle.current.comment("ask")}
          {...(onFocusAgentPane ? { onFocusAgentPane } : {})}
          status={agentSaid || statusLine || ""}
        />
      ) : null}
      {reviewEditor ? (
        <ChangesForgeHead
          connectionId={connectionClient.connectionId}
          snapshot={ownSnapshot}
          forge={forge}
          mode={forgeMode}
          threads={drawnThreads ?? NO_THREADS}
        />
      ) : null}
      {reviewEditor &&
      !changesAgent.agentName &&
      !overallOpen &&
      !changesAgent.summary.trim() ? (
        <button
          type="button"
          className="diff-overall-toggle"
          title="An overall comment on the review (:overall)"
          {...(mobile ? { "aria-label": "Overall comment" } : {})}
          onClick={() => setOverallOpen(true)}
        >
          {mobile ? (
            <MessageSquarePlus size={14} aria-hidden="true" />
          ) : (
            <>
              Overall<span className="diff-head-word"> comment</span>
            </>
          )}
        </button>
      ) : null}
      {reviewEditor && (statusLine || agentSaid) ? (
        // One short line by the agent's chip (what it works on, its last
        // word), whole in the tooltip; a mark while it works.
        <span
          className={`changes-review-status${agentWorking ? " is-working" : ""}`}
          aria-live="polite"
          title={agentSaid || statusLine}
        >
          {agentWorking ? (
            <span className="review-working-mark" aria-hidden="true" />
          ) : null}
          {agentSaid || statusLine}
        </span>
      ) : null}
      {reviewEditor && focusBar !== null ? (
        <div className="diff-review-focusbar">
          <span className="note">
            {changesAgent.agentName ?? "Agent"} review, focus (optional):
          </span>
          <input
            // The focus bar takes the keys as soon as it opens.
            // biome-ignore lint/a11y/noAutofocus: see above
            autoFocus
            aria-label="Review focus"
            value={focusBar}
            placeholder="locking, API, error paths... (Enter starts, Esc cancels)"
            onChange={(event) => setFocusBar(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                startAgentReview(focusBar);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setFocusBar(null);
                sectionRef.current?.focus({ preventScroll: true });
              }
            }}
          />
          <button
            type="button"
            className="btn primary rv-sm"
            onClick={() => startAgentReview(focusBar)}
          >
            Start
          </button>
        </div>
      ) : null}
      <div className="diff-content-actions">
        {/* The review has { } and n N for these, `/` to find; a phone's
            review keeps the arrows, its keys out of reach. */}
        {hunkTargets.length && !(reviewEditor && !mobile) ? (
          <div className="diff-hunk-navigation" aria-label="Change navigation">
            <button
              type="button"
              onClick={() => goToHunk(-1)}
              aria-label="Previous change"
              title="Previous change"
            >
              <ChevronUp size={14} />
            </button>
            <span>
              {hunkIndex < 0 ? "–" : hunkIndex + 1}/{hunkTargets.length}
              {mobile ? (
                ""
              ) : (
                <span className="diff-head-word">
                  {` ${hunkTargets.length === 1 ? "change" : "changes"}`}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => goToHunk(1)}
              aria-label="Next change"
              title="Next change"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        ) : null}
        {!embedded && !mobile && !reviewEditor ? (
          <div
            className={`diff-search-controls${searchQuery ? " has-query" : ""}`}
          >
            <label className="diff-search">
              <Search size={13} />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    goToSearchMatch(e.shiftKey ? -1 : 1);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchQuery("");
                  }
                }}
                placeholder="Find loaded files"
                disabled={!hasSearchableDiff}
              />
            </label>
            <span
              className="diff-search-count"
              role="status"
              aria-live="polite"
            >
              {deferredSearchQuery && searchMatchCount
                ? `${searchIndex + 1}/${searchMatchCount}`
                : deferredSearchQuery
                  ? "No results"
                  : ""}
            </span>
            <button
              type="button"
              className="diff-search-button"
              onClick={() => goToSearchMatch(-1)}
              disabled={!searchMatchCount}
              aria-label="Previous matching loaded file"
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              className="diff-search-button"
              onClick={() => goToSearchMatch(1)}
              disabled={!searchMatchCount}
              aria-label="Next matching loaded file"
            >
              <ChevronDown size={14} />
            </button>
            {searchQuery ? (
              <button
                type="button"
                className="diff-search-button"
                onClick={() => {
                  setSearchQuery("");
                  focusSearch();
                }}
                aria-label="Clear diff search"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {reviewEditor && reviewLayout.files.length ? (
        <span
          className="diff-reviewed-count"
          title="Files reviewed (r a chunk, v a file)"
        >
          {reviewedFileCount}/{reviewLayout.files.length}
          <span className="diff-head-word"> reviewed</span>
        </span>
      ) : null}
      {reviewEditor && listedThreads.length ? (
        <button
          type="button"
          className={`diff-comments-toggle${hideComments ? "" : " is-active"}`}
          aria-pressed={!hideComments}
          aria-label="Comments"
          title={
            hideComments
              ? `Show the ${listedThreads.length} hidden comment${listedThreads.length === 1 ? "" : "s"} (t, :comments)`
              : "Show / hide every comment (t, :comments)"
          }
          onClick={() => setHideComments((hidden) => !hidden)}
        >
          {hideComments ? (
            <MessageSquareOff size={14} />
          ) : (
            <MessageSquare size={14} />
          )}
          {hideComments ? (
            <span className="rv-badge">{listedThreads.length}</span>
          ) : null}
        </button>
      ) : null}
      {reviewEditor && readingOrder.length ? (
        <UnresolvedNav
          className="diff-unresolved-nav"
          total={unresolvedTotal}
          position={unresolvedAt}
          openOnly={threadView.openOnly}
          onStep={(direction) => {
            reviewHandlers.current.threadKey?.(
              direction === 1 ? "gn" : "gN",
              null,
            );
            sectionRef.current?.focus({ preventScroll: true });
          }}
          onOpenOnly={() => {
            toggleOpenOnly();
            sectionRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {listedThreads.length ? (
        <ThreadsChip
          className="diff-threads-chip"
          threads={listedThreads}
          undelivered={
            diffThreads?.undelivered
              ? {
                  count: diffThreads.undelivered.ids.size,
                  reason: diffThreads.undelivered.reason,
                }
              : undefined
          }
          open={threadsOpen}
          onToggle={() => setThreadsOpen((open) => !open)}
        />
      ) : null}
      {mobile && reviewEditor ? (
        // A phone's diff is unified: its view menu only wraps.
        <ReviewMenu
          className="diff-view-menu"
          title="How the diff is drawn: long lines wrapped or not (:set)"
          label={
            <>
              <WrapText size={14} aria-hidden="true" />
              <ChevronDown size={12} />
            </>
          }
          items={[
            {
              label: "Wrap long lines",
              checked: mobileWrap,
              onSelect: toggleMobileWrap,
            },
          ]}
        />
      ) : null}
      {!mobile && reviewEditor ? (
        // The review's one view menu: side by side, unified, wrapped
        // (S and :set stay).
        <ReviewMenu
          className="diff-view-menu"
          title="How the diff is drawn: side by side or unified, lines wrapped (S, :set)"
          label={
            <>
              <Columns2 size={13} aria-hidden="true" />
              <span className="diff-head-word">
                {viewMode === "split" ? "Split" : "Unified"}
                {desktopWrap ? " · Wrap" : ""}
              </span>
              <ChevronDown size={12} />
            </>
          }
          items={[
            {
              label: "Split",
              hint: "S",
              checked: viewMode === "split",
              onSelect: () => setViewMode("split"),
            },
            {
              label: "Unified",
              hint: "S",
              checked: viewMode === "unified",
              onSelect: () => setViewMode("unified"),
            },
            {
              label: "Wrap",
              checked: desktopWrap,
              onSelect: () => setDesktopWrap((value) => !value),
            },
          ]}
        />
      ) : !mobile ? (
        <div className="diff-display-controls">
          <div className="diff-view-toggle" aria-label="Diff view mode">
            <button
              type="button"
              className={viewMode === "split" ? "is-active" : ""}
              onClick={() => setViewMode("split")}
              aria-pressed={viewMode === "split"}
            >
              Split
            </button>
            <button
              type="button"
              className={viewMode === "unified" ? "is-active" : ""}
              onClick={() => setViewMode("unified")}
              aria-pressed={viewMode === "unified"}
            >
              Unified
            </button>
          </div>
          <button
            type="button"
            className={`diff-wrap-toggle ${desktopWrap ? "is-active" : ""}`}
            onClick={() => setDesktopWrap((value) => !value)}
            aria-pressed={desktopWrap}
          >
            Wrap
          </button>
        </div>
      ) : null}
      {headEnd}
    </>
  );

  return (
    <section
      ref={sectionRef}
      className={`diff-content-view ${embedded ? "is-embedded" : ""} ${
        mobile ? "is-mobile" : ""
      }`}
      aria-label={embedded ? "File changes" : "Diff Viewer content"}
      tabIndex={-1}
      data-review-cursor={cursor.active ? "" : undefined}
      onKeyDown={
        cursor.active
          ? (event) => {
              cursor.onKeyDown(event);
              if (event.defaultPrevented)
                cursorKeyRef.current = event.nativeEvent;
            }
          : undefined
      }
    >
      <div className={`diff-content-head${reviewEditor ? " is-review" : ""}`}>
        {phoneRow ? null : headBack}
        {headTitle}
        {phoneRow ? (
          // A phone's review head: the review on its own line above, every
          // control on one row under it (Back first), scrolled, never wrapped.
          <div className="diff-review-row">
            {headBack}
            {headControls}
          </div>
        ) : (
          headControls
        )}
      </div>
      {reviewEditor ? null : viewBar}

      {error && !visibleEntries.length ? (
        <div className="diff-content-state is-error">
          <span>{plainDiffError(error)}</span>
          {onRetry ? (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          {errorBack ? (
            <button type="button" onClick={errorBack.run}>
              {errorBack.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {summaryLoading && !visibleEntries.length ? (
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          Loading diff
        </div>
      ) : null}
      {!summaryLoading && !error && !visibleEntries.length ? (
        <div className="diff-content-state">
          {otherFiles.length
            ? "No changed files; other files of the review below."
            : "No changed files."}
        </div>
      ) : null}
      <DiffThreadsContext.Provider value={diffThreads}>
        <DiffDrawingContext.Provider value={drawing}>
          {overallBlock}
          {forgeSection}
          {generalBlock}
          {diffList}
          {otherFilesBlock}
        </DiffDrawingContext.Provider>
      </DiffThreadsContext.Provider>
      {/* The review's list opens with none too (`:conversations`), saying so. */}
      {threadsOpen &&
      ((listedThreads.length && diffThreads) || reviewEditor) ? (
        <ThreadsList
          className="diff-threads"
          threads={
            reviewEditor
              ? conversationOrder([...listedThreads, ...viewed.otherView])
              : listedThreads
          }
          {...(reviewEditor && viewed.otherView.length
            ? { whereNote: otherViewNote(viewed.otherView) }
            : {})}
          api={diffThreads?.api ?? threadWrites(connectionClient.connectionId)}
          onGo={
            reviewEditor
              ? (thread) => {
                  // On its line, the panel closed: its view shown, its
                  // file opened and read, its lines revealed on the way.
                  setThreadsOpen(false);
                  const spot = readingOrder.find(
                    (each) => each.thread.id === thread.id,
                  );
                  const other = spot ? undefined : otherFileOf(thread);
                  if (spot) showThread(spot);
                  else if (other) showOtherFile(other);
                  else goToAnyThread(thread);
                  sectionRef.current?.focus({ preventScroll: true });
                }
              : goToThread
          }
          onClose={() => {
            setThreadsOpen(false);
            if (reviewEditor)
              sectionRef.current?.focus({ preventScroll: true });
          }}
          {...(reviewEditor
            ? {
                editor: (thread: ReviewThread, close: () => void) =>
                  threadComposer(thread, null, close),
              }
            : {})}
        />
      ) : null}
      {cursor.status ? (
        <div className="diff-cursor-status" aria-live="polite">
          {cursor.status}
        </div>
      ) : null}
      {cursor.searchPrompt ? (
        <CommandLine
          kind="/"
          onBlur={cursor.closeSearchPrompt}
          onSubmit={(text) => {
            sectionRef.current?.focus({ preventScroll: true });
            cursor.submitSearch(text);
          }}
          onCancel={() => {
            cursor.closeSearchPrompt();
            sectionRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      <AnnotationComposerPopover
        draft={reviewEditor ? null : annotationComposerDraft}
        onSave={saveAnnotation}
        onClose={closeAnnotationComposer}
      />
    </section>
  );
}

/** What the review's views (the commit bar) give Changes' diff. */
type ViewProps = {
  /** Where the review's place is kept (the scope's, until it has a review). */
  placeKey?: string;
  /** The view to show is drawn (its commit's files): the place can be read. */
  placeSettled?: boolean;
  /** The commit bar, under the head. */
  viewBar?: ReactNode;
  /** `<` `>` `gc`: true when taken. */
  viewKey?: (key: string) => boolean;
  /** `:commit`, `:all`, `:commits`, `:e`. */
  viewCommands?: InspectorCommand[];
  /**
   * The commit shown (null: all the changes); undefined without views.
   * A comment shows in the view it was written on.
   */
  viewCommit?: string | null;
  /** One commit: it is all the changes, its comments show on it too. */
  viewSingleCommit?: boolean;
  /** A path found in no file of the view: another view's file, shown. */
  onSearchElsewhere?: (pattern: string) => Promise<string | null>;
  /** A file as the view shows it, for the lines revealed around a hunk. */
  readViewFile?: (path: string) => Promise<string>;
  /**
   * A merge request's review: its discussions found again
   * in today's file, the head they are on, all the changes shown.
   */
  forge?: {
    relocations: ReadonlyMap<string, ForgeRelocation>;
    headSha: string | null;
    onAllChanges: () => void;
  };
};

type DiffContentViewProps = Omit<
  Parameters<typeof DiffContentViewInner>[0],
  keyof ViewProps
> & {
  /**
   * The review's view shown when not the scope's own files (a commit, a
   * range opened by name), for the tree; null when the scope's are shown.
   */
  onViewEntries?: (
    view: {
      label: string;
      entries: readonly GitDiffEntry[];
      /** A review of one commit's name: its short sha and subject. */
      title?: string;
    } | null,
  ) => void;
  /**
   * Commits' Review this commit: that commit shown in the
   * Branch scope's commit bar once its commits are read; `onCommitAbsent`
   * when the scope does not hold it.
   */
  showCommit?: { sha: string; at: number } | null;
  onCommitAbsent?: (sha: string) => void;
  /**
   * The review shown as the scope cannot be read: its code is gone from
   * its checkout (base, head or checkout), with why.
   */
  onReviewGone?: (sessionId: string, message: string) => void;
};

const NO_FILES: Record<string, GitDiffFile> = {};
const NO_AGENT_PANES: readonly { paneId: string; agent: string }[] = [];

/**
 * Changes' diff. A scope that is a review of commits (the Branch scope, a
 * range opened by name) gets the review's views: the
 * commit bar, `<` `>` `gc` `:commit` `:all`, a commit's files with its
 * message first, the reload offer.
 */
export function DiffContentView({
  onViewEntries,
  showCommit = null,
  onCommitAbsent,
  onReviewGone,
  ...props
}: DiffContentViewProps) {
  const {
    reviewCursor = false,
    embedded = false,
    reviewScope = WORKING_SCOPE,
    connectionClient,
    files = NO_FILES,
    file,
    repo,
  } = props;
  const reviewing = reviewCursor && !embedded;
  const first = Object.values(files)[0] ?? file ?? null;
  const root = repo?.root ?? first?.root ?? "";
  const workspaceId = first?.workspace_id ?? "";
  const { sessions } = useReviewState();
  const connectionId = connectionClient.connectionId;
  const viewsScope =
    reviewing &&
    (reviewScope.kind === "branch" || reviewScope.kind === "review");
  const bound = viewsScope
    ? scopeReview([...sessions.values()], connectionId, root, reviewScope)
    : null;
  const branchBase =
    reviewScope.kind === "branch"
      ? (reviewScope.base ?? reviewScope.automaticBase)
      : undefined;
  const source: ViewsSource | null = !viewsScope
    ? null
    : reviewScope.kind === "review"
      ? { sessionId: reviewScope.sessionId }
      : bound
        ? { sessionId: bound.session.id }
        : workspaceId && root && branchBase
          ? {
              workspaceId,
              path: root,
              target: { kind: "range", base: branchBase, head: "HEAD" },
            }
          : null;
  // The view is remembered per review: a scope's, whether its review was
  // opened yet or not.
  const placeKey =
    reviewScope.kind === "review"
      ? reviewScope.sessionId
      : `changes:${connectionId}:${root}:${branchBase ?? ""}`;
  const where = useMemo(() => ({ root, workspaceId }), [root, workspaceId]);
  const views = useChangesViews({
    connectionId,
    source,
    enabled: viewsScope,
    native: reviewScope.kind === "branch",
    placeKey,
    where,
  });
  // A review whose code is gone says so once per failure.
  const reviewGoneRef = useRef(onReviewGone);
  reviewGoneRef.current = onReviewGone;
  const goneSession =
    views.gone && reviewScope.kind === "review" ? reviewScope.sessionId : null;
  const goneStatus = views.status;
  useEffect(() => {
    if (goneSession) reviewGoneRef.current?.(goneSession, goneStatus);
  }, [goneSession, goneStatus]);
  // A merge request's review: its discussions read again while shown, an
  // older head's found again in today's file.
  const forgeSnapshot =
    reviewScope.kind === "review"
      ? (sessions.get(reviewScope.sessionId) ?? null)
      : null;
  const forgeOn = reviewing && !!forgeSnapshot?.session.gitlab;
  useForgePoll(
    connectionId,
    forgeOn && forgeSnapshot ? forgeSnapshot.session.id : null,
    forgeOn,
  );
  const relocations = useForgeRelocations({
    connectionId,
    sessionId: forgeSnapshot?.session.id ?? null,
    threads: forgeSnapshot?.threads ?? NO_THREADS,
    headSha: views.headSha,
    enabled: forgeOn && views.sha === null,
    worktree: forgeSnapshot?.session.target.kind === "worktree",
  });
  const [viewGoTo, setViewGoTo] = useState<{
    path: string;
    line?: number;
    at: number;
    /**
     * The view it is in (gn to another commit's thread): gone to once that
     * view is shown, not in the one shown while it is read.
     */
    sha?: string | null;
  } | null>(null);
  const shownSha = views.shownSha;
  useEffect(() => {
    if (!viewGoTo || viewGoTo.sha === undefined) return;
    if (shownSha !== viewGoTo.sha) return;
    setViewGoTo({
      path: viewGoTo.path,
      ...(viewGoTo.line !== undefined ? { line: viewGoTo.line } : {}),
      at: Date.now(),
    });
  }, [viewGoTo, shownSha]);
  const sectionKeys = useRef<HTMLDivElement | null>(null);
  const say = (message: string) => store.notify({ kind: "info", message });
  const viewEntriesRef = useRef(onViewEntries);
  viewEntriesRef.current = onViewEntries;
  const shownEntries = views.shown?.entries ?? null;
  const viewLabel = views.name
    ? `${views.name.head} ${views.name.subject}`
    : (bound?.session.title ?? "Review");
  const reviewTitle =
    oneCommitTitle(bound?.session.target, views.commits) ?? undefined;
  useEffect(() => {
    viewEntriesRef.current?.(
      shownEntries
        ? {
            label: viewLabel,
            entries: shownEntries,
            ...(reviewTitle ? { title: reviewTitle } : {}),
          }
        : null,
    );
  }, [shownEntries, viewLabel, reviewTitle]);
  useEffect(() => () => viewEntriesRef.current?.(null), []);
  // Review this commit: shown once the Branch scope's commits are read.
  const commitAbsentRef = useRef(onCommitAbsent);
  commitAbsentRef.current = onCommitAbsent;
  const commitShown = useRef("");
  const commitAbsentAt = useRef(0);
  const summaryLoading = props.summaryLoading ?? false;
  const entryCount = props.entries?.length ?? 0;
  const viewsActive = views.active;
  const viewsReady = views.ready;
  const viewCommits = views.commits;
  const showView = views.show;
  const scopeKind = reviewScope.kind;
  // Again when the scope's review settles (its base read, its review
  // found): each is read anew at its own remembered view.
  const commitAt = showCommit ? `${showCommit.at}|${placeKey}` : "";
  useEffect(() => {
    if (!showCommit || commitShown.current === commitAt) return;
    if (Date.now() - showCommit.at > 15_000) return;
    if (!reviewing || scopeKind !== "branch") return;
    // Its commits still on their way (read once its files are).
    if (viewsActive ? !viewsReady : summaryLoading || entryCount) return;
    commitShown.current = commitAt;
    const sha = showCommit.sha;
    const found = viewCommits?.find(
      (commit) => commit.sha === sha || commit.sha.startsWith(sha),
    );
    if (found) showView(found.sha);
    else if (commitAbsentAt.current !== showCommit.at) {
      commitAbsentAt.current = showCommit.at;
      commitAbsentRef.current?.(sha);
    }
  }, [
    showCommit,
    commitAt,
    reviewing,
    scopeKind,
    summaryLoading,
    entryCount,
    viewsActive,
    viewsReady,
    viewCommits,
    showView,
  ]);
  // The file gone to is read first (set below, once the view is known).
  const pickedUnreadRef = useRef<string | null>(null);
  const pickedAsked = useRef<string | null>(null);
  const loadViewFile = views.loadFile;
  useEffect(() => {
    const wanted = pickedUnreadRef.current;
    // Once per go-to: a file that fails waits for Retry.
    if (!wanted || wanted === pickedAsked.current) return;
    pickedAsked.current = wanted;
    loadViewFile(wanted.slice(0, wanted.lastIndexOf("\n")));
  });
  if (!reviewing) return <DiffContentViewInner {...props} />;

  const { onRetry, onCreateAnnotation, cursorGoTo } = props;
  const reload = () => {
    views.reload();
    onRetry?.();
  };
  const reviewTarget = bound?.session.target;
  /** A step's untracked files too large for its snapshots. */
  const shownTarget =
    reviewScope.kind === "review"
      ? sessions.get(reviewScope.sessionId)?.session.target
      : undefined;
  const skipped =
    reviewScope.kind === "step"
      ? (reviewScope.step.skipped ?? [])
      : shownTarget?.kind === "step"
        ? (shownTarget.skipped ?? [])
        : [];
  /** The view's own files, when they are not Changes'. */
  const foreign =
    views.active &&
    (views.commits === null
      ? reviewScope.kind === "review"
      : !(views.sha === null && reviewScope.kind === "branch"));
  const shown = foreign
    ? (views.shown ?? {
        entries: [],
        files: NO_FILES,
        loadingKeys: [],
        fileErrors: {},
      })
    : null;
  // The file a search found in another view is the one picked there, as
  // the tree's pick would: the cursor goes there once it is drawn.
  const goTo =
    viewGoTo &&
    viewGoTo.sha === undefined &&
    (!cursorGoTo || viewGoTo.at > cursorGoTo.at)
      ? viewGoTo
      : cursorGoTo;
  const picked =
    (goTo && shown?.entries.find((each) => each.path === goTo.path)) ??
    shown?.entries[0];
  // The file gone to is read first, large or generated as it may be.
  const pickedUnread =
    picked && shown && !shown.files[`branch:${picked.path}`]
      ? picked.path
      : null;
  pickedUnreadRef.current =
    pickedUnread && goTo ? `${pickedUnread}\n${goTo.at}` : null;
  const focusDiff = () =>
    sectionKeys.current
      ?.closest<HTMLElement>(".diff-content-view")
      ?.focus({ preventScroll: true });
  /**
   * gn / gN past the view's threads: the next unresolved one written on
   * another commit (one rewritten out of the review too, named as it was),
   * its view shown and the cursor on it.
   */
  const threadsElsewhere = (
    direction: 1 | -1,
    drawn: ReadonlySet<string>,
  ): boolean => {
    if (!views.active || !views.commits?.length) return false;
    const order = views.commits.map((commit) => commit.sha);
    const seen = new Set<string>();
    const candidates = [...(bound?.threads ?? []), ...(props.threads ?? [])]
      .filter((thread) => {
        if (seen.has(thread.id)) return false;
        seen.add(thread.id);
        const { commit, path } = thread.anchor;
        return (
          !thread.resolved &&
          !!commit &&
          !!path &&
          commit !== views.sha &&
          !drawn.has(thread.id)
        );
      })
      .map((thread) => {
        const at = order.indexOf(thread.anchor.commit!);
        return { thread, rank: at < 0 ? order.length : at };
      })
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          (a.thread.anchor.line ?? 0) - (b.thread.anchor.line ?? 0),
      );
    const next =
      direction === 1 ? candidates[0] : candidates[candidates.length - 1];
    if (!next) return false;
    const { anchor } = next.thread;
    const sha = anchor.commit!;
    views.show(
      sha,
      order.includes(sha)
        ? undefined
        : {
            ...(anchor.commitSubject ? { subject: anchor.commitSubject } : {}),
            ...(anchor.commitParent ? { parent: anchor.commitParent } : {}),
          },
    );
    setViewGoTo({
      path: anchor.path!,
      ...(anchor.line !== undefined ? { line: anchor.line } : {}),
      at: Date.now(),
      sha,
    });
    return true;
  };
  /**
   * Go to it on a thread of another view: its commit's (one rewritten out
   * of the review too, named as it was), or all the changes'.
   */
  const showThreadView = (thread: ReviewThread): boolean => {
    if (!views.active || !views.commits?.length) return false;
    const { commit, commitSubject, commitParent } = thread.anchor;
    const order = views.commits.map((each) => each.sha);
    const sha = commit
      ? (order.find((each) => each.startsWith(commit)) ?? commit)
      : null;
    if (sha === views.sha) return false;
    views.show(
      sha,
      sha === null || order.includes(sha)
        ? undefined
        : {
            ...(commitSubject ? { subject: commitSubject } : {}),
            ...(commitParent ? { parent: commitParent } : {}),
          },
    );
    return true;
  };
  const commands: InspectorCommand[] = [
    {
      name: "commit",
      description:
        "one commit: :commit 2, :commit words; :commit alone, all the changes",
      run: (argument) => views.command("commit", argument),
    },
    {
      name: "all",
      description: "all the changes (:commit alone)",
      run: () => {
        if (!views.history) views.show(null);
      },
    },
    {
      name: "commits",
      description: "pick a commit by its subject or sha (gc)",
      run: (argument) => views.command("commits", argument),
    },
    {
      name: "reload",
      aliases: ["e", "edit"],
      description: "read the review again, on the same line (R, gr)",
      run: reload,
    },
  ];
  return (
    <DiffContentViewInner
      {...props}
      {...(shown
        ? {
            entries: shown.entries,
            files: shown.files,
            entry: picked ?? null,
            file: picked
              ? (shown.files[`branch:${picked.path}`] ?? null)
              : null,
            loading: false,
            error: null,
            fileErrors: shown.fileErrors,
            loadingKeys: shown.loadingKeys,
            summaryLoading: !views.shown,
            // The view's files near the reader are read, not Changes'.
            onNearbyFilesChange: (entries: GitDiffEntry[]) =>
              views.loadNearby(entries.map((entry) => entry.path)),
            // A file not read yet (large, generated, failed): read now.
            onSelectFile: (entry: GitDiffEntry) => {
              views.loadFile(entry.path);
              props.onSelectFile?.(entry);
            },
          }
        : {})}
      cursorGoTo={goTo ?? null}
      onRetry={reload}
      onThreadsElsewhere={threadsElsewhere}
      onShowThreadView={showThreadView}
      placeKey={placeKey}
      placeSettled={
        !views.active ||
        (views.ready &&
          !views.placePending &&
          (!!views.shown ||
            (views.current === null && reviewScope.kind === "branch")))
      }
      {...(onCreateAnnotation
        ? {
            onCreateAnnotation: (input, written) =>
              onCreateAnnotation(
                input.source === "diff"
                  ? {
                      ...input,
                      ...(views.current
                        ? {
                            commit: {
                              sha: views.current.sha,
                              subject: views.current.subject,
                              parent: views.current.parent,
                            },
                          }
                        : {}),
                      // A range opened by name: its own review.
                      ...(reviewScope.kind === "review" &&
                      reviewTarget?.kind === "range" &&
                      !input.target
                        ? { target: reviewTarget }
                        : {}),
                    }
                  : input,
                written,
              ),
          }
        : {})}
      viewBar={
        <>
          <div ref={sectionKeys} hidden />
          {skipped.length ? (
            <div className="diff-review-views">
              <span className="note" role="note">
                Left out of this step (untracked, over 50 MB):{" "}
                {skipped.join(", ")}
              </span>
            </div>
          ) : null}
          {views.active ? (
            <ChangesCommitBar
              views={views}
              onReload={reload}
              onDone={focusDiff}
            />
          ) : null}
        </>
      }
      viewKey={(key) => {
        if (key !== "<" && key !== ">" && key !== "gc") return false;
        if (!views.active || !views.commits?.length) {
          say("This review has a single commit.");
          return true;
        }
        if (key === "gc") views.openPicker();
        else views.step(key === ">" ? 1 : -1);
        return true;
      }}
      viewCommands={commands}
      {...(forgeOn
        ? {
            forge: {
              relocations,
              headSha: views.headSha,
              onAllChanges: () => views.show(null),
            },
          }
        : {})}
      {...(views.active && views.commits?.length
        ? {
            viewCommit: views.sha,
            viewSingleCommit: views.commits.length === 1 && !views.history,
          }
        : {})}
      {...(views.active
        ? { readViewFile: views.readFile }
        : reviewScope.kind === "step" && workspaceId && root
          ? {
              // The step's after tree, read with no review made.
              readViewFile: async (path: string) =>
                (
                  await reviewCall<{ text: string }>(
                    connectionId,
                    "review.file",
                    {
                      workspace_id: workspaceId,
                      checkout: root,
                      target: stepTarget(reviewScope.step),
                      path,
                      rev: reviewScope.step.after,
                    },
                  )
                ).text,
            }
          : {})}
      onSearchElsewhere={async (pattern) => {
        const path = await views.searchElsewhere(pattern);
        if (path) setViewGoTo({ path, at: Date.now() });
        return path;
      }}
    />
  );
}
