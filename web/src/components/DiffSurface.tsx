import {
  DEFAULT_THEMES,
  getSingularPatch,
  type FileDiff as PierreFileDiff,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  FileDiff,
  Virtualizer,
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import {
  Component,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { diffSyntaxLanguageForPath } from "./diffSyntaxHighlighting";

/**
 * The Pierre diff surface: what draws a file's patch, shared by every view
 * that shows a diff (Changes, Commits, Files' file changes). It only draws;
 * the views keep their own state and give it the patch, the options, the
 * comments under lines and what a line selection does.
 */

/** Something drawn under a line of one side of the diff. */
export type DiffSurfaceAnnotation = {
  side: "old" | "new";
  line: number;
};

export type DiffSurfaceOptions = NonNullable<
  ComponentProps<typeof FileDiff<DiffSurfaceAnnotation>>["options"]
>;

/** Pierre's own instance of a drawn file (cursor, scrolling, expansion). */
export type DiffSurfaceInstance = PierreFileDiff<DiffSurfaceAnnotation>;

const DIFF_WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  poolSize: Math.min(
    Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
    globalThis.matchMedia?.("(pointer: coarse)")?.matches ? 1 : 2,
  ),
  totalASTLRUCacheSize: 8,
  workerFactory: () =>
    new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
      type: "module",
    }),
};
const DIFF_HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: DEFAULT_THEMES,
  preferredHighlighter: "shiki-wasm",
};
const DIFF_SELECTION_CSS = `
  [data-line][data-selected-line] {
    background-color: color-mix(
      in srgb,
      var(--diffs-selection-base) 32%,
      var(--diffs-computed-diff-line-bg)
    ) !important;
    box-shadow: inset 3px 0 0 var(--diffs-selection-base);
  }
  [data-column-number][data-selected-line] {
    background-color: color-mix(
      in srgb,
      var(--diffs-selection-base) 46%,
      var(--diffs-bg)
    ) !important;
    color: var(--diffs-fg) !important;
    font-weight: 800;
  }
  [data-line][data-selected-line="first"] {
    border-top: 1px solid var(--diffs-selection-base);
  }
  [data-line][data-selected-line="last"] {
    border-bottom: 1px solid var(--diffs-selection-base);
  }
  [data-line][data-selected-line="single"] {
    border-block: 1px solid var(--diffs-selection-base);
  }
  [data-line][data-editor-active-line] {
    background-color: color-mix(
      in srgb,
      var(--diffs-selection-base) 18%,
      var(--diffs-computed-diff-line-bg)
    ) !important;
    box-shadow: inset 2px 0 0 var(--diffs-selection-base);
  }
  [data-column-number][data-editor-active-line] {
    color: var(--diffs-fg) !important;
    font-weight: 800;
  }
  ::highlight(roamgate-diff-cursor) {
    background-color: var(--diffs-selection-base);
    color: var(--diffs-bg);
  }
`;

/** The options every diff view draws with: its layout, wrap and theme. */
export function diffSurfaceOptions({
  diffStyle,
  wrap,
  themeType,
  onPostRender,
}: {
  diffStyle: "split" | "unified";
  wrap: boolean;
  themeType: "dark" | "light";
  onPostRender?: DiffSurfaceOptions["onPostRender"];
}): DiffSurfaceOptions {
  return {
    theme: DEFAULT_THEMES,
    themeType,
    diffStyle,
    overflow: wrap ? "wrap" : "scroll",
    disableFileHeader: true,
    stickyHeader: false,
    diffIndicators: "bars",
    hunkSeparators: "line-info-basic",
    lineDiffType: "word-alt",
    maxLineDiffLength: 2_000,
    tokenizeMaxLineLength: 4_000,
    tokenizeMaxLength: 250_000,
    preferredHighlighter: "shiki-wasm",
    unsafeCSS: DIFF_SELECTION_CSS,
    ...(onPostRender ? { onPostRender } : {}),
  };
}

/**
 * The scrolling list the files' surfaces are drawn in: Pierre virtualizes
 * the rows of every file in it and highlights them in its workers.
 */
export function DiffSurfaceScroll({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <WorkerPoolContextProvider
      poolOptions={DIFF_WORKER_POOL_OPTIONS}
      highlighterOptions={DIFF_HIGHLIGHTER_OPTIONS}
    >
      <Virtualizer
        className={className}
        contentClassName="pierre-diff-scroll-content"
      >
        {children}
      </Virtualizer>
    </WorkerPoolContextProvider>
  );
}

let nextPatchCacheKey = 0;

export function highlightedPatch(patch: string, path: string) {
  const diff = getSingularPatch(patch);
  // Pierre 1.4 no longer assigns keys; each parsed patch needs its own worker cache entry.
  diff.cacheKey = `patch:${++nextPatchCacheKey}`;
  const language = diffSyntaxLanguageForPath(path);
  // Pierre applies lang to both sides; let it infer each side of a language-changing rename.
  if (!diff.prevName || diffSyntaxLanguageForPath(diff.prevName) === language)
    diff.lang = language;
  return diff;
}

class DiffRenderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function RawPatch({ patch }: { patch: string }) {
  return <pre className="diff-raw-patch">{patch}</pre>;
}

function HighlightedPatch({
  patch,
  path,
  transformDiff,
  ...props
}: Omit<ComponentProps<typeof FileDiff<DiffSurfaceAnnotation>>, "fileDiff"> & {
  patch: string;
  path: string;
  transformDiff?: (diff: FileDiffMetadata) => FileDiffMetadata;
}) {
  const fileDiff = useMemo(() => {
    const diff = highlightedPatch(patch, path);
    return transformDiff ? transformDiff(diff) : diff;
  }, [patch, path, transformDiff]);
  return <FileDiff<DiffSurfaceAnnotation> {...props} fileDiff={fileDiff} />;
}

export type DiffSurfaceProps<A extends DiffSurfaceAnnotation> = {
  patch: string;
  path: string;
  options: DiffSurfaceOptions;
  /** Drawn under their lines by `renderAnnotation`. */
  annotations?: readonly A[];
  renderAnnotation?: (annotation: A) => ReactNode;
  /**
   * Line selection is on when given: called with the lines a drag (or a
   * click on a line number) ended on. The selection stays drawn while
   * `selectionActive`, or until this returns false.
   */
  onSelectLines?: (range: SelectedLineRange | null) => boolean;
  selectionActive?: boolean;
  /** What Pierre is given, from the parsed patch (default: the patch). */
  transformDiff?: (diff: FileDiffMetadata) => FileDiffMetadata;
  /** Called after each render with the drawn rows' element. */
  decorate?: (node: HTMLElement, instance: DiffSurfaceInstance) => void;
  /** Pierre's instance while it is drawn, null once it is gone. */
  onInstance?: (instance: DiffSurfaceInstance | null) => void;
  /** A click on a line's text: its number and side. */
  onLineClick?: (
    line: number,
    side: "deletions" | "additions",
    event: PointerEvent,
  ) => void;
  /**
   * The lines drawn selected, set by the view (a Visual selection): over
   * a drag's selection while given (null: none).
   */
  selectedLines?: SelectedLineRange | null;
};

/**
 * A file's patch drawn by Pierre, or shown raw when Pierre cannot read it.
 * Remounted on a new patch: the renderer's line cache realigns against
 * edited documents and can index out of range when a reloaded diff
 * replaces the whole patch.
 */
export function DiffSurface<A extends DiffSurfaceAnnotation>({
  patch,
  path,
  options,
  annotations,
  renderAnnotation,
  onSelectLines,
  selectionActive = false,
  transformDiff,
  decorate,
  onInstance,
  onLineClick,
  selectedLines: viewSelection,
}: DiffSurfaceProps<A>) {
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(
    null,
  );
  const surfaceOptions = useMemo<DiffSurfaceOptions>(() => {
    const onPostRender = options.onPostRender;
    return {
      ...options,
      lineHoverHighlight: onSelectLines ? "number" : "disabled",
      enableLineSelection: Boolean(onSelectLines),
      controlledSelection: Boolean(onSelectLines),
      onLineSelectionStart: onSelectLines ? setSelectedLines : undefined,
      onLineSelectionChange: onSelectLines ? setSelectedLines : undefined,
      onLineSelectionEnd: onSelectLines
        ? (range) => {
            if (!onSelectLines(range)) setSelectedLines(null);
          }
        : undefined,
      ...(onLineClick
        ? {
            onLineClick: ({ lineNumber, annotationSide, event }) =>
              onLineClick(lineNumber, annotationSide, event),
          }
        : {}),
      ...(decorate || onInstance
        ? {
            onPostRender: (node, instance, phase) => {
              onPostRender?.(node, instance, phase);
              if (phase === "unmount") {
                onInstance?.(null);
                return;
              }
              onInstance?.(instance);
              decorate?.(node, instance);
            },
          }
        : {}),
    };
  }, [decorate, onInstance, onLineClick, onSelectLines, options]);
  useEffect(() => {
    if (!selectionActive) setSelectedLines(null);
  }, [selectionActive]);
  const pierreAnnotations = useMemo(
    () =>
      (annotations ?? []).map((annotation) => ({
        side:
          annotation.side === "old"
            ? ("deletions" as const)
            : ("additions" as const),
        lineNumber: annotation.line,
        metadata: annotation,
      })),
    [annotations],
  );
  return (
    <div className="pierre-diff-surface">
      <DiffRenderBoundary
        fallback={<RawPatch patch={patch} />}
        resetKey={patch}
      >
        <HighlightedPatch
          key={patch}
          patch={patch}
          path={path}
          transformDiff={transformDiff}
          options={surfaceOptions}
          lineAnnotations={pierreAnnotations}
          selectedLines={
            viewSelection !== undefined
              ? viewSelection
              : onSelectLines
                ? selectedLines
                : undefined
          }
          renderAnnotation={
            renderAnnotation
              ? ({ metadata }) => renderAnnotation(metadata as A)
              : undefined
          }
        />
      </DiffRenderBoundary>
    </div>
  );
}
