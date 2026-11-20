import { ChevronDown, ChevronUp, ListFilter } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReviewThread } from "../../../shared/review";
import { roamgateLocalStorage } from "../browserStorage";
import { workCall } from "../work";
import { openWork } from "../workOpen";
import "./ThreadsPanel.css";
import { summaryLine } from "./reviewImageUpload";

/**
 * The comments of a review or of an agent chat, beside what they are on:
 * one line each, open ones first, unfolded to read or answer, searched with
 * /. The review and the chat give their threads and what acting on one
 * means there.
 *
 * Resolved ones are hidden unless asked for (H, remembered in the browser),
 * then shown after the open ones. Resolving one leaves the list where it is:
 * the selection goes to the next open one and nothing scrolls by itself;
 * only a move by key brings the selection into view.
 */

/** Where the choice to show the resolved threads is kept. */
export const SHOW_RESOLVED_KEY = "threadsPanel.showResolved";

function readShowResolved(): boolean {
  return roamgateLocalStorage.getItem(SHOW_RESOLVED_KEY) === "1";
}

function writeShowResolved(show: boolean) {
  try {
    roamgateLocalStorage.setItem(SHOW_RESOLVED_KEY, show ? "1" : "0");
  } catch {
    /* The choice only lasts for this panel when storage is not writable. */
  }
}

/** When the thread's latest message was written or rewritten. */
/**
 * A thread becomes a work item that adopts it (its comments and id kept),
 * shown on the Work board; the thread is then the item's, not the
 * review's.
 */
async function promoteToWork(threadId: string) {
  try {
    const { item } = await workCall<{ item: { id: string } }>("promote", {
      thread: threadId,
    });
    openWork(item.id);
  } catch (error) {
    window.alert(
      `Could not make a work item: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function lastMessageAt(thread: ReviewThread): string {
  let last = "";
  for (const comment of thread.comments) {
    if (comment.createdAt > last) last = comment.createdAt;
    if (comment.updatedAt > last) last = comment.updatedAt;
  }
  return last || thread.createdAt;
}

/**
 * A review's conversations as its comments panel lists them: the open
 * ones first, the latest written first; the forge's discussions left out.
 */
export function conversationOrder(
  threads: readonly ReviewThread[],
): ReviewThread[] {
  return threads
    .filter((thread) => thread.kind !== "merge-request")
    .map((thread) => ({ thread, last: lastMessageAt(thread) }))
    .sort(
      (a, b) =>
        Number(a.thread.resolved) - Number(b.thread.resolved) ||
        b.last.localeCompare(a.last) ||
        b.thread.updatedAt.localeCompare(a.thread.updatedAt),
    )
    .map(({ thread }) => thread);
}

/**
 * Where the choice to show only the unresolved threads where they are (in
 * the code, in the chat) is kept: one choice for the review and the chats.
 */
export const OPEN_ONLY_KEY = "threads.openOnly";

const openOnlyListeners = new Set<(on: boolean) => void>();

function readOpenOnly(): boolean {
  return roamgateLocalStorage.getItem(OPEN_ONLY_KEY) === "1";
}

/**
 * Whether resolved threads are left out where threads are drawn (and so
 * from n / N): remembered in the browser, the same in every view open.
 */
export function useOpenOnly(): [boolean, (on: boolean) => void] {
  const [openOnly, setOpenOnly] = useState(readOpenOnly);
  useEffect(() => {
    openOnlyListeners.add(setOpenOnly);
    return () => {
      openOnlyListeners.delete(setOpenOnly);
    };
  }, []);
  const change = useCallback((on: boolean) => {
    try {
      roamgateLocalStorage.setItem(OPEN_ONLY_KEY, on ? "1" : "0");
    } catch {
      /* Kept for this page only when storage is not writable. */
    }
    for (const listener of openOnlyListeners) listener(on);
  }, []);
  return [openOnly, change];
}

/**
 * The unresolved threads, one after the other: previous / next (gN / gn),
 * where you are among them ("2 of 5 unresolved"), and the choice to show
 * only them.
 */
export function UnresolvedNav({
  total,
  position,
  openOnly,
  onStep,
  onOpenOnly,
  className = "",
  commandHints = false,
}: {
  total: number;
  /** The unresolved thread you are on, from 1; null when on none. */
  position: number | null;
  openOnly: boolean;
  onStep: (direction: 1 | -1) => void;
  onOpenOnly: (on: boolean) => void;
  className?: string;
  /** Where the keys are not had (a file's source): the `:` commands said. */
  commandHints?: boolean;
}) {
  const hint = (key: string, command: string) =>
    commandHints ? `:${command}` : key;
  const label = !total
    ? "All resolved"
    : position
      ? `${position} of ${total} unresolved`
      : `${total} unresolved`;
  return (
    <div
      className={`unresolved-nav ${className}`}
      role="group"
      aria-label="Unresolved threads"
    >
      <button
        type="button"
        className="unresolved-nav-step"
        aria-label="Previous unresolved thread"
        title={`Previous unresolved thread (${hint("gN", "previous")})`}
        disabled={!total}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={14} />
      </button>
      <span className="unresolved-nav-where" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className="unresolved-nav-step"
        aria-label="Next unresolved thread"
        title={`Next unresolved thread (${hint("gn", "next")})`}
        disabled={!total}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={`unresolved-nav-only${openOnly ? " on" : ""}`}
        aria-pressed={openOnly}
        aria-label="Unresolved only"
        title={
          openOnly
            ? `Showing only the unresolved threads: show the resolved ones too (${hint("gH", "unresolved")})`
            : commandHints
              ? "Show only the unresolved threads (:unresolved)"
              : "Show only the unresolved threads; n / N skip the resolved ones (gH)"
        }
        onClick={() => onOpenOnly(!openOnly)}
      >
        <ListFilter size={14} />
      </button>
    </div>
  );
}

export type PanelThread = {
  id: string;
  resolved: boolean;
  /** Where it is: a file and line, or the words of a message it quotes. */
  where: string;
  /** More about it (its commit, its kind). */
  meta?: string;
  /** When its last message was written, as shown. */
  when?: string;
  comments: readonly { id: string; author: string; body: string }[];
  /** Whether it can be answered here (a review comment is edited instead). */
  canReply: boolean;
  /** More words the search finds it by. */
  search?: string;
};

/**
 * Where a panel is (its search, selection, threads unfolded and scroll),
 * read when it is drawn and written as it changes: a chat's panel drawn
 * again after the chat was not shown is where it was.
 */
export type ThreadsPanelPlace = {
  query: string;
  selectedId: string | null;
  unfolded: string[];
  scrollTop: number;
};

/** "2 open · 10 comments": opens the panel. */
export function ThreadsChip({
  threads,
  open,
  onToggle,
  className = "",
  undelivered,
  commandHints = false,
}: {
  threads: readonly { resolved: boolean }[];
  open: boolean;
  onToggle: () => void;
  className?: string;
  /** Where the keys are not had (a file's source): the `:` command said. */
  commandHints?: boolean;
  /** Comments that did not reach the agent, and why: said on the chip. */
  undelivered?: { count: number; reason: string };
}) {
  const unresolved = threads.filter((thread) => !thread.resolved).length;
  return (
    <button
      type="button"
      className={`threads-chip ${className}`}
      aria-expanded={open}
      title={
        undelivered
          ? `The comments (${commandHints ? ":conversations" : "T"}). Not delivered: ${undelivered.reason}`
          : `The comments (${commandHints ? ":conversations" : "T"})`
      }
      onClick={onToggle}
    >
      <span>{unresolved} open</span>
      <span className="threads-chip-total">
        {" "}
        · {threads.length} comment{threads.length === 1 ? "" : "s"}
      </span>
      {undelivered ? (
        <span className="threads-chip-undelivered" role="status">
          {" "}
          · {undelivered.count} not delivered
        </span>
      ) : null}
    </button>
  );
}

export function ThreadsPanel({
  threads,
  title = "Comments",
  className = "",
  onClose,
  onGo,
  onResolve,
  onReply,
  replying,
  renderBody,
  place,
}: {
  /** In the order shown: open ones first, then the latest. */
  threads: readonly PanelThread[];
  title?: string;
  className?: string;
  onClose: () => void;
  onGo: (id: string) => void;
  onResolve: (id: string) => void;
  onReply: (id: string) => void;
  /** The answer being written, drawn under its thread. */
  replying?: { id: string; editor: ReactNode } | null;
  renderBody: (thread: PanelThread, body: string) => ReactNode;
  /** Where it was, kept as it changes. */
  place?: ThreadsPanelPlace;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState(place?.query ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(
    place?.selectedId ?? null,
  );
  /** Unfolded by hand: each one is one line until then. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(
    () => new Set(place?.unfolded),
  );
  useEffect(() => {
    if (!place) return;
    place.query = query;
    place.selectedId = selectedId;
    place.unfolded = [...unfolded];
  }, [place, query, selectedId, unfolded]);
  // Drawn again: scrolled where it was.
  const placeRef = useRef(place);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && placeRef.current?.scrollTop)
      list.scrollTop = placeRef.current.scrollTop;
  }, []);
  const [showResolved, setShowResolved] = useState(readShowResolved);
  /** Set by a move by key: only that brings the selection into view. */
  const scrollToSelection = useRef(false);

  // The list has the keys from the start; / goes to the search.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);
  // An answer sent or closed: its box goes, the list keeps the keys (the
  // page would have them otherwise).
  const replyingId = replying?.id ?? null;
  const wasReplying = useRef(replyingId);
  useEffect(() => {
    const was = wasReplying.current;
    wasReplying.current = replyingId;
    if (!was || replyingId) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body)
        panelRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [replyingId]);

  const toggleShowResolved = () =>
    setShowResolved((current) => {
      writeShowResolved(!current);
      return !current;
    });

  /** The threads the search finds, open ones first, in the order given. */
  const matched = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const found = words.length
      ? threads.filter((thread) => {
          const text = [
            thread.where,
            thread.meta ?? "",
            thread.search ?? "",
            thread.resolved ? "resolved" : "open",
            ...thread.comments.flatMap((comment) => [
              comment.author,
              comment.body,
            ]),
          ]
            .join("\n")
            .toLowerCase();
          return words.every((word) => text.includes(word));
        })
      : threads;
    return {
      open: found.filter((thread) => !thread.resolved),
      resolved: found.filter((thread) => thread.resolved),
    };
  }, [threads, query]);
  const shown = useMemo(
    () =>
      showResolved ? [...matched.open, ...matched.resolved] : matched.open,
    [matched, showResolved],
  );
  const selected = shown.find((thread) => thread.id === selectedId) ?? shown[0];
  const selectedKey = selected?.id;

  // A thread resolved while selected (here or elsewhere) leaves the
  // selection on the next open one, in its place: the list does not follow
  // it to the resolved ones or to the top.
  const lastShown = useRef<{ ids: string[]; resolved: Set<string> }>({
    ids: [],
    resolved: new Set(),
  });
  useLayoutEffect(() => {
    const before = lastShown.current;
    const resolved = new Set(
      threads.filter((thread) => thread.resolved).map((thread) => thread.id),
    );
    lastShown.current = { ids: shown.map((thread) => thread.id), resolved };
    if (!selectedId || before.resolved.has(selectedId)) return;
    if (!resolved.has(selectedId)) return;
    const at = before.ids.indexOf(selectedId);
    const openNow = new Set(
      shown.filter((thread) => !thread.resolved).map((thread) => thread.id),
    );
    const next =
      before.ids.slice(at + 1).find((id) => openNow.has(id)) ??
      before.ids
        .slice(0, Math.max(0, at))
        .reverse()
        .find((id) => openNow.has(id));
    if (next) setSelectedId(next);
  }, [threads, shown, selectedId]);

  // Only a move by key brings the selection into view: a new list (a thread
  // resolved, an answer come in) leaves the scroll where it is.
  useEffect(() => {
    if (!scrollToSelection.current || !selectedKey) return;
    scrollToSelection.current = false;
    panelRef.current
      ?.querySelector(`[data-panel-thread="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const isOpen = (thread: PanelThread) =>
    unfolded.has(thread.id) || replying?.id === thread.id;
  const toggle = (thread: PanelThread) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(thread.id)) next.add(thread.id);
      return next;
    });
  const reply = (thread: PanelThread) => {
    setSelectedId(thread.id);
    onReply(thread.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The answer being written has its own keys.
    if ((event.target as HTMLElement).closest(".threads-panel-reply")) return;
    const inSearch = event.target === searchRef.current;
    const at = selected ? shown.indexOf(selected) : 0;
    const select = (next: PanelThread | undefined) => {
      if (!next) return;
      scrollToSelection.current = next.id !== selected?.id;
      setSelectedId(next.id);
    };
    const move = (delta: number) =>
      select(shown[Math.max(0, Math.min(shown.length - 1, at + delta))]);
    const key = event.ctrlKey ? `C-${event.key}` : event.key;
    let handled = true;
    if (key === "ArrowDown" || key === "C-n") move(1);
    else if (key === "ArrowUp" || key === "C-p") move(-1);
    else if (key === "Enter") {
      if (selected) onGo(selected.id);
    } else if (key === "Escape") {
      if (inSearch) panelRef.current?.focus({ preventScroll: true });
      else onClose();
    } else if (inSearch || event.metaKey || event.altKey || event.ctrlKey)
      handled = false;
    else if (key === "j") move(1);
    else if (key === "k") move(-1);
    else if (key === "g") select(shown[0]);
    else if (key === "G") select(shown[shown.length - 1]);
    else if (key === "o") {
      if (selected) onGo(selected.id);
    } else if (key === " ") {
      if (selected) toggle(selected);
    } else if (key === "r") {
      if (selected) {
        setSelectedId(selected.id);
        onResolve(selected.id);
      }
    } else if (key === "R" || key === "a") {
      if (selected?.canReply) reply(selected);
    } else if (key === "H") toggleShowResolved();
    else if (key === "/") searchRef.current?.focus();
    else if (key === "q" || key === "T") onClose();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const unresolved = threads.filter((thread) => !thread.resolved).length;
  const resolvedCount = threads.length - unresolved;
  const hiddenCount = showResolved ? 0 : matched.resolved.length;
  const resolvedToggle = (label: string) => (
    <button
      type="button"
      className="threads-panel-resolved-toggle"
      aria-pressed={showResolved}
      title={
        showResolved
          ? "Hide the resolved threads (H)"
          : "Show the resolved threads after the open ones (H)"
      }
      onClick={toggleShowResolved}
    >
      {label}
    </button>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a list with keys
    <div
      ref={panelRef}
      className={`threads-panel ${className}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="threads-panel-head">
        <strong>{title}</strong>
        <span className="threads-panel-count">
          {unresolved} open
          {resolvedCount ? (
            <>
              {" · "}
              {resolvedToggle(
                `${resolvedCount} resolved, ${showResolved ? "hide" : "show"}`,
              )}
            </>
          ) : null}
        </span>
        <button
          type="button"
          className="threads-panel-close"
          title="Close (Esc)"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {threads.length ? (
        <input
          ref={searchRef}
          type="search"
          className="threads-panel-search"
          placeholder="Search (/): words, author, where... Enter goes, Esc back"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId(null);
          }}
        />
      ) : (
        <p className="threads-panel-note">No comment yet.</p>
      )}
      {threads.length && !shown.length ? (
        <p className="threads-panel-note">
          {!hiddenCount
            ? "Nothing matches."
            : query.trim()
              ? "Nothing open matches."
              : "Nothing open."}
        </p>
      ) : null}
      <div
        ref={listRef}
        className="threads-panel-list"
        onScroll={(event) => {
          if (place) place.scrollTop = event.currentTarget.scrollTop;
        }}
      >
        {shown.flatMap((thread, index) => {
          const open = isOpen(thread);
          const firstResolved =
            thread.resolved && (index === 0 || !shown[index - 1]?.resolved);
          const first = thread.comments[0];
          const last = thread.comments[thread.comments.length - 1];
          return [
            firstResolved ? (
              <div key="resolved-group" className="threads-panel-group">
                {resolvedToggle(`${matched.resolved.length} resolved, hide`)}
              </div>
            ) : null,
            // biome-ignore lint/a11y/useKeyWithClickEvents: j / k select by key
            <section
              key={thread.id}
              data-panel-thread={thread.id}
              className={`threads-panel-item${thread === selected ? " is-selected" : ""}${thread.resolved ? " is-resolved" : ""}`}
              onClick={(event) => {
                setSelectedId(thread.id);
                // The list keeps the keys, unless words are selected or the
                // click is in the answer being written.
                if (
                  !window.getSelection()?.toString() &&
                  !(event.target as HTMLElement).closest(".threads-panel-reply")
                )
                  panelRef.current?.focus({ preventScroll: true });
              }}
            >
              <div className="threads-panel-top">
                <button
                  type="button"
                  className="threads-panel-where"
                  title="Go to it (Enter)"
                  onClick={() => onGo(thread.id)}
                >
                  {thread.resolved ? "✓ " : ""}
                  {thread.where}
                </button>
                {thread.when ? (
                  <span className="threads-panel-when">{thread.when}</span>
                ) : null}
              </div>
              {thread.meta ? (
                <div className="threads-panel-meta">{thread.meta}</div>
              ) : null}
              <button
                type="button"
                className="threads-panel-summary"
                aria-expanded={open}
                title={open ? "Fold it (Space)" : "Read it (Space)"}
                onClick={() => toggle(thread)}
              >
                <span className="threads-panel-fold">{open ? "▾" : "▸"}</span>
                <span className="threads-panel-first">
                  {open ? "Fold" : summaryLine(first?.body ?? "")}
                </span>
                {open ? null : (
                  <span className="threads-panel-count">
                    {thread.comments.length} message
                    {thread.comments.length === 1 ? "" : "s"}
                    {last && thread.comments.length > 1
                      ? ` · last by ${last.author}`
                      : ""}
                  </span>
                )}
              </button>
              {open
                ? thread.comments.map((comment) => (
                    <div key={comment.id} className="threads-panel-message">
                      <span className="threads-panel-author">
                        {comment.author}
                      </span>
                      {renderBody(thread, comment.body)}
                    </div>
                  ))
                : null}
              {replying?.id === thread.id ? (
                <div className="threads-panel-reply">{replying.editor}</div>
              ) : null}
              <div className="threads-panel-actions">
                <button
                  type="button"
                  title={thread.resolved ? "Reopen it (r)" : "Resolve it (r)"}
                  onClick={() => onResolve(thread.id)}
                >
                  {thread.resolved ? "Reopen" : "Resolve"}
                </button>
                {thread.canReply && replying?.id !== thread.id ? (
                  <button
                    type="button"
                    title="Answer it here (R)"
                    onClick={() => reply(thread)}
                  >
                    Reply
                  </button>
                ) : null}
                <button
                  type="button"
                  title="Go to it (Enter)"
                  onClick={() => onGo(thread.id)}
                >
                  Go to it
                </button>
                <button
                  type="button"
                  title="Make it a work item: the thread moves to the Work board"
                  onClick={() => void promoteToWork(thread.id)}
                >
                  Work item
                </button>
              </div>
            </section>,
          ];
        })}
        {hiddenCount ? (
          <div className="threads-panel-group">
            {resolvedToggle(`${hiddenCount} resolved, show`)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
