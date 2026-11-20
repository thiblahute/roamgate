import type { EditorView, WidgetType } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { REVIEW_USER, type ReviewThread } from "../../../shared/review";
import { MAX_QUOTE_LENGTH } from "../annotations";
import {
  FileThread,
  type FileThreadsApi,
  type FileThreadView,
  type Undelivered,
} from "./FileThreads";

/*
 * The threads of a file shown as source (the Files preview's CodeMirror
 * view), drawn as the review's diff draws them: each under the last line
 * it is on, its lines marked, the resolved ones folded to a line. The
 * editor keeps the keys: j / k (and the arrows) step from a line into the
 * messages of the thread under it and out again, c comments on the
 * cursor's line or selection (Vim's visual mode, the mouse's) or answers
 * the line's thread, C always comments anew, R answers, r resolves or
 * reopens, za folds, dd deletes a lone comment of yours, gn / gN go to the
 * unresolved threads, gH shows only those, T lists them. With Vim keys on,
 * Vim's own keys (j / k, gg / G, zz, / and n / N) stay Vim's: these come
 * first only where Vim's would do nothing in a read-only file, and read
 * Vim's pending prefix (g, z, d) rather than taking it from Vim. Without
 * Vim keys, j / k, gg / G, zz / zt / zb and n / N (thread to thread) are
 * the view's own.
 */

/** The lines a comment is on, and their words. */
export type SourceThreadRange = {
  line: number;
  endLine?: number;
  quote: string;
};
export type SourceThreadPoint = { x: number; y: number };

/**
 * The threads drawn under each line: a thread under the last line it is
 * on (within the file), the resolved ones left out while only the
 * unresolved are shown; a thread on no line (one of a removed line) is
 * listed with the comments, not drawn.
 */
export function sourceThreadsByLine(
  threads: readonly ReviewThread[],
  openOnly: boolean,
  lineCount: number,
): Map<number, ReviewThread[]> {
  const byLine = new Map<number, ReviewThread[]>();
  for (const thread of threads) {
    const { line, endLine } = thread.anchor;
    if (line === undefined || (openOnly && thread.resolved)) continue;
    const under = Math.max(1, Math.min(endLine ?? line, lineCount));
    byLine.set(under, [...(byLine.get(under) ?? []), thread]);
  }
  for (const under of byLine.values())
    under.sort(
      (a, b) =>
        (a.anchor.line ?? 0) - (b.anchor.line ?? 0) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  return byLine;
}

/**
 * The widgets' elements: CodeMirror makes one under each line with threads
 * as the line comes into its viewport and drops it as it leaves; React
 * draws the cards in it (SourceThreadCards, through a portal).
 */
export type WidgetHosts = {
  attach: (line: number, element: HTMLElement) => void;
  detach: (line: number, element: HTMLElement) => void;
};

/** What the source view draws for its threads (codeMirrorAnnotationExtensions). */
export type SourceThreadDrawing = {
  byLine: ReadonlyMap<number, readonly ReviewThread[]>;
  /** The line a comment being written is drawn under, with its box. */
  draftLine?: number;
  hosts: WidgetHosts;
  /** The gutter's badge pressed: the line's threads folded, or unfolded. */
  onToggleFold: (line: number) => void;
};

/**
 * The hosts, kept as a map for the portals, each watched: the cards drawn
 * or grown in one change its height, which CodeMirror measures again.
 */
export function useSourceThreadHosts(editor: () => EditorView | null): {
  hosts: WidgetHosts;
  elements: ReadonlyMap<number, HTMLElement>;
} {
  const [elements, setElements] = useState<ReadonlyMap<number, HTMLElement>>(
    () => new Map(),
  );
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  const hosts = useMemo<WidgetHosts>(
    () => ({
      attach(line, element) {
        if (!observer.current && typeof ResizeObserver !== "undefined")
          observer.current = new ResizeObserver(() =>
            editorRef.current()?.requestMeasure(),
          );
        observer.current?.observe(element);
        setElements((current) => new Map(current).set(line, element));
      },
      detach(line, element) {
        observer.current?.unobserve(element);
        setElements((current) => {
          if (current.get(line) !== element) return current;
          const next = new Map(current);
          next.delete(line);
          return next;
        });
      },
    }),
    [],
  );
  return { hosts, elements };
}

/**
 * The block widget under a line with threads: an element the cards are
 * drawn in, the same one while the line's threads are the same.
 */
export function threadsWidgetClass(Base: typeof WidgetType) {
  return class ThreadsWidget extends Base {
    constructor(
      readonly line: number,
      readonly ids: string,
      readonly hosts: WidgetHosts,
    ) {
      super();
    }

    eq(other: ThreadsWidget) {
      return other.line === this.line && other.ids === this.ids;
    }

    toDOM() {
      const element = document.createElement("div");
      element.className = "cm-source-threads chat-review";
      element.dataset.line = String(this.line);
      this.hosts.attach(this.line, element);
      return element;
    }

    destroy(dom: HTMLElement) {
      this.hosts.detach(this.line, dom);
    }

    ignoreEvent() {
      return true;
    }
  };
}

/**
 * Scrolls the editor up or down, only, to show a stop of a thread: a card
 * is as wide as the view, so a sideways scroll (scrollIntoView's) would
 * put the file's first columns under the gutters.
 */
export function revealStop(stop: HTMLElement, block: "nearest" | "center") {
  const scroller = stop.closest<HTMLElement>(".cm-scroller");
  if (!scroller) {
    stop.scrollIntoView?.({ block });
    return;
  }
  const box = stop.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  if (!box.height || !port.height) return;
  if (block === "center")
    scroller.scrollTop +=
      box.top + box.height / 2 - (port.top + port.height / 2);
  else if (box.top < port.top) scroller.scrollTop -= port.top - box.top + 8;
  else if (box.bottom > port.bottom)
    scroller.scrollTop += box.bottom - port.bottom + 8;
}

/**
 * The width the cards have: the view's, short of the gutters, as CSS
 * variables on the editor (the content is as wide as its longest line).
 */
export function measureCardWidth(view: EditorView) {
  view.requestMeasure({
    read: (v) => ({
      gutters:
        v.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0,
      port: v.scrollDOM.clientWidth,
    }),
    write: ({ gutters, port }, v) => {
      v.dom.style.setProperty("--cm-gutters-width", `${gutters}px`);
      v.dom.style.setProperty(
        "--cm-visible-width",
        `${Math.max(0, port - gutters)}px`,
      );
    },
  });
}

/** The cards under a line, as the rendered view and the diff draw them. */
export function SourceThreadCards({
  threads,
  api,
  view,
  undelivered,
  nested,
}: {
  threads: readonly ReviewThread[];
  api: FileThreadsApi;
  view: FileThreadView;
  undelivered?: Undelivered;
  nested?: ReadonlyMap<string, ReviewThread[]>;
}) {
  return (
    <>
      {threads.map((thread) => (
        <FileThread
          key={thread.id}
          thread={thread}
          api={api}
          view={view}
          undelivered={undelivered}
          nested={nested}
        />
      ))}
    </>
  );
}

/** Vim's state for the editor, read as a key is pressed; null without Vim keys. */
export type VimAccess = {
  insertMode: boolean;
  visualMode: boolean;
  /** The prefix Vim keeps for its next key (g, z), as typed. */
  pending: string;
  /** The operator waiting for its motion (d after `d`). */
  operator: string | null;
  /** A count typed. */
  count: boolean;
  /** Drops what Vim keeps: a prefix or operator taken here. */
  clear: () => void;
  exitVisual: () => void;
};

/** What the keys act on, read as each key is pressed. */
export type SourceKeys = {
  /** The stop j / k are on (m:COMMENT, t:THREAD), null on a line. */
  cursor: string | null;
  setCursor: (key: string | null) => void;
  /** The threads drawn under a line. */
  threadsAt: (line: number) => readonly ReviewThread[];
  /** Their messages and folded lines, as drawn under the line, in order. */
  stopsAt: (line: number) => HTMLElement[];
  threadOf: (stop: HTMLElement) => ReviewThread | undefined;
  folded: (thread: ReviewThread) => boolean;
  toggleFold: (thread: ReviewThread) => void;
  /** Opens the answer to a thread, or goes back into the one being written. */
  reply: (thread: ReviewThread) => void;
  resolve: (thread: ReviewThread) => void;
  remove: (thread: ReviewThread) => void;
  /** A comment on some lines, written at `at`. */
  comment: (range: SourceThreadRange, at: SourceThreadPoint) => void;
  /** T: the panel of every thread. */
  openOverview: () => void;
  /** gn / gN. */
  jumpUnresolved: (direction: 1 | -1) => void;
  /** n / N without Vim keys: thread to thread, resolved ones too. */
  stepThread: (direction: 1 | -1) => void;
  /** gH. */
  toggleOpenOnly: () => void;
  say: (notice: string) => void;
  /** Without Vim keys: the g / z / d prefix waiting for its second key. */
  prefix: { current: string };
};

type KeyLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
};

/** The whole lines of the selection, as a comment is anchored. */
function selectedLines(view: EditorView): SourceThreadRange | null {
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const doc = view.state.doc;
  const line = doc.lineAt(from).number;
  let endLine = doc.lineAt(to).number;
  if (endLine > line && to === doc.line(endLine).from) endLine -= 1;
  return {
    line,
    ...(endLine === line ? {} : { endLine }),
    quote: doc.sliceString(from, to).replace(/\n$/, ""),
  };
}

/** Where a comment box would open: under the start of a line. */
function pointUnder(view: EditorView, line: number): SourceThreadPoint {
  try {
    const rect = view.coordsAtPos(view.state.doc.line(line).from);
    if (rect && (rect.left || rect.bottom))
      return { x: rect.left + 6, y: rect.bottom + 8 };
  } catch {
    // Not laid out (a test's DOM): the editor's corner.
  }
  const box = view.dom.getBoundingClientRect();
  return { x: box.left + 56, y: box.top + 28 };
}

/**
 * A key pressed in the editor, with Vim's pending prefix read (`vim`) or
 * the view's own (without Vim keys): true when the view took it.
 */
export function sourceViewKey(
  event: KeyLike,
  view: EditorView,
  vim: VimAccess | null,
  keys: SourceKeys,
): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (vim?.insertMode) return false;
  const key = event.key;
  let full = key;
  if (vim) {
    if (vim.pending === "g" || vim.pending === "z") full = vim.pending + key;
    else if (vim.operator === "d" && key === "d") full = "dd";
    else if (vim.pending || vim.operator || vim.count) return false;
  } else {
    const pending = keys.prefix.current;
    keys.prefix.current = "";
    if (pending && key !== "Escape") full = pending + key;
    else if (key === "g" || key === "z" || key === "d") {
      keys.prefix.current = key;
      return true;
    }
  }
  const taken = sourceKeyCommand(full, view, vim, keys);
  // A prefix Vim kept for a sequence taken here: dropped, with its count.
  if (taken && vim && full !== key) vim.clear();
  return taken;
}

/**
 * A key, or a two-key sequence, as the view reads it (`:comment` runs
 * `c`, `:fold` `za`): true when it meant something here.
 */
export function sourceKeyCommand(
  full: string,
  view: EditorView,
  vim: VimAccess | null,
  k: SourceKeys,
): boolean {
  const doc = view.state.doc;
  const main = view.state.selection.main;
  const line = doc.lineAt(main.head).number;
  const stops = k.stopsAt(line);
  const at = k.cursor
    ? stops.findIndex((stop) => stop.dataset.chatStop === k.cursor)
    : -1;
  const here = at >= 0 ? stops[at] : undefined;
  const focused = here ? k.threadOf(here) : undefined;
  const under = k.threadsAt(line);
  const first = focused ?? under.find((thread) => !thread.resolved) ?? under[0];
  const select = (stop: HTMLElement) => {
    k.setCursor(stop.dataset.chatStop ?? null);
    revealStop(stop, "nearest");
  };
  const goLine = (target: number) => {
    k.setCursor(null);
    if (target < 1 || target > doc.lines) return;
    view.dispatch({
      selection: { anchor: doc.line(target).from },
      scrollIntoView: true,
    });
  };
  const comment = (range: SourceThreadRange) => {
    if (range.quote.length > MAX_QUOTE_LENGTH) {
      k.say("Select fewer lines to annotate");
      return;
    }
    vim?.exitVisual();
    k.comment(range, pointUnder(view, range.endLine ?? range.line));
  };
  switch (full) {
    case "j":
    case "ArrowDown": {
      if (here) {
        const next = stops[at + 1];
        if (next) select(next);
        else goLine(line + 1);
        return true;
      }
      if (stops[0]) {
        select(stops[0]);
        return true;
      }
      if (vim || full === "ArrowDown") return false;
      goLine(line + 1);
      return true;
    }
    case "k":
    case "ArrowUp": {
      if (here) {
        if (at > 0) select(stops[at - 1]!);
        else k.setCursor(null);
        return true;
      }
      const above = line > 1 ? k.stopsAt(line - 1) : [];
      const last = above[above.length - 1];
      if (last) {
        goLine(line - 1);
        select(last);
        return true;
      }
      if (vim || full === "ArrowUp") return false;
      goLine(line - 1);
      return true;
    }
    case "c":
    case "C":
    case "Enter": {
      if (full === "Enter" && !focused) return false;
      if (focused && full !== "C") {
        k.reply(focused);
        return true;
      }
      const selected = selectedLines(view);
      if (selected) {
        comment(selected);
        return true;
      }
      if (full === "c" && first) {
        k.reply(first);
        return true;
      }
      comment({ line, quote: doc.line(line).text });
      return true;
    }
    case "R":
      if (first) k.reply(first);
      else k.say("No comment on this line to answer.");
      return true;
    case "r":
      if (first) k.resolve(first);
      else k.say("No comment on this line.");
      return true;
    case "za":
      if (!first) {
        k.say("No comment to fold on this line.");
        return true;
      }
      // The cursor stays on the thread, folded or open.
      if (focused)
        k.setCursor(
          k.folded(first) ? `m:${first.comments[0]?.id}` : `t:${first.id}`,
        );
      k.toggleFold(first);
      return true;
    case "dd":
      if (
        first &&
        first.comments.length === 1 &&
        first.comments[0]?.author === REVIEW_USER
      )
        k.remove(first);
      else k.say("dd deletes a lone comment of yours.");
      return true;
    case "T":
      k.openOverview();
      return true;
    case "gn":
      k.jumpUnresolved(1);
      return true;
    case "gN":
      k.jumpUnresolved(-1);
      return true;
    case "gH":
      k.toggleOpenOnly();
      return true;
    case "n":
    case "N":
      if (vim) return false;
      k.stepThread(full === "n" ? 1 : -1);
      return true;
    case "gg":
      if (vim) return false;
      goLine(1);
      return true;
    case "G":
      if (vim) return false;
      goLine(doc.lines);
      return true;
    case "zz":
    case "zt":
    case "zb": {
      if (vim) return false;
      const ctor = view.constructor as typeof EditorView;
      view.dispatch({
        effects: ctor.scrollIntoView(main.head, {
          y: full === "zz" ? "center" : full === "zt" ? "start" : "end",
        }),
      });
      return true;
    }
    case "Escape":
      if (!here) return false;
      k.setCursor(null);
      return true;
    default:
      return false;
  }
}
