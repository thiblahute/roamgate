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
  parseSiteUrl,
  type RenderedFrameMessage,
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
import { useConnectionClient } from "../useConnectionClient";
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
import {
  directoryPreviewName,
  directoryPreviewPath,
  normalizeFilesystemPath,
} from "../filesystemPaths";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
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
  const [codemirror, state, view, searchModule, vimModule] = await Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/search"),
    import("@replit/codemirror-vim"),
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
  };
}

/** `:files` in a preview's Vim keys: each preview registers its handler. */
const previewFilesCommands = new WeakMap<object, () => void>();
/** `:only` in a preview's Vim keys: its Review only mode, as in the review. */
const previewOnlyCommands = new WeakMap<object, () => void>();
let previewExCommandsDefined = false;

function definePreviewExCommands(deps: CodeMirrorPreviewDeps) {
  if (previewExCommandsDefined) return;
  previewExCommandsDefined = true;
  deps.Vim.defineEx("files", "files", (cm) => previewFilesCommands.get(cm)?.());
  deps.Vim.defineEx("only", "only", (cm) => previewOnlyCommands.get(cm)?.());
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
  onShowInReview,
  onReanchorAnnotations,
  rendered: renderedAtLine = false,
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
  onReanchorAnnotations?: (path: string, text: string) => void;
  /**
   * Show in code review: the file (absolute path) in the code review of
   * its checkout, at a line.
   */
  onShowInReview?: (path: string, line?: number) => void;
  /** `line` shown as rendered (Show rendered), not in the source. */
  rendered?: boolean;
}) {
  const connectionClient = useConnectionClient();
  const workspaces = useStoreSelector((state) => state.workspaces);
  const previewSectionRef = useRef<HTMLElement | null>(null);
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
    seen: () => {
      const section = previewSectionRef.current;
      return (
        !!section?.isConnected &&
        (typeof section.checkVisibility !== "function" ||
          section.checkVisibility())
      );
    },
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
    setPreviewMode("rendered");
  }, [entry?.path]);

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
  const frameMessage = useCallback(
    (
      message: Exclude<
        RenderedFrameMessage,
        { type: "ready" | "size" | "stray" | "storage" }
      >,
      box: DOMRect,
      frame: HTMLIFrameElement,
    ) => {
      if (message.type === "clear") {
        setMarkdownSelection(null);
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
  const keysRoot = canComment ? contentElement : null;
  const threadOrder = useMemo(
    () => fileThreadOrder(fileThreads.threads, previewText),
    [fileThreads.threads, previewText],
  );
  const threadsById = useMemo(
    () => new Map(fileThreads.all.map((thread) => [thread.id, thread])),
    [fileThreads.all],
  );
  /** The comments' panel lists every conversation, as the review pane's. */
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
  const unresolvedNav = (
    <>
      <UnresolvedNav
        className="file-preview-unresolved-nav"
        total={threadOrder.filter((thread) => !thread.resolved).length}
        position={unresolvedPosition(threadOrder, cursorThread)}
        openOnly={threadView.openOnly}
        onStep={jumpUnresolved}
        onOpenOnly={threadView.setOpenOnly}
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

  return (
    <section
      ref={previewSectionRef}
      className={`file-preview${zen ? " is-zen" : ""}`}
      aria-label="File preview"
      tabIndex={-1}
      onKeyDown={(e) => {
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
                  treeHidden
                    ? "Show the file tree (:files)"
                    : "Hide the file tree (:files)"
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
                title="Refresh preview (R)"
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
            <span>Changed on disk: R to reload</span>
            <button
              type="button"
              className="file-preview-copy"
              title="Read the file again, where you are in it (R)"
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
              onOpenFile(url);
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
              <div className="file-preview-state is-error">{error}</div>
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
                  onOpenDocument={onOpenFile}
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
                onToggleTree={onToggleTree}
                onToggleOnly={onCreateAnnotation ? toggleZen : undefined}
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
  onToggleTree,
  onToggleOnly,
}: {
  text: string;
  path: string;
  line?: number;
  theme: AppTheme;
  annotations: readonly FileLineReviewAnnotation[];
  editorViewRef: MutableRefObject<CodeMirrorEditorView | null>;
  onRequestAnnotation?: (request: CodeMirrorAnnotationRequest) => void;
  /** `:files`: hides or shows the file tree beside the preview. */
  onToggleTree?: () => void;
  /** `:only`: the preview's Review only mode. */
  onToggleOnly?: () => void;
}) {
  const toggleTreeRef = useRef(onToggleTree);
  toggleTreeRef.current = onToggleTree;
  const toggleOnlyRef = useRef(onToggleOnly);
  toggleOnlyRef.current = onToggleOnly;
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
        previewFilesCommands.set(cm, () => toggleTreeRef.current?.());
        previewOnlyCommands.set(cm, () => toggleOnlyRef.current?.());
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
