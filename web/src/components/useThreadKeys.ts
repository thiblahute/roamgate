import { useEffect, useRef } from "react";
import { REVIEW_USER, type ReviewThread } from "../../../shared/review";
import { createKeyMachine, runKeyCommand } from "../keyMachine";
import { latestComment } from "../reviewNavigation";
import { useOpenAtTarget } from "../reviewOpenAt";

/*
 * The keys of threads drawn where they are (an agent chat's, the Files
 * preview's): j / k step through the stops (the parts one comments on,
 * the threads' messages and folded lines), n / N go thread to thread,
 * gn / gN to the unresolved ones and gH shows only those, c / Enter
 * comment on a stop or answer its thread, R on a thread's message (or
 * its first part) answers that message in a thread on the whole of it
 * (elsewhere, R answers the thread), r resolves, za folds, dd deletes a
 * lone comment of yours, T lists them, g; goes to the comment written
 * last (as in the review pane), gg / G and zz / zt / zb place, Ctrl+D /
 * Ctrl+U scroll half a page and Ctrl+F / Ctrl+B a page, the cursor moving
 * with the page, { / } go to the previous / next heading (a document's,
 * a work item's design doc). In a table, whose cells are stops, the keys
 * move as in a grid: h / l to the cell on the left or right, j / k down
 * and up its column (through the threads on a row), out of the table
 * past its last or first row. Only while the list itself has the focus:
 * in a comment box the keys are the box's. Where the list says how
 * (stopAt), a click on a stop, or words selected in it, puts the cursor
 * there, as a click on a part of a chat's message does; a click on a link
 * or a control is left to it.
 */

/** Ctrl and these: how many pages the page keys scroll. */
const PAGE_KEYS: Record<string, number> = { d: 0.5, u: -0.5, f: 1, b: -1 };

const HEADING = /^H[1-6]$/;

/**
 * A stop that is a heading, in one, or one first (a document's part: its
 * + aside, in the wrappers around its words).
 */
function isHeadingStop(stop: HTMLElement): boolean {
  if (HEADING.test(stop.tagName)) return true;
  let element = stop.firstElementChild;
  while (element) {
    if (element.classList.contains("rc-part-add")) {
      element = element.nextElementSibling;
      continue;
    }
    if (HEADING.test(element.tagName)) return true;
    if (element.tagName !== "DIV") break;
    element = element.firstElementChild;
  }
  return !!stop.parentElement?.closest("h1, h2, h3, h4, h5, h6");
}

/** The keys a count repeats: the moves. */
const REPEATED = new Set([
  "{",
  "}",
  "j",
  "k",
  "ArrowDown",
  "ArrowUp",
  "h",
  "l",
  "n",
  "N",
  "J",
  "K",
]);

/** What the keys act on, read as each key is pressed. */
export type ThreadKeys = {
  /** The stops j / k go through, in order. */
  stops: (list: HTMLElement) => HTMLElement[];
  /** The stop a click or a selection at `target` is in, if any. */
  stopAt?: (target: Element) => HTMLElement | null;
  /** A stop's place, as `cursor` holds it. */
  keyOf: (stop: HTMLElement) => string;
  cursor: string | null;
  setCursor: (key: string | null) => void;
  threadsById: ReadonlyMap<string, ReviewThread>;
  /** Threads folded or unfolded by hand: resolved ones start folded. */
  flipped: ReadonlySet<string>;
  openOnly: boolean;
  toggleFold: (thread: ReviewThread) => void;
  /** Puts j / k on a thread. */
  goToThread: (id: string) => void;
  /** g;: puts j / k on a comment of a thread, shown. */
  goToComment?: (thread: ReviewThread, comment: string) => void;
  /** The threads g; looks among (all of threadsById by default). */
  latestAmong?: (thread: ReviewThread) => boolean;
  /** T: the panel of every thread. */
  openOverview: () => void;
  /** gn / gN. */
  jumpUnresolved: (direction: 1 | -1) => void;
  /** gH. */
  toggleOpenOnly: () => void;
  resolve: (thread: ReviewThread) => void;
  remove: (thread: ReviewThread) => void;
  /** Opens the answer to a thread. */
  reply: (thread: ReviewThread) => void;
  /**
   * R on a thread's message (its stop, or its first part): a thread on
   * the whole message, true when opened (replyOnMessage); false lets R
   * answer the thread.
   */
  replyMessage?: (
    here: HTMLElement | undefined,
    thread?: ReviewThread,
  ) => boolean;
  /**
   * c / Enter, before a thread here is answered: true when it did
   * something (a comment being written taken up again, a part of a
   * thread's message commented on).
   */
  commentFirst?: (
    here: HTMLElement | undefined,
    thread?: ReviewThread,
  ) => boolean;
  /** c / Enter on a stop that is no thread's: false lets the key go. */
  comment: (here: HTMLElement) => boolean;
  /** j past the last stop. */
  pastEnd?: () => void;
  /** i, a, Esc: the keys leave the list. */
  leave?: () => void;
  /**
   * zz / zt / zb and the page keys scroll the nearest scroller around the
   * list when nothing from a stop up to the list scrolls (a work item's
   * detail, in the board's scrolling body).
   */
  outerScroller?: boolean;
  /** The list's own other keys (the chat's J / K, g;): true when done. */
  otherKey?: (
    key: string,
    at: { here: HTMLElement | undefined; all: HTMLElement[] },
    select: (stop: HTMLElement | undefined) => void,
  ) => boolean;
};

/**
 * The keys on `list` (found by `getList` each time `attach` changes),
 * which gets the focus (tabIndex -1) as j / k move.
 */
export function useThreadKeys(
  getList: () => HTMLElement | null,
  attach: unknown,
  options: ThreadKeys,
) {
  const keys = useRef(options);
  keys.current = options;
  const findList = useRef(getList);
  findList.current = getList;
  useEffect(() => {
    void attach;
    const list = findList.current();
    if (!list) return;
    list.tabIndex = -1;
    /** The cursor a count's keys moved, before the list draws it. */
    let moved: string | null | undefined;
    const select = (stop: HTMLElement | undefined) => {
      if (!stop) return;
      moved = keys.current.keyOf(stop);
      keys.current.setCursor(moved);
      stop.scrollIntoView({ block: "nearest" });
      list.focus({ preventScroll: true });
    };
    /*
     * Counts and the g / z / d prefixes: the one key machine (keyMachine.ts),
     * so `5j`, `gg`, `gn`, `g;`, `za`, `dd` read as in the review and Changes.
     */
    const machine = createKeyMachine();
    /** The column j / k keep in a table, across the threads on its rows. */
    let column: { table: Element; at: number } | null = null;
    /** The scroller zz / zt made room in. */
    let padded: HTMLElement | null = null;
    const unpad = () => {
      if (padded) padded.style.paddingBottom = "";
      padded = null;
    };
    /** The scroller a stop is placed in, and the page keys scroll. */
    const scrollerFor = (stop: HTMLElement | undefined) => {
      const inner = stop ? scrollerOf(stop, list) : list;
      if (inner !== list || scrolls(list) || !keys.current.outerScroller)
        return inner;
      return outerScrollerOf(list) ?? list;
    };
    /**
     * Ctrl+D / Ctrl+U / Ctrl+F / Ctrl+B: the scroller moves by `pages`
     * (half a page, a page), and the cursor with it: kept where it was on
     * the screen, or as far again where the scroller could not go (at
     * the top or the bottom).
     */
    const page = (pages: number) => {
      const k = keys.current;
      const all = k.stops(list);
      if (!all.length) return;
      const here = all.find((stop) => k.keyOf(stop) === k.cursor);
      const scroller = scrollerFor(here ?? all[0]);
      const delta = Math.round(scroller.clientHeight * pages);
      const from = here
        ? here.getBoundingClientRect().top
        : scroller.getBoundingClientRect().top;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + delta;
      const target = from + delta - (scroller.scrollTop - before);
      let best = all[0]!;
      let distance = Number.POSITIVE_INFINITY;
      for (const stop of all) {
        const away = Math.abs(stop.getBoundingClientRect().top - target);
        if (away < distance) {
          best = stop;
          distance = away;
        }
      }
      // Always a step, when there is one that way.
      if (here && best === here) {
        const at = all.indexOf(here);
        best =
          all[Math.max(0, Math.min(all.length - 1, at + Math.sign(delta)))]!;
      }
      moved = k.keyOf(best);
      k.setCursor(moved);
      list.focus({ preventScroll: true });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.target !== list || event.metaKey) return;
      if (event.ctrlKey) {
        const pages = PAGE_KEYS[event.key];
        if (pages === undefined || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        machine.reset();
        moved = undefined;
        page(pages);
        return;
      }
      const result = machine.feed(event.key);
      if (result.type === "wait") {
        // A count (3j moves three stops) or a prefix: kept for the next key.
        if (event.key.length === 1) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      moved = undefined;
      // A sequence the list has no meaning for: its second key alone.
      const done = runKeyCommand(result, (key, count) =>
        run(key, Math.min(Math.max(1, count ?? 1), 9999)),
      );
      if (!done) return;
      event.preventDefault();
      event.stopPropagation();
    };
    /** A key, `times` times for the moves; false when it is none of ours. */
    const run = (key: string, times: number): boolean => {
      const repeat = REPEATED.has(key) ? times : 1;
      for (let index = 0; index < repeat; index++) {
        const from = moved === undefined ? keys.current.cursor : moved;
        if (!step(key)) return index > 0;
        const to = moved === undefined ? keys.current.cursor : moved;
        if (to === from) break;
      }
      return true;
    };
    const step = (key: string): boolean => {
      const k = keys.current;
      const cursor = moved === undefined ? k.cursor : moved;
      const all = k.stops(list);
      const at = all.findIndex((stop) => k.keyOf(stop) === cursor);
      const here = all[at];
      const threadId =
        here?.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId;
      const thread = threadId ? k.threadsById.get(threadId) : undefined;
      const place = (block: "start" | "center" | "end") => {
        if (!here) return;
        // In the list's own scroller only: scrollIntoView would also
        // scroll the ancestors that clip it, the Files preview's content
        // box among them, and move the whole preview. (A list that does
        // not scroll itself may say to use the one around it.)
        const scroller = scrollerFor(here);
        // As Vim does at the end of a file: room below the last stops,
        // until the keys leave.
        if (block !== "end") {
          if (padded && padded !== scroller) padded.style.paddingBottom = "";
          padded = scroller;
          scroller.style.paddingBottom = `${scroller.clientHeight}px`;
        }
        scroller.scrollTop += placeOffset(here, scroller, block);
      };
      const vertical =
        key === "j" || key === "ArrowDown"
          ? 1
          : key === "k" || key === "ArrowUp"
            ? -1
            : 0;
      const grid =
        here && (vertical || key === "h" || key === "l")
          ? gridStep(
              here,
              all,
              vertical || (key === "h" ? "left" : "right"),
              column,
            )
          : null;
      if (grid) {
        column = grid.column;
        if (grid.to) select(grid.to);
        else if (grid.past) k.pastEnd?.();
      } else if (vertical === 1 && at >= all.length - 1) {
        // Past the last one: out, where the list says.
        k.pastEnd?.();
      } else if (vertical) {
        const to = enterCell(
          all[vertical === 1 ? at + 1 : Math.max(0, at - 1)],
          all,
          column,
        );
        // Into a table's cells or its threads, the column is kept.
        const table = to?.closest("table");
        column =
          to && table && isCell(to)
            ? { table, at: column?.table === table ? column.at : 0 }
            : column && to && column.table.contains(to)
              ? column
              : null;
        select(to);
      } else if (key === "n" || key === "N") {
        // The next or previous thread, from where the cursor is.
        const threads = Array.from(
          list.querySelectorAll<HTMLElement>(
            ".chat-thread[data-thread-id]:not(.is-draft)",
          ),
        );
        const from = here ?? all[all.length - 1];
        const own = from?.closest<HTMLElement>(".chat-thread");
        const after = (element: HTMLElement) =>
          !!from &&
          element !== own &&
          !!(
            from.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING
          );
        const next =
          key === "n"
            ? threads.find(after)
            : [...threads]
                .reverse()
                .find(
                  (element) =>
                    element !== own && !after(element) && element !== from,
                );
        if (next?.dataset.threadId) {
          k.goToThread(next.dataset.threadId);
          // Where goToThread puts it: its first stop, or its folded line.
          const stop = next.dataset.chatStop
            ? next
            : next.querySelector<HTMLElement>("[data-chat-stop]");
          if (stop) moved = k.keyOf(stop);
        }
      } else if (key === "T") k.openOverview();
      else if (key === "{" || key === "}") {
        // The previous / next heading, from where the cursor is.
        const headings = all.filter(isHeadingStop);
        const next =
          key === "}"
            ? headings.find((stop) => all.indexOf(stop) > at)
            : [...headings]
                .reverse()
                .find((stop) => at < 0 || all.indexOf(stop) < at);
        if (!next) return false;
        select(next);
      } else if (key === "gg") select(all[0]);
      else if (key === "G") select(all[all.length - 1]);
      else if (key === "zz") place("center");
      else if (key === "zt") place("start");
      else if (key === "zb") place("end");
      else if (key === "za" && thread) {
        // The cursor stays on the thread, folded or open.
        const folded = here?.dataset.chatStop?.startsWith("t:");
        k.setCursor(folded ? `m:${thread.comments[0]?.id}` : `t:${thread.id}`);
        k.toggleFold(thread);
      } else if (key === "gn") k.jumpUnresolved(1);
      else if (key === "gN") k.jumpUnresolved(-1);
      else if (key === "gH") k.toggleOpenOnly();
      else if (key === "g;" && k.goToComment) {
        const threads = [...k.threadsById.values()];
        const latest = latestComment(
          k.latestAmong ? threads.filter(k.latestAmong) : threads,
        );
        if (latest) k.goToComment(latest.thread, latest.comment.id);
      } else if (k.otherKey?.(key, { here, all }, select)) {
        /* The list's own key. */
      } else if (key === "r" && thread) {
        // Resolving folds it: the cursor follows onto its one line.
        if (!thread.resolved && !k.flipped.has(thread.id))
          k.setCursor(`t:${thread.id}`);
        else if (thread.resolved && here?.dataset.chatStop?.startsWith("t:"))
          k.setCursor(`m:${thread.comments[0]?.id}`);
        k.resolve(thread);
        // Showing only the unresolved ones, it goes away: on to the next.
        if (k.openOnly && !thread.resolved) k.jumpUnresolved(1);
      } else if (key === "dd" && thread) {
        if (
          thread.comments.length === 1 &&
          thread.comments[0]?.author === REVIEW_USER
        )
          k.remove(thread);
      } else if (
        (key === "c" || key === "Enter") &&
        k.commentFirst?.(here, thread)
      ) {
        /* Taken up or commented on. */
      } else if (key === "R" && k.replyMessage?.(here, thread)) {
        /* A thread on the whole message. */
      } else if ((key === "c" || key === "Enter" || key === "R") && thread) {
        // An answer being written in that thread: back into it.
        const open = list.querySelector<HTMLElement>(
          `.chat-thread[data-thread-id="${CSS.escape(thread.id)}"] .chat-thread-editor .cm-content`,
        );
        if (open) open.focus();
        else k.reply(thread);
      } else if ((key === "c" || key === "Enter") && here) {
        if (!k.comment(here)) return false;
      } else if ((key === "i" || key === "a" || key === "Escape") && k.leave)
        k.leave();
      else return false;
      return true;
    };
    // The room zz made below the last stops goes with the keys, however
    // they leave (a click in a box, another pane).
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && list.contains(next))) unpad();
    };
    // A click, or a selection made with the mouse, on a stop: the cursor
    // goes there and the keys are the list's.
    const onPick = (event: MouseEvent) => {
      const k = keys.current;
      if (!k.stopAt || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(LEFT_TO_ITSELF)) return;
      const selection = list.ownerDocument.getSelection();
      const range =
        selection && !selection.isCollapsed && selection.rangeCount
          ? selection.getRangeAt(0)
          : null;
      const start = range?.startContainer;
      const from = !start
        ? target
        : start instanceof Element
          ? start
          : start.parentElement;
      if (!from || !list.contains(from) || from.closest(LEFT_TO_ITSELF)) return;
      const stop = k.stopAt(from);
      if (!stop || !list.contains(stop)) return;
      k.setCursor(k.keyOf(stop));
      if (list.ownerDocument.activeElement !== list)
        list.focus({ preventScroll: true });
    };
    list.addEventListener("keydown", onKey);
    list.addEventListener("focusout", onFocusOut);
    list.addEventListener("click", onPick);
    list.addEventListener("mouseup", onPick);
    return () => {
      list.removeEventListener("keydown", onKey);
      list.removeEventListener("focusout", onFocusOut);
      list.removeEventListener("click", onPick);
      list.removeEventListener("mouseup", onPick);
      unpad();
    };
  }, [attach]);
  // A link to one of the list's comments (reviewOpenAt.ts): its thread
  // unfolded, gone to as g; goes to a comment, the comment highlighted.
  useOpenAtTarget({
    find: (id) => keys.current.threadsById.get(id),
    threads: options.threadsById,
    root: () => findList.current(),
    go: (thread, comment) => {
      const k = keys.current;
      if (thread.resolved !== k.flipped.has(thread.id)) k.toggleFold(thread);
      // Once drawn unfolded.
      requestAnimationFrame(() => {
        const now = keys.current;
        if (comment && now.goToComment) now.goToComment(thread, comment);
        else now.goToThread(thread.id);
      });
    },
  });
}

/** What a click does by itself: a link, a control, a box, a thread. */
const LEFT_TO_ITSELF =
  "a[href], button, input, textarea, select, summary, label, iframe, [contenteditable], [role='button'], .cm-editor, .chat-thread";

const isCell = (stop: Element | undefined): stop is HTMLElement =>
  stop?.tagName === "TD" || stop?.tagName === "TH";

/** A table's rows of cells that are stops, top to bottom. */
function gridRows(
  table: Element,
  stops: ReadonlySet<Element>,
): HTMLElement[][] {
  return [...table.querySelectorAll("tr")]
    .filter((row) => row.closest("table") === table)
    .map((row) =>
      [...row.children].filter(
        (cell): cell is HTMLElement => isCell(cell) && stops.has(cell),
      ),
    )
    .filter((row) => row.length > 0);
}

/**
 * Onto a table from outside it, or from the threads on one of its rows:
 * the cell of that row in the column kept, else its first.
 */
function enterCell(
  target: HTMLElement | undefined,
  all: readonly HTMLElement[],
  column: { table: Element; at: number } | null,
): HTMLElement | undefined {
  const table = isCell(target) ? target.closest("table") : null;
  if (!target || !table) return target;
  const row = gridRows(table, new Set(all)).find((cells) =>
    cells.includes(target),
  );
  if (!row) return target;
  const at = column?.table === table ? column.at : 0;
  return row[Math.min(at, row.length - 1)];
}

/**
 * The keys of a table's cells, as in a grid: the stop to go to (`past`:
 * beyond the last stop), and the column kept. Null when `here` is no
 * cell or the key is no grid move.
 */
export function gridStep(
  here: HTMLElement,
  all: readonly HTMLElement[],
  move: 1 | -1 | "left" | "right",
  kept: { table: Element; at: number } | null = null,
): {
  to?: HTMLElement;
  past?: boolean;
  column: { table: Element; at: number } | null;
} | null {
  if (!isCell(here)) return null;
  const table = here.closest("table");
  if (!table) return null;
  const rows = gridRows(table, new Set(all));
  const r = rows.findIndex((cells) => cells.includes(here));
  const row = rows[r];
  if (!row) return null;
  const c = row.indexOf(here);
  if (move === "left" || move === "right") {
    const to = row[c + (move === "left" ? -1 : 1)];
    return { to: to ?? here, column: { table, at: to ? row.indexOf(to) : c } };
  }
  // On a short row's last cell, the column j / k came down or up in.
  const column = {
    table,
    at:
      kept?.table === table && kept.at > c && c === row.length - 1
        ? kept.at
        : c,
  };
  const at = column.at;
  if (move === 1) {
    const last = all.indexOf(row[row.length - 1]!);
    const next = all[last + 1];
    // The threads on this row first, then the cell below.
    if (next && !isCell(next) && table.contains(next))
      return { to: next, column };
    const below = rows[r + 1];
    if (below) return { to: below[Math.min(at, below.length - 1)], column };
    const after = all.slice(last + 1).find((stop) => !table.contains(stop));
    return after ? { to: after, column: null } : { past: true, column };
  }
  const first = all.indexOf(row[0]!);
  const previous = all[first - 1];
  // The threads on the row above, then its cell.
  if (previous && !isCell(previous) && table.contains(previous))
    return { to: previous, column };
  const above = rows[r - 1];
  if (above) return { to: above[Math.min(at, above.length - 1)], column };
  return { to: previous ?? here, column: previous ? null : column };
}

const scrolls = (element: HTMLElement) => {
  const overflow = getComputedStyle(element).overflowY;
  return overflow === "auto" || overflow === "scroll";
};

/**
 * The scroller `stop` is placed in: the outermost one from it up to the
 * list (the list itself in a chat, the Markdown's in the Files preview,
 * not a code block's), or the list when none scrolls.
 */
export function scrollerOf(stop: HTMLElement, list: HTMLElement): HTMLElement {
  let found: HTMLElement | null = null;
  for (
    let element: HTMLElement | null = stop.parentElement;
    element;
    element = element === list ? null : element.parentElement
  )
    if (scrolls(element)) found = element;
  return found ?? list;
}

/** The nearest scroller around `list`, out of it. */
function outerScrollerOf(list: HTMLElement): HTMLElement | null {
  for (
    let element = list.parentElement;
    element;
    element = element.parentElement
  )
    if (scrolls(element)) return element;
  return null;
}

/** How far `scroller` scrolls to put `stop` at its top, middle or bottom. */
export function placeOffset(
  stop: HTMLElement,
  scroller: HTMLElement,
  block: "start" | "center" | "end",
): number {
  const box = stop.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const top = box.top - view.top - scroller.clientTop;
  const room = scroller.clientHeight - box.height;
  return block === "start"
    ? top
    : block === "center"
      ? top - room / 2
      : top - room;
}
