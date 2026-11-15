import { imageMimeForPath } from "../../../shared/filePreview";
import { roamgateLocalStorage, subscribeLocalStorage } from "../browserStorage";
import { shortcutMatches } from "../shortcutPreferences";
import type { SelectedLineRange } from "@pierre/diffs";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  MessageSquareText,
  Search,
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
import { REVIEW_USER, type ReviewThread } from "../../../shared/review";
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
  reviewsUndelivered,
  threadWrites,
  ThreadsList,
  type Undelivered,
  useFileThreadView,
} from "./FileThreads";
import { ThreadsChip } from "./ThreadsPanel";
import {
  changesDraftSession,
  ReviewDiffComposer,
  suggestionBlock,
} from "./ReviewDiffComposer";
import {
  cursorThreadPlace,
  type PlacedThread,
  placeDiffThreads,
  threadReadingOrder,
  threadsAtCursor,
} from "../changesThreads";
import { repoFeedback, type ShownRepo } from "../changesRepo";
import { latestComment } from "../reviewNavigation";
import { useChangesAgent } from "../changesReview";
import type { ReviewProgress } from "./DiffViewerPanel";
import {
  CHANGES_REVIEW_VIEW,
  type ChunkSpan,
  changesReviewed,
  chunkSpans,
  markChunks,
  reviewedLayout,
} from "../changesReviewed";
import { nextUnreviewedHunk } from "../reviewNavigation";
import {
  fileToggleChanges,
  fileToggleNotice,
  hunkToggle,
  hunkToggleNotice,
  pickHunks,
} from "../reviewToggle";
import type { GitFileAction } from "../gitActions";
import { ChangesAgentBar } from "./ChangesAgentBar";
import { stepNotice, stepUnresolved } from "../unresolvedThreads";
import { usePendingFeedback } from "../feedbackPending";
import { useReviewState } from "../review";
import { useInspectorCommands } from "../useInspectorCommands";
import type { InspectorCommand } from "../inspectorCommands";
import { CommandLine } from "./CommandLine";
import {
  type DiffCursor,
  DIFF_CURSOR_KEYS,
  DIFF_REVIEW_KEYS,
  useDiffCursor,
} from "./useDiffCursor";
import "./DiffContentView.css";

export { highlightedPatch } from "./DiffSurface";

type DiffViewMode = "split" | "unified";
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

function loadDiffViewMode(): DiffViewMode {
  return roamgateLocalStorage.getItem(DIFF_VIEW_MODE_KEY) === "unified"
    ? "unified"
    : "split";
}

function loadMobileDiffWrap() {
  return roamgateLocalStorage.getItem(MOBILE_DIFF_WRAP_KEY) === "true";
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
};

const NO_MARKS: Readonly<Record<string, string>> = {};
const NO_ANNOTATIONS: readonly ReviewAnnotation[] = [];
const NO_NESTED: ReadonlyMap<string, ReviewThread[]> = new Map();

const DiffThreadsContext = createContext<DiffThreads | null>(null);

/** The id of the comment box drawn as an annotation under its line. */
const COMPOSER_ID = "\u0000composer";

/**
 * The review's comment box (reviewin Changes), what the annotation of
 * COMPOSER_ID draws; hidden comments and the threads only the unresolved
 * ones: what `t` and `gH` set.
 */
type DiffDrawing = {
  composer: ReactNode;
  composerKey: string;
  hideComments: boolean;
  openOnly: boolean;
};

const DiffDrawingContext = createContext<DiffDrawing | null>(null);

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
   * the staged or unstaged entry they were written on (plan D8).
   */
  byPath = false,
): ReviewThread[] {
  const byId = new Map(threads.map((each) => [each.id, each]));
  const shown = new Set(
    entries.map((each) => (byPath ? each.path : `${each.kind}:${each.path}`)),
  );
  return annotations.flatMap((note) => {
    const thread =
      note.source === "diff" &&
      shown.has(byPath ? note.path : `${note.kind}:${note.path}`)
        ? byId.get(note.id)
        : undefined;
    return thread ? [thread] : [];
  });
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
          {waiting.error === undefined ? (
            <div className="rc-bar" role="status">
              <span className="rc-kind">Sending...</span>
            </div>
          ) : (
            <div className="rc-bar" role="alert">
              <span className="rc-kind rc-failed">
                Not saved: {waiting.error}
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="btn ghost"
                onClick={waiting.retry}
              >
                Retry
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={waiting.discard}
              >
                Discard
              </button>
            </div>
          )}
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
  onOpenFile?: (entry: GitDiffEntry) => void;
  openFileLabel?: string;
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
  /**
   * The file is reviewed (every chunk) and folded to its header, as the
   * review pane folds it; `onShowReviewed` shows it again.
   */
  reviewedFolded?: boolean;
  onShowReviewed?: (path: string) => void;
};

const DiffFileSection = memo(function DiffFileSection({
  section,
  loading,
  nearby,
  imagePreviewState,
  options,
  currentSearchMatch,
  embedded,
  mobile,
  annotations,
  annotationSelectionActive,
  onToggle,
  onSelectFile,
  onOpenFile,
  openFileLabel = "Open in Files",
  onRequestAnnotation,
  onEditAnnotation,
  onInstance,
  onLineClick,
  cursorSelection,
  searchHit = false,
  chunkSpans,
  reviewedFolded = false,
  onShowReviewed,
}: DiffFileSectionProps) {
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
      chunkSpans
        ? (node: HTMLElement) => markChunks(node.shadowRoot ?? node, chunkSpans)
        : undefined,
    [chunkSpans],
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
    // A reviewed file folded on its own opens, as in the review pane.
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
      className={`diff-file-section ${embedded ? "is-embedded" : ""} ${currentSearchMatch ? "is-search-current" : ""} ${searchHit ? "is-cursor-search-hit" : ""}`}
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
        </header>
      )}
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
    previous.onRequestAnnotation === next.onRequestAnnotation &&
    previous.onEditAnnotation === next.onEditAnnotation &&
    previous.onInstance === next.onInstance &&
    previous.onLineClick === next.onLineClick &&
    sameRange(previous.cursorSelection, next.cursorSelection) &&
    previous.searchHit === next.searchHit &&
    previous.chunkSpans === next.chunkSpans &&
    previous.reviewedFolded === next.reviewedFolded &&
    previous.onShowReviewed === next.onShowReviewed
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

export function DiffContentView({
  selectionRevision = 0,
  cursorGoTo = null,
  scopeLabel,
  scopeControls,
  headEnd,
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
  onAddReviewImage,
  onGitAction,
}: {
  selectionRevision?: number;
  /** On "in Changes", what is shown: repository, scope, branch and base. */
  scopeLabel?: string;
  /** The scope line as controls (the review in Changes), for scopeLabel. */
  scopeControls?: ReactNode;
  /** At the toolbar's end (Review only: Show all, Zen's way out). */
  headEnd?: ReactNode;
  /** Files' Review on "in Changes": the cursor to that file and line. */
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
  onOpenFile?: (entry: GitDiffEntry) => void;
  openFileLabel?: string;
  loadImagePreview?: (path: string) => Promise<FilePreview>;
  onCreateAnnotation?: (annotation: NewReviewAnnotation) => void;
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
   * The review's Vim cursor and keys (on "in Changes" with Vim keys on);
   * off, Changes keeps its own keys and mouse.
   */
  reviewCursor?: boolean;
  /** The files with a hit of the cursor's search, for the tree to mark. */
  onSearchMatchesChange?: (paths: readonly string[]) => void;
  /** The files' reviewed chunks, for the tree (the review in Changes). */
  onReviewProgress?: (progress: ReadonlyMap<string, ReviewProgress>) => void;
  /** Stores an image pasted in the review's comment box; Markdown for it. */
  onAddReviewImage?: (file: File) => Promise<string>;
  /** A git action on a file of the working changes (`:stage`, `gs`). */
  onGitAction?: (action: GitFileAction, path: string) => boolean;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const { sessions: reviewSessions } = useReviewState();
  // Only the shown repository's: another one's file of the same path never
  // gets its threads.
  const repoRoot = repo?.root;
  const repoOwn = repo?.own;
  const scoped = useMemo(
    () =>
      repoFeedback(
        givenAnnotations,
        givenThreads ?? [],
        (sessionId) => reviewSessions.get(sessionId)?.session.root,
        repoRoot === undefined ? undefined : { root: repoRoot, own: !!repoOwn },
      ),
    [givenAnnotations, givenThreads, repoOwn, repoRoot, reviewSessions],
  );
  const annotations = scoped.annotations;
  const threads = givenThreads ? scoped.threads : undefined;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectFileRef = useRef(onSelectFile);
  const openFileRef = useRef(onOpenFile);
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
  const continuous = !embedded && connectionType !== "ssh";
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
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    loadDiffViewMode(),
  );
  const [desktopWrap, setDesktopWrap] = useState(() => loadDesktopDiffWrap());
  const [mobileWrap, setMobileWrap] = useState(() => loadMobileDiffWrap());
  useEffect(
    () =>
      subscribeLocalStorage((key) => {
        if (key === null || key === DIFF_VIEW_MODE_KEY)
          setViewMode(loadDiffViewMode());
        if (key === null || key === DESKTOP_DIFF_WRAP_KEY)
          setDesktopWrap(loadDesktopDiffWrap());
        if (key === null || key === MOBILE_DIFF_WRAP_KEY)
          setMobileWrap(loadMobileDiffWrap());
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
    for (const annotation of annotations) {
      if (annotation.source !== "diff") continue;
      const key = `${annotation.kind}:${annotation.path}`;
      const pathAnnotations = grouped.get(key);
      if (pathAnnotations) pathAnnotations.push(annotation);
      else grouped.set(key, [annotation]);
    }
    return grouped;
  }, [annotations]);
  // The comments' threads, in the file's views: drawn under their lines,
  // listed in the Comments panel, as in the Files preview.
  const threadView = useFileThreadView(() => sectionRef.current);
  const [threadsOpen, setThreadsOpen] = useState(false);
  /** The review's comment box and thread keys, "in Changes" (plan phase 4). */
  const reviewEditor = reviewCursor && !embedded;
  /** `t`: every comment hidden (their margin markers stay). */
  const [hideComments, setHideComments] = useState(false);
  /** A suggestion asked for with `s`, the comment box's first words. */
  const [composerSeed, setComposerSeed] = useState<string | undefined>();
  const [overallOpen, setOverallOpen] = useState(false);
  const changesAgent = useChangesAgent(
    connectionClient.connectionId,
    reviewEditor ? (Object.values(filesByKey)[0]?.root ?? file?.root) : null,
    Object.values(filesByKey)[0]?.workspace_id ?? file?.workspace_id,
  );
  const shownThreads = useMemo(
    () =>
      diffViewThreads(annotations, threads ?? [], visibleEntries, reviewEditor),
    [annotations, reviewEditor, threads, visibleEntries],
  );
  const diffThreads = useMemo<DiffThreads | null>(() => {
    if (!threads?.length) return null;
    return {
      byId: new Map(threads.map((each) => [each.id, each])),
      api: threadWrites(connectionClient.connectionId),
      view: threadView,
      nested: reviewEditor ? nestThreads(threads).nested : NO_NESTED,
      undelivered: reviewsUndelivered(
        [...new Set(threads.map((each) => each.sessionId))].map((id) =>
          reviewSessions.get(id),
        ),
      ),
    };
  }, [
    connectionClient.connectionId,
    reviewEditor,
    reviewSessions,
    threadView,
    threads,
  ]);
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
  const renderedSections = useMemo<DiffSection[]>(
    () =>
      visibleEntries.map((visibleEntry) => {
        const key = diffEntryKey(visibleEntry);
        const diffFile = filesByKey[key] ?? null;
        const renderableFile = diffRenderableFile(diffFile);
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
    [
      activeEntryKey,
      continuous,
      embedded,
      fileErrors,
      filesByKey,
      manualCollapseStates,
      visibleEntries,
    ],
  );
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
  const handleOpenFile = useCallback((target: GitDiffEntry) => {
    openFileRef.current?.(target);
  }, []);
  const handleRequestAnnotation = useCallback(
    (target: DiffAnnotationRequest) => setPendingAnnotation(target),
    [],
  );
  const closeAnnotationComposer = useCallback(
    () => setPendingAnnotation(null),
    [],
  );
  const saveAnnotation = useCallback(
    (comment: string) => {
      if (!pendingAnnotation || !onCreateAnnotation) return;
      onCreateAnnotation({
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
      });
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
        onPostRender: () => {
          if (performance.now() <= userScrollUntilRef.current)
            restoreScrollAnchor();
        },
      }),
    [effectiveViewMode, restoreScrollAnchor, theme, wrapEnabled],
  );

  /*
   * The review's Vim cursor (plan: review into the inspector, phase 3), on
   * the files drawn as diffs; only where the inspector shows Changes "in
   * Changes" with Vim keys on.
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
      mode: "comment" | "suggest" | "new",
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
  const cursor = useDiffCursor({
    enabled: reviewCursor && !embedded,
    sections: cursorSections,
    split: effectiveViewMode === "split",
    rootRef: sectionRef,
    onToggleSplit: () =>
      setViewMode((mode) => (mode === "split" ? "unified" : "split")),
    onReload: onRetry,
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
    ...(reviewEditor
      ? {
          onComment: (
            key: string,
            range: SelectedLineRange,
            mode: "comment" | "suggest" | "new",
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
  // The review's reviewed marks on the rows shown (phase 5).
  const reviewLayout = useMemo(
    () => reviewedLayout(cursor.model),
    [cursor.model],
  );
  const reviewedMarks = changesAgent.snapshot?.session.reviewed ?? NO_MARKS;
  const reviewState = useMemo(
    () => changesReviewed(reviewLayout, reviewedMarks),
    [reviewLayout, reviewedMarks],
  );
  const chunkSpansByKey = useMemo(
    () => chunkSpans(cursor.model, reviewLayout, reviewState),
    [cursor.model, reviewLayout, reviewState],
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
      const taken = cursorLineClickRef.current(key, line, side, shift);
      // A click on a folded reviewed chunk's line shows the chunk.
      requestAnimationFrame(() => peekFoldedRef.current());
      return taken;
    },
    [],
  );
  const peekFoldedRef = useRef(() => {});
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

  // ---- The review's threads and comment box (reviewin Changes) ----------

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
  // Reviewed chunks fold to one line, as in the review pane, unless a
  // thread is on them or they are peeked at (za, a click on the line).
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
  // Reviewed files fold to their header, as in the review pane, until
  // shown again (Show, a click on the name, gn to a thread there); shown,
  // a file stays open until it is unmarked.
  const [shownReviewed, setShownReviewed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const foldedFiles = useMemo(() => {
    const folded = new Set<string>();
    if (!reviewEditor) return folded;
    reviewLayout.files.forEach((info, index) => {
      if (reviewState.files.has(index) && !shownReviewed.has(info.path))
        folded.add(info.path);
    });
    return folded;
  }, [reviewEditor, reviewLayout, reviewState, shownReviewed]);
  useEffect(() => {
    // Unmarked: the next mark folds it again.
    const reviewedPaths = new Set(
      reviewLayout.files
        .filter((_, index) => reviewState.files.has(index))
        .map((info) => info.path),
    );
    setShownReviewed((current) => {
      const kept = [...current].filter((path) => reviewedPaths.has(path));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [reviewLayout, reviewState]);
  const foldedFilesRef = useRef(foldedFiles);
  foldedFilesRef.current = foldedFiles;
  /** Shows a folded reviewed file (only a folded one: kept open till unmarked). */
  const showReviewed = useCallback((path: string) => {
    if (!foldedFilesRef.current.has(path)) return;
    setShownReviewed((current) =>
      current.has(path) ? current : new Set(current).add(path),
    );
  }, []);
  // Picked in the tree, or gone to from Files' Review: a folded reviewed
  // file shows, as the review pane's file list shows it.
  const pickedPath = selectionRevision > 0 ? (entry?.path ?? null) : null;
  useEffect(() => {
    if (pickedPath) showReviewed(pickedPath);
  }, [pickedPath, selectionRevision, showReviewed]);
  useEffect(() => {
    if (cursorGoTo?.path) showReviewed(cursorGoTo.path);
  }, [cursorGoTo?.path, cursorGoTo?.at, showReviewed]);
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
  peekFoldedRef.current = () => {
    const at = cursorHandle.current.rowIndex();
    const found = reviewedSpanAt(at);
    if (found?.span.folded && found.span.rows[0] === at) togglePeek(at);
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
      if (spot) add(spot.key, { ...note, side: spot.side, line: spot.line });
      // Not a thread (yet): a note kept in this browser, where it was.
      else if (!diffThreads?.byId.has(note.id))
        add(`${note.kind}:${note.path}`, note);
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
  }, [annotationsByPath, diffNotes, diffThreads, pendingAnnotation, placement]);

  /** The thread dd deleted last: what u brings back. */
  const lastDeleted = useRef<ReviewThread | null>(null);
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
  /** Shows a thread to be read: unfolded, its line in view. */
  const showThread = (spot: PlacedThread) => {
    // In a folded reviewed file: the file opens, as the review pane's gn;
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
  reviewHandlers.current.move = (direction, count) => {
    if (direction === 1) enterLast.current = false;
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
      if (threadView.folded(owner)) threadView.unfold([owner.id]);
      threadView.setReplying(owner.id);
      return true;
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
    // A line being discussed: c answers there; C asks anew.
    if (mode !== "new" && target.endLine === undefined) {
      const spot = spotAtCursor();
      const open =
        spot &&
        threadsAtCursor(readingOrder, spot).find(
          (each) => !each.thread.resolved && each.thread.kind === "discussion",
        );
      if (open) {
        if (threadView.folded(open.thread)) threadView.unfold([open.thread.id]);
        threadView.setReplying(open.thread.id);
        return true;
      }
    }
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
      fileToggleChanges(info, marking, CHANGES_REVIEW_VIEW, reviewedMarks),
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
      CHANGES_REVIEW_VIEW,
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

  reviewHandlers.current.threadKey = (key) => {
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
      case "gn":
      case "gN":
      case "n":
      case "N": {
        const direction = key === "gn" || key === "n" ? 1 : -1;
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
        threadView.setOpenOnly(!threadView.openOnly);
        say(
          threadView.openOnly
            ? "All the comments shown"
            : "Only the unresolved comments shown",
        );
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
        if (!first) return togglePeek(cursorHandle.current.rowIndex());
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
          diffThreads.api.resolve(first.thread);
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
        // Your last comment on the line, rewritten in place.
        const written = (focused ? [{ thread: focused }] : here)
          .flatMap((each) =>
            each.thread.comments.map((comment) => ({ each, comment })),
          )
          .filter(({ comment }) => comment.author === REVIEW_USER);
        const mine = written[written.length - 1];
        if (!mine) return false;
        if (threadView.folded(mine.each.thread))
          threadView.unfold([mine.each.thread.id]);
        threadView.setEditing(mine.comment.id);
        return true;
      }
      case "dd": {
        if (!first || !diffThreads) return false;
        const [only, ...rest] = first.thread.comments;
        if (!only || rest.length || only.author !== REVIEW_USER) {
          say("Delete a comment with its Delete button.");
          return true;
        }
        lastDeleted.current = first.thread;
        diffThreads.api.remove(first.thread);
        say("Comment deleted (u undoes)");
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
        onGitAction("stage", path);
        return true;
      }
      case "T":
        if (shownThreads.length) setThreadsOpen((open) => !open);
        else say("No comments yet.");
        return true;
      case "t":
        setHideComments((hidden) => !hidden);
        return true;
      default:
        return false;
    }
  };

  /**
   * Comments on the whole review, or on code this view does not show (not
   * found by their text), drawn above the diff; the forge's discussions
   * under their own heading.
   */
  const generalThreads = useMemo<ReviewThread[]>(() => {
    if (!reviewEditor || !diffThreads || !placement) return [];
    const seen = new Set<string>();
    const found: ReviewThread[] = [];
    const add = (thread: ReviewThread) => {
      if (seen.has(thread.id) || partThreadIds.has(thread.id)) return;
      seen.add(thread.id);
      found.push(thread);
    };
    for (const thread of placement.unplaced) add(thread);
    const placed = new Set(placement.placed.map((spot) => spot.thread.id));
    for (const thread of diffThreads.byId.values())
      if (!thread.anchor.path && !placed.has(thread.id)) add(thread);
    return found;
  }, [diffThreads, partThreadIds, placement, reviewEditor]);
  const generalBlock =
    reviewEditor && diffThreads && !hideComments && generalThreads.length ? (
      <div className="diff-review-general" data-testid="diff-review-general">
        {(
          [
            [
              "Comments on the review, or on code not shown here",
              generalThreads.filter((each) => each.kind !== "merge-request"),
            ],
            [
              "GitLab",
              generalThreads.filter((each) => each.kind === "merge-request"),
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
                  />
                </div>
              ))}
            </section>
          ) : null;
        })}
      </div>
    ) : null;

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
    focusDiffAfterEditor();
  };
  const composerNode: ReactNode =
    reviewEditor && pendingAnnotation ? (
      <ReviewDiffComposer
        key={`${pendingAnnotation.kind}:${pendingAnnotation.path}:${pendingAnnotation.side}:${pendingAnnotation.line}:${pendingAnnotation.endLine ?? ""}`}
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
        draftSession={changesDraftSession(resourceKey)}
        onSave={(text) => {
          if (hideComments) setHideComments(false);
          saveAnnotation(text);
          setComposerSeed(undefined);
          focusDiffAfterEditor();
        }}
        onClose={closeReviewComposer}
        {...(onAddReviewImage ? { onAddImage: onAddReviewImage } : {})}
        notify={say}
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
    ? `${pendingAnnotation.kind}:${pendingAnnotation.path}:${pendingAnnotation.side}:${pendingAnnotation.line}:${pendingAnnotation.endLine ?? ""}:${composerSeed ?? ""}`
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
    roamgateLocalStorage.setItem(DIFF_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);
  useEffect(() => {
    roamgateLocalStorage.setItem(DESKTOP_DIFF_WRAP_KEY, String(desktopWrap));
  }, [desktopWrap]);
  useEffect(() => {
    roamgateLocalStorage.setItem(MOBILE_DIFF_WRAP_KEY, String(mobileWrap));
  }, [mobileWrap]);
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
      focusSearch();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [embedded, mobile, focusSearch]);

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
                      reviewedFolded: foldedFiles.has(section.entry.path),
                      onShowReviewed: showReviewed,
                    }
                  : {}),
              }
            : {})}
        />
      ))}
    </DiffSurfaceScroll>
  ) : null;

  /*
   * The diff's `:` commands in the inspector's prompt (Changes, a commit's
   * diff), each a button of its bar; the Files preview's embedded diff has
   * the preview's.
   */
  const diffCommands: InspectorCommand[] = [
    ...(hunkTargets.length
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
    ...(!mobile && hasSearchableDiff
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
    ...(!mobile
      ? [
          {
            name: "diff",
            aliases: ["s"],
            description: "side by side / unified (Split, Unified)",
            run: () =>
              setViewMode((mode) => (mode === "split" ? "unified" : "split")),
          },
          // With the review's cursor, the review's meaning: a toggle.
          {
            name: "split",
            description: cursor.active
              ? "side by side / unified (S)"
              : "side by side (Split)",
            run: () =>
              cursor.active
                ? setViewMode((mode) =>
                    mode === "split" ? "unified" : "split",
                  )
                : setViewMode("split"),
          },
          {
            name: "unified",
            description: cursor.active
              ? "side by side / unified (S)"
              : "one column (Unified)",
            run: () =>
              cursor.active
                ? setViewMode((mode) =>
                    mode === "split" ? "unified" : "split",
                  )
                : setViewMode("unified"),
          },
        ]
      : []),
    {
      name: "wrap",
      description: "wrap the long lines, or not (Wrap)",
      run: () =>
        mobile
          ? setMobileWrap((value) => !value)
          : setDesktopWrap((value) => !value),
    },
    ...(reviewEditor
      ? [
          {
            name: "comments",
            aliases: ["hidecomments"],
            description: "show / hide every comment (t)",
            run: () => setHideComments((hidden) => !hidden),
          },
          {
            name: "unresolved",
            aliases: ["openonly"],
            description: "show only the unresolved comments, or all (gH)",
            run: () => threadView.setOpenOnly(!threadView.openOnly),
          },
        ]
      : []),
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
    ...(reviewEditor && changesAgent.agentName
      ? [
          {
            name: "send",
            aliases: ["handoff"],
            description: `send the held comments, or the open discussions, to ${changesAgent.agentName}`,
            run: () => changesAgent.send(),
          },
          {
            name: "hold",
            description:
              "hold your comments until :send, or send each as written",
            run: () => changesAgent.toggleHold(),
          },
          {
            name: "review",
            description: `${changesAgent.agentName} reviews the changes: :review [focus]`,
            run: (argument: string) => changesAgent.review(argument),
          },
          {
            name: "overall",
            aliases: ["summary"],
            description: "write the overall comment on the review",
            run: () => setOverallOpen(true),
          },
        ]
      : []),
    ...(shownThreads.length
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
          commands: diffCommands,
          ...(cursor.active
            ? {
                line: cursor.goToLine,
                keys: reviewEditor
                  ? [...DIFF_CURSOR_KEYS, ...DIFF_REVIEW_KEYS]
                  : DIFF_CURSOR_KEYS,
              }
            : {}),
        },
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
      onKeyDownCapture={(e) => {
        if (
          !embedded &&
          !mobile &&
          shortcutMatches(e.nativeEvent, "preview.search") &&
          // With the review's cursor, Ctrl-f is a page down (Vim's); a
          // Mac's Cmd+F still finds.
          !(cursor.active && e.ctrlKey && !e.metaKey)
        ) {
          if (isEditableSearchTarget(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          focusSearch();
        }
      }}
    >
      <div className="diff-content-head">
        {mobile && backAction ? (
          <button
            type="button"
            className="diff-content-back"
            title={backAction.label}
            aria-label={backAction.label}
            onClick={backAction.onClick}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
        ) : null}
        {embedded ? null : (
          <div className="diff-content-title">
            {scopeControls ? (
              scopeControls
            ) : scopeLabel ? (
              <strong className="diff-content-scope" title={scopeLabel}>
                {scopeLabel}
                {changedFileCount
                  ? ` · ${changedFileCount} file${changedFileCount === 1 ? "" : "s"}`
                  : ""}
              </strong>
            ) : (
              <strong>
                {changedFileCount
                  ? `${changedFileCount} changed file${
                      changedFileCount === 1 ? "" : "s"
                    }`
                  : "Diff Viewer"}
              </strong>
            )}
          </div>
        )}
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
        {mobile ? (
          <button
            type="button"
            className={`diff-wrap-toggle ${mobileWrap ? "is-active" : ""}`}
            onClick={() => setMobileWrap((value) => !value)}
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
          />
        ) : null}
        <div className="diff-content-actions">
          {hunkTargets.length ? (
            <div
              className="diff-hunk-navigation"
              aria-label="Change navigation"
            >
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
                {mobile
                  ? ""
                  : ` ${hunkTargets.length === 1 ? "change" : "changes"}`}
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
          {!embedded && !mobile ? (
            <div className="diff-search-controls">
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
        {shownThreads.length ? (
          <ThreadsChip
            className="diff-threads-chip"
            threads={shownThreads}
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
        {!mobile ? (
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
      </div>

      {error && !visibleEntries.length ? (
        <div className="diff-content-state is-error">
          <span>{error}</span>
          {onRetry ? (
            <button type="button" onClick={onRetry}>
              Retry
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
        <div className="diff-content-state">No changed files.</div>
      ) : null}
      <DiffThreadsContext.Provider value={diffThreads}>
        <DiffDrawingContext.Provider value={drawing}>
          {generalBlock}
          {diffList}
        </DiffDrawingContext.Provider>
      </DiffThreadsContext.Provider>
      {threadsOpen && shownThreads.length && diffThreads ? (
        <ThreadsList
          className="diff-threads"
          threads={shownThreads}
          api={diffThreads.api}
          onGo={goToThread}
          onClose={() => setThreadsOpen(false)}
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
