import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./ThreadsPanel.css";

/**
 * The comments of a review or of an agent chat, beside what they are on:
 * one line each, open ones first, unfolded to read or answer, searched with
 * /. The review and the chat give their threads and what acting on one
 * means there.
 */

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

/** "2 open · 10 comments": opens the panel. */
export function ThreadsChip({
  threads,
  open,
  onToggle,
  className = "",
}: {
  threads: readonly { resolved: boolean }[];
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const unresolved = threads.filter((thread) => !thread.resolved).length;
  return (
    <button
      type="button"
      className={`threads-chip ${className}`}
      aria-expanded={open}
      title="The comments (T)"
      onClick={onToggle}
    >
      <span>{unresolved} open</span>
      <span className="threads-chip-total">
        {" "}
        · {threads.length} comment{threads.length === 1 ? "" : "s"}
      </span>
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
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Unfolded by hand: each one is one line until then. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());

  // The list has the keys from the start; / goes to the search.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return threads;
    return threads.filter((thread) => {
      const text = [
        thread.where,
        thread.meta ?? "",
        thread.search ?? "",
        thread.resolved ? "resolved" : "open",
        ...thread.comments.flatMap((comment) => [comment.author, comment.body]),
      ]
        .join("\n")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [threads, query]);
  const selected = shown.find((thread) => thread.id === selectedId) ?? shown[0];

  useEffect(() => {
    if (!selected) return;
    panelRef.current
      ?.querySelector(`[data-panel-thread="${CSS.escape(selected.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

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
    const move = (delta: number) => {
      const next = shown[Math.max(0, Math.min(shown.length - 1, at + delta))];
      if (next) setSelectedId(next.id);
    };
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
    else if (key === "g") setSelectedId(shown[0]?.id ?? null);
    else if (key === "G") setSelectedId(shown[shown.length - 1]?.id ?? null);
    else if (key === "o") {
      if (selected) onGo(selected.id);
    } else if (key === " ") {
      if (selected) toggle(selected);
    } else if (key === "r") {
      if (selected) onResolve(selected.id);
    } else if (key === "R" || key === "a") {
      if (selected?.canReply) reply(selected);
    } else if (key === "/") searchRef.current?.focus();
    else if (key === "q" || key === "T") onClose();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const unresolved = threads.filter((thread) => !thread.resolved).length;
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
          {unresolved} open · {threads.length}
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
        <p className="threads-panel-note">Nothing matches.</p>
      ) : null}
      <div className="threads-panel-list">
        {shown.map((thread) => {
          const open = isOpen(thread);
          const first = thread.comments[0];
          const last = thread.comments[thread.comments.length - 1];
          return (
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
                  {open ? "Fold" : (first?.body ?? "").split("\n")[0]}
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
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
