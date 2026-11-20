import { shortcutMatches } from "../shortcutPreferences";
import { vimKeys } from "../vimKeys";
import {
  audioMimeForPath,
  AUDIO_INLINE_PREVIEW_MAX_BYTES,
} from "../../../shared/filePreview";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  X,
} from "lucide-react";
import { fileReviewLineLabel, MAX_QUOTE_LENGTH } from "../annotations";
import {
  FileAnnotationDrag,
  type FileAnnotationRequest,
} from "./fileAnnotationDrag";
import type {
  FileLineReviewAnnotation,
  NewReviewAnnotation,
  ReviewAnnotation,
} from "../annotations";
import type { FileExplorerEntry, FilePreview } from "../types";
import type {
  ReviewRegion,
  ReviewRenderPart,
  ReviewThread,
} from "../../../shared/review";
import {
  pageFromHome,
  pageUnderHome,
  parseSiteUrl,
  RENDERED_PREFIX,
  type RenderedFrameMessage,
  type RenderedRootMap,
} from "../../../shared/renderedPage";
import type { FeedbackCapture } from "../workspaceFeedback";
import {
  cropGraphic,
  elementLabel,
  type HeldGraphic,
  holdGraphic,
} from "../renderedCapture";
import { isAnimatedSvg, markdownSource, pointQuote } from "../renderedSource";
import { DiagramFrameContext } from "./DiagramBlock";
import {
  fileStopAnchor,
  fileThreadKeys,
  fileThreadOrder,
  fileThreadPlace,
  focusFileThread,
  reviewsUndelivered,
  fileStopForLine,
  fileStopKey,
  SlotThreads,
  ThreadsList,
  useFileThreads,
  useFileThreadView,
  useMarkedBlocks,
  useQuoteHighlights,
} from "./FileThreads";
import { useThreadKeys } from "./useThreadKeys";
import {
  stepNotice,
  stepUnresolved,
  unresolvedPosition,
} from "../unresolvedThreads";
import { RenderedFrame } from "./RenderedFrame";
import { useGraphicPointing } from "./useGraphicPointing";
import { useRenderedScripts } from "../useRenderedScripts";
import { ThreadsChip, UnresolvedNav } from "./ThreadsPanel";
import {
  useZenEscape,
  useZenMode,
  ZenButton,
  zenKeyTarget,
} from "../useZenMode";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { useChangedOnDisk } from "../useChangedOnDisk";
import {
  useLiveConnectionClient,
  useReloadOnReconnect,
} from "../useReloadOnReconnect";
import {
  framesHtmlPreview,
  resolveWorkspaceMarkdownImageUrl,
  workspaceMarkdownDocumentPath,
  workspaceFileUrl,
} from "../workspaceFileUrl";
import {
  MarkdownPreview,
  markdownHeadingPath,
  type MarkdownSelectionTarget,
  type SlotWhere,
} from "./markdown";
import {
  AnnotationComposerPopover,
  type AnnotationComposerDraft,
} from "./AnnotationComposerPopover";
import { MermaidDiagram } from "./MermaidDiagram";
import { ImagePreview } from "./ImagePreview";
import { ZenDock } from "./ZenIsland";
import { lazyWithReload } from "../lazyWithReload";
import {
  handlePreviewEditorCopy,
  isEditablePreviewTarget,
  isPreviewKeyboardTarget,
  selectAllInPreviewEditor,
  selectAllInPreviewElement,
} from "./previewSelection";
import { highlightCodeTokens } from "./syntaxHighlighting";
import { store, useStoreSelector } from "../store";
import type { ReviewFileMarks } from "../useReviewFileMarks";
import {
  directoryPreviewName,
  directoryPreviewPath,
  normalizeFilesystemPath,
} from "../filesystemPaths";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { CommandLine } from "./CommandLine";
import { detectShortcutPlatform } from "../shortcutBindings";
import {
  canStep,
  currentPlace,
  dropFramePage,
  dropRepeat,
  framePageFor,
  historyKeyStep,
  keepScroll,
  type PreviewHistory,
  type PreviewPlace,
  pushPlace,
  settleFrame,
  startHistory,
  stepHistory,
} from "../previewHistory";
import { keepPreviewTabPlace, readPreviewTabPlace } from "../previewPlaces";
import {
  type InspectorCommand,
  inspectorCompletions,
  INSPECTOR_COMMAND_WORDS,
  isTypingTarget,
  opensCommandLine,
  runInspectorCommand,
} from "../inspectorCommands";
import { useInspectorCommands } from "../useInspectorCommands";
import "./FilePreviewContent.css";

export type ActiveFilePreviewSelection = {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fragment?: string;
  line?: number;
  /** The line shown as rendered (Show rendered), not in the source. */
  rendered?: boolean;
  snippet?: string;
};

export type FilePreviewSelectionMeta = {
  userInitiated?: boolean;
  deletedEntry?: Pick<FileExplorerEntry, "path" | "type">;
};

type AppTheme = "dark" | "light";

const PDF_INLINE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
/** How long a scroll waits for the file to be tall enough for it. */
const SCROLL_RESTORE_MS = 3000;

type PendingFileAnnotation =
  | {
      kind: "line";
      x: number;
      y: number;
      path: string;
      line: number;
      endLine?: number;
      quote: string;
    }
  | {
      kind: "quote";
      x: number;
      y: number;
      path: string;
      quote: string;
      section: string[];
      line?: number;
      endLine?: number;
      render?: ReviewRenderPart;
      /** A picture of a graphic's region, while the comment is written. */
      snapshot?: Blob;
      preview?: string;
    };

type CodeMirrorPreviewDeps = Awaited<
  ReturnType<typeof importCodeMirrorPreviewDeps>
>;

let codeMirrorPreviewDepsPromise: Promise<CodeMirrorPreviewDeps> | null = null;

async function importCodeMirrorPreviewDeps() {
  const [codemirror, state, view, searchModule, vimModule, vimEx] =
    await Promise.all([
      import("codemirror"),
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/search"),
      import("@replit/codemirror-vim"),
      import("./vimEx"),
    ]);

  return {
    basicSetup: codemirror.basicSetup,
    configuredShortcutGuard: state.Prec.highest(
      view.keymap.of([
        { key: "Mod-f", run: () => true },
        { key: "Mod-a", run: () => true },
      ]),
    ),
    Compartment: state.Compartment,
    Decoration: view.Decoration,
    RangeSet: state.RangeSet,
    GutterMarker: view.GutterMarker,
    gutter: view.gutter,
    EditorState: state.EditorState,
    EditorView: view.EditorView,
    ViewPlugin: view.ViewPlugin,
    keymap: view.keymap,
    openSearchPanel: searchModule.openSearchPanel,
    search: searchModule.search,
    searchKeymap: searchModule.searchKeymap,
    vim: vimModule.vim,
    getCM: vimModule.getCM,
    Vim: vimModule.Vim,
    defineExCommands: vimEx.defineExCommands,
    vimExEditors: vimEx.vimExEditors,
  };
}

/**
 * The Files preview's `:` commands, every name and alias: its source view's
 * Vim keys have them too, run by the preview's own command line.
 */
export const PREVIEW_COMMAND_WORDS: readonly string[] = [
  "files",
  "only",
  "o",
  "diffonly",
  "zen",
  "conversations",
  "threads",
  "conv",
  "unresolved",
  "openonly",
  "next",
  "previous",
  "prev",
  "comment",
  "fold",
  "e",
  "edit",
  "reload",
  "source",
  "rendered",
  "preview",
  "scripts",
  "point",
  "review",
  "reviewed",
  "url",
  "copy",
  "q",
  "quit",
  "close",
  "back",
  "forward",
];
/**
 * The preview's words for its Vim keys' `:`, defined through vimEx.ts's one
 * registry: Vim's ex commands are global, and a `:q` of its own would take
 * the comment editors' and the chat's.
 */
function definePreviewExCommands(deps: CodeMirrorPreviewDeps) {
  deps.defineExCommands([...PREVIEW_COMMAND_WORDS, ...INSPECTOR_COMMAND_WORDS]);
}

function loadCodeMirrorPreviewDeps() {
  codeMirrorPreviewDepsPromise ??= importCodeMirrorPreviewDeps();
  return codeMirrorPreviewDepsPromise;
}

function openPreviewSearch(view: CodeMirrorEditorView | null) {
  if (!view) return;
  void loadCodeMirrorPreviewDeps().then((deps) => deps.openSearchPanel(view));
}

function isMarkdownPath(path: string) {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdown") ||
    lower.endsWith(".mkdn")
  );
}

function isMermaidPath(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".mmd") || lower.endsWith(".mermaid");
}

// PDF.js only loads when a PDF is shown by it.
const PdfPages = lazyWithReload("pdf-pages", () => import("./PdfPages"));

/**
 * Whether the browser shows a PDF in a frame itself. Chrome on Android and
 * Safari on iOS do not: their PDFs are drawn with PDF.js instead.
 */
function framesShowPdf() {
  return (
    navigator.pdfViewerEnabled === true &&
    !window.matchMedia("(pointer: coarse)").matches
  );
}

function frameSnapshotBlob(url: string): Blob | null {
  const data = /^data:image\/png;base64,(.+)$/.exec(url)?.[1];
  if (!data) return null;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1)
      bytes[at] = binary.charCodeAt(at);
    return new Blob([bytes], { type: "image/png" });
  } catch {
    return null;
  }
}

function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf");
}

function currentDocumentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => currentDocumentTheme());

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(currentDocumentTheme()),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function FilePreviewContent({
  entry,
  preview: previewProp,
  loading: loadingProp,
  error,
  fragment,
  line,
  snippet,
  changesContent,
  changesKey,
  annotations = [],
  backAction,
  onOpenChanges,
  onOpenFile,
  onRefresh,
  onToggleTree,
  treeHidden = false,
  onClosePreview,
  onCreateAnnotation,
  onAddReviewImage,
  onShowInReview,
  reviewFiles,
  onReanchorAnnotations,
  rendered: renderedAtLine = false,
  placeScope,
}: {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fragment?: string;
  line?: number;
  snippet?: string;
  changesContent?: ReactNode;
  changesKey?: string;
  backAction?: { label: string; onClick: () => void };
  annotations?: readonly ReviewAnnotation[];
  onOpenChanges?: () => void;
  onOpenFile?: (path: string, fragment?: string) => void;
  onRefresh?: () => void;
  /** Hides or shows the file tree beside the preview (also `:files`). */
  onToggleTree?: () => void;
  treeHidden?: boolean;
  onClosePreview?: () => void;
  onCreateAnnotation?: (
    annotation: NewReviewAnnotation,
    capture?: FeedbackCapture & { root?: string },
  ) => void;
  /** Stores an image put in a comment; the Markdown for it. */
  onAddReviewImage?: (file: File) => Promise<string>;
  onReanchorAnnotations?: (path: string, text: string) => void;
  /**
   * Show in code review: the file (absolute path) in the code review of
   * its checkout, at a line.
   */
  onShowInReview?: (path: string, line?: number) => void;
  /**
   * The checkout's review (reviews in Changes): the file's reviewed
   * tick, toggled here as in Changes; an unchanged file joins the review.
   */
  reviewFiles?: ReviewFileMarks;
  /** `line` shown as rendered (Show rendered), not in the source. */
  rendered?: boolean;
  /**
   * The checkout the tabs are of: each tab is shown again where it was left
   * (previewPlaces), after another view or workspace and a page reload.
   */
  placeScope?: string;
}) {
  const connectionClient = useLiveConnectionClient();
  const workspaces = useStoreSelector((state) => state.workspaces);
  const previewSectionRef = useRef<HTMLElement | null>(null);
  /** On screen: not under another view, nor in a hidden inspector. */
  const previewSeen = () => {
    const section = previewSectionRef.current;
    return (
      !!section?.isConnected &&
      (typeof section.checkVisibility !== "function" ||
        section.checkVisibility())
    );
  };
  /*
   * A reload keeps the file shown until it is read again: the reader's
   * place (scroll, cursor, open threads) stays, the text changes under it.
   */
  const [held, setHeld] = useState<{
    path: string;
    preview: FilePreview;
  } | null>(null);
  const holding =
    !!held &&
    loadingProp &&
    !previewProp &&
    !error &&
    entry?.path === held.path;
  useEffect(() => {
    if (held && !holding) setHeld(null);
  }, [held, holding]);
  const preview = holding ? held.preview : previewProp;
  const loading = holding ? false : loadingProp;
  /** The refresh button, R and the notice: the file read again, in place. */
  const reload = () => {
    if (!onRefresh) return;
    if (entry && previewProp && !loadingProp)
      setHeld({ path: entry.path, preview: previewProp });
    onRefresh();
  };
  // A file the lost connection failed to read is read again once it is
  // back, in place; so is one whose read the connection's loss left
  // unanswered.
  useReloadOnReconnect(error, connectionClient.connectionId, reload);
  const wasDown = useRef(false);
  useEffect(() => {
    if (!connectionClient.isCurrent()) {
      wasDown.current = true;
      return;
    }
    if (!wasDown.current) return;
    wasDown.current = false;
    if (loadingProp && !previewProp && entry) reload();
    // Only when the connection comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionClient]);
  const changedOnDisk = useChangedOnDisk({
    client: connectionClient,
    workspaceId: previewProp?.workspace_id,
    path: entry && !/^https?:\/\//i.test(entry.path) ? entry.path : undefined,
    shown:
      onRefresh &&
      previewProp &&
      !loadingProp &&
      previewProp.type !== "directory"
        ? previewProp
        : null,
    // Not while its view or the inspector is hidden.
    seen: () => previewSeen(),
  });
  const previewContentRef = useRef<HTMLDivElement | null>(null);
  /** The preview's content, once drawn: it has the threads' keys. */
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );
  const contentRef = useCallback((element: HTMLDivElement | null) => {
    previewContentRef.current = element;
    setContentElement(element);
  }, []);
  const editorViewRef = useRef<CodeMirrorEditorView | null>(null);
  const onOpenChangesRef = useRef(onOpenChanges);
  onOpenChangesRef.current = onOpenChanges;
  const [previewMode, setPreviewMode] = useState<"rendered" | "raw">(
    "rendered",
  );
  const [detailTab, setDetailTab] = useState<"file" | "changes">("file");
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  // Keep unfinished comments attached to their file while switching tabs.
  // The Inspector is keyed by connection/checkout, so this map cannot cross scopes.
  const draftPath = entry?.path ?? "";
  const [fileDrafts, setFileDrafts] = useState<
    Record<string, { pending: PendingFileAnnotation | null; comment: string }>
  >({});
  const pendingAnnotation = fileDrafts[draftPath]?.pending ?? null;
  const setPendingAnnotation = useCallback(
    (pending: PendingFileAnnotation | null) => {
      setFileDrafts((current) => ({
        ...current,
        [draftPath]: { pending, comment: "" },
      }));
    },
    [draftPath],
  );
  const setDraftComment = (comment: string) => {
    setFileDrafts((current) => ({
      ...current,
      [draftPath]: { pending: current[draftPath]?.pending ?? null, comment },
    }));
  };
  const [markdownSelection, setMarkdownSelection] = useState<
    (MarkdownSelectionTarget & { render?: ReviewRenderPart }) | null
  >(null);
  const [pointMode, setPointMode] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlText, setUrlText] = useState("http://localhost:");
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [zen, toggleZen] = useZenMode();
  /** Review only's bar: the page's banner shows at its start. */
  const [zenBanner, setZenBanner] = useState<HTMLElement | null>(null);
  useZenEscape(zen, toggleZen);
  /** The paused graphic while its comment is written. */
  const heldGraphic = useRef<HeldGraphic | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameHeld = useRef<HTMLIFrameElement | null>(null);
  const letGraphicGo = useCallback(() => {
    heldGraphic.current?.resume();
    heldGraphic.current = null;
    frameHeld.current?.contentWindow?.postMessage(
      { roamgate: "rendered", type: "resume" },
      "*",
    );
    frameHeld.current = null;
  }, []);
  const theme = useDocumentTheme();
  const previewText = preview?.text ?? null;
  const lineBeyondPreview =
    line !== undefined &&
    previewText !== null &&
    line > previewText.split(/\r?\n/).length;
  const previewPath = preview?.path ?? "";
  const markdownDocumentPath = preview
    ? workspaceMarkdownDocumentPath(previewPath, preview.root)
    : previewPath;
  const hasPreviewText = previewText !== null;
  const hasMarkdownPreview = hasPreviewText && isMarkdownPath(previewPath);
  const hasMermaidPreview = hasPreviewText && isMermaidPath(previewPath);
  const hasPdfPreview = Boolean(preview && isPdfPath(previewPath));
  const pdfTooLarge =
    hasPdfPreview && (preview?.size ?? 0) > PDF_INLINE_PREVIEW_MAX_BYTES;
  const hasAudioPreview = Boolean(
    preview && preview.type !== "directory" && audioMimeForPath(previewPath),
  );
  const audioTooLarge =
    hasAudioPreview && (preview?.size ?? 0) > AUDIO_INLINE_PREVIEW_MAX_BYTES;
  const hasMediaPreview = hasPdfPreview || hasAudioPreview;
  // Framed and read by the rendered pages, whose limits decide: never the
  // text preview's.
  const hasHtmlPreview = framesHtmlPreview(preview);
  const hasRichPreview =
    hasMarkdownPreview || hasMermaidPreview || hasHtmlPreview;
  const renderRichPreview = hasRichPreview && previewMode === "rendered";
  const inlinePreviewUrl = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return null;
    return workspaceFileUrl(
      connectionClient,
      preview.workspace_id,
      previewPath,
      { inline: true, revision: preview.resource_revision },
    );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
  ]);
  const markdownImageUrlResolver = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return undefined;
    return (source: string) =>
      resolveWorkspaceMarkdownImageUrl(
        source,
        markdownDocumentPath,
        connectionClient,
        preview.workspace_id,
        preview.resource_revision,
      );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
    markdownDocumentPath,
  ]);
  const markdownLinkUrlResolver = useMemo(() => {
    if (!preview?.workspace_id) return undefined;
    return (path: string) =>
      workspaceFileUrl(connectionClient, preview.workspace_id, path);
  }, [connectionClient, preview?.workspace_id]);
  const changesAvailable =
    changesContent !== undefined && !!changesKey && !!onOpenChanges;
  const showingChanges = detailTab === "changes" && changesAvailable;
  const directoryPath = directoryPreviewPath(preview);
  const directoryWorkspaceRoot = directoryPath
    ? workspaces.some((workspace) => {
        const root = workspace.worktree?.checkout_path ?? workspace.cwd;
        return !!root && normalizeFilesystemPath(root) === directoryPath;
      })
    : false;
  const showDirectoryWorkspaceAction =
    !!directoryPath && !directoryWorkspaceRoot;
  const directoryWorkspaceName = directoryPath
    ? directoryPreviewName(directoryPath)
    : "";
  const lineAnnotations = useMemo(
    () =>
      annotations.filter(
        (annotation): annotation is FileLineReviewAnnotation =>
          annotation.source === "file" &&
          annotation.anchor === "line" &&
          annotation.path === previewPath,
      ),
    [annotations, previewPath],
  );
  const annotationComposerDraft: AnnotationComposerDraft | null =
    pendingAnnotation
      ? {
          x: pendingAnnotation.x,
          y: pendingAnnotation.y,
          title:
            pendingAnnotation.kind === "line"
              ? `${pendingAnnotation.path} · ${fileReviewLineLabel(pendingAnnotation)}`
              : pendingAnnotation.section.length
                ? `${pendingAnnotation.path} · ${pendingAnnotation.section.join(" › ")}`
                : `${pendingAnnotation.path} · selected passage`,
          quote: pendingAnnotation.quote,
          ...(pendingAnnotation.kind === "quote" && pendingAnnotation.preview
            ? { preview: pendingAnnotation.preview }
            : {}),
        }
      : null;

  useEffect(() => {
    // A tab shown again keeps the Source switch it was left with.
    setPreviewMode(
      (placeScope && entry?.path
        ? readPreviewTabPlace(placeScope, entry.path)?.mode
        : undefined) ?? "rendered",
    );
  }, [entry?.path, placeScope]);

  useEffect(() => {
    if (line && !renderedAtLine) setPreviewMode("raw");
  }, [entry?.path, line, renderedAtLine]);

  useEffect(() => {
    setMarkdownSelection(null);
  }, [previewPath]);

  useEffect(() => {
    if (previewText === null || !previewPath || preview?.truncated) return;
    onReanchorAnnotations?.(previewPath, previewText);
  }, [onReanchorAnnotations, preview?.truncated, previewPath, previewText]);

  useEffect(() => {
    if (hasMarkdownPreview && renderRichPreview && !showingChanges) return;
    setMarkdownSelection(null);
  }, [hasMarkdownPreview, renderRichPreview, showingChanges]);

  useEffect(() => {
    if (detailTab === "changes" && changesAvailable) {
      onOpenChangesRef.current?.();
    }
  }, [changesAvailable, changesKey, detailTab]);

  useEffect(() => {
    if (showingChanges || !hasPreviewText) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".shortcut-modal"))
        return;
      const find = shortcutMatches(e, "preview.search");
      if (!find && !shortcutMatches(e, "preview.selectAll")) return;
      const section = previewSectionRef.current;
      if (!section || section.offsetParent === null) return;
      if (isEditablePreviewTarget(e.target)) return;
      if (find) {
        if (renderRichPreview) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        openPreviewSearch(editorViewRef.current);
        return;
      }
      if (!isPreviewKeyboardTarget(section, e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (renderRichPreview) {
        selectAllInPreviewElement(previewContentRef.current);
      } else {
        selectAllInPreviewEditor(editorViewRef.current);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [hasPreviewText, renderRichPreview, showingChanges]);

  useEffect(() => {
    const section = previewSectionRef.current;
    if (!section) return;
    const onCopy = (event: ClipboardEvent) => {
      handlePreviewEditorCopy(editorViewRef.current, event);
    };
    section.addEventListener("copy", onCopy);
    return () => section.removeEventListener("copy", onCopy);
  }, []);

  const closeAnnotationComposer = useCallback(() => {
    setPendingAnnotation(null);
    letGraphicGo();
  }, [letGraphicGo, setPendingAnnotation]);

  const saveAnnotation = useCallback(
    (comment: string) => {
      const pending = pendingAnnotation;
      if (!pending || !onCreateAnnotation) return;
      // The source of its last line, as a diff's comment keeps it.
      const last = pending.endLine ?? pending.line;
      const lineText =
        last !== undefined && previewText !== null
          ? markdownSource(previewText).split("\n")[last - 1]
          : undefined;
      if (pending.kind === "line") {
        onCreateAnnotation(
          {
            source: "file",
            anchor: "line",
            path: pending.path,
            line: pending.line,
            ...(pending.endLine === undefined
              ? {}
              : { endLine: pending.endLine }),
            quote: pending.quote,
            comment,
          },
          {
            ...(preview?.root ? { root: preview.root } : {}),
            ...(lineText !== undefined ? { lineText } : {}),
          },
        );
      } else {
        onCreateAnnotation(
          {
            source: "file",
            anchor: "quote",
            path: pending.path,
            quote: pending.quote,
            section: pending.section,
            comment,
            ...(pending.line !== undefined ? { line: pending.line } : {}),
            ...(pending.endLine !== undefined
              ? { endLine: pending.endLine }
              : {}),
            ...(pending.render ? { render: pending.render } : {}),
          },
          {
            ...(preview?.root ? { root: preview.root } : {}),
            ...(pending.snapshot ? { snapshot: pending.snapshot } : {}),
            ...(lineText !== undefined ? { lineText } : {}),
          },
        );
      }
      setPendingAnnotation(null);
      setMarkdownSelection(null);
      letGraphicGo();
      window.getSelection()?.removeAllRanges();
    },
    [
      letGraphicGo,
      onCreateAnnotation,
      pendingAnnotation,
      preview?.root,
      previewText,
      setPendingAnnotation,
    ],
  );

  const siteUrl = entry && /^https?:\/\//i.test(entry.path) ? entry.path : null;
  const absolutePath =
    preview && previewPath
      ? previewPath.startsWith("/")
        ? previewPath
        : `${preview.root.replace(/\/+$/, "")}/${previewPath}`
      : undefined;
  /** The file's path in the review's repository, when it is in it. */
  const reviewPath = (() => {
    const root = reviewFiles?.root?.replace(/\/+$/, "");
    return root && absolutePath?.startsWith(`${root}/`)
      ? absolutePath.slice(root.length + 1)
      : undefined;
  })();
  const reviewTick = reviewPath
    ? reviewFiles?.marks.get(reviewPath)
    : undefined;
  const toggleReviewed = () => {
    if (!reviewFiles || !reviewPath) return;
    const was = reviewTick?.reviewed ?? false;
    reviewFiles.toggle(reviewPath).then(
      () =>
        store.notify({
          kind: "info",
          message: was
            ? `${reviewPath} no longer reviewed`
            : `${reviewPath} reviewed`,
          autoDismissMs: 2500,
        }),
      (error) =>
        store.notify({
          kind: "error",
          message: "Not marked",
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  const fileThreads = useFileThreads(
    connectionClient.connectionId,
    siteUrl ? { url: siteUrl } : { absolute: absolutePath },
    previewText,
  );
  // Each comment is delivered by the review it is in.
  const undelivered = useMemo(
    () => reviewsUndelivered(fileThreads.owners),
    [fileThreads.owners],
  );
  const scripts = useRenderedScripts(
    connectionClient.connectionId,
    siteUrl ?? absolutePath,
  );
  const canComment = !!onCreateAnnotation && !showingChanges;
  const isSvgFile = previewPath.toLowerCase().endsWith(".svg");
  const isFramePage = !!siteUrl || (hasHtmlPreview && renderRichPreview);
  const canPoint =
    canComment &&
    (isFramePage ||
      (hasMarkdownPreview && renderRichPreview) ||
      hasMermaidPreview ||
      !!preview?.image_data_url);
  useEffect(() => {
    if (!canPoint) setPointMode(false);
  }, [canPoint]);
  // A standalone SVG goes in the sandbox frame while animated or pointed
  // at, where it can be paused and its elements named.
  const [svgText, setSvgText] = useState<string | null>(null);
  useEffect(() => {
    setSvgText(null);
    if (!isSvgFile || !inlinePreviewUrl) return;
    let cancelled = false;
    void fetch(inlinePreviewUrl)
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => {
        if (!cancelled) setSvgText(text);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSvgFile, inlinePreviewUrl]);
  const drawSvgFramed =
    svgText !== null && (isAnimatedSvg(svgText) || pointMode || scripts.on);

  /** Which graphic, said for the agent: "diagram 2", an image's name. */
  const graphicName = useCallback(
    (graphic: Element) => {
      const root = previewContentRef.current;
      const slot = graphic.closest(".markdown-diagram-slot");
      if (slot && root)
        return `diagram ${[...root.querySelectorAll(".markdown-diagram-slot")].indexOf(slot) + 1}`;
      if (graphic.closest(".md-html-slot")) return "HTML block";
      if (graphic instanceof HTMLImageElement && hasMarkdownPreview)
        return graphic.alt || "image";
      return entry?.name ?? previewPath;
    },
    [entry?.name, hasMarkdownPreview, previewPath],
  );
  const pointing = useGraphicPointing(
    previewContentRef,
    pointMode,
    (graphic, region: ReviewRegion, under) => {
      void (async () => {
        letGraphicGo();
        const held = holdGraphic(graphic);
        heldGraphic.current = held;
        const block = graphic.closest<HTMLElement>(
          ".md-source-item, .md-source-block",
        );
        const line = block ? Number(block.dataset.line) : undefined;
        const blockEnd = block ? Number(block.dataset.end) : undefined;
        const element = elementLabel(under, graphic);
        const name = graphicName(graphic);
        const crop = await cropGraphic(graphic, region);
        const box = graphic.getBoundingClientRect();
        setMarkdownSelection(null);
        setPendingAnnotation({
          kind: "quote",
          x: box.left + box.width * region.x,
          y: box.top + box.height * (region.y + region.h) + 8,
          path: previewPath,
          quote: pointQuote(name, region, element),
          section: [],
          ...(line !== undefined ? { line } : {}),
          ...(blockEnd !== undefined && blockEnd !== line
            ? { endLine: blockEnd }
            : {}),
          render: {
            graphic: name,
            region,
            ...(element ? { element } : {}),
            ...(held.moment ? { moment: held.moment } : {}),
          },
          ...(crop
            ? { snapshot: crop, preview: URL.createObjectURL(crop) }
            : {}),
        });
      })();
    },
  );
  // Back and Forward, as a browser's: per tab (the path shown), the files
  // a link here opened and the pages its frame went to, each with where it
  // was scrolled.
  const historyKey = entry?.path ?? "";
  const histories = useRef(new Map<string, PreviewHistory>());
  const [, setHistoryTick] = useState(0);
  const history = histories.current.get(historyKey) ?? startHistory(historyKey);
  const setHistory = (key: string, next: PreviewHistory) => {
    histories.current.set(key, next);
    setHistoryTick((tick) => tick + 1);
  };
  /** The tab a link or Back / Forward goes to, with its history there. */
  const going = useRef<{ to: string; history: PreviewHistory } | null>(null);
  /**
   * Where to scroll the file once drawn; the page a frame must show, for
   * the tab `key` (a page from the directory `root`), as kept.
   */
  const pendingScroll = useRef<number | null>(null);
  const pendingFrame = useRef<{
    key: string;
    page: string;
    scroll: number;
    root?: string;
  } | null>(null);
  /** The tab whose frame went back to its own page, a kept one missing. */
  const frameFellBack = useRef<string | null>(null);
  /**
   * The directory the frame's pages are kept as paths from: the file's,
   * or the site URL's.
   */
  const frameRoot = siteUrl
    ? siteUrl.replace(/[?#].*$/, "").replace(/[^/]*$/, "")
    : absolutePath
      ? absolutePath.slice(0, absolutePath.lastIndexOf("/") + 1)
      : undefined;
  /** The page `place` shows again in this tab's frame, kept from its own. */
  const restoreFrame = (place: PreviewPlace, key: string) => {
    const page = framePageFor(place, key);
    return page === undefined
      ? null
      : {
          key,
          page,
          scroll: place.scroll,
          ...(place.frameRoot !== undefined ? { root: place.frameRoot } : {}),
        };
  };
  /** The frame's page's token and the frame's home under it. */
  const frameAt = useRef<{ prefix: string; home: string } | null>(null);
  const shownKey = useRef("");
  if (historyKey && shownKey.current !== historyKey) {
    shownKey.current = historyKey;
    const arriving = going.current;
    going.current = null;
    // A tab shown again: where it was left, here or kept (previewPlaces).
    const kept =
      histories.current.get(historyKey) ??
      (placeScope
        ? readPreviewTabPlace(placeScope, historyKey)?.history
        : undefined);
    const arrived =
      arriving && arriving.to === historyKey ? arriving.history : kept;
    // Nothing the last tab still waited for is this one's.
    pendingScroll.current = null;
    pendingFrame.current = null;
    frameFellBack.current = null;
    if (arrived) {
      histories.current.set(historyKey, arrived);
      const place = currentPlace(arrived);
      // A link's or Back's place from its top; a tab left scrolled, there.
      pendingScroll.current =
        arriving && arriving.to === historyKey
          ? place.scroll
          : place.scroll || null;
      pendingFrame.current = restoreFrame(place, historyKey);
    } else histories.current.set(historyKey, startHistory(historyKey));
  }
  /** The scroller of the file shown; a page's frame says its own. */
  const fileScroller = () =>
    contentElement?.querySelector<HTMLElement>(
      ".file-preview-markdown, .cm-scroller, .file-preview-mermaid",
    ) ?? contentElement;
  const isPageFrame = !!siteUrl || (hasHtmlPreview && renderRichPreview);
  /** The history with where the place shown now is scrolled. */
  const historyNow = () =>
    isPageFrame ? live() : keepScroll(live(), fileScroller()?.scrollTop ?? 0);
  /** A link here (or :url) opens `path`: a place after this one. */
  const openFromView = onOpenFile
    ? (path: string, fragment?: string) => {
        const here = historyNow();
        const next = pushPlace(here, {
          path,
          ...(fragment ? { fragment } : {}),
        });
        if (path === historyKey) setHistory(historyKey, next);
        else {
          histories.current.set(historyKey, here);
          going.current = { to: path, history: next };
        }
        onOpenFile(path, fragment);
      }
    : undefined;
  /**
   * Shows a page in the frame by its path from the frame's home, under the
   * token of the page it shows; false when that token cannot reach it.
   */
  const framePage = (page: string) => {
    const frame = frameRef.current;
    const at = frameAt.current;
    const url = at ? pageUnderHome(page, at.home) : null;
    if (!frame || !at || url === null) return false;
    frame.contentWindow?.location.replace(
      new URL(at.prefix + url, frame.src).href,
    );
    return true;
  };
  /** A URL under the frame's token as a path from its home. */
  const homePage = (url: string) =>
    pageFromHome(url, frameAt.current?.home ?? "");
  /** Back (-1) or Forward (1). */
  const stepPlace = (step: -1 | 1) => {
    const here = historyNow();
    const moved = stepHistory(here, step);
    if (!moved) return;
    const { place } = moved;
    if (place.path !== historyKey) {
      histories.current.set(historyKey, here);
      going.current = { to: place.path, history: moved.history };
      onOpenFile?.(place.path, place.fragment);
      return;
    }
    setHistory(historyKey, moved.history);
    const again = isPageFrame ? restoreFrame(place, historyKey) : null;
    if (again && (again.root ?? frameRoot) === frameRoot) {
      pendingFrame.current = again;
      if (!framePage(again.page)) pendingFrame.current = null;
      return;
    }
    pendingScroll.current = place.scroll;
    if ((place.fragment ?? "") !== (fragment ?? ""))
      onOpenFile?.(place.path, place.fragment);
  };
  // The file drawn: scrolled where it was left, once it is tall enough
  // (diagrams and images draw after the text): tried again as it grows,
  // for a while.
  useEffect(() => {
    if (loading || pendingScroll.current === null || isPageFrame) return;
    let observer: ResizeObserver | null = null;
    let giveUp: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      const scroller = fileScroller();
      const wanted = pendingScroll.current;
      if (!scroller || wanted === null) return;
      scroller.scrollTop = wanted;
      if (Math.abs(scroller.scrollTop - wanted) <= 1) {
        pendingScroll.current = null;
        observer?.disconnect();
        return;
      }
      if (observer || typeof ResizeObserver === "undefined") return;
      observer = new ResizeObserver(settle);
      for (const child of scroller.children) observer.observe(child);
      giveUp = setTimeout(() => {
        observer?.disconnect();
        pendingScroll.current = null;
      }, SCROLL_RESTORE_MS);
    };
    const frame = requestAnimationFrame(() => requestAnimationFrame(settle));
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (giveUp) clearTimeout(giveUp);
    };
  });
  /** The tab's history as kept now, frame messages between draws too. */
  const live = () => histories.current.get(historyKey) ?? history;
  /**
   * A page's frame shows `shown` under its token (`root`): a place, or the
   * one Back went to.
   */
  const onFramePage = (
    shown: string,
    first: boolean,
    root?: RenderedRootMap,
  ) => {
    const frame = frameRef.current;
    const prefix =
      (root && /^\/rendered\/[0-9a-f]{32}\//.exec(root.to)?.[0]) ||
      (frame
        ? /^\/rendered\/[^/]+\//.exec(new URL(frame.src).pathname)?.[0]
        : undefined);
    frameAt.current = prefix?.startsWith(RENDERED_PREFIX)
      ? { prefix, home: root?.home ?? "" }
      : null;
    // Kept from the frame's home: the same page under any of its tokens.
    const url = homePage(shown);
    // Its own page again, a kept one missing: the place is that page now.
    if (frameFellBack.current === historyKey) {
      frameFellBack.current = null;
      pendingFrame.current = null;
      setHistory(historyKey, dropRepeat(settleFrame(live(), url, frameRoot)));
      return;
    }
    // Only this tab's, and from this frame's directory: a page kept for
    // another tab or another directory would be a page that is not there.
    const ours = (want: { key: string; root?: string } | null) =>
      !!want &&
      want.key === historyKey &&
      (want.root === undefined ||
        frameRoot === undefined ||
        want.root === frameRoot);
    if (!ours(pendingFrame.current)) pendingFrame.current = null;
    const pending = pendingFrame.current;
    const kept = first ? restoreFrame(currentPlace(live()), historyKey) : null;
    const wanted = pending?.page ?? (ours(kept) ? kept?.page : undefined);
    if (wanted !== undefined && wanted !== url) {
      if (first || pending) {
        pendingFrame.current = {
          key: historyKey,
          page: wanted,
          scroll: pending?.scroll ?? currentPlace(live()).scroll,
          ...(frameRoot !== undefined ? { root: frameRoot } : {}),
        };
        if (framePage(wanted)) return;
      }
      pendingFrame.current = null;
    }
    if (wanted === url) {
      const scroll = pending?.scroll ?? currentPlace(live()).scroll;
      pendingFrame.current = null;
      if (scroll)
        frame?.contentWindow?.postMessage(
          { roamgate: "rendered", type: "scrollTo", y: scroll },
          "*",
        );
      if (first || pending) {
        setHistory(historyKey, settleFrame(live(), url, frameRoot));
        return;
      }
    }
    setHistory(
      historyKey,
      first
        ? settleFrame(live(), url, frameRoot)
        : pushPlace(live(), {
            path: historyKey,
            framePage: url,
            ...(frameRoot !== undefined ? { frameRoot } : {}),
          }),
    );
  };
  /**
   * The frame shows Roamgate's not-found page: when it was a page kept
   * for this tab, shown again, the tab's own page instead, the place
   * dropped. A link of the page's own leaves it there, with its link back.
   */
  const onFrameMissing = () => {
    const pending = pendingFrame.current;
    const frame = frameRef.current;
    pendingFrame.current = null;
    if (!pending || pending.key !== historyKey || !frame) return;
    frameFellBack.current = historyKey;
    setHistory(historyKey, dropFramePage(live()));
    frame.contentWindow?.location.replace(frame.src);
  };
  /** The page's Back / Forward keys, scroll and own navigation. */
  const frameHistory = (
    message: Extract<
      RenderedFrameMessage,
      { type: "history" | "scroll" | "location" }
    >,
    frame: HTMLIFrameElement,
  ) => {
    if (message.type === "history") {
      stepPlace(message.step);
      return;
    }
    if (frame !== frameRef.current) return;
    // Kept without drawing again: nothing shown depends on it. Not while
    // hidden (another view), where the frame may say it is at the top.
    if (message.type === "scroll") {
      if (!previewSeen()) return;
      histories.current.set(historyKey, keepScroll(live(), message.y));
      keepPlaceRef.current();
    } else
      setHistory(
        historyKey,
        pushPlace(live(), {
          path: historyKey,
          framePage: homePage(message.url),
          ...(frameRoot !== undefined ? { frameRoot } : {}),
        }),
      );
  };
  const frameHistoryRef = useRef(frameHistory);
  frameHistoryRef.current = frameHistory;
  const onFramePageRef = useRef(onFramePage);
  onFramePageRef.current = onFramePage;
  const reportFramePage = useCallback(
    (url: string, first: boolean, root?: RenderedRootMap) =>
      onFramePageRef.current(url, first, root),
    [],
  );
  const onFrameMissingRef = useRef(onFrameMissing);
  onFrameMissingRef.current = onFrameMissing;
  const reportFrameMissing = useCallback(() => onFrameMissingRef.current(), []);
  const mac = detectShortcutPlatform() === "mac";
  const historyButtons = (
    <>
      <button
        type="button"
        className="file-preview-refresh"
        title={`Back (${mac ? "Cmd+[" : "Alt+Left"}, :back)`}
        aria-label="Back"
        disabled={!canStep(history, -1)}
        onClick={() => stepPlace(-1)}
      >
        <ArrowLeft size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="file-preview-refresh"
        title={`Forward (${mac ? "Cmd+]" : "Alt+Right"}, :forward)`}
        aria-label="Forward"
        disabled={!canStep(history, 1)}
        onClick={() => stepPlace(1)}
      >
        <ArrowRight size={13} aria-hidden="true" />
      </button>
    </>
  );
  const frameMessage = useCallback(
    (
      message: Exclude<
        RenderedFrameMessage,
        { type: "ready" | "size" | "stray" | "storage" | "missing" | "home" }
      >,
      box: DOMRect,
      frame: HTMLIFrameElement,
    ) => {
      if (message.type === "clear") {
        setMarkdownSelection(null);
        return;
      }
      if (
        message.type === "history" ||
        message.type === "scroll" ||
        message.type === "location"
      ) {
        frameHistoryRef.current(message, frame);
        return;
      }
      if (message.type === "key") {
        // A key of the threads pressed in the page: as if pressed here.
        previewContentRef.current?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: message.key,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      const path = siteUrl ?? previewPath;
      // An SVG in its own frame: a diagram of the file, or the file.
      const inlineSvg = frame.dataset.inlineSvg === "1";
      const block = frame.closest<HTMLElement>(
        ".md-source-item, .md-source-block",
      );
      const line = block ? Number(block.dataset.line) : undefined;
      const blockEnd = block ? Number(block.dataset.end) : undefined;
      const lines = {
        ...(line !== undefined ? { line } : {}),
        ...(blockEnd !== undefined && blockEnd !== line
          ? { endLine: blockEnd }
          : {}),
      };
      if (message.type === "select") {
        setMarkdownSelection({
          quote: message.quote,
          section: [],
          x: box.left + message.rect.x,
          y: box.top + message.rect.y + message.rect.h + 6,
          ...lines,
          render: inlineSvg
            ? { graphic: graphicName(frame), quote: message.quote }
            : {
                url: message.url,
                selector: message.selector,
                quote: message.quote,
              },
        });
        return;
      }
      const snapshot = message.snapshot
        ? frameSnapshotBlob(message.snapshot)
        : null;
      letGraphicGo();
      frameHeld.current = frame;
      const name = inlineSvg ? graphicName(frame) : message.selector;
      setMarkdownSelection(null);
      setPendingAnnotation({
        kind: "quote",
        x: box.left + message.rect.x + message.rect.w * message.region.x,
        y:
          box.top +
          message.rect.y +
          message.rect.h * (message.region.y + message.region.h) +
          8,
        path,
        quote: pointQuote(name, message.region, message.element),
        section: [],
        ...lines,
        render: {
          ...(inlineSvg
            ? { graphic: name }
            : { url: message.url, selector: message.selector }),
          region: message.region,
          ...(message.element ? { element: message.element } : {}),
          ...(message.moment ? { moment: message.moment } : {}),
        },
        ...(snapshot
          ? { snapshot, preview: URL.createObjectURL(snapshot) }
          : {}),
      });
    },
    [graphicName, letGraphicGo, previewPath, setPendingAnnotation, siteUrl],
  );
  const diagramFrames = useMemo(
    () =>
      canComment
        ? {
            connectionId: connectionClient.connectionId,
            pointMode,
            scripts: scripts.on,
            onMessage: frameMessage,
          }
        : null,
    [
      canComment,
      connectionClient.connectionId,
      frameMessage,
      pointMode,
      scripts.on,
    ],
  );
  const renderHtmlBlock = useCallback(
    (html: string) => (
      <RenderedFrame
        connectionId={connectionClient.connectionId}
        svg={html}
        name="HTML block"
        scripts
        autoHeight
        pointMode={pointMode}
        onMessage={frameMessage}
        className="md-html-frame"
      />
    ),
    [connectionClient.connectionId, frameMessage, pointMode],
  );
  const canScript =
    !showingChanges &&
    (!!siteUrl ||
      (renderRichPreview && (hasMarkdownPreview || hasHtmlPreview)) ||
      isSvgFile);
  const scriptsControl = canScript ? (
    <>
      <button
        type="button"
        className={`file-preview-copy${scripts.on ? " is-on" : ""}`}
        aria-pressed={scripts.on}
        disabled={!!scripts.listed}
        title={
          scripts.listed
            ? `Scripts run here: ${scripts.listed} is in Settings, Instance, Sites we work on. Sandboxed, without access to Roamgate.`
            : scripts.on
              ? "Scripts run for this file. Sandboxed, without access to Roamgate. Click to turn them off."
              : "Scripts are off. Click to run this file's scripts, sandboxed without access to Roamgate."
        }
        onClick={scripts.toggle}
      >
        {scripts.on
          ? `Scripts on${scripts.listed ? " (listed)" : ""}`
          : "Scripts off"}
      </button>
      {scripts.turnedOn && !scripts.listed && scripts.alwaysEntry ? (
        <button
          type="button"
          className="file-preview-copy"
          title={`Always run scripts under ${scripts.alwaysEntry}: adds it to Sites we work on`}
          onClick={() => void scripts.always()}
        >
          Always here
        </button>
      ) : null}
    </>
  ) : null;
  // The threads' keys and what they have open, as in an agent chat: j / k
  // through the blocks and the threads' messages, n / N, gn / gN, gH, c,
  // R, r, za, dd, T, zz / zt / zb (useThreadKeys).
  const threadView = useFileThreadView(() => previewContentRef.current);
  const { cursor: threadCursor, setCursor: setThreadCursor } = threadView;
  /*
   * Where the tab is left (previewPlaces): kept as it changes, its scroll
   * as it scrolls, while the preview is seen, and given back when the tab
   * is shown again, here or in an inspector drawn anew.
   */
  /** The tab the cursor, folds, panel and mode shown now are of. */
  const placeKey = useRef("");
  const keepPlace = () => {
    if (!placeScope || !historyKey || placeKey.current !== historyKey) return;
    keepPreviewTabPlace(placeScope, historyKey, {
      history: live(),
      cursor: threadView.cursor,
      flipped: [...threadView.flipped],
      mode: previewMode,
      threadsOpen,
    });
  };
  const keepPlaceRef = useRef(keepPlace);
  keepPlaceRef.current = keepPlace;
  const shownRef = useRef({ historyKey, isPageFrame, live });
  shownRef.current = { historyKey, isPageFrame, live };
  // A tab shown again: its cursor, folds and Comments panel as left.
  useEffect(() => {
    const kept =
      placeScope && historyKey
        ? readPreviewTabPlace(placeScope, historyKey)
        : null;
    if (!kept) return;
    setThreadCursor(kept.cursor);
    threadView.setFlipped(new Set(kept.flipped));
    setThreadsOpen(kept.threadsOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyKey, placeScope]);
  // Kept as it changes; not in the draw a tab is shown in (its state is
  // still the last tab's until given back).
  useEffect(() => {
    if (placeKey.current !== historyKey) {
      placeKey.current = historyKey;
      return;
    }
    keepPlace();
  });
  // Its scroll as it scrolls: not while a scroll is given back, nor while
  // hidden (a hidden scroller is at its top).
  useEffect(() => {
    if (!contentElement) return;
    const onScroll = (event: Event) => {
      const { historyKey: key, isPageFrame: framed, live } = shownRef.current;
      if (pendingScroll.current !== null || framed || !previewSeen()) return;
      const scroller = fileScroller();
      if (!scroller || event.target !== scroller) return;
      histories.current.set(key, keepScroll(live(), scroller.scrollTop));
      keepPlaceRef.current();
    };
    contentElement.addEventListener("scroll", onScroll, true);
    return () => contentElement.removeEventListener("scroll", onScroll, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentElement]);
  // Shown again after another view (hidden, its scroll is lost): where it
  // was, the frame's page too.
  useEffect(() => {
    const section = previewSectionRef.current;
    if (!section || typeof ResizeObserver === "undefined") return;
    let seen = previewSeen();
    const observer = new ResizeObserver(() => {
      const now = previewSeen();
      if (now && !seen) {
        const { isPageFrame: framed, live } = shownRef.current;
        const { scroll } = currentPlace(live());
        if (framed)
          frameRef.current?.contentWindow?.postMessage(
            { roamgate: "rendered", type: "scrollTo", y: scroll },
            "*",
          );
        else if (scroll) {
          pendingScroll.current = scroll;
          setHistoryTick((tick) => tick + 1);
        }
      }
      seen = now;
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  const keysRoot = canComment ? contentElement : null;
  const threadOrder = useMemo(
    () => fileThreadOrder(fileThreads.threads, previewText),
    [fileThreads.threads, previewText],
  );
  const threadsById = useMemo(
    () => new Map(fileThreads.all.map((thread) => [thread.id, thread])),
    [fileThreads.all],
  );
  /** The comments' panel lists every conversation. */
  const conversations = useMemo(
    () => fileThreads.all.filter((thread) => thread.kind !== "merge-request"),
    [fileThreads.all],
  );
  /** The thread the cursor is in, if any. */
  const cursorThread = useMemo(() => {
    if (!threadCursor) return null;
    if (threadCursor.startsWith("t:")) return threadCursor.slice(2);
    if (!threadCursor.startsWith("m:")) return null;
    const comment = threadCursor.slice(2);
    return (
      threadOrder.find((thread) =>
        thread.comments.some((message) => message.id === comment),
      )?.id ?? null
    );
  }, [threadCursor, threadOrder]);
  /**
   * The line the cursor is on: its block's, its thread's, else the line
   * the file was opened at.
   */
  const cursorLine = (): number | undefined => {
    const block = /^b:(\d+)/.exec(threadCursor ?? "");
    if (block) return Number(block[1]);
    const thread = cursorThread ? threadsById.get(cursorThread) : undefined;
    return thread?.anchor.line ?? line;
  };
  /** A word on a step (wrapped around), gone after a moment. */
  const [threadNotice, setThreadNotice] = useState("");
  /** The `:` prompt, open, and where the focus was when it opened. */
  const [commandLine, setCommandLine] = useState<{
    from: HTMLElement | null;
  } | null>(null);
  useEffect(() => {
    if (!threadNotice) return;
    const timer = window.setTimeout(() => setThreadNotice(""), 1800);
    return () => window.clearTimeout(timer);
  }, [threadNotice]);
  /** A thread's place, shown: in the file, or in the page's frame. */
  const goToThread = useCallback(
    (thread: ReviewThread) => {
      if (isFramePage) {
        const render = thread.anchor.render;
        frameRef.current?.contentWindow?.postMessage(
          {
            roamgate: "rendered",
            type: "show",
            ...(render?.selector ? { selector: render.selector } : {}),
            ...(render?.quote ? { quote: render.quote } : {}),
          },
          "*",
        );
        return;
      }
      focusFileThread(previewContentRef.current, thread, setThreadCursor);
    },
    [isFramePage, setThreadCursor],
  );
  /** gn / gN: the next or previous unresolved thread, wrapping around. */
  const jumpUnresolved = (direction: 1 | -1) => {
    const step = stepUnresolved(
      threadOrder,
      fileThreadPlace(threadOrder, threadCursor, cursorThread, direction),
      direction,
    );
    if (!step) {
      setThreadNotice("No unresolved comment in this file.");
      return;
    }
    if (step.wrapped) setThreadNotice(stepNotice(step, direction));
    const thread = threadOrder[step.index]!;
    // Folded by hand: unfolded to be read.
    if (threadView.flipped.has(thread.id) && !thread.resolved) {
      threadView.unfold([thread.id]);
      requestAnimationFrame(() => goToThread(thread));
    } else goToThread(thread);
  };
  /**
   * c / Enter on a block, a list item or a table cell: a comment on its
   * own words and lines, or on those selected in it.
   */
  const commentBlock = (block: HTMLElement): boolean => {
    const own = fileStopAnchor(block, MAX_QUOTE_LENGTH);
    if (!own) return false;
    const box = block.getBoundingClientRect();
    const selected =
      markdownSelection &&
      markdownSelection.line !== undefined &&
      markdownSelection.line >= own.line &&
      markdownSelection.line <= (own.endLine ?? own.line)
        ? markdownSelection
        : null;
    const line = selected?.line ?? own.line;
    const end = selected ? selected.endLine : own.endLine;
    setPendingAnnotation({
      kind: "quote",
      path: previewPath,
      quote: selected?.quote ?? own.quote,
      section:
        selected?.section ??
        markdownHeadingPath(
          block.closest(".file-preview-markdown") ?? block,
          block,
        ),
      x: selected?.x ?? box.left,
      y: selected?.y ?? box.bottom + 6,
      line,
      ...(end !== undefined && end !== line ? { endLine: end } : {}),
    });
    setMarkdownSelection(null);
    return true;
  };
  useThreadKeys(
    () => keysRoot,
    keysRoot,
    fileThreadKeys({
      view: threadView,
      api: fileThreads,
      threadsById,
      goToThread,
      openOverview: () => setThreadsOpen(true),
      jumpUnresolved,
      comment: commentBlock,
    }),
  );
  useMarkedBlocks(contentElement, threadCursor);
  // Show rendered: the cursor on the block (item, cell) of the line asked,
  // in view, once the file is drawn.
  useEffect(() => {
    if (!renderedAtLine || !line || !contentElement || previewText === null)
      return;
    const frame = requestAnimationFrame(() => {
      const stop = fileStopForLine(contentElement, line);
      if (!stop) return;
      setThreadCursor(fileStopKey(stop));
      stop.scrollIntoView?.({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [renderedAtLine, line, contentElement, previewText, setThreadCursor]);
  useQuoteHighlights(contentElement, threadsById, previewText);
  const threadsUnder = useCallback(
    (
      stops: readonly string[],
      stopOf: (line: number, quote?: string) => string | undefined,
      where: SlotWhere,
    ) => (
      <SlotThreads
        stops={stops}
        stopOf={stopOf}
        where={where}
        threads={fileThreads.threads}
        api={fileThreads}
        view={threadView}
        undelivered={undelivered}
        nested={fileThreads.nested}
      />
    ),
    [fileThreads, threadView, undelivered],
  );
  const fileShown = !showingChanges;
  /** A page, a rendered file: what has the threads' blocks and keys. */
  const renderedShown = fileShown && (renderRichPreview || !!siteUrl);
  /** The source view, whose Vim keys are its own: `:` commands said. */
  const sourceShown =
    fileShown && hasPreviewText && !renderRichPreview && !hasMediaPreview;
  const unresolvedNav = (
    <>
      <UnresolvedNav
        className="file-preview-unresolved-nav"
        total={threadOrder.filter((thread) => !thread.resolved).length}
        position={unresolvedPosition(threadOrder, cursorThread)}
        openOnly={threadView.openOnly}
        onStep={jumpUnresolved}
        onOpenOnly={threadView.setOpenOnly}
        commandHints={sourceShown}
      />
      {threadNotice ? (
        <span className="chat-unresolved-notice" role="status">
          {threadNotice}
        </span>
      ) : null}
    </>
  );

  const copyPreviewText = async () => {
    if (previewText === null) return;
    try {
      await copyTextFromUserGesture(previewText);
      store.notify({
        kind: "success",
        message: "File content copied",
        detail: previewPath,
        autoDismissMs: 3000,
      });
    } catch (copyError) {
      store.notify({
        kind: "error",
        message: "Failed to copy file content",
        detail: (copyError as Error).message,
      });
    }
  };

  /** The threads' keys, as if typed on the list (`:comment` is `c`). */
  const pressThreadKeys = (...names: string[]) => {
    for (const key of names)
      keysRoot?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
  };
  /**
   * The `:` commands, each what a key, a button or the source view's Vim
   * keys already do here, there only where that is.
   */
  const previewCommands: InspectorCommand[] = [
    ...(onToggleTree
      ? [
          {
            name: "files",
            description: "show / hide the file tree",
            run: () => onToggleTree(),
          },
        ]
      : []),
    ...(fileShown && onCreateAnnotation
      ? [
          {
            name: "only",
            aliases: ["o", "diffonly", "zen"],
            description: "Review only: no chrome, just the file (o)",
            run: () => toggleZen(),
          },
        ]
      : []),
    ...(canComment
      ? [
          {
            name: "conversations",
            aliases: ["threads", "conv"],
            description: "every conversation of the file, resolved too (T)",
            run: () => setThreadsOpen(true),
          },
          {
            name: "unresolved",
            aliases: ["openonly"],
            description: "show only the unresolved threads, or all again (gH)",
            run: () => threadView.setOpenOnly(!threadView.openOnly),
          },
          {
            name: "next",
            description: "the next unresolved thread (gn)",
            run: () => jumpUnresolved(1),
          },
          {
            name: "previous",
            aliases: ["prev"],
            description: "the previous unresolved thread (gN)",
            run: () => jumpUnresolved(-1),
          },
        ]
      : []),
    ...(canComment && renderedShown
      ? [
          {
            name: "comment",
            description:
              "comment on the cursor's block, or answer its thread (c)",
            run: () => pressThreadKeys("c"),
          },
          {
            name: "fold",
            description: "fold / unfold the cursor's thread (za)",
            run: () => pressThreadKeys("z", "a"),
          },
        ]
      : []),
    ...(fileShown && hasRichPreview
      ? [
          {
            name: "source",
            description: "the file's source (the Source switch)",
            run: () => setPreviewMode("raw"),
          },
          {
            name: "rendered",
            aliases: ["preview"],
            description: "the file rendered (the Source switch)",
            run: () => setPreviewMode("rendered"),
          },
        ]
      : []),
    ...(canScript && !scripts.listed
      ? [
          {
            name: "scripts",
            description:
              "run this file's or page's scripts, sandboxed, or not (:scripts on|off)",
            run: (argument: string) => {
              if (argument === "on" && scripts.on) return;
              if (argument === "off" && !scripts.on) return;
              scripts.toggle();
            },
          },
        ]
      : []),
    ...(canPoint
      ? [
          {
            name: "point",
            description: "point at a graphic, or stop (the Point button)",
            run: () => setPointMode((on) => !on),
          },
        ]
      : []),
    ...(fileShown && !siteUrl && absolutePath && onShowInReview
      ? [
          {
            name: "review",
            description: "this file in its checkout's code review, at the line",
            run: () => onShowInReview(absolutePath, cursorLine()),
          },
        ]
      : []),
    ...(fileShown && reviewPath
      ? [
          {
            name: "reviewed",
            description:
              "this file reviewed in the checkout's review, or not (its tick)",
            run: toggleReviewed,
          },
        ]
      : []),
    ...(fileShown && entry && onRefresh
      ? [
          {
            name: "reload",
            aliases: ["refresh", "e", "edit"],
            description:
              "read the file again, in place (R, the refresh button)",
            run: reload,
          },
        ]
      : []),
    ...(fileShown && hasPreviewText && !preview?.truncated
      ? [
          {
            name: "copy",
            description: "copy the whole file",
            run: () => void copyPreviewText(),
          },
        ]
      : []),
    ...(fileShown && onOpenFile
      ? [
          {
            name: "url",
            description: "open a site's page here (:url ADDRESS)",
            run: (argument: string) => {
              if (!argument) {
                setUrlOpen(true);
                return;
              }
              const url = parseSiteUrl(argument);
              if (url) openFromView?.(url);
              else
                store.notify({
                  kind: "info",
                  message: `Not a page's address: ${argument}`,
                  autoDismissMs: 2500,
                });
            },
          },
        ]
      : []),
    ...(fileShown && entry
      ? [
          {
            name: "back",
            description: `the place before (${mac ? "Cmd+[" : "Alt+Left"})`,
            run: () => stepPlace(-1),
          },
          {
            name: "forward",
            description: `the place after (${mac ? "Cmd+]" : "Alt+Right"})`,
            run: () => stepPlace(1),
          },
        ]
      : []),
    ...(entry && onClosePreview
      ? [
          {
            name: "q",
            aliases: ["quit", "close"],
            description: "close the preview",
            run: () => onClosePreview(),
          },
        ]
      : []),
  ];
  /** `:N` in a rendered file: the cursor on the block of line N. */
  const goToLine =
    renderedShown && canComment && contentElement && previewText !== null
      ? (target: number) => {
          const stop = fileStopForLine(contentElement, target);
          if (!stop) return;
          setThreadCursor(fileStopKey(stop));
          stop.scrollIntoView?.({ block: "center" });
        }
      : undefined;
  /*
   * In the inspector, its prompt has these commands with the rest of the
   * Files view's and its own, and `:` is the inspector's.
   */
  const inspectorRun = useInspectorCommands(
    fileShown
      ? {
          commands: previewCommands,
          line: goToLine,
          root: () => previewSectionRef.current,
        }
      : null,
  );
  const runPreviewCommand = (input: string) => {
    if (inspectorRun) {
      inspectorRun(input);
      return;
    }
    const problem = runInspectorCommand(previewCommands, input, goToLine);
    if (problem)
      store.notify({ kind: "info", message: problem, autoDismissMs: 2500 });
  };
  const openCommandLine = () =>
    setCommandLine({
      from:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    });
  /** Esc, Enter: the focus back where it was when `:` was pressed. */
  const leaveCommandLine = () => {
    const from = commandLine?.from;
    setCommandLine(null);
    const back = from?.isConnected ? from : previewSectionRef.current;
    back?.focus({ preventScroll: true });
  };

  return (
    <section
      ref={previewSectionRef}
      className={`file-preview${zen ? " is-zen" : ""}`}
      aria-label="File preview"
      tabIndex={-1}
      onKeyDown={(e) => {
        // `:` anywhere in the view, a page's frame included (its script
        // hands it over), but where it is typed text.
        if (
          !e.defaultPrevented &&
          !inspectorRun &&
          fileShown &&
          !commandLine &&
          opensCommandLine(e)
        ) {
          e.preventDefault();
          e.stopPropagation();
          openCommandLine();
          return;
        }
        // Back and Forward, but where Alt+arrows move in typed text.
        const historyStep = historyKeyStep(e);
        if (
          historyStep &&
          !e.defaultPrevented &&
          fileShown &&
          !isTypingTarget(e.target)
        ) {
          e.preventDefault();
          e.stopPropagation();
          stepPlace(historyStep);
          return;
        }
        // R: the file read again (the refresh button), but where R is
        // typed text, the source's own keys, or a thread's reply
        // (useThreadKeys took it then).
        if (
          e.key === "R" &&
          !e.defaultPrevented &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          onRefresh &&
          entry &&
          !showingChanges &&
          zenKeyTarget(e.target) &&
          !(e.target as HTMLElement).closest?.(".cm-editor")
        ) {
          e.preventDefault();
          e.stopPropagation();
          reload();
          return;
        }
        if (
          e.key === "o" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          zenKeyTarget(e.target) &&
          !(e.target as HTMLElement).closest?.(".cm-editor")
        )
          toggleZen();
      }}
      onKeyDownCapture={(e) => {
        // The file's own source view is read-only: `o` there is the mode
        // too (its Vim keys would take it and do nothing). Comment editors
        // keep theirs.
        if (
          onCreateAnnotation &&
          e.key === "o" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          zenKeyTarget(e.target) &&
          e.target instanceof Node &&
          !!editorViewRef.current?.contentDOM.contains(e.target)
        ) {
          e.preventDefault();
          e.stopPropagation();
          toggleZen();
          return;
        }
        if (shortcutMatches(e.nativeEvent, "preview.search")) {
          if (showingChanges || renderRichPreview) return;
          e.preventDefault();
          e.stopPropagation();
          openPreviewSearch(editorViewRef.current);
        }
      }}
    >
      <div className="file-preview-head">
        <div className="file-preview-title-row">
          {backAction ? (
            <button
              type="button"
              className="file-preview-back"
              title={backAction.label}
              aria-label={backAction.label}
              onClick={backAction.onClick}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
          ) : null}
          {fileShown && entry ? historyButtons : null}
          <div className="file-preview-title" title={entry?.name}>
            {entry?.name ?? "Preview"}
          </div>
          <div className="file-preview-head-actions">
            {!showingChanges && showDirectoryWorkspaceAction ? (
              <button
                type="button"
                className="file-preview-refresh"
                title="New workspace with this directory as CWD"
                aria-label="New workspace with this directory as CWD"
                onClick={() => setWorkspaceDialogOpen(true)}
              >
                <FolderPlus size={13} aria-hidden="true" />
              </button>
            ) : null}
            {onToggleTree ? (
              <button
                type="button"
                className="file-preview-refresh"
                title={
                  // :files is the file view's (the inspector's, there).
                  `${treeHidden ? "Show" : "Hide"} the file tree${showingChanges && !inspectorRun ? "" : " (:files)"}`
                }
                aria-label={
                  treeHidden ? "Show the file tree" : "Hide the file tree"
                }
                aria-pressed={treeHidden}
                onClick={onToggleTree}
              >
                {treeHidden ? (
                  <PanelLeftOpen size={13} aria-hidden="true" />
                ) : (
                  <PanelLeftClose size={13} aria-hidden="true" />
                )}
              </button>
            ) : null}
            {!showingChanges && entry && onRefresh ? (
              <button
                type="button"
                className="file-preview-refresh"
                title="Refresh preview (R, :refresh)"
                aria-label="Refresh preview"
                disabled={loadingProp}
                onClick={reload}
              >
                <RefreshCw
                  size={13}
                  className={loadingProp ? "is-spinning" : undefined}
                  aria-hidden="true"
                />
              </button>
            ) : null}
            {!showingChanges && onOpenFile ? (
              <button
                type="button"
                className="file-preview-copy"
                title="Open a site's page here, to browse and comment on"
                aria-expanded={urlOpen}
                onClick={() => setUrlOpen((open) => !open)}
              >
                URL
              </button>
            ) : null}
            {!showingChanges && onCreateAnnotation ? (
              <ZenButton
                zen={zen}
                onToggle={toggleZen}
                className="file-preview-refresh"
                label="Review only"
                title="Review only: hide all the chrome, just the file (o, :only; o or Esc brings it back)"
                size={13}
              />
            ) : null}
            {scriptsControl}
            {canPoint ? (
              <button
                type="button"
                className={`file-preview-copy${pointMode ? " is-on" : ""}`}
                aria-pressed={pointMode}
                title="Point at a graphic: click for a point, drag for a box (or hold Alt)"
                onClick={() => setPointMode((on) => !on)}
              >
                Point
              </button>
            ) : null}
            {canComment ? (
              <>
                <ThreadsChip
                  threads={fileThreads.threads}
                  undelivered={
                    undelivered
                      ? {
                          count: undelivered.ids.size,
                          reason: undelivered.reason,
                        }
                      : undefined
                  }
                  open={threadsOpen}
                  onToggle={() => setThreadsOpen((open) => !open)}
                  className="file-preview-threads-chip"
                  commandHints={sourceShown}
                />
                {unresolvedNav}
              </>
            ) : null}
            {!showingChanges && hasPreviewText && !preview?.truncated ? (
              <button
                type="button"
                className="file-preview-copy"
                title="Copy entire file content"
                onClick={() => void copyPreviewText()}
              >
                Copy
              </button>
            ) : null}
            {!showingChanges && hasRichPreview ? (
              <button
                type="button"
                className="file-preview-mode-toggle"
                role="switch"
                aria-label="Source mode"
                aria-checked={previewMode === "raw"}
                onClick={() =>
                  setPreviewMode((mode) =>
                    mode === "rendered" ? "raw" : "rendered",
                  )
                }
              >
                <span className="file-preview-mode-label">
                  {hasMermaidPreview ? "Diagram" : "Preview"}
                </span>
                <span
                  className={
                    "settings-switch" + (previewMode === "raw" ? " is-on" : "")
                  }
                  aria-hidden="true"
                >
                  <span />
                </span>
                <span className="file-preview-mode-label">Source</span>
              </button>
            ) : null}
            {!showingChanges && !siteUrl && absolutePath && onShowInReview ? (
              <button
                type="button"
                className="file-preview-copy"
                title="Show in code review: this file in the review of its checkout, at the cursor's line"
                onClick={() => onShowInReview(absolutePath, cursorLine())}
              >
                Review
              </button>
            ) : null}
            {!showingChanges && reviewPath ? (
              <button
                type="button"
                className={`file-preview-copy file-preview-reviewed ${reviewTick?.reviewed ? "is-reviewed" : ""}`}
                aria-pressed={reviewTick?.reviewed ?? false}
                title={
                  reviewTick?.reviewed
                    ? "Reviewed in the checkout's review: unmark it (:reviewed)"
                    : "Mark this file reviewed in the checkout's review (:reviewed)"
                }
                onClick={toggleReviewed}
              >
                {reviewTick?.reviewed ? "\u2713 Reviewed" : "Reviewed"}
              </button>
            ) : null}
            {changesAvailable ? (
              <button
                type="button"
                className="file-preview-changes-toggle"
                aria-pressed={showingChanges}
                title={showingChanges ? "Show file preview" : "Show changes"}
                onClick={() =>
                  setDetailTab(showingChanges ? "file" : "changes")
                }
              >
                Changes
              </button>
            ) : null}
            {entry && onClosePreview ? (
              <button
                type="button"
                className="file-preview-refresh"
                title="Close preview"
                aria-label="Close file preview"
                onClick={onClosePreview}
              >
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
        {entry ? <span>{entry.path}</span> : null}
        {changedOnDisk && !showingChanges ? (
          <div className="file-preview-changed" role="status">
            <span>Changed on disk: R or :refresh to reload</span>
            <button
              type="button"
              className="file-preview-copy"
              title="Read the file again, where you are in it (R, :refresh)"
              disabled={loadingProp}
              onClick={reload}
            >
              Reload
            </button>
          </div>
        ) : null}
        {urlOpen ? (
          <form
            className="file-preview-url"
            onSubmit={(event) => {
              event.preventDefault();
              const url = parseSiteUrl(urlText);
              if (!url || !onOpenFile) return;
              setUrlOpen(false);
              openFromView?.(url);
            }}
          >
            <input
              // biome-ignore lint/a11y/noAutofocus: asked for just now
              autoFocus
              type="url"
              value={urlText}
              onChange={(event) => setUrlText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setUrlOpen(false);
              }}
              placeholder="http://localhost:8080/docs/"
              aria-label="The page to open"
            />
            <button type="submit" className="file-preview-copy">
              Open
            </button>
          </form>
        ) : null}
      </div>

      {showingChanges ? (
        <div
          className="file-preview-changes"
          role="region"
          aria-label={`Changes for ${entry?.name ?? "selected file"}`}
        >
          {changesContent}
        </div>
      ) : (
        <div className="file-preview-with-threads">
          <div
            ref={contentRef}
            {...(canPoint ? pointing.handlers : {})}
            className="file-preview-file-content"
            role="region"
            aria-label={`Preview of ${entry?.name ?? "selected file"}`}
          >
            {!entry ? (
              <div className="file-preview-state">
                Select a text file to preview.
              </div>
            ) : null}
            {loading ? (
              <div className="file-preview-state">
                <span className="file-loading-spinner" />
                Loading preview
              </div>
            ) : null}
            {error ? (
              <div className="file-preview-state is-error">
                <span>{error}</span>
                {onRefresh ? (
                  <button type="button" className="btn ghost" onClick={reload}>
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {!loading && !error && directoryPath ? (
              <div className="file-preview-state">
                Directories cannot be previewed.
              </div>
            ) : null}
            {siteUrl ? (
              <RenderedFrame
                connectionId={connectionClient.connectionId}
                url={siteUrl}
                scripts={scripts.turnedOn}
                name={siteUrl}
                pointMode={pointMode}
                onMessage={frameMessage}
                onPage={reportFramePage}
                onMissing={reportFrameMissing}
                frameRef={frameRef}
                bannerIn={zen ? zenBanner : null}
              />
            ) : null}
            {!loading && !error && drawSvgFramed && svgText !== null ? (
              <RenderedFrame
                key={previewPath}
                connectionId={connectionClient.connectionId}
                svg={svgText}
                scripts={scripts.on}
                name={entry?.name ?? previewPath}
                pointMode={pointMode}
                onMessage={frameMessage}
                className="file-preview-html"
              />
            ) : null}
            {!loading && !error && preview?.image_data_url && !drawSvgFramed ? (
              <ImagePreview
                key={previewPath}
                src={preview.image_data_url}
                name={entry?.name ?? preview.path}
              />
            ) : null}
            {!loading &&
            !error &&
            hasPdfPreview &&
            !pdfTooLarge &&
            inlinePreviewUrl ? (
              framesShowPdf() ? (
                <iframe
                  className="file-preview-pdf"
                  src={inlinePreviewUrl}
                  title={`PDF preview: ${entry?.name ?? previewPath}`}
                />
              ) : (
                <Suspense
                  fallback={
                    <div className="file-preview-state">Loading the PDF...</div>
                  }
                >
                  <PdfPages
                    key={inlinePreviewUrl}
                    url={inlinePreviewUrl}
                    name={entry?.name ?? previewPath}
                  />
                </Suspense>
              )
            ) : null}
            {!loading && !error && pdfTooLarge ? (
              <div className="file-preview-state">
                PDF is too large to preview. Use Download from the file menu.
              </div>
            ) : null}
            {!loading && !error && audioTooLarge ? (
              <div className="file-preview-state">
                Audio is too large to preview (25 MiB maximum). Use Download
                from the file menu.
              </div>
            ) : null}
            {!loading &&
            !error &&
            hasAudioPreview &&
            !audioTooLarge &&
            inlinePreviewUrl ? (
              <div className="file-preview-audio">
                <audio
                  key={inlinePreviewUrl}
                  controls
                  preload="metadata"
                  src={inlinePreviewUrl}
                  aria-label={`Audio preview: ${entry?.name ?? previewPath}`}
                />
              </div>
            ) : null}
            {!loading &&
            !error &&
            preview?.binary &&
            !preview.image_data_url &&
            !hasMediaPreview ? (
              <div className="file-preview-state">
                Binary file cannot be previewed.
              </div>
            ) : null}
            {!loading &&
            !error &&
            hasHtmlPreview &&
            renderRichPreview &&
            absolutePath ? (
              <RenderedFrame
                // Read again on a reload: the page shown is the file's now.
                key={`${absolutePath}:${preview?.resource_revision ?? ""}`}
                connectionId={connectionClient.connectionId}
                file={absolutePath}
                scripts={scripts.turnedOn}
                name={entry?.name ?? previewPath}
                pointMode={pointMode}
                onMessage={frameMessage}
                onPage={reportFramePage}
                onMissing={reportFrameMissing}
                frameRef={frameRef}
                bannerIn={zen ? zenBanner : null}
              />
            ) : null}
            {!loading &&
            !error &&
            preview?.truncated &&
            !hasMediaPreview &&
            !(hasHtmlPreview && renderRichPreview) ? (
              <div className="file-preview-banner">
                Preview truncated at 512 KB.
              </div>
            ) : null}
            {!loading && !error && lineBeyondPreview ? (
              <div className="file-preview-banner" role="status">
                Match at line {line} is outside this preview. The beginning of
                the file is shown below.
                {snippet ? (
                  <code className="file-preview-search-snippet">{snippet}</code>
                ) : null}
              </div>
            ) : null}
            {!loading && !error && hasMarkdownPreview && renderRichPreview ? (
              <DiagramFrameContext.Provider value={diagramFrames}>
                <MarkdownPreview
                  className="file-preview-reading"
                  htmlDocument
                  threadsFor={onCreateAnnotation ? threadsUnder : undefined}
                  htmlBlock={scripts.on ? renderHtmlBlock : undefined}
                  text={previewText}
                  imageUrlResolver={markdownImageUrlResolver}
                  documentPath={onOpenFile ? markdownDocumentPath : undefined}
                  linkUrlResolver={markdownLinkUrlResolver}
                  fragment={fragment}
                  onOpenDocument={openFromView}
                  onSelectionChange={
                    onCreateAnnotation ? setMarkdownSelection : undefined
                  }
                />
              </DiagramFrameContext.Provider>
            ) : null}
            {!loading && !error && hasMermaidPreview && renderRichPreview ? (
              <MermaidDiagram
                key={previewPath}
                code={previewText}
                className="file-preview-mermaid"
              />
            ) : null}
            {!loading &&
            !error &&
            hasPreviewText &&
            !renderRichPreview &&
            !hasMediaPreview ? (
              <CodeMirrorPreview
                text={previewText}
                path={previewPath}
                line={line}
                theme={theme}
                annotations={lineAnnotations}
                editorViewRef={editorViewRef}
                onCommand={runPreviewCommand}
                onRequestAnnotation={
                  onCreateAnnotation
                    ? ({ line, endLine, quote, x, y }) =>
                        setPendingAnnotation({
                          kind: "line",
                          path: previewPath,
                          line,
                          endLine,
                          quote,
                          x,
                          y,
                        })
                    : undefined
                }
              />
            ) : null}
          </div>
          {threadsOpen && canComment ? (
            <ThreadsList
              className="file-preview-threads"
              threads={conversations}
              api={fileThreads}
              onGo={goToThread}
              onClose={() => setThreadsOpen(false)}
            />
          ) : null}
        </div>
      )}
      {commandLine && fileShown ? (
        <CommandLine
          kind=":"
          completions={(typed) => inspectorCompletions(previewCommands, typed)}
          onBlur={() => setCommandLine(null)}
          onSubmit={(text) => {
            leaveCommandLine();
            runPreviewCommand(text);
          }}
          onCancel={leaveCommandLine}
        />
      ) : null}
      {pointing.box}
      {zen ? (
        <div className="file-preview-zen-hint">
          <span ref={setZenBanner} className="file-preview-zen-banner-slot" />
          <button
            type="button"
            title="Show the chrome again (o or Esc)"
            onClick={toggleZen}
          >
            Show all
          </button>
          {scriptsControl}
          {canPoint ? (
            <button
              type="button"
              className={pointMode ? "is-on" : ""}
              aria-pressed={pointMode}
              onClick={() => setPointMode((on) => !on)}
            >
              Point
            </button>
          ) : null}
          {canComment ? (
            <>
              <ThreadsChip
                threads={fileThreads.threads}
                undelivered={
                  undelivered
                    ? {
                        count: undelivered.ids.size,
                        reason: undelivered.reason,
                      }
                    : undefined
                }
                open={threadsOpen}
                onToggle={() => setThreadsOpen((open) => !open)}
                commandHints={sourceShown}
              />
              {unresolvedNav}
            </>
          ) : null}
          <ZenDock labels iconSize={13} />
        </div>
      ) : null}
      {markdownSelection &&
      onCreateAnnotation &&
      (siteUrl || (hasRichPreview && renderRichPreview)) &&
      !showingChanges
        ? createPortal(
            <button
              type="button"
              className="markdown-annotate-button"
              style={{
                left: Math.min(
                  Math.max(8, markdownSelection.x),
                  Math.max(8, window.innerWidth - 154),
                ),
                top: Math.min(
                  Math.max(8, markdownSelection.y),
                  Math.max(8, window.innerHeight - 42),
                ),
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setPendingAnnotation({
                  kind: "quote",
                  path: previewPath,
                  quote: markdownSelection.quote,
                  section: markdownSelection.section,
                  x: markdownSelection.x,
                  y: markdownSelection.y,
                  ...(markdownSelection.line !== undefined
                    ? { line: markdownSelection.line }
                    : {}),
                  ...(markdownSelection.endLine !== undefined
                    ? { endLine: markdownSelection.endLine }
                    : {}),
                  ...(markdownSelection.render
                    ? { render: markdownSelection.render }
                    : {}),
                });
                setMarkdownSelection(null);
              }}
            >
              Annotate selection
            </button>,
            document.body,
          )
        : null}
      <AnnotationComposerPopover
        draft={annotationComposerDraft}
        commentValue={fileDrafts[draftPath]?.comment ?? ""}
        onCommentChange={setDraftComment}
        suspendOnFileTabNavigation
        {...(onAddReviewImage ? { onAddImage: onAddReviewImage } : {})}
        onSave={saveAnnotation}
        onClose={closeAnnotationComposer}
      />
      <CreateWorkspaceDialog
        open={workspaceDialogOpen}
        initialName={directoryWorkspaceName}
        initialCwd={directoryPath ?? ""}
        onClose={() => setWorkspaceDialogOpen(false)}
      />
    </section>
  );
}

type CodeMirrorAnnotationRequest = FileAnnotationRequest;

type CodeMirrorAnnotationRuntime = {
  deps: CodeMirrorPreviewDeps;
  compartment: InstanceType<CodeMirrorPreviewDeps["Compartment"]>;
  view: CodeMirrorEditorView;
};

function codeMirrorAnnotationExtensions(
  deps: CodeMirrorPreviewDeps,
  text: string,
  annotations: readonly FileLineReviewAnnotation[],
  onRequestAnnotation?: (request: CodeMirrorAnnotationRequest) => void,
) {
  if (!onRequestAnnotation && annotations.length === 0) return [];
  const annotationsByLine = new Map<number, FileLineReviewAnnotation[]>();
  for (const annotation of annotations) {
    const current = annotationsByLine.get(annotation.line);
    if (current) current.push(annotation);
    else annotationsByLine.set(annotation.line, [annotation]);
  }

  const normalizedText = text.replace(/\r\n?/g, "\n");
  const lineStarts = [0];
  for (let index = 0; index < normalizedText.length; index += 1) {
    if (normalizedText[index] === "\n") lineStarts.push(index + 1);
  }

  const annotatedLines = new Set<number>();
  for (const annotation of annotations) {
    const end = Math.min(
      annotation.endLine ?? annotation.line,
      lineStarts.length,
    );
    for (let line = annotation.line; line <= end; line += 1)
      annotatedLines.add(line);
  }

  class ReviewGutterMarker extends deps.GutterMarker {
    constructor(
      private count: number,
      private stale: boolean,
    ) {
      super();
    }

    toDOM() {
      const marker = document.createElement("span");
      marker.className = `cm-review-annotation-marker ${
        this.stale ? "is-stale" : ""
      }`;
      marker.textContent = String(this.count);
      marker.title = `${this.count} review comment${this.count === 1 ? "" : "s"}`;
      return marker;
    }
  }

  const dragPlugin = deps.ViewPlugin.define(
    (view) =>
      new FileAnnotationDrag(
        view,
        (request) => onRequestAnnotation?.(request),
        () =>
          store.notify({
            kind: "info",
            message: "Select fewer lines to annotate",
            detail: `The selected text exceeds the ${MAX_QUOTE_LENGTH.toLocaleString("en-US")}-character annotation limit.`,
          }),
      ),
  );

  return [
    dragPlugin,
    deps.gutter({
      class: "cm-review-annotation-gutter",
      markers: (view) =>
        deps.RangeSet.of(
          Array.from(annotationsByLine.entries())
            .sort(([left], [right]) => left - right)
            .flatMap(([lineNumber, matches]) => {
              if (lineNumber > view.state.doc.lines) return [];
              const line = view.state.doc.line(lineNumber);
              return [
                new ReviewGutterMarker(
                  matches.length,
                  matches.every((annotation) => annotation.stale),
                ).range(line.from),
              ];
            }),
          true,
        ),
      domEventHandlers: {
        mousedown: (view, line, event) => {
          if (
            !(event instanceof MouseEvent) ||
            event.button !== 0 ||
            !onRequestAnnotation
          ) {
            return false;
          }
          return (
            view
              .plugin(dragPlugin)
              ?.start(view.state.doc.lineAt(line.from).number, event) ?? false
          );
        },
      },
    }),
    deps.EditorView.decorations.of(
      deps.Decoration.set(
        Array.from(annotatedLines)
          .sort((left, right) => left - right)
          .flatMap((lineNumber) => {
            const from = lineStarts[lineNumber - 1];
            return from === undefined
              ? []
              : [
                  deps.Decoration.line({
                    attributes: { "data-review-annotated": "true" },
                  }).range(from),
                ];
          }),
      ),
    ),
  ];
}

function CodeMirrorPreview({
  text,
  path,
  line,
  theme,
  annotations,
  editorViewRef,
  onRequestAnnotation,
  onCommand,
}: {
  text: string;
  path: string;
  line?: number;
  theme: AppTheme;
  annotations: readonly FileLineReviewAnnotation[];
  editorViewRef: MutableRefObject<CodeMirrorEditorView | null>;
  onRequestAnnotation?: (request: CodeMirrorAnnotationRequest) => void;
  /** A `:` command typed in its Vim keys (`:files`, `:only`...). */
  onCommand?: (input: string) => void;
}) {
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const annotationRuntimeRef = useRef<CodeMirrorAnnotationRuntime | null>(null);
  const annotationsRef = useRef(annotations);
  const requestAnnotationRef = useRef(onRequestAnnotation);
  const lineRef = useRef(line);
  annotationsRef.current = annotations;
  requestAnnotationRef.current = onRequestAnnotation;
  lineRef.current = line;

  const scrollToLine = (
    deps: CodeMirrorPreviewDeps,
    view: CodeMirrorEditorView,
    target: number,
  ) => {
    if (target > view.state.doc.lines) return;
    const position = view.state.doc.line(
      Math.min(view.state.doc.lines, Math.max(1, target)),
    ).from;
    view.dispatch({
      selection: { anchor: position },
      effects: deps.EditorView.scrollIntoView(position, { y: "center" }),
    });
  };

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    let cancelled = false;
    let view: CodeMirrorEditorView | null = null;
    parent.textContent = "";

    void loadCodeMirrorPreviewDeps().then((deps) => {
      if (cancelled || !containerRef.current) return;
      parent.textContent = "";
      const syntaxCompartment = new deps.Compartment();
      const annotationCompartment = new deps.Compartment();
      view = new deps.EditorView({
        parent,
        state: deps.EditorState.create({
          doc: text,
          extensions: [
            ...(vimKeys() ? [deps.vim()] : []),
            deps.basicSetup,
            deps.configuredShortcutGuard,
            deps.search({ top: true }),
            deps.keymap.of(deps.searchKeymap),
            deps.EditorState.readOnly.of(true),
            deps.EditorView.editable.of(false),
            deps.EditorView.contentAttributes.of({ tabindex: "0" }),
            syntaxCompartment.of([]),
            annotationCompartment.of(
              codeMirrorAnnotationExtensions(
                deps,
                text,
                annotationsRef.current,
                (request) => requestAnnotationRef.current?.(request),
              ),
            ),
            deps.EditorView.theme(
              {
                "&": {
                  height: "100%",
                  backgroundColor: "var(--viewer-code-bg)",
                  color: "var(--text-code)",
                },
                ".cm-scroller": {
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "12px",
                  lineHeight: "1.55",
                },
                ".cm-content": {
                  caretColor: "var(--accent)",
                  padding: "10px 0",
                },
                ".cm-content ::selection": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 32%, transparent) !important",
                  color: "inherit",
                },
                ".cm-line": {
                  padding: "0 12px",
                },
                ".cm-gutters": {
                  backgroundColor: "var(--viewer-code-bg)",
                  color: "var(--muted)",
                  borderRight: "1px solid var(--border-soft)",
                },
                ".cm-lineNumbers .cm-gutterElement": {
                  padding: "0 10px 0 12px",
                  minWidth: "42px",
                },
                ".cm-activeLineGutter, .cm-activeLine": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 10%, transparent)",
                },
                ".cm-selectionBackground, &.cm-focused .cm-selectionBackground":
                  {
                    backgroundColor:
                      "color-mix(in srgb, var(--accent) 32%, transparent) !important",
                  },
                ".cm-cursor": {
                  borderLeftColor: "var(--accent)",
                },
                ".cm-fat-cursor": {
                  background:
                    "color-mix(in srgb, var(--accent) 60%, transparent) !important",
                },
                "&:not(.cm-focused) .cm-fat-cursor": {
                  background: "none !important",
                  outline:
                    "1px solid color-mix(in srgb, var(--accent) 60%, transparent) !important",
                },
                ".cm-panels, .cm-panels.cm-panels-top, .cm-panels.cm-panels-bottom":
                  {
                    backgroundColor: "var(--viewer-header-bg)",
                    color: "var(--text)",
                    borderColor: "var(--border-soft)",
                  },
                ".cm-panel.cm-search": {
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  backgroundColor: "var(--viewer-header-bg)",
                  color: "var(--text)",
                },
                ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-search input":
                  {
                    height: "30px",
                    padding: "0 8px",
                    backgroundColor: "var(--viewer-code-bg)",
                    color: "var(--text)",
                    border: "1px solid var(--viewer-border)",
                    borderRadius: "7px",
                    outline: "none",
                  },
                ".cm-panel.cm-search .cm-textfield:focus, .cm-panel.cm-search input:focus":
                  {
                    borderColor: "var(--accent)",
                    boxShadow: "0 0 0 2px var(--accent-soft)",
                  },
                ".cm-panel.cm-search .cm-button, .cm-panel.cm-search button": {
                  height: "30px",
                  padding: "0 10px",
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--text)",
                  border: "1px solid var(--viewer-border)",
                  borderRadius: "7px",
                  backgroundImage: "none",
                  font: "inherit",
                },
                ".cm-panel.cm-search .cm-button:hover, .cm-panel.cm-search button:hover":
                  {
                    backgroundColor: "var(--viewer-header-bg)",
                  },
                ".cm-panel.cm-search .cm-button:disabled, .cm-panel.cm-search button:disabled":
                  {
                    opacity: "0.48",
                  },
                ".cm-panel.cm-search label": {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  color: "var(--text)",
                },
                ".cm-panel.cm-search input[type=checkbox]": {
                  width: "16px",
                  height: "16px",
                  margin: "0",
                  padding: "0",
                  accentColor: "var(--accent)",
                },
                ".cm-searchMatch": {
                  backgroundColor:
                    "color-mix(in srgb, var(--yellow) 36%, transparent)",
                  outline:
                    "1px solid color-mix(in srgb, var(--yellow) 45%, transparent)",
                },
                ".cm-searchMatch-selected": {
                  backgroundColor:
                    "color-mix(in srgb, var(--yellow) 58%, transparent)",
                  color: "var(--text-strong)",
                  outline: "1px solid var(--yellow)",
                },
                ".cm-matchingBracket": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 18%, transparent)",
                  color: "var(--text-strong)",
                  outline:
                    "1px solid color-mix(in srgb, var(--accent) 38%, transparent)",
                },
                ".cm-nonmatchingBracket": {
                  backgroundColor: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  outline: "1px solid var(--danger-border)",
                },
                ".cm-foldPlaceholder": {
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--muted)",
                  border: "1px solid var(--viewer-border)",
                },
                ".cm-tooltip, .cm-tooltip.cm-tooltip-autocomplete": {
                  border: "1px solid var(--viewer-border)",
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--text)",
                },
              },
              { dark: theme === "dark" },
            ),
          ],
        }),
      });
      editorViewRef.current = view;
      const cm = deps.getCM(view);
      if (cm) {
        definePreviewExCommands(deps);
        deps.vimExEditors.set(cm, (input) => commandRef.current?.(input));
      }
      annotationRuntimeRef.current = {
        deps,
        compartment: annotationCompartment,
        view,
      };
      if (lineRef.current) {
        scrollToLine(deps, view, lineRef.current);
        // Opened at a line (gf, a search hit): its keys go to the file.
        view.focus();
      }
      const activeView = view;

      void highlightCodeTokens(text, path)
        .then((tokens) => {
          if (cancelled || view !== activeView) return;
          const decorations = deps.Decoration.set(
            tokens.map(({ from, to, className }) =>
              deps.Decoration.mark({ class: className }).range(from, to),
            ),
            true,
          );
          activeView.dispatch({
            effects: syntaxCompartment.reconfigure(
              deps.EditorView.decorations.of(decorations),
            ),
          });
        })
        .catch(() => {
          // Highlighting is progressive; the plain-text preview remains usable.
        });
    });

    return () => {
      cancelled = true;
      if (editorViewRef.current === view) editorViewRef.current = null;
      if (annotationRuntimeRef.current?.view === view) {
        annotationRuntimeRef.current = null;
      }
      view?.destroy();
    };
  }, [editorViewRef, path, text, theme]);

  useEffect(() => {
    const runtime = annotationRuntimeRef.current;
    if (runtime && line) scrollToLine(runtime.deps, runtime.view, line);
  }, [line]);

  useEffect(() => {
    const runtime = annotationRuntimeRef.current;
    if (!runtime) return;
    runtime.view.dispatch({
      effects: runtime.compartment.reconfigure(
        codeMirrorAnnotationExtensions(
          runtime.deps,
          text,
          annotations,
          (request) => requestAnnotationRef.current?.(request),
        ),
      ),
    });
  }, [annotations, text]);

  return (
    <div ref={containerRef} className="file-preview-code syntax-highlighted" />
  );
}
