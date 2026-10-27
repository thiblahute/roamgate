import {
  createContext,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  REVIEW_USER,
  type ReviewChatPart,
  type ReviewMessagePart,
  type ReviewSnapshot,
  type ReviewThread,
} from "../../../shared/review";
import { roamgateLocalStorage } from "../browserStorage";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "../review";
import type { HistoryEntry } from "./agentHistory";
import { lazyWithReload } from "../lazyWithReload";
import { type MessageParts, NoteBody } from "./ReviewNoteBody";
import { type PanelThread, ThreadsChip, ThreadsPanel } from "./ThreadsPanel";
import { formatUiDateTime } from "../uiLocale";
import { CHAT_PARTS_EVENT } from "./chatPaging";
import "./ChatThreads.css";

/**
 * Comment threads on parts of an agent chat's messages: a review of the chat
 * (target `chat`), whose threads the agent gets as it gets review comments
 * and answers in them. Drawn under the part of the message they quote.
 */

type ChatThreads = {
  /** The parts of a message one comments on, and the threads on them. */
  partsFor: (entry: HistoryEntry) => MessageParts;
};

const ChatThreadsContext = createContext<ChatThreads | null>(null);

/** Parts and threads for a message, when the chat has threads. */
export function useChatParts(entry: HistoryEntry): MessageParts | undefined {
  return useContext(ChatThreadsContext)?.partsFor(entry);
}

/**
 * A message Roamgate typed for you to hand review comments (the chat's own
 * threads included) to the agent: shown as one line, the threads being
 * where they are read.
 */
export function reviewDelivery(
  text: string,
): { title: string; count: number } | null {
  const body = text.replace(/^\s*<pasted_content[^>]*>\s*/, "");
  const head = /^\[Roamgate review "([^"\n]*)" \(([^)\n]*)\)\]/.exec(body);
  if (!head) return null;
  const count = body.match(/^- \[[0-9a-f]{8}\]/gm)?.length ?? 0;
  return { title: head[2] === "chat" ? "this chat" : head[1]!, count };
}

/** Vim keys in comment boxes: the review's `:vim` setting. */
function vimKeys(): boolean {
  try {
    const prefs = JSON.parse(
      roamgateLocalStorage.getItem("reviewPrefs") ?? "{}",
    ) as { vim?: boolean };
    return prefs.vim !== false;
  } catch {
    return true;
  }
}

/** How a message starts, for the agent to tell which one is meant. */
function excerptOf(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.replace(/[#>*_`[\]-]/g, " ").trim())
      .find(Boolean) ?? "";
  const words = line.replace(/\s+/g, " ");
  return words.length > 80 ? `${words.slice(0, 80)}…` : words;
}

// The editor is loaded with the first comment box, not with the chat.
const ReviewCommentEditor = lazyWithReload("review-comment-editor", () =>
  import("./ReviewCommentEditor").then((module) => ({
    default: module.ReviewCommentEditor,
  })),
);

/** A comment box: Cmd+Enter or :w saves, Esc on an empty one closes. */
function ThreadEditor({
  placeholder,
  onSave,
  onClose,
  onLeave,
}: {
  placeholder: string;
  onSave: (text: string) => void;
  onClose: () => void;
  /** Esc with words written: they stay, the keys go back to the chat. */
  onLeave: () => void;
}) {
  const text = useRef("");
  const [vim] = useState(vimKeys);
  return (
    <div className="chat-thread-editor">
      <Suspense fallback={null}>
        <ReviewCommentEditor
          value=""
          vimMode={vim}
          placeholder={placeholder}
          onChange={(value) => {
            text.current = value;
          }}
          onCommit={(explicit) => {
            if (explicit && text.current.trim()) onSave(text.current);
            // Leaving a box with words in it keeps them.
            else if (!text.current.trim()) onClose();
            else if (!explicit) onLeave();
          }}
          onCancel={onClose}
          onSuggest={() => {}}
        />
      </Suspense>
      <div className="chat-thread-bar">
        <span className="chat-thread-hint">Cmd+Enter sends</span>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={() => {
            if (text.current.trim()) onSave(text.current);
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export function ChatThreadsProvider({
  connectionId,
  workspaceId,
  chat,
  path,
  agent,
  paneId,
  children,
}: {
  connectionId: string;
  workspaceId: string;
  /** The chat: its agent session. */
  chat: string;
  /** The agent's directory. */
  path: string;
  agent: string;
  paneId: string;
  children: ReactNode;
}) {
  const reviews = useReviewState();
  const snapshot = useMemo(
    () =>
      [...reviews.sessions.values()].find(
        ({ session }) =>
          session.connectionId === connectionId &&
          session.target.kind === "chat" &&
          session.target.chat === chat,
      ),
    [reviews.sessions, connectionId, chat],
  );
  const byEntry = useMemo(() => {
    const threads = new Map<string, ReviewThread[]>();
    for (const thread of snapshot?.threads ?? []) {
      const entry = thread.anchor.chat?.entry;
      if (entry) threads.set(entry, [...(threads.get(entry) ?? []), thread]);
    }
    return threads;
  }, [snapshot]);
  const [draft, setDraft] = useState<ReviewChatPart | null>(null);
  // Threads on parts of the threads' own messages, by the message, and the
  // one being written.
  const byMessage = useMemo(() => {
    const threads = new Map<string, ReviewThread[]>();
    for (const thread of snapshot?.threads ?? []) {
      const comment = thread.anchor.message?.comment;
      if (comment)
        threads.set(comment, [...(threads.get(comment) ?? []), thread]);
    }
    return threads;
  }, [snapshot]);
  const [partDraft, setPartDraft] = useState<ReviewMessagePart | null>(null);
  /**
   * Where j / k are: a part of a message (`p:ENTRY:PART`), a message of a
   * thread (`m:COMMENT`) or a folded thread (`t:THREAD`).
   */
  const [cursor, setCursor] = useState<string | null>(null);
  /** Threads folded or unfolded by hand: resolved ones start folded. */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [replying, setReplying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const entries = useRef(new Map<string, HistoryEntry>());

  const sessionId = useRef<string | null>(null);
  sessionId.current = snapshot?.session.id ?? null;
  /** Writes, then reads the review back so what you wrote shows at once. */
  const write = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setError("");
      try {
        let id = sessionId.current;
        if (!id) {
          const opened = await reviewCall<ReviewSnapshot>(
            connectionId,
            "review.open",
            {
              workspace_id: workspaceId,
              path,
              target: { kind: "chat", chat },
              title: `Chat with ${agent}`,
              agent,
              agent_pane: paneId,
            },
          );
          rememberReviewSnapshot(opened);
          id = opened.session.id;
        }
        await reviewCall(connectionId, method, { session_id: id, ...params });
        rememberReviewSnapshot(
          await reviewCall<ReviewSnapshot>(connectionId, "review.get", {
            session_id: id,
          }),
        );
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [connectionId, workspaceId, path, chat, agent, paneId],
  );

  const comment = useCallback((entry: HistoryEntry, quote: string) => {
    setDraft({
      entry: entry.id,
      quote: quote.trim().slice(0, 4000),
      ...(entry.sent_at ? { at: entry.sent_at } : {}),
      excerpt: excerptOf(entry.text),
    });
    window.getSelection()?.removeAllRanges();
  }, []);

  /**
   * A comment box closed (sent or not): the keys go back to the
   * conversation, where the cursor still is.
   */
  const backToConversation = () =>
    requestAnimationFrame(() =>
      scopeRef.current
        ?.querySelector<HTMLElement>(".agent-history-chat")
        ?.focus({ preventScroll: true }),
    );

  const toggleFold = (thread: ReviewThread) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(thread.id)) next.delete(thread.id);
      else next.add(thread.id);
      return next;
    });

  const renderThread = (thread: ReviewThread): ReactNode => {
    const folded = thread.resolved !== flipped.has(thread.id);
    const first = thread.comments[0];
    if (folded)
      return (
        <button
          type="button"
          className={`chat-thread is-folded${cursor === `t:${thread.id}` ? " is-focused" : ""}`}
          data-thread-id={thread.id}
          data-chat-stop={`t:${thread.id}`}
          onClick={() => toggleFold(thread)}
          title="Unfold"
        >
          <span className="chat-thread-mark">
            {thread.resolved ? "✓ Resolved" : "▸ Folded"}
          </span>
          <span className="chat-thread-summary">
            {(first?.body ?? "").split("\n")[0]}
          </span>
          <span className="chat-thread-count">
            {thread.comments.length} message
            {thread.comments.length === 1 ? "" : "s"}
          </span>
        </button>
      );
    return (
      <div
        className={`chat-thread${thread.resolved ? " is-resolved" : ""}`}
        data-thread-id={thread.id}
      >
        {thread.comments.map((message) => (
          <div
            key={message.id}
            className={`chat-thread-message${message.author === REVIEW_USER ? "" : " from-agent"}${cursor === `m:${message.id}` ? " is-focused" : ""}`}
            data-chat-stop={`m:${message.id}`}
          >
            <span className="chat-thread-author">
              {message.author === REVIEW_USER ? "You" : message.author}
            </span>
            {/* Its parts take comments too, drawn under them. */}
            <div className="chat-thread-body" data-message-id={message.id}>
              <NoteBody
                text={message.body}
                parts={messageParts(thread, message.id)}
              />
            </div>
          </div>
        ))}
        {replying === thread.id ? (
          <ThreadEditor
            placeholder="Reply..."
            onLeave={backToConversation}
            onClose={() => {
              setReplying(null);
              backToConversation();
            }}
            onSave={(text) =>
              void write("review.reply", { comment_id: thread.id, text }).then(
                (ok) => {
                  if (!ok) return;
                  setReplying(null);
                  backToConversation();
                },
              )
            }
          />
        ) : (
          <div className="chat-thread-bar">
            <button type="button" onClick={() => setReplying(thread.id)}>
              Reply
            </button>
            <button
              type="button"
              onClick={() =>
                void write("review.resolve", {
                  comment_id: thread.id,
                  resolved: !thread.resolved,
                })
              }
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
            <button type="button" onClick={() => toggleFold(thread)}>
              Fold
            </button>
            {thread.comments.length === 1 && first?.author === REVIEW_USER ? (
              <button
                type="button"
                onClick={() =>
                  void write("review.delete", { comment_id: thread.id })
                }
              >
                Delete
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  /** The parts of a thread's message, and the threads on them. */
  const messageParts = (
    thread: ReviewThread,
    comment: string,
  ): MessageParts => {
    const notes = (byMessage.get(comment) ?? []).map((nested) => ({
      key: nested.id,
      quote: nested.anchor.message?.quote ?? "",
      node: renderThread(nested),
    }));
    if (partDraft?.comment === comment)
      notes.push({
        key: "draft",
        quote: partDraft.quote,
        node: (
          <div className="chat-thread is-draft">
            <ThreadEditor
              placeholder={`Comment for ${agent}...`}
              onLeave={backToConversation}
              onClose={() => {
                setPartDraft(null);
                backToConversation();
              }}
              onSave={(text) =>
                void write("review.thread.add", {
                  kind: "discussion",
                  anchor: { message: partDraft },
                  text,
                }).then((ok) => {
                  if (!ok) return;
                  setPartDraft(null);
                  backToConversation();
                })
              }
            />
          </div>
        ),
      });
    return {
      notes,
      focused: cursor?.startsWith(`q:${comment}:`)
        ? Number(cursor.slice(comment.length + 3))
        : null,
      onComment: (quote) =>
        setPartDraft({
          thread: thread.id,
          comment,
          quote: quote.trim().slice(0, 4000),
        }),
      onSelect: (part) => setCursor(`q:${comment}:${part}`),
    };
  };

  const partsFor = (entry: HistoryEntry): MessageParts => {
    entries.current.set(entry.id, entry);
    const notes = (byEntry.get(entry.id) ?? []).map((thread) => ({
      key: thread.id,
      quote: thread.anchor.chat?.quote ?? "",
      node: renderThread(thread),
    }));
    if (draft?.entry === entry.id)
      notes.push({
        key: "draft",
        quote: draft.quote,
        node: (
          <div className="chat-thread is-draft">
            <ThreadEditor
              placeholder={`Comment for ${agent}...`}
              onLeave={backToConversation}
              onClose={() => {
                setDraft(null);
                backToConversation();
              }}
              onSave={(text) =>
                void write("review.thread.add", {
                  kind: "discussion",
                  anchor: { chat: draft },
                  text,
                }).then((ok) => {
                  if (!ok) return;
                  setDraft(null);
                  backToConversation();
                })
              }
            />
          </div>
        ),
      });
    return {
      notes,
      focused: cursor?.startsWith(`p:${entry.id}:`)
        ? Number(cursor.slice(entry.id.length + 3))
        : null,
      onComment: (quote) => comment(entry, quote),
      onSelect: (part) => setCursor(`p:${entry.id}:${part}`),
      single: true,
    };
  };

  // The keys: from the message box (k on its first line in normal mode, or
  // Alt+Up) into the conversation. There j / k step through the parts of
  // the agent's messages and the threads under them; c comments on a part
  // (or answers a thread), r resolves, za folds, zz / zt / zb place, and i
  // or Esc go back to the box.
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const threadsById = useMemo(
    () => new Map((snapshot?.threads ?? []).map((t) => [t.id, t])),
    [snapshot],
  );
  const flippedRef = useRef(flipped);
  flippedRef.current = flipped;
  // The chat's comments, open ones first, then the latest message.
  const overview = useMemo(
    () =>
      [...(snapshot?.threads ?? [])]
        .filter((thread) => thread.anchor.chat || thread.anchor.message)
        .map((thread) => ({
          thread,
          last: thread.comments.reduce(
            (latest, c) => (c.updatedAt > latest ? c.updatedAt : latest),
            thread.createdAt,
          ),
        }))
        .sort(
          (a, b) =>
            Number(a.thread.resolved) - Number(b.thread.resolved) ||
            b.last.localeCompare(a.last),
        )
        .map(({ thread }) => thread),
    [snapshot],
  );
  const [overviewOpen, setOverviewOpen] = useState(false);
  /** The thread answered from the panel. */
  const [panelReply, setPanelReply] = useState<string | null>(null);
  const panelThreads = useMemo<PanelThread[]>(
    () =>
      overview.map((thread) => {
        const part = thread.anchor.chat;
        const nested = thread.anchor.message;
        const last = thread.comments[thread.comments.length - 1];
        return {
          id: thread.id,
          resolved: thread.resolved,
          where: ((part ?? nested)?.quote ?? "").split("\n")[0] ?? "",
          meta: nested
            ? "On a message of a thread"
            : `On ${agent}'s message${part?.at ? ` of ${new Date(part.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${part?.excerpt ? `: ${part.excerpt}` : ""}`,
          when: last ? formatUiDateTime(last.updatedAt) : undefined,
          comments: thread.comments.map((comment) => ({
            id: comment.id,
            author: comment.author === REVIEW_USER ? "You" : comment.author,
            body: comment.body,
          })),
          canReply: true,
        };
      }),
    [overview, agent],
  );
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  // The chat's frame, found again whenever it is drawn anew (an empty chat,
  // a reload of its history).
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const find = () =>
      setFrame(
        scope.querySelector<HTMLElement>(".agent-history-chat-frame") ?? null,
      );
    find();
    const observer = new MutationObserver(find);
    observer.observe(scope, { childList: true });
    return () => observer.disconnect();
  }, []);
  /** Puts j / k on a thread (its first message, or its folded line). */
  const goToThread = useCallback((id: string, commentId?: string) => {
    const list = scopeRef.current?.querySelector<HTMLElement>(
      ".agent-history-chat",
    );
    const element = list?.querySelector<HTMLElement>(
      `.chat-thread[data-thread-id="${CSS.escape(id)}"]`,
    );
    if (!list || !element) return false;
    // A comment of an open thread, else its first one (or its folded line).
    const stop = element.dataset.chatStop
      ? element
      : (commentId &&
          element.querySelector<HTMLElement>(
            `[data-chat-stop="m:${CSS.escape(commentId)}"]`,
          )) ||
        element.querySelector<HTMLElement>("[data-chat-stop]");
    if (stop?.dataset.chatStop) setCursor(stop.dataset.chatStop);
    (stop ?? element).scrollIntoView({ block: "center" });
    list.focus({ preventScroll: true });
    return true;
  }, []);
  const openOverview = useCallback(() => setOverviewOpen(true), []);
  /** g;: the comment written last, yours or the agent's. */
  const goToLatest = useCallback(() => {
    let latest: { thread: string; comment: string; at: string } | null = null;
    for (const thread of snapshot?.threads ?? [])
      if (thread.anchor.chat || thread.anchor.message)
        for (const comment of thread.comments) {
          const at =
            comment.updatedAt > comment.createdAt
              ? comment.updatedAt
              : comment.createdAt;
          if (!latest || at > latest.at)
            latest = { thread: thread.id, comment: comment.id, at };
        }
    if (latest) goToThread(latest.thread, latest.comment);
  }, [snapshot, goToThread]);
  const closeOverview = () => {
    setOverviewOpen(false);
    setPanelReply(null);
    scopeRef.current
      ?.querySelector<HTMLElement>(".agent-history-chat")
      ?.focus({ preventScroll: true });
  };

  const keys = useRef({
    cursor,
    threadsById,
    comment,
    write,
    toggleFold,
    goToThread,
    openOverview,
    goToLatest,
    setPartDraft,
  });
  keys.current = {
    cursor,
    threadsById,
    comment,
    write,
    toggleFold,
    goToThread,
    openOverview,
    goToLatest,
    setPartDraft,
  };
  useEffect(() => {
    const messages = scopeRef.current?.closest<HTMLElement>(
      ".agent-history-messages",
    );
    const list = scopeRef.current?.querySelector<HTMLElement>(
      ".agent-history-chat",
    );
    if (!messages || !list) return;
    list.tabIndex = -1;
    const keyOf = (stop: HTMLElement) => {
      if (stop.dataset.chatStop) return stop.dataset.chatStop;
      const message =
        stop.closest<HTMLElement>(".chat-thread-body")?.dataset.messageId;
      if (message) return `q:${message}:${stop.dataset.part}`;
      const entry =
        stop.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
      return `p:${entry}:${stop.dataset.part}`;
    };
    const stops = () =>
      Array.from(
        list.querySelectorAll<HTMLElement>(
          ".chat-review [data-part], [data-chat-stop]",
        ),
      ).filter(
        (stop) =>
          (stop.dataset.chatStop ||
            !stop.closest(".chat-thread") ||
            partOfLongThreadMessage(stop)) &&
          // The conversation as shown: not what tool calls hold, nor what
          // is hidden.
          !stop.closest(".agent-history-chat-tools") &&
          stop.getClientRects().length > 0,
      );
    // A thread's message in several parts: each is a stop, after the
    // message itself (one part: the message is the stop).
    const partOfLongThreadMessage = (stop: HTMLElement) => {
      const body = stop.closest<HTMLElement>(".chat-thread-body");
      return (
        !!body &&
        body.querySelectorAll(":scope [data-part]").length -
          body.querySelectorAll(":scope .rc-part-notes [data-part]").length >
          1
      );
    };
    const select = (stop: HTMLElement | undefined) => {
      if (!stop) return;
      setCursor(keyOf(stop));
      stop.scrollIntoView({ block: "nearest" });
      list.focus({ preventScroll: true });
    };
    const backToBox = () => {
      setCursor(null);
      list.style.paddingBottom = "";
      messages
        .querySelector<HTMLElement>(
          ".agent-history-composer :is(textarea, [contenteditable='true'])",
        )
        ?.focus({ preventScroll: true });
      // Back where the conversation goes on; at its end the chat follows
      // new messages again.
      list.scrollTop = list.scrollHeight;
    };
    const onEnter = () => {
      const all = stops();
      select(all[all.length - 1]);
    };
    let pending = "";
    const onKey = (event: KeyboardEvent) => {
      if (event.target !== list || event.metaKey || event.ctrlKey) return;
      const {
        cursor,
        threadsById,
        comment,
        write,
        toggleFold,
        goToThread,
        openOverview,
        goToLatest,
      } = keys.current;
      const all = stops();
      const at = all.findIndex((stop) => keyOf(stop) === cursor);
      const here = all[at];
      const threadId =
        here?.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId;
      const thread = threadId ? threadsById.get(threadId) : undefined;
      const key = pending + event.key;
      pending = "";
      const place = (block: ScrollLogicalPosition) => {
        // As Vim does at the end of a file: room below the last messages,
        // until back in the box.
        if (block !== "end")
          list.style.paddingBottom = `${list.clientHeight}px`;
        here?.scrollIntoView({ block });
      };
      if (key === "j" || key === "ArrowDown") {
        // Past the last one: back down into the box.
        if (at >= all.length - 1) backToBox();
        else select(all[at + 1]);
      } else if (key === "k" || key === "ArrowUp")
        select(all[Math.max(0, at - 1)]);
      else if (key === "J" || key === "K") {
        // Message by message: the first part of the next one, or of this
        // one (then the one before) going up.
        const firsts = all.filter(
          (stop) => !stop.dataset.chatStop && stop.dataset.part === "0",
        );
        const entryOf = (stop: HTMLElement | undefined) =>
          stop?.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
        const mine = here
          ? firsts.findIndex((stop) => entryOf(stop) === entryOf(here))
          : firsts.length;
        const target =
          key === "J"
            ? firsts[mine + 1]
            : here && firsts[mine] && firsts[mine] !== here
              ? firsts[mine]
              : firsts[mine - 1];
        select(target);
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
        if (next?.dataset.threadId) goToThread(next.dataset.threadId);
      } else if (key === "T") openOverview();
      else if (key === "gg") select(all[0]);
      else if (key === "G") select(all[all.length - 1]);
      else if (key === "zz") place("center");
      else if (key === "zt") place("start");
      else if (key === "zb") place("end");
      else if (key === "za" && thread) {
        // The cursor stays on the thread, folded or open.
        const folded = here?.dataset.chatStop?.startsWith("t:");
        setCursor(folded ? `m:${thread.comments[0]?.id}` : `t:${thread.id}`);
        toggleFold(thread);
      } else if (key === "g;") goToLatest();
      else if (key === "g" || key === "z" || key === "d") pending = key;
      else if (key === "r" && thread) {
        // Resolving folds it: the cursor follows onto its one line.
        if (!thread.resolved && !flippedRef.current.has(thread.id))
          setCursor(`t:${thread.id}`);
        else if (thread.resolved && here?.dataset.chatStop?.startsWith("t:"))
          setCursor(`m:${thread.comments[0]?.id}`);
        void write("review.resolve", {
          comment_id: thread.id,
          resolved: !thread.resolved,
        });
      } else if (key === "dd" && thread) {
        if (
          thread.comments.length === 1 &&
          thread.comments[0]?.author === REVIEW_USER
        )
          void write("review.delete", { comment_id: thread.id });
      } else if (
        (key === "c" || key === "Enter") &&
        list.querySelector(".chat-thread.is-draft .cm-content")
      )
        // A comment being written: back into it.
        list
          .querySelector<HTMLElement>(".chat-thread.is-draft .cm-content")
          ?.focus();
      else if (
        (key === "c" || key === "Enter") &&
        here?.dataset.part !== undefined &&
        here.closest(".chat-thread-body")
      ) {
        // A part of a thread's message: a thread on it.
        const message =
          here.closest<HTMLElement>(".chat-thread-body")?.dataset.messageId;
        const add = here.querySelector(":scope > .rc-part-add");
        if (message && thread)
          keys.current.setPartDraft({
            thread: thread.id,
            comment: message,
            quote: (here.textContent ?? "")
              .replace(add?.textContent ?? "", "")
              .trim()
              .slice(0, 4000),
          });
      } else if ((key === "c" || key === "Enter" || key === "R") && thread) {
        // An answer being written in that thread: back into it.
        const open = list.querySelector<HTMLElement>(
          `.chat-thread[data-thread-id="${CSS.escape(thread.id)}"] .chat-thread-editor .cm-content`,
        );
        if (open) open.focus();
        else setReplying(thread.id);
      } else if ((key === "c" || key === "Enter") && here) {
        const entry =
          here.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
        const message = entry ? entries.current.get(entry) : undefined;
        if (!message) return;
        const add = here.querySelector(":scope > .rc-part-add");
        comment(
          message,
          (here.textContent ?? "").replace(add?.textContent ?? "", "").trim(),
        );
      } else if (key === "i" || key === "a" || key === "Escape") backToBox();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    // The room zz made below the last messages goes with the keys, however
    // they leave (a click in the box, another pane).
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && list.contains(next)))
        list.style.paddingBottom = "";
    };
    messages.addEventListener(CHAT_PARTS_EVENT, onEnter);
    list.addEventListener("keydown", onKey);
    list.addEventListener("focusout", onFocusOut);
    return () => {
      messages.removeEventListener(CHAT_PARTS_EVENT, onEnter);
      list.removeEventListener("keydown", onKey);
      list.removeEventListener("focusout", onFocusOut);
      list.style.paddingBottom = "";
    };
  }, []);

  // Words selected in a message offer a comment on them.
  const [selection, setSelection] = useState<{
    entry: string;
    quote: string;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = window.getSelection();
        const range =
          current && !current.isCollapsed && current.rangeCount === 1
            ? current.getRangeAt(0)
            : null;
        const start =
          range?.startContainer instanceof Element
            ? range.startContainer
            : range?.startContainer.parentElement;
        const message = start?.closest<HTMLElement>(".chat-review [data-part]")
          ? start?.closest<HTMLElement>("[data-entry-id]")
          : null;
        const quote = current?.toString().trim() ?? "";
        if (!range || !message?.dataset.entryId || !quote) {
          setSelection(null);
          return;
        }
        const rect = range.getBoundingClientRect();
        setSelection({
          entry: message.dataset.entryId,
          quote,
          x: Math.max(8, Math.min(rect.left, window.innerWidth - 120)),
          y: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 44)),
        });
      }, 200);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  // Rebuilt when what partsFor reads changes, not on every render.
  const value = useMemo<ChatThreads>(
    () => ({ partsFor }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      byEntry,
      byMessage,
      draft,
      partDraft,
      cursor,
      flipped,
      replying,
      write,
      comment,
    ],
  );
  return (
    <ChatThreadsContext.Provider value={value}>
      <div ref={scopeRef} className="chat-threads-scope">
        {children}
      </div>
      {frame && overview.length
        ? createPortal(
            <>
              <ThreadsChip
                className="chat-threads-chip"
                threads={overview}
                open={overviewOpen}
                onToggle={() =>
                  overviewOpen ? closeOverview() : openOverview()
                }
              />
              {overviewOpen ? (
                <ThreadsPanel
                  className="chat-threads-panel"
                  threads={panelThreads}
                  onClose={closeOverview}
                  onGo={(id) => {
                    setOverviewOpen(false);
                    goToThread(id);
                  }}
                  onResolve={(id) => {
                    const thread = threadsById.get(id);
                    if (thread)
                      void write("review.resolve", {
                        comment_id: id,
                        resolved: !thread.resolved,
                      });
                  }}
                  onReply={setPanelReply}
                  replying={
                    panelReply
                      ? {
                          id: panelReply,
                          editor: (
                            <ThreadEditor
                              placeholder="Reply..."
                              onClose={() => setPanelReply(null)}
                              onLeave={() => {}}
                              onSave={(text) =>
                                void write("review.reply", {
                                  comment_id: panelReply,
                                  text,
                                }).then((ok) => ok && setPanelReply(null))
                              }
                            />
                          ),
                        }
                      : null
                  }
                  renderBody={(_, body) => <NoteBody text={body} />}
                />
              ) : null}
            </>,
            frame,
          )
        : null}
      {error ? (
        <div className="chat-thread-error" role="alert">
          {error}
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      {selection
        ? createPortal(
            <button
              type="button"
              className="chat-thread-select"
              style={{ left: selection.x, top: selection.y }}
              // Keeps the selection while the button is pressed.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                const entry = entries.current.get(selection.entry);
                if (entry) comment(entry, selection.quote);
                setSelection(null);
              }}
            >
              Comment
            </button>,
            document.body,
          )
        : null}
    </ChatThreadsContext.Provider>
  );
}
