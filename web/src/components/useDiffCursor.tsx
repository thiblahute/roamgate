import { getSingularPatch, type SelectedLineRange } from "@pierre/diffs";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clampRow,
  type DiffCursorModel,
  diffCursorModel,
  fileStep,
  filesWithHits,
  hunkStep,
  rowAt,
  rowLine,
  screenRow,
  scrollTarget,
  searchHits,
  stepRows,
  stickyInset,
  wordStep,
} from "../diffCursor";
import { isTypingTarget } from "../inspectorCommands";
import { runKeyCommand, useKeyMachine } from "../keyMachine";
import { reviewKeyRoute } from "../reviewKeys";
import { shortcutMatches } from "../shortcutPreferences";
import { store } from "../store";
import {
  findFile,
  firstNonBlank,
  type Match,
  nextMatch,
  searchRegExp,
  wordAt,
} from "../reviewNavigation";
import type { DiffSurfaceInstance } from "./DiffSurface";

/*
 * The review's Vim cursor in Changes. The cursor moves on rows read from
 * Pierre's hunks (diffCursor.ts), never on the DOM; Pierre draws it
 * (setEditorActiveLine, the Visual lines as its selected lines) and scrolls
 * to it through its line positions. Keys go through the one key machine
 * (keyMachine.ts). With Vim keys on or off (they only change the comment
 * editor); not on an embedded diff, which keeps its own keys and mouse.
 */

/** A file of the diff shown, as the cursor reads it. */
export type DiffCursorSection = {
  key: string;
  path: string;
  /** Its patch, when loaded and drawn as a diff. */
  patch: string | null;
};

/** Where a move leaves the cursor's line on the screen. */
/** The lines kept between a search's hit and the screen's edges. */
const SEARCH_MARGIN_LINES = 3;

/** "reveal": a search's hit, kept clear of the edges (scrollTarget). */
type ScrollTo = "center" | "start" | "end" | "nearest" | "reveal" | "none";

type CursorState = { at: number; col: number; scroll: ScrollTo };

/** How long a go-to request (Files' Review, a thread) is taken. */
export const GO_TO_FRESH_MS = 10_000;

/** Whether a go-to's path (absolute or relative) names a row's path. */
export function goToMatches(wanted: string, rowPath: string): boolean {
  const relative = rowPath.replace(/^\.?\//, "");
  return (
    wanted === rowPath || wanted === relative || wanted.endsWith(`/${relative}`)
  );
}

/** Pierre's parsed patch, read once per patch text. */
const parsedPatches = new Map<string, ReturnType<typeof getSingularPatch>>();
function parsedPatch(patch: string) {
  let parsed = parsedPatches.get(patch);
  if (!parsed) {
    try {
      parsed = getSingularPatch(patch);
    } catch {
      return null;
    }
    // Bounded: the patches of a few views.
    if (parsedPatches.size > 200) parsedPatches.clear();
    parsedPatches.set(patch, parsed);
  }
  return parsed;
}

export type DiffCursor = {
  /** The cursor is on (the review in Changes). */
  active: boolean;
  model: DiffCursorModel;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** A file's Pierre instance, drawn (or gone: null). */
  onInstance: (key: string, instance: DiffSurfaceInstance | null) => void;
  /**
   * A click on a line: puts the cursor there (Shift: a Visual selection
   * from the cursor). True when it was on the cursor's line already, for
   * the comment to open there.
   */
  onLineClick: (
    key: string,
    line: number,
    side: "deletions" | "additions",
    shift: boolean,
  ) => boolean;
  /** The Visual selection's lines in a file, for Pierre to draw. */
  selectionIn: (key: string) => SelectedLineRange | null | undefined;
  /** `/` was pressed: the search prompt is open. */
  searchPrompt: boolean;
  /** Opens the search prompt, as `/` does (Cmd+F in the review). */
  openSearchPrompt: () => void;
  submitSearch: (text: string) => void;
  closeSearchPrompt: () => void;
  /** The search's or the Visual selection's status line, or null. */
  status: ReactNode;
  /** `:N`: row N of all the changes. */
  goToLine: (line: number) => void;
  /** The paths with a search hit, for the tree to mark. */
  matchingPaths: readonly string[];
  /** The line the cursor is on, as a file's line numbers. */
  where: () => CursorWhere | null;
  /** The files the cursor's line, or the Visual selection, touches. */
  selectedPaths: () => string[];
  /** Puts the cursor on a file's line (a thread's, say), scrolling to it. */
  goTo: (key: string, line: number, side: "old" | "new") => boolean;
  /** The cursor's row of the model, and the Visual selection's other end. */
  rowIndex: () => number;
  selection: () => number | null;
  /** Cancels the Visual selection. */
  clearSelection: () => void;
  /** Puts the cursor on a row of the model, scrolling to it. */
  moveTo: (row: number) => void;
  /** `:ask`, `:suggest`: a comment on the cursor's or the `V` lines. */
  comment: (mode: CommentMode) => boolean;
};

/**
 * What a comment key asks: a comment (c, Enter, i, a), a suggestion (s),
 * a new question for the agent (C), or one answered where the line is
 * discussed (`:ask`).
 */
export type CommentMode = "comment" | "suggest" | "new" | "ask";

/** The cursor's line, as the review's anchors name it. */
export type CursorWhere = {
  /** The file's section of the diff. */
  key: string;
  path: string;
  old: number | null;
  new: number | null;
  /** The side the cursor is on: where its comments are written. */
  side: "old" | "new";
};

export function useDiffCursor({
  enabled,
  sections,
  split,
  rootRef,
  onToggleSplit,
  onReload,
  runCommand,
  notify,
  selectionRevision,
  selectedKey,
  onComment,
  threadKey,
  threadMove,
  onMarkFile,
  onScrollTo,
  goTo: lineGoTo = null,
  skipRow,
  revealRow,
  searchElsewhere,
}: {
  enabled: boolean;
  sections: readonly DiffCursorSection[];
  split: boolean;
  rootRef: RefObject<HTMLElement | null>;
  onToggleSplit: () => void;
  onReload?: () => void;
  /**
   * Runs a `:` command of the inspector (`f` and `o` are `:files` and
   * `:only`); false when there is no inspector to run it.
   */
  runCommand: (input: string) => boolean;
  notify: (message: string) => void;
  /** A file picked in the tree: the cursor goes to its first line. */
  selectionRevision: number;
  selectedKey: string | null;
  /**
   * `c`, Enter, `i`, `a` (a comment) and `s` (a suggestion): on the
   * cursor's line, or on the lines selected with `V` in one file. False:
   * there is no way to comment here.
   */
  onComment?: (
    key: string,
    range: SelectedLineRange,
    mode: CommentMode,
  ) => boolean;
  /**
   * The thread keys (gn, gN, gH, g;, gl, za, r, e, dd, u, T, t) of the
   * file's comments, given the line the cursor is on; true when taken.
   */
  threadKey?: (key: string, count: number | null) => boolean;
  /**
   * j / k step into the messages drawn under a line (and the parts of a
   * message) before going to the next line: how many lines are left to
   * move once it stepped, or null when it took no step.
   */
  threadMove?: (direction: 1 | -1, count: number) => number | null;
  /** Option+V (Alt+V): the cursor's file reviewed, or no longer. */
  onMarkFile?: () => void;
  /**
   * Just before the cursor scrolls the diff (zz, zt, zb, a jump): the
   * scroll is the user's, so the view's file anchor follows it rather than
   * putting the files back where they were.
   */
  onScrollTo?: () => void;
  /**
   * Files' Review: the cursor to that file's line (the nearest one shown),
   * once the file is drawn; `at` tells requests apart.
   */
  goTo?: { path: string; line?: number; at: number } | null;
  /** Rows the cursor steps over (a folded reviewed chunk's but its first). */
  skipRow?: (row: number) => boolean;
  /**
   * A search's hit in a row the cursor steps over (a folded reviewed chunk
   * or file): unfolds what hides it, as Vim opens a fold for a search.
   */
  revealRow?: (row: number) => void;
  /**
   * A pattern found nowhere in the view: a file of another of the
   * review's views whose path matches, shown (the commit bar's views);
   * null when none has.
   */
  searchElsewhere?: (pattern: string) => Promise<string | null>;
}): DiffCursor {
  // The same files (keys and patches): the same model, whatever array
  // they came in.
  const shownSections = useRef<readonly DiffCursorSection[]>([]);
  if (
    shownSections.current.length !== sections.length ||
    shownSections.current.some(
      (section, index) =>
        section.key !== sections[index]!.key ||
        section.patch !== sections[index]!.patch,
    )
  )
    shownSections.current = sections;
  const stableSections = shownSections.current;
  const model = useMemo(
    () =>
      diffCursorModel(
        enabled
          ? stableSections.flatMap((section) => {
              const diff = section.patch ? parsedPatch(section.patch) : null;
              return diff
                ? [{ key: section.key, path: section.path, diff }]
                : [];
            })
          : [],
      ),
    [enabled, stableSections],
  );
  const [cursor, setCursorState] = useState<CursorState>({
    at: 0,
    col: 0,
    scroll: "none",
  });
  const [anchor, setAnchor] = useState<number | null>(null);
  const [search, setSearch] = useState<{
    pattern: string;
    wholeWord: boolean;
  } | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  /** The last n / N went round: back at the top, or at the bottom. */
  const [wrapped, setWrapped] = useState<"top" | "bottom" | null>(null);
  const [searchPrompt, setSearchPrompt] = useState(false);
  /** A search that found no line: n / N go file to file by path. */
  const fileSearch = useRef<string | null>(null);
  const wantCol = useRef(0);
  /** Side by side, the side j / k stay on. */
  const splitSide = useRef<"left" | "right">("right");
  const machine = useKeyMachine(["gs"]);
  const instances = useRef(new Map<string, DiffSurfaceInstance>());
  /** The cursor's row as a place, to find it again in a new model. */
  const place = useRef<{
    key: string;
    kind: string;
    old: number | null;
    new: number | null;
  } | null>(null);
  const modelRef = useRef(model);

  const rows = model.rows;
  const at = Math.max(0, Math.min(rows.length - 1, cursor.at));
  const row = rows[at];

  // A new model (a file loaded, a reload): the cursor stays on its line.
  useLayoutEffect(() => {
    if (modelRef.current === model) return;
    modelRef.current = model;
    const was = place.current;
    if (!was) return;
    const found = model.rows.findIndex(
      (each) =>
        each.key === was.key &&
        each.kind === was.kind &&
        each.old === was.old &&
        each.new === was.new,
    );
    setCursorState((current) => ({
      ...current,
      at: found >= 0 ? found : clampRow(model, current.at, null),
      scroll: "none",
    }));
    setAnchor((current) =>
      current === null ? null : clampRow(model, current, null),
    );
  }, [model]);

  useEffect(() => {
    place.current = row
      ? { key: row.key, kind: row.kind, old: row.old, new: row.new }
      : null;
  }, [row]);

  /** Moves the cursor; the line goes to the middle unless told. */
  const skipRowRef = useRef(skipRow);
  skipRowRef.current = skipRow;
  const revealRowRef = useRef(revealRow);
  revealRowRef.current = revealRow;
  const jumpTo = useCallback(
    (
      target: number,
      column?: number,
      scroll: ScrollTo = "center",
      reveal = false,
    ) => {
      const current = modelRef.current;
      if (!current.rows.length) return;
      let next = clampRow(current, target, anchorRef.current);
      // In a folded chunk: on its one line, or past it when the cursor
      // was on that line already. A search's hit there unfolds it.
      const skip = skipRowRef.current;
      if (reveal && skip?.(next) && revealRowRef.current)
        revealRowRef.current(next);
      else if (skip?.(next)) {
        let head = next;
        while (head > 0 && skip(head)) head -= 1;
        let past = next;
        while (past < current.rows.length - 1 && skip(past)) past += 1;
        // Nothing to stop on before it (a folded file first): past it.
        if (skip(head)) next = skip(past) ? next : past;
        else if (cursorRef.current.at === head && next > head)
          next = skip(past) ? head : past;
        else next = head;
      }
      const length = current.rows[next]!.text.length;
      if (column !== undefined) wantCol.current = column;
      const col = Math.max(
        0,
        Math.min(column ?? wantCol.current, Math.max(0, length - 1)),
      );
      const moved = current.rows[next]!;
      if (moved.kind === "-") splitSide.current = "left";
      else if (moved.kind === "+") splitSide.current = "right";
      setCursorState({ at: next, col, scroll });
    },
    [],
  );
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // A file picked in the tree: the cursor on its first line, where shown.
  const lastRevision = useRef(selectionRevision);
  useEffect(() => {
    if (lastRevision.current === selectionRevision) return;
    lastRevision.current = selectionRevision;
    const file = model.files.find((each) => each.key === selectedKey);
    if (file && file.end > file.start) jumpTo(file.start, 0, "none");
  }, [selectionRevision, selectedKey, model, jumpTo]);

  // Files' Review: the file's line, once its rows are in the model.
  // A request a few seconds old is not taken again by a new surface.
  const goToDone = useRef(0);
  useEffect(() => {
    if (!enabled || !lineGoTo || lineGoTo.at === goToDone.current) return;
    if (Date.now() - lineGoTo.at > GO_TO_FRESH_MS) return;
    const rows = model.rows;
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (!goToMatches(lineGoTo.path, row.path)) continue;
      if (lineGoTo.line === undefined) {
        best = index;
        break;
      }
      const line = row.new ?? row.old;
      if (line === null) continue;
      const away = Math.abs(line - lineGoTo.line);
      if (away < distance) {
        distance = away;
        best = index;
      }
    }
    // Once the tree picked the file (its first line, its scroll to the
    // top), the line, centered.
    if (best < 0 || rows[best]!.key !== selectedKey) return;
    goToDone.current = lineGoTo.at;
    const target = best;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => jumpTo(target, 0, "center")),
    );
  }, [enabled, lineGoTo, model, jumpTo, selectedKey, selectionRevision]);

  // ---- Drawing: Pierre's active line and selection, the column ----------

  const shadowOf = useCallback(
    (key: string) =>
      [
        ...(rootRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? []),
      ]
        .find((each) => each.dataset.diffEntryKey === key)
        ?.querySelector("diffs-container")?.shadowRoot ?? null,
    [rootRef],
  );

  const drawCursor = useCallback(() => {
    const current = modelRef.current.rows[cursorRef.current.at];
    for (const [key, instance] of instances.current) {
      if (!enabled || !current || key !== current.key) {
        instance.setEditorActiveLine(null);
        continue;
      }
      const { line, side } = rowLine(
        current,
        splitRef.current ? splitSide.current : "right",
      );
      instance.setEditorActiveLine(line, { side });
    }
  }, [enabled]);
  const cursorRef = useRef(cursor);
  cursorRef.current = { ...cursor, at };
  const splitRef = useRef(split);
  splitRef.current = split;

  /** The column: its word marked on the line, a highlight where possible. */
  const drawColumn = useCallback(() => {
    const current = modelRef.current.rows[cursorRef.current.at];
    const root = rootRef.current;
    if (!root) return;
    for (const element of root.querySelectorAll<HTMLElement>(
      "[data-diff-entry-key]",
    )) {
      const shadow =
        element.querySelector("diffs-container")?.shadowRoot ?? null;
      for (const marked of shadow?.querySelectorAll<HTMLElement>(
        "[data-cursor-col]",
      ) ?? [])
        marked.removeAttribute("data-cursor-col");
    }
    if (!enabled || !current) return;
    const shadow = shadowOf(current.key);
    const line = shadow?.querySelector<HTMLElement>(
      "[data-line][data-editor-active-line]",
    );
    if (!line) return;
    const col = cursorRef.current.col;
    const word = wordAt(current.text, col);
    line.setAttribute(
      "data-cursor-col",
      word && word.start <= col && col < word.end
        ? `${word.start}:${word.word}`
        : `${col}:`,
    );
    drawColumnHighlight(line, col);
  }, [enabled, rootRef, shadowOf]);

  useLayoutEffect(() => {
    void cursor;
    void split;
    drawCursor();
    // Pierre draws the active line on its next render pass.
    const frame = requestAnimationFrame(drawColumn);
    const timer = setTimeout(drawColumn, 30);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [cursor, split, model, drawCursor, drawColumn]);

  const drawColumnRef = useRef(drawColumn);
  drawColumnRef.current = drawColumn;
  const onInstance = useCallback(
    (key: string, instance: DiffSurfaceInstance | null) => {
      if (instance) {
        instances.current.set(key, instance);
        const current = modelRef.current.rows[cursorRef.current.at];
        if (enabled && current?.key === key) {
          const { line, side } = rowLine(
            current,
            splitRef.current ? splitSide.current : "right",
          );
          instance.setEditorActiveLine(line, { side });
          // Drawn again (a chunk folded, say): the column with it.
          requestAnimationFrame(() => drawColumnRef.current());
        }
      } else instances.current.delete(key);
    },
    [enabled],
  );

  // ---- The screen --------------------------------------------------------

  const scroller = useCallback(
    () =>
      rootRef.current?.querySelector<HTMLElement>(".pierre-diff-scroll") ??
      null,
    [rootRef],
  );

  /** Where each file's drawing starts in the scroller's content. */
  const fileTops = useCallback((): Map<string, number> => {
    const tops = new Map<string, number>();
    const box = scroller();
    if (!box) return tops;
    const boxTop = box.getBoundingClientRect().top - box.scrollTop;
    for (const section of rootRef.current?.querySelectorAll<HTMLElement>(
      "[data-diff-entry-key]",
    ) ?? []) {
      const surface = section.querySelector<HTMLElement>(
        ".pierre-diff-surface",
      );
      if (surface && section.dataset.diffEntryKey)
        tops.set(
          section.dataset.diffEntryKey,
          surface.getBoundingClientRect().top - boxTop,
        );
    }
    return tops;
  }, [rootRef, scroller]);

  /** A row's top and height in the scroller's content, or null. */
  const rowBox = useCallback(
    (
      index: number,
      tops: Map<string, number> = fileTops(),
    ): { top: number; height: number } | null => {
      const current = modelRef.current.rows[index];
      const fileTop = current ? tops.get(current.key) : undefined;
      if (!current || fileTop === undefined) return null;
      const { line, side } = rowLine(
        current,
        splitRef.current ? splitSide.current : "right",
      );
      // Under the Virtualizer, Pierre's files are VirtualizedFileDiffs.
      const position = (
        instances.current.get(current.key) as
          | {
              getLinePosition?: (
                line: number,
                side?: "deletions" | "additions",
              ) => { top: number; height: number } | undefined;
            }
          | undefined
      )?.getLinePosition?.(line, side);
      if (!position) return null;
      return { top: fileTop + position.top, height: position.height };
    },
    [fileTops],
  );

  /** The rows fully on the screen, top to bottom. */
  const visibleRows = useCallback((): number[] => {
    const box = scroller();
    if (!box) return [];
    const top = box.scrollTop;
    const bottom = top + box.clientHeight;
    const tops = fileTops();
    const current = modelRef.current;
    const found: number[] = [];
    const seen = new Set<number>();
    current.files.forEach((file, index) => {
      // Only the files that reach the screen.
      const start = tops.get(file.key);
      const next = current.files[index + 1];
      const end = next ? tops.get(next.key) : undefined;
      if (start === undefined || start > bottom) return;
      if (end !== undefined && end < top) return;
      for (let at = file.start; at < file.end; at++) {
        const place = rowBox(at, tops);
        if (!place) continue;
        if (place.top < top - 1 || place.top + place.height > bottom + 1)
          continue;
        // Side by side, a drawn line once.
        if (seen.has(Math.round(place.top))) continue;
        seen.add(Math.round(place.top));
        found.push(at);
      }
    });
    return found;
  }, [fileTops, rowBox, scroller]);

  const onScrollToRef = useRef(onScrollTo);
  onScrollToRef.current = onScrollTo;
  /** What stays stuck atop the scroller over a row's file: its header. */
  const insetFor = useCallback(
    (index: number): number => {
      const box = scroller();
      const key = modelRef.current.rows[index]?.key;
      if (!box || key === undefined) return 0;
      const section =
        [
          ...(rootRef.current?.querySelectorAll<HTMLElement>(
            "[data-diff-entry-key]",
          ) ?? []),
        ].find((each) => each.dataset.diffEntryKey === key) ?? null;
      return stickyInset(box, section);
    },
    [rootRef, scroller],
  );
  const scrollToRow = useCallback(
    (index: number, mode: ScrollTo) => {
      if (mode === "none") return;
      const box = scroller();
      const place = rowBox(index);
      if (!box || !place) return;
      const next = scrollTarget(
        place,
        { top: box.scrollTop, height: box.clientHeight },
        mode,
        insetFor(index),
        SEARCH_MARGIN_LINES * place.height,
      );
      if (next === null) return;
      onScrollToRef.current?.();
      box.scrollTo({ top: next });
    },
    [insetFor, rowBox, scroller],
  );

  /**
   * Once drawn, the cursor's line where it really is (Pierre's positions
   * do not know what a fold hides): put clear of the stuck header again
   * when it is not.
   */
  const settleRow = useCallback(
    (index: number, mode: ScrollTo) => {
      if (mode === "none") return;
      const box = scroller();
      const current = modelRef.current.rows[index];
      if (!box || !current || cursorRef.current.at !== index) return;
      const line = shadowOf(current.key)?.querySelector<HTMLElement>(
        "[data-line][data-editor-active-line]",
      );
      if (!line) return;
      const drawn = line.getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      if (!drawn.height || !frame.height) return;
      const next = scrollTarget(
        {
          top: box.scrollTop + drawn.top - frame.top,
          height: drawn.height,
        },
        { top: box.scrollTop, height: box.clientHeight },
        mode === "reveal" ? "reveal" : "nearest",
        insetFor(index),
        SEARCH_MARGIN_LINES * drawn.height,
      );
      if (next === null) return;
      onScrollToRef.current?.();
      box.scrollTo({ top: next });
    },
    [insetFor, scroller, shadowOf],
  );

  useEffect(() => {
    if (!enabled) return;
    scrollToRow(at, cursor.scroll);
    if (cursor.scroll === "none") return;
    const mode = cursor.scroll;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => settleRow(at, mode));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [enabled, at, cursor, scrollToRow, settleRow]);

  // ---- Search -----------------------------------------------------------

  const hits = useMemo(
    () => (search ? searchHits(model, search.pattern, search.wholeWord) : []),
    [model, search],
  );

  // Every hit drawn on the screen marked, the cursor's (the current one)
  // more strongly: Pierre's lines are in shadow roots, so with the CSS
  // Custom Highlight API. Drawn again as Pierre draws rows on a scroll.
  const searchRef = useRef(search);
  searchRef.current = search;
  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const drawSearch = useCallback(() => {
    const registry = highlightRegistry();
    if (!registry) return;
    const shown = enabled ? searchRef.current : null;
    const regexp = shown ? searchRegExp(shown.pattern, shown.wholeWord) : null;
    const root = rootRef.current;
    if (!regexp || !root) {
      registry.delete(SEARCH_HIGHLIGHT);
      registry.delete(SEARCH_CURRENT_HIGHLIGHT);
      return;
    }
    const all: Range[] = [];
    for (const section of root.querySelectorAll<HTMLElement>(
      "[data-diff-entry-key]",
    ))
      for (const line of section
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []) {
        const text = line.textContent ?? "";
        regexp.lastIndex = 0;
        for (const match of text.matchAll(regexp)) {
          if (!match[0]) break;
          const range = textRange(line, match.index!, match[0].length);
          if (range) all.push(range);
        }
      }
    const current: Range[] = [];
    const at = cursorRef.current.at;
    const hit = hitsRef.current.find(
      (each) => each.at === at && each.start === cursorRef.current.col,
    );
    const row = modelRef.current.rows[at];
    if (hit && row && hit.end > hit.start)
      for (const line of shadowOf(row.key)?.querySelectorAll<HTMLElement>(
        "[data-line][data-editor-active-line]",
      ) ?? []) {
        const range = textRange(line, hit.start, hit.end - hit.start);
        if (range) current.push(range);
      }
    setHighlight(registry, SEARCH_HIGHLIGHT, all, 0);
    setHighlight(registry, SEARCH_CURRENT_HIGHLIGHT, current, 1);
  }, [enabled, rootRef, shadowOf]);
  useLayoutEffect(() => {
    void cursor;
    void hits;
    void split;
    drawSearch();
    const frame = requestAnimationFrame(drawSearch);
    const timer = setTimeout(drawSearch, 60);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [cursor, hits, split, drawSearch]);
  useEffect(() => {
    if (!search) return;
    const box = scroller();
    if (!box) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = requestAnimationFrame(drawSearch);
      timer = setTimeout(drawSearch, 120);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [search, scroller, drawSearch]);
  useEffect(
    () => () => {
      highlightRegistry()?.delete(SEARCH_HIGHLIGHT);
      highlightRegistry()?.delete(SEARCH_CURRENT_HIGHLIGHT);
    },
    [],
  );

  useEffect(() => {
    if (!notFound) return;
    const timer = setTimeout(() => setNotFound(null), 4000);
    return () => clearTimeout(timer);
  }, [notFound]);

  const searchFile = (pattern: string, direction: 1 | -1): boolean => {
    const index = findFile(
      model.files.map((file) => file.path),
      pattern,
      model.rows[at]?.file ?? -1,
      direction,
    );
    const file = model.files[index];
    if (index < 0 || !file) return false;
    jumpTo(file.start, 0);
    notify(`File ${file.path}`);
    return true;
  };

  const runSearch = (
    pattern: string,
    wholeWord: boolean,
    direction: 1 | -1,
  ) => {
    fileSearch.current = null;
    const found = searchHits(model, pattern, wholeWord);
    if (!found.length) {
      setSearch(null);
      if (searchFile(pattern, direction)) fileSearch.current = pattern;
      else if (searchElsewhere)
        void searchElsewhere(pattern).then((path) => {
          if (path) fileSearch.current = pattern;
          else setNotFound(pattern);
        });
      else setNotFound(pattern);
      return;
    }
    setNotFound(null);
    setSearch({ pattern, wholeWord });
    goToHit(found, direction);
  };

  /** The next hit, its fold opened, clear of the edges; a wrap told. */
  const goToHit = (found: readonly Match[], direction: 1 | -1) => {
    const step = nextMatch(found, { at, col: cursor.col }, direction);
    if (!step) return;
    const wrap =
      step.wrapped && found.length > 1
        ? direction === 1
          ? "top"
          : "bottom"
        : null;
    setWrapped(wrap);
    if (wrap)
      notify(
        wrap === "top"
          ? "Search hit the bottom, continuing at the top"
          : "Search hit the top, continuing at the bottom",
      );
    jumpTo(step.hit.at, step.hit.start, "reveal", true);
  };

  const repeatSearch = (direction: 1 | -1) => {
    if (fileSearch.current) {
      searchFile(fileSearch.current, direction);
      return;
    }
    goToHit(hits, direction);
  };

  // ---- Keys -------------------------------------------------------------

  const halfScreen = () => Math.max(1, Math.floor(visibleRows().length / 2));

  const handle = (key: string, count: number | null): boolean => {
    const n = count ?? 1;
    // Side by side, j / k go on with the side the cursor is on (an
    // unchanged line: the side it came from).
    if (row?.kind === "-") splitSide.current = "left";
    else if (row?.kind === "+") splitSide.current = "right";
    const side = split ? splitSide.current : null;
    switch (key) {
      case "j":
      case "ArrowDown":
      case "k":
      case "ArrowUp": {
        const way = key === "j" || key === "ArrowDown" ? 1 : -1;
        const rest = threadMove ? threadMove(way, n) : null;
        if (rest === 0) return true;
        jumpTo(
          stepRows(model, at, way * (rest ?? n), side),
          undefined,
          "nearest",
        );
        return true;
      }
      case "J":
      case "K":
        jumpTo(stepRows(model, at, (key === "J" ? 10 : -10) * n, side));
        return true;
      case "gg":
        jumpTo(count ? count - 1 : 0, 0, "start");
        return true;
      case "G":
        if (count) jumpTo(count - 1, 0);
        else jumpTo(rows.length - 1, 0, "end");
        return true;
      case "Home":
        jumpTo(0, 0, "start");
        return true;
      case "End":
        jumpTo(rows.length - 1, 0, "end");
        return true;
      case "PageDown":
        jumpTo(at + 2 * halfScreen());
        return true;
      case "PageUp":
        jumpTo(at - 2 * halfScreen());
        return true;
      case "H":
      case "M":
      case "L": {
        const target = screenRow(visibleRows(), key, n);
        if (target !== null) jumpTo(target, undefined, "nearest");
        return true;
      }
      case "zz":
      case "z.":
      case "zt":
      case "zb":
        // A message j / k are on is placed itself, else the cursor's row.
        if (threadKey?.(key, count)) return true;
        scrollToRow(
          at,
          key === "zt" ? "start" : key === "zb" ? "end" : "center",
        );
        return true;
      case "}":
      case "{": {
        const target = hunkStep(model, at, key === "}" ? 1 : -1, n);
        jumpTo(target, firstNonBlank(model.rows[target]?.text ?? ""));
        return true;
      }
      case "]":
      case "[": {
        const target = fileStep(model, at, key === "]" ? n : -n);
        if (target !== null) jumpTo(target, 0);
        return true;
      }
      case "w":
      case "W":
      case "b":
      case "B":
      case "E": {
        const next = wordStep(
          model,
          { at, col: cursor.col },
          key.toLowerCase() as "w" | "b" | "e",
          n,
        );
        jumpTo(next.at, next.col, next.at === at ? "none" : "nearest");
        return true;
      }
      case "h":
        jumpTo(at, Math.max(0, cursor.col - n), "none");
        return true;
      case "l":
        jumpTo(at, cursor.col + n, "none");
        return true;
      case "ArrowLeft":
      case "ArrowRight": {
        // As h / l; side by side, from a line's start (Left) or end
        // (Right), on to the line facing it on the other side.
        const left = key === "ArrowLeft";
        const last = Math.max(0, (row?.text.length ?? 1) - 1);
        const pair =
          split && (left ? cursor.col <= 0 : cursor.col >= last)
            ? model.splitLines.find(
                (line) => line.left === at || line.right === at,
              )
            : undefined;
        const other = left ? pair?.left : pair?.right;
        if (other !== null && other !== undefined && other !== at) {
          splitSide.current = left ? "left" : "right";
          jumpTo(
            other,
            left ? Math.max(0, (rows[other]?.text.length ?? 1) - 1) : 0,
            "none",
          );
        } else
          jumpTo(
            at,
            left ? Math.max(0, cursor.col - n) : cursor.col + n,
            "none",
          );
        return true;
      }
      case "0":
        jumpTo(at, 0, "none");
        return true;
      case "^":
        jumpTo(at, firstNonBlank(model.rows[at]?.text ?? ""), "none");
        return true;
      case "$":
        jumpTo(at, Math.max(0, (row?.text.length ?? 1) - 1), "none");
        return true;
      case "*":
      case "#": {
        const word = wordAt(row?.text ?? "", cursor.col);
        if (word) runSearch(word.word, true, key === "*" ? 1 : -1);
        return true;
      }
      case "n":
      case "N":
        // No search going: n / N go thread to thread, as in the review.
        if (!search && !fileSearch.current)
          return threadKey ? threadKey(key, count) : false;
        repeatSearch(key === "n" ? 1 : -1);
        return true;
      case "/":
        setSearchPrompt(true);
        return true;
      case "V":
        setAnchor((current) => (current === null ? at : null));
        return true;
      case "S":
        onToggleSplit();
        return true;
      case "R":
      case "gr":
        if (!onReload) return false;
        onReload();
        return true;
      case "c":
      case "C":
      case "Enter":
      case "i":
      case "a":
      case "s":
        return commentHere(
          key === "s" ? "suggest" : key === "C" ? "new" : "comment",
        );
      case "f":
        return runCommand("files");
      case "o":
        return runCommand("only");
      case "p":
        return runCommand("repo");
      case "(":
        return runCommand("prevrepo");
      case ")":
        return runCommand("nextrepo");
      case "Escape":
        if (anchor !== null) setAnchor(null);
        else if (search || fileSearch.current) {
          setSearch(null);
          fileSearch.current = null;
        } else return threadKey ? threadKey(key, count) : false;
        return true;
      default:
        return threadKey ? threadKey(key, count) : false;
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!enabled || event.defaultPrevented || !rows.length) return;
    if (isTypingTarget(event.target) || searchPrompt) return;
    // The app's shortcuts that reach past the review (its toggles, the
    // sidebar, the overlay tab) and those leaving for another workspace,
    // tab or pane go to the app (reviewKeys.ts).
    if (
      reviewKeyRoute(
        (id) => shortcutMatches(event.nativeEvent, id),
        store.get().overlayOpen,
      ) !== "review"
    ) {
      machine.reset();
      return;
    }
    // Option+V (Alt+V): read by the key's code, as a Mac types "√".
    if (
      onMarkFile &&
      event.altKey &&
      event.code === "KeyV" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      machine.reset();
      onMarkFile();
      return;
    }
    if (event.metaKey || event.altKey) return;
    if (event.ctrlKey) {
      const half = halfScreen();
      const deltas: Record<string, number> = {
        d: half,
        u: -half,
        f: 2 * half,
        b: -2 * half,
        j: 2 * half,
        k: -2 * half,
        e: 1,
        y: -1,
      };
      const delta = deltas[event.key];
      if (delta === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      machine.reset();
      jumpTo(at + delta);
      return;
    }
    // Tab / Shift+Tab: the next or previous message, as n / N with no
    // search; left to the page when there is none.
    if (event.key === "Tab") {
      if (threadKey?.(event.shiftKey ? "S-Tab" : "Tab", null)) {
        event.preventDefault();
        event.stopPropagation();
        machine.reset();
      }
      return;
    }
    const result = machine.feed(event.key);
    if (result.type === "wait") {
      if (event.key.length === 1) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (runKeyCommand(result, handle)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onLineClick = (
    key: string,
    line: number,
    side: "deletions" | "additions",
    shift: boolean,
  ): boolean => {
    if (!enabled) return false;
    const target = rowAt(model, key, line, side);
    if (target < 0) return false;
    splitSide.current = side === "deletions" ? "left" : "right";
    if (shift) {
      setAnchor((current) => current ?? at);
      jumpTo(target, undefined, "none");
      return false;
    }
    const again = target === at && anchor === null;
    setAnchor(null);
    jumpTo(target, undefined, "none");
    return again;
  };

  /** A comment on the cursor's line or the selection's; true when opened. */
  const commentHere = (mode: CommentMode): boolean => {
    if (!onComment) return false;
    const range = selectedRange();
    if (!range) return false;
    const opened = onComment(range.key, range.range, mode);
    if (opened) setAnchor(null);
    return opened;
  };

  /**
   * The lines a comment would be on: the cursor's, or the selection's in
   * its first file; into another file (a Shift+click there), it ends at
   * that one's end. The highlight shows the same lines.
   */
  const selectedRange = (): {
    key: string;
    range: SelectedLineRange;
  } | null => {
    const first = Math.min(at, anchor ?? at);
    let last = Math.max(at, anchor ?? at);
    const from = rows[first];
    if (!from || !rows[last]) return null;
    while (rows[last]!.key !== from.key) last--;
    const to = rows[last]!;
    const start = rowLine(from, from.kind === "-" ? "left" : "right");
    const end = rowLine(to, to.kind === "-" ? "left" : "right");
    return {
      key: from.key,
      range: {
        start: start.line,
        side: start.side,
        end: end.line,
        endSide: end.side,
      },
    };
  };

  const where = (): CursorWhere | null => {
    const here = rows[at];
    if (!here) return null;
    return {
      key: here.key,
      path: here.path,
      old: here.old,
      new: here.new,
      side:
        here.kind === "-" || (split && splitSide.current === "left")
          ? "old"
          : "new",
    };
  };

  const selectedPaths = (): string[] => {
    const last = rows[at];
    if (!last) return [];
    const lo = Math.min(at, anchor ?? at);
    const hi = Math.max(at, anchor ?? at);
    return [...new Set(rows.slice(lo, hi + 1).map((each) => each.path))];
  };

  const goTo = (key: string, line: number, side: "old" | "new"): boolean => {
    const target = rowAt(
      modelRef.current,
      key,
      line,
      side === "old" ? "deletions" : "additions",
    );
    if (target < 0) return false;
    setAnchor(null);
    jumpTo(target, 0, "center");
    return true;
  };

  const selectionIn = (key: string): SelectedLineRange | null | undefined => {
    if (!enabled) return undefined;
    if (anchor === null) return null;
    const selected = selectedRange();
    return selected?.key === key ? selected.range : null;
  };

  const matchingPaths = useMemo(
    () => filesWithHits(model, hits),
    [model, hits],
  );
  const current = search
    ? hits.findIndex((hit: Match) => hit.at === at && hit.start === cursor.col)
    : -1;
  /** Files listed but not drawn (not read yet, or closed): not searched. */
  const unread = search
    ? stableSections.filter((section) => !section.patch).length
    : 0;
  const status: ReactNode = search ? (
    <>
      <span className="diff-cursor-label">
        {search.wholeWord ? "Word " : "Search "}
      </span>
      <mark>{search.pattern}</mark>
      {`  match ${current + 1 || "-"} of ${hits.length}${search.wholeWord ? " (whole word)" : ""}${wrapped && current >= 0 ? ` · wrapped to the ${wrapped}` : ""}${unread ? ` · ${unread} file${unread === 1 ? "" : "s"} not read yet, not searched` : ""} · n / N next / previous · Esc clears`}
    </>
  ) : notFound ? (
    <>
      <span className="diff-cursor-label">Pattern not found: </span>
      <mark>{notFound}</mark>
    </>
  ) : anchor !== null ? (
    <>
      <span className="diff-cursor-label">-- VISUAL LINE -- </span>
      {`${Math.abs(at - anchor) + 1} line${Math.abs(at - anchor) === 0 ? "" : "s"} · Esc cancels`}
    </>
  ) : null;

  return {
    active: enabled && rows.length > 0,
    model,
    onKeyDown,
    onInstance,
    onLineClick,
    selectionIn,
    searchPrompt,
    openSearchPrompt: () => setSearchPrompt(true),
    submitSearch: (text) => {
      setSearchPrompt(false);
      if (text) runSearch(text, false, 1);
    },
    closeSearchPrompt: () => setSearchPrompt(false),
    status: enabled ? status : null,
    goToLine: (line) => jumpTo(line - 1, 0),
    matchingPaths,
    where,
    selectedPaths,
    goTo,
    rowIndex: () => at,
    selection: () => anchor,
    clearSelection: () => setAnchor(null),
    moveTo: (row) => jumpTo(row, undefined, "center"),
    comment: commentHere,
  };
}

const SEARCH_HIGHLIGHT = "roamgate-diff-search";
const SEARCH_CURRENT_HIGHLIGHT = "roamgate-diff-search-current";

type HighlightRegistry = Map<string, unknown>;
type HighlightClass = new (...ranges: Range[]) => { priority: number };

/** The page's CSS highlights, where the browser has them. */
function highlightRegistry(): HighlightRegistry | null {
  return (
    (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
      ?.highlights ?? null
  );
}

function setHighlight(
  registry: HighlightRegistry,
  name: string,
  ranges: Range[],
  priority: number,
) {
  const Highlight = (globalThis as { Highlight?: HighlightClass }).Highlight;
  if (!Highlight || !ranges.length) {
    registry.delete(name);
    return;
  }
  const highlight = new Highlight(...ranges);
  highlight.priority = priority;
  registry.set(name, highlight);
}

/** The range of `length` characters from `start` in a drawn line's text. */
function textRange(
  line: HTMLElement,
  start: number,
  length: number,
): Range | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let range: Range | null = null;
  const end = start + length;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const size = node.textContent?.length ?? 0;
    if (!range && start < offset + size) {
      range = document.createRange();
      range.setStart(node, start - offset);
    }
    if (range && end <= offset + size) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += size;
  }
  return null;
}

/**
 * The cursor's column in the line, drawn with the CSS Custom Highlight API
 * where the browser has it (Pierre's lines are in a shadow root: no element
 * of ours can go in them).
 */
function drawColumnHighlight(line: HTMLElement, col: number) {
  const registry = (
    globalThis as {
      CSS?: { highlights?: Map<string, unknown> };
      Highlight?: new (...ranges: Range[]) => unknown;
    }
  ).CSS?.highlights;
  const Highlight = (
    globalThis as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;
  if (!registry || !Highlight) return;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (col < offset + length) {
      const range = document.createRange();
      range.setStart(node, col - offset);
      range.setEnd(node, col - offset + 1);
      const highlight = new Highlight(range) as { priority?: number };
      // Over the search's marks.
      highlight.priority = 2;
      registry.set("roamgate-diff-cursor", highlight);
      return;
    }
    offset += length;
  }
  registry.delete("roamgate-diff-cursor");
}
