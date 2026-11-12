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
  firstColumn,
  hunkStep,
  rowAt,
  rowLine,
  screenRow,
  searchFileStep,
  searchHits,
  searchStep,
  stepRows,
  wordStep,
} from "../diffCursor";
import { isTypingTarget } from "../inspectorCommands";
import { runKeyCommand, useKeyMachine } from "../keyMachine";
import { type Match, wordAt } from "../reviewNavigation";
import type { DiffSurfaceInstance } from "./DiffSurface";
import type { ShortcutRow } from "./ShortcutList";

/*
 * The review's Vim cursor in Changes (plan: review into the inspector,
 * phase 3). The cursor moves on rows read from Pierre's hunks
 * (diffCursor.ts), never on the DOM; Pierre draws it (setEditorActiveLine,
 * the Visual lines as its selected lines) and scrolls to it through its
 * line positions. Keys go through the one key machine (keyMachine.ts).
 * Only on "in Changes" (`:set reviewin=changes`) with Vim keys on: on
 * classic, Changes keeps upstream's keys and mouse.
 */

/** A file of the diff shown, as the cursor reads it. */
export type DiffCursorSection = {
  key: string;
  path: string;
  /** Its patch, when loaded and drawn as a diff. */
  patch: string | null;
};

/** Where a move leaves the cursor's line on the screen. */
type ScrollTo = "center" | "start" | "end" | "nearest" | "none";

type CursorState = { at: number; col: number; scroll: ScrollTo };

/** The keys of the cursor, for the inspector's shortcut list. */
export const DIFF_CURSOR_KEYS: readonly ShortcutRow[] = [
  [
    "j k ↓ ↑",
    "next / previous line (5j); side by side, on one side of the diff",
  ],
  ["J K", "10 lines down / up"],
  ["gg G", "first / last line (12G and :12: line 12 of all the changes)"],
  ["Ctrl-d Ctrl-u", "half a screen down / up"],
  ["Ctrl-f Ctrl-b", "a screen down / up (also Ctrl-j Ctrl-k, PageDown PageUp)"],
  ["Ctrl-e Ctrl-y", "a line down / up"],
  ["H M L", "top / middle / bottom of the screen"],
  ["zz zt zb", "current line to the middle / top / bottom"],
  ["{ }", "previous / next hunk"],
  ["[ ]", "previous / next file"],
  ["w b E", "next word / previous word / end of word"],
  ["h l", "one character left / right"],
  ["0 ^ $", "start / first character / end of the line"],
  ["← →", "side by side: the removed / added line of the row"],
  ["/", "search the diff (smart case); n / N next / previous match, Esc ends"],
  ["* #", "search the word under the cursor, forward / backward"],
  ["V", "select lines (j / k extend, Shift+click too); Esc cancels"],
  ["S", "side by side / unified"],
  ["R gr", "reload the changes"],
  ["f", "show / hide the file tree (:files)"],
  ["o", "Review only: the diff alone (:only)"],
];

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
  /** The cursor is on (in Changes, "in Changes", Vim keys). */
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
  submitSearch: (text: string) => void;
  closeSearchPrompt: () => void;
  /** The search's or the Visual selection's status line, or null. */
  status: ReactNode;
  /** `:N`: row N of all the changes. */
  goToLine: (line: number) => void;
  /** The paths with a search hit, for the tree to mark. */
  matchingPaths: readonly string[];
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
  const [searchPrompt, setSearchPrompt] = useState(false);
  /** A search that found no line: n / N go file to file by path. */
  const fileSearch = useRef<string | null>(null);
  const wantCol = useRef(0);
  /** Side by side, the side j / k stay on. */
  const splitSide = useRef<"left" | "right">("right");
  const machine = useKeyMachine();
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
  const jumpTo = useCallback(
    (target: number, column?: number, scroll: ScrollTo = "center") => {
      const current = modelRef.current;
      if (!current.rows.length) return;
      const next = clampRow(current, target, anchorRef.current);
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

  const scrollToRow = useCallback(
    (index: number, mode: ScrollTo) => {
      if (mode === "none") return;
      const box = scroller();
      const place = rowBox(index);
      if (!box || !place) return;
      const height = box.clientHeight;
      const top = box.scrollTop;
      let next = top;
      if (mode === "start") next = place.top;
      else if (mode === "end") next = place.top + place.height - height;
      else if (mode === "center")
        next = place.top - (height - place.height) / 2;
      else if (place.top < top) next = place.top;
      else if (place.top + place.height > top + height)
        next = place.top + place.height - height;
      if (Math.abs(next - top) < 1) return;
      box.scrollTo({ top: Math.max(0, next) });
    },
    [rowBox, scroller],
  );

  useEffect(() => {
    if (!enabled) return;
    scrollToRow(at, cursor.scroll);
  }, [enabled, at, cursor, scrollToRow]);

  // ---- Search -----------------------------------------------------------

  const hits = useMemo(
    () => (search ? searchHits(model, search.pattern, search.wholeWord) : []),
    [model, search],
  );

  useEffect(() => {
    if (!notFound) return;
    const timer = setTimeout(() => setNotFound(null), 4000);
    return () => clearTimeout(timer);
  }, [notFound]);

  const searchFile = (pattern: string, direction: 1 | -1): boolean => {
    const index = searchFileStep(model, pattern, at, direction);
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
      else setNotFound(pattern);
      return;
    }
    setNotFound(null);
    setSearch({ pattern, wholeWord });
    const target = searchStep(found, { at, col: cursor.col }, direction);
    if (target) jumpTo(target.at, target.start, "nearest");
  };

  const repeatSearch = (direction: 1 | -1) => {
    if (fileSearch.current) {
      searchFile(fileSearch.current, direction);
      return;
    }
    const target = searchStep(hits, { at, col: cursor.col }, direction);
    if (target) jumpTo(target.at, target.start, "nearest");
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
        jumpTo(stepRows(model, at, n, side), undefined, "nearest");
        return true;
      case "k":
      case "ArrowUp":
        jumpTo(stepRows(model, at, -n, side), undefined, "nearest");
        return true;
      case "J":
        jumpTo(stepRows(model, at, 10 * n, side));
        return true;
      case "K":
        jumpTo(stepRows(model, at, -10 * n, side));
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
        scrollToRow(at, "center");
        return true;
      case "zt":
        scrollToRow(at, "start");
        return true;
      case "zb":
        scrollToRow(at, "end");
        return true;
      case "}":
        jumpTo(
          hunkStep(model, at, 1, n),
          firstColumn(model, hunkStep(model, at, 1, n)),
        );
        return true;
      case "{":
        jumpTo(
          hunkStep(model, at, -1, n),
          firstColumn(model, hunkStep(model, at, -1, n)),
        );
        return true;
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
        const pair = split
          ? model.splitLines.find(
              (line) => line.left === at || line.right === at,
            )
          : undefined;
        if (pair) {
          splitSide.current = key === "ArrowLeft" ? "left" : "right";
          const other = key === "ArrowLeft" ? pair.left : pair.right;
          if (other !== null && other !== at) jumpTo(other, undefined, "none");
          else setCursorState((current) => ({ ...current, scroll: "none" }));
        } else
          jumpTo(
            at,
            key === "ArrowLeft" ? Math.max(0, cursor.col - n) : cursor.col + n,
            "none",
          );
        return true;
      }
      case "0":
        jumpTo(at, 0, "none");
        return true;
      case "^":
        jumpTo(at, firstColumn(model, at), "none");
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
        if (!search && !fileSearch.current) return false;
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
      case "f":
        return runCommand("files");
      case "o":
        return runCommand("only");
      case "Escape":
        if (anchor !== null) setAnchor(null);
        else if (search || fileSearch.current) {
          setSearch(null);
          fileSearch.current = null;
        } else return false;
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!enabled || event.defaultPrevented || !rows.length) return;
    if (isTypingTarget(event.target) || searchPrompt) return;
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

  const selectionIn = (key: string): SelectedLineRange | null | undefined => {
    if (!enabled) return undefined;
    if (anchor === null) return null;
    const from = rows[Math.min(anchor, at)];
    const to = rows[Math.max(anchor, at)];
    if (!from || !to || from.key !== key) return null;
    const start = rowLine(from, from.kind === "-" ? "left" : "right");
    const end = rowLine(to, to.kind === "-" ? "left" : "right");
    return {
      start: start.line,
      side: start.side,
      end: end.line,
      endSide: end.side,
    };
  };

  const matchingPaths = useMemo(
    () => filesWithHits(model, hits),
    [model, hits],
  );
  const current = search
    ? hits.findIndex((hit: Match) => hit.at === at && hit.start === cursor.col)
    : -1;
  const status: ReactNode = search ? (
    <>
      <span className="diff-cursor-label">
        {search.wholeWord ? "Word " : "Search "}
      </span>
      <mark>{search.pattern}</mark>
      {`  match ${current + 1 || "-"} of ${hits.length}${search.wholeWord ? " (whole word)" : ""} · n / N next / previous · Esc clears`}
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
    submitSearch: (text) => {
      setSearchPrompt(false);
      if (text) runSearch(text, false, 1);
    },
    closeSearchPrompt: () => setSearchPrompt(false),
    status: enabled ? status : null,
    goToLine: (line) => jumpTo(line - 1, 0),
    matchingPaths,
  };
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
      registry.set("roamgate-diff-cursor", new Highlight(range));
      return;
    }
    offset += length;
  }
  registry.delete("roamgate-diff-cursor");
}
