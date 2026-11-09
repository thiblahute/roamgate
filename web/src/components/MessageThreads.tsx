import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ReviewAnchor,
  ReviewComment,
  ReviewMessagePart,
  ReviewThread,
} from "../../../shared/review";
import type { PendingWrite } from "../reviewPending";
import { type MessageParts, NoteBody } from "./ReviewNoteBody";
import { MessageReplyButton, ThreadCard } from "./ThreadCard";
import { type ThreadBox, ThreadEditor } from "./ThreadEditor";

/*
 * Messages with threads on their parts, one way for an agent chat's
 * messages (ChatThreads) and the Files preview's threads (FileThreads): a
 * message is drawn by NoteBody in parts, the + beside a part opens a
 * thread on it quoting it, and the threads on a part are drawn under it,
 * their own messages in parts too. Reply on a thread's
 * message (or R on it) opens a thread on the whole message, quoting
 * nothing (`message: {thread, comment}`): such threads are drawn under
 * the message after those on its parts (MessageNotes), their head saying
 * "On this message". j / k stop on the parts (`q:COMMENT:PART` for a
 * thread's message, the list's own key for another message), the
 * threads' messages (`m:COMMENT`) and folded threads (`t:THREAD`); a
 * thread's message in one part is that message's stop. Words selected in
 * a message offer Comment, a thread quoting them.
 */

/**
 * A stop of the keys: its place, as the cursor holds it. A part of a
 * message that is no thread's (a chat's, a Markdown preview's block) is
 * named by `other`.
 */
export function messageStopKey(
  stop: HTMLElement,
  other: (stop: HTMLElement) => string = (part) => `p:${part.dataset.part}`,
): string {
  if (stop.dataset.chatStop) return stop.dataset.chatStop;
  const message =
    stop.dataset.part !== undefined
      ? stop.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
      : undefined;
  if (message) return `q:${message}:${stop.dataset.part}`;
  return other(stop);
}

/**
 * A thread's message in several parts: each is a stop, after the message
 * itself (one part: the message is the stop).
 */
export function partOfLongMessage(stop: HTMLElement): boolean {
  const body = stop.closest<HTMLElement>(".chat-thread-body");
  // Not the parts of the threads drawn in it: on its parts, on the whole.
  return (
    !!body &&
    body.querySelectorAll(":scope [data-part]").length -
      body.querySelectorAll(
        ":scope .rc-part-notes [data-part], :scope .chat-message-notes [data-part]",
      ).length >
      1
  );
}

/**
 * Whether an element is a stop of j / k: a thread's message or folded
 * line, a part of a message that is no thread's, or a part of a thread's
 * message in several.
 */
export function isMessageStop(stop: HTMLElement): boolean {
  return (
    !!stop.dataset.chatStop ||
    (stop.dataset.part !== undefined &&
      (!stop.closest(".chat-thread") || partOfLongMessage(stop)))
  );
}

/** The stops of j / k in `list`, in order; `keep` leaves more out. */
export function messageStops(
  list: HTMLElement,
  selector = ".chat-review [data-part], [data-chat-stop]",
  keep?: (stop: HTMLElement) => boolean,
): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(selector)).filter(
    (stop) =>
      isMessageStop(stop) &&
      (!keep || keep(stop)) &&
      stop.getClientRects().length > 0,
  );
}

/** A part's words, as the quote of a thread on it (its + aside). */
export function partQuote(part: HTMLElement): string {
  const add = part.querySelector(":scope > .rc-part-add");
  return (part.textContent ?? "")
    .replace(add?.textContent ?? "", "")
    .trim()
    .slice(0, 4000);
}

/**
 * c / Enter before a thread is answered: a comment being written in
 * `list` is taken up again; on a part of a thread's message (or of a
 * message `threadOf` names the thread of: a work item's description), a
 * thread on that part quoting it. False lets the key go on.
 */
export function commentOnPart(
  list: HTMLElement | null,
  here: HTMLElement | undefined,
  thread: ReviewThread | undefined,
  setPartDraft: (part: ReviewMessagePart) => void,
  threadOf?: (here: HTMLElement) => string | undefined,
): boolean {
  const draft = list?.querySelector<HTMLElement>(
    ".chat-thread.is-draft .cm-content",
  );
  if (draft) {
    draft.focus();
    return true;
  }
  if (here?.dataset.part === undefined) return false;
  const message =
    here.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
  const owner = thread?.id ?? threadOf?.(here);
  if (!message || !owner) return false;
  setPartDraft({ thread: owner, comment: message, quote: partQuote(here) });
  return true;
}

/**
 * R on a thread's message (its stop, or its first part): a thread on the
 * whole message, quoting nothing, its answer drawn under it after the
 * threads on its parts. A comment being written in `list` is taken up
 * again instead. The message's thread is `thread`, else what `threadOf`
 * names (a work item's description). False lets the key go on (R answers
 * the thread).
 */
export function replyOnMessage(
  list: HTMLElement | null,
  here: HTMLElement | undefined,
  thread: ReviewThread | undefined,
  setPartDraft: (part: ReviewMessagePart) => void,
  threadOf?: (here: HTMLElement) => string | undefined,
): boolean {
  const draft = list?.querySelector<HTMLElement>(
    ".chat-thread.is-draft .cm-content",
  );
  if (draft) {
    draft.focus();
    return true;
  }
  if (!here) return false;
  const stop = here.dataset.chatStop;
  const message = stop?.startsWith("m:")
    ? stop.slice(2)
    : here.dataset.part === "0"
      ? here.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
      : undefined;
  const owner = thread?.id ?? threadOf?.(here);
  if (!message || !owner) return false;
  setPartDraft({ thread: owner, comment: message });
  return true;
}

/** A thread on the whole of a message: on it, quoting none of its words. */
export function onWholeMessage(thread: ReviewThread): boolean {
  const part = thread.anchor.message;
  return !!part && !part.quote;
}

/**
 * The threads on a message: those on its parts, drawn under the words
 * they quote, and those on the whole of it, drawn under it after them.
 */
export function splitMessageThreads(threads: readonly ReviewThread[] = []): {
  onParts: ReviewThread[];
  onMessage: ReviewThread[];
} {
  const onParts: ReviewThread[] = [];
  const onMessage: ReviewThread[] = [];
  for (const thread of threads)
    (onWholeMessage(thread) ? onMessage : onParts).push(thread);
  return { onParts, onMessage };
}

/** Said first of a thread on the whole of a message, drawn under it. */
export function OnMessageHead() {
  return <p className="chat-thread-on">On this message</p>;
}

/**
 * The threads on the whole of a message, under it after the threads on
 * its parts, and the box of one being written (`draft`).
 */
export function MessageNotes({
  threads,
  hidden,
  renderThread,
  draft,
}: {
  threads: readonly ReviewThread[];
  hidden?: ReadonlySet<string>;
  renderThread: (thread: ReviewThread) => ReactNode;
  draft?: ReactNode;
}) {
  const shown = threads.filter((thread) => !hidden?.has(thread.id));
  if (!shown.length && !draft) return null;
  return (
    <div className="chat-message-notes">
      {shown.map(renderThread)}
      {draft}
    </div>
  );
}

/**
 * The parts of a message: the threads on them drawn under the words they
 * quote, and the one being written; the part j / k is on; a click on a
 * part puts the cursor on it (`KEY:PART`), or on the message itself
 * (`messageStop`) when it has one part, that message being the stop.
 */
export function messagePartsOf({
  key,
  threads = [],
  hidden,
  renderThread,
  draft,
  cursor,
  setCursor,
  onComment,
  single,
  messageStop,
}: {
  /** The cursor's prefix for the message's parts: `q:COMMENT`, `p:ENTRY`. */
  key: string;
  threads?: readonly ReviewThread[];
  hidden?: ReadonlySet<string>;
  renderThread: (thread: ReviewThread) => ReactNode;
  /** The box being written on the message, under the words it quotes. */
  draft?: { quote: string; node: ReactNode } | null;
  cursor: string | null;
  setCursor: (key: string) => void;
  /** + beside a part: a thread on it, quoting it. */
  onComment: (quote: string) => void;
  /** The message is a stop in one part too (one that is no thread's). */
  single?: boolean;
  /** A thread's message: its own stop (`m:COMMENT`). */
  messageStop?: string;
}): MessageParts {
  const notes = threads
    .filter((thread) => !hidden?.has(thread.id))
    .map((thread) => ({
      key: thread.id,
      quote: thread.anchor.message?.quote ?? thread.anchor.chat?.quote ?? "",
      node: renderThread(thread),
    }));
  if (draft) notes.push({ key: "draft", quote: draft.quote, node: draft.node });
  const at = `${key}:`;
  return {
    notes,
    focused: cursor?.startsWith(at) ? Number(cursor.slice(at.length)) : null,
    onComment,
    onSelect: (part) => {
      if (messageStop && !single) {
        const body = document.querySelector(
          `[data-message-id="${CSS.escape(messageStop.replace(/^m:/, ""))}"]`,
        );
        const parts =
          body?.querySelectorAll(":scope > .rc-text > [data-part]").length ?? 0;
        if (parts <= 1) {
          setCursor(messageStop);
          return;
        }
      }
      setCursor(`${at}${part}`);
    },
    ...(single ? { single: true } : {}),
  };
}

/** A comment box of the threads: an answer to a thread, or on a part. */
export type BoxKey = { reply: string } | { part: ReviewMessagePart };

/**
 * What a list's threads share: the threads on parts of messages, where
 * j / k are, what is folded, the boxes open, the writes on their way, and
 * how a thread on a part is anchored and its box kept (the chat keeps
 * its boxes' words; a work item's anchor says the item).
 */
export type MessageThreadsScope = {
  /** The threads on parts of messages, by the message. */
  byMessage: ReadonlyMap<string, ReviewThread[]>;
  /** Threads left out (only the unresolved ones shown). */
  hidden?: ReadonlySet<string>;
  cursor: string | null;
  setCursor: (key: string) => void;
  /** Threads folded or unfolded by hand: resolved ones start folded. */
  flipped: ReadonlySet<string>;
  toggleFold: (thread: ReviewThread) => void;
  /** The thread whose answer is being written. */
  replying: string | null;
  setReplying: (id: string | null) => void;
  /**
   * The thread being written on a part: the message, the words (none: on
   * the whole message, Reply on it).
   */
  partDraft: ReviewMessagePart | null;
  setPartDraft: (part: ReviewMessagePart | null) => void;
  /** The anchor of a thread on a part: the chat's, the work item's. */
  partAnchor: (part: ReviewMessagePart) => ReviewAnchor;
  partPlaceholder: string;
  pendingById: ReadonlyMap<string, PendingWrite>;
  /** Your comments the agent did not get, and what is said beside them. */
  undelivered?: { ids: ReadonlySet<string>; text: string } | null;
  write: (method: string, params: Record<string, unknown>) => Promise<boolean>;
  send: (write: Omit<PendingWrite, "sessionId" | "at">) => Promise<boolean>;
  /** A box's kept words, focus and image store. */
  box: (key: BoxKey) => {
    kept?: ThreadBox;
    autoFocus?: boolean;
    onAddImage?: (file: File) => Promise<string>;
  };
  /** A box closed, with the id of what it last sent (a failed write goes). */
  onCloseBox?: (id?: string) => void;
  /** A box closed or left: the keys go back where they were. */
  onLeave: () => void;
  /** Drawn before a thread's messages: where it was written. */
  head?: (thread: ReviewThread) => ReactNode;
};

/**
 * A thread drawn where it is: its messages in parts, the threads on their
 * parts under them (drawn the same) and those on the whole of them after,
 * Reply on each message, the answer being written, its writes on their
 * way or not delivered. `onMessage`: drawn under the message it is on,
 * its head says so.
 */
export function MessageThread({
  thread,
  scope,
  onMessage = false,
}: {
  thread: ReviewThread;
  scope: MessageThreadsScope;
  onMessage?: boolean;
}) {
  const pendingOf = (message: ReviewComment, index: number) =>
    scope.pendingById.get(message.id) ??
    (index === 0 ? scope.pendingById.get(thread.id) : undefined);
  return (
    <ThreadCard
      thread={thread}
      folded={thread.resolved !== scope.flipped.has(thread.id)}
      cursor={scope.cursor}
      onToggleFold={() => scope.toggleFold(thread)}
      onReply={() => scope.setReplying(thread.id)}
      onReplyMessage={(message) =>
        scope.setPartDraft({ thread: thread.id, comment: message.id })
      }
      onResolve={() =>
        void scope.write("review.resolve", {
          comment_id: thread.id,
          resolved: !thread.resolved,
        })
      }
      onDelete={() =>
        void scope.write("review.delete", { comment_id: thread.id })
      }
      head={scope.head?.(thread) ?? (onMessage ? <OnMessageHead /> : undefined)}
      messageClass={(message, index) =>
        pendingOf(message, index) ? " is-pending" : ""
      }
      authorExtra={(message, index) => {
        const pending = pendingOf(message, index);
        return pending ? (
          <span
            className={`chat-thread-pending${pending.error ? " is-failed" : ""}`}
            role={pending.error ? "alert" : "status"}
          >
            {pending.error ? "Not saved: Send tries again" : "Sending..."}
          </span>
        ) : scope.undelivered?.ids.has(message.id) ? (
          <>
            <span className="chat-thread-pending is-failed" role="status">
              {scope.undelivered.text}
            </span>
            <button
              type="button"
              className="chat-thread-retry"
              onClick={() => void scope.write("review.retry", {})}
            >
              Retry
            </button>
          </>
        ) : null;
      }}
      body={(message) => (
        <ThreadMessageBody scope={scope} thread={thread} message={message} />
      )}
      footer={
        scope.pendingById.has(thread.id) ? null : scope.replying ===
          thread.id ? (
          <ThreadEditor
            {...scope.box({ reply: thread.id })}
            placeholder="Reply..."
            onLeave={scope.onLeave}
            onClose={(id) => {
              scope.onCloseBox?.(id);
              scope.setReplying(null);
              scope.onLeave();
            }}
            onSave={(text, id) =>
              scope
                .send({
                  id,
                  replyTo: thread.id,
                  kind: thread.kind,
                  anchor: thread.anchor,
                  text,
                })
                .then((ok) => {
                  if (!ok) return;
                  scope.setReplying(null);
                  scope.onLeave();
                })
            }
          />
        ) : undefined
      }
    />
  );
}

/**
 * A thread's message (`message`, of `thread`) as it is drawn: its parts
 * with the threads on them under the words they quote (threadMessageParts),
 * then the threads on the whole of it and the box of one being written
 * (MessageNotes). `single`: a message that is a stop on its own even in
 * one part (a work item's description); `actions`: Reply in a row of its
 * own under it, for a message with no author row to hold it.
 */
export function ThreadMessageBody({
  scope,
  thread,
  message,
  single = false,
  actions = false,
}: {
  scope: MessageThreadsScope;
  thread: ReviewThread;
  message: ReviewComment;
  single?: boolean;
  actions?: boolean;
}) {
  const comment = message.id;
  const { onMessage } = splitMessageThreads(scope.byMessage.get(comment));
  const draft = scope.partDraft;
  return (
    <>
      <NoteBody
        text={message.body}
        parts={threadMessageParts(scope, thread, comment, { single })}
      />
      {actions ? (
        <div className="chat-thread-message-actions">
          <MessageReplyButton
            onClick={() => scope.setPartDraft({ thread: thread.id, comment })}
          />
        </div>
      ) : null}
      <MessageNotes
        threads={onMessage}
        hidden={scope.hidden}
        renderThread={(nested) => (
          <MessageThread
            key={nested.id}
            thread={nested}
            scope={scope}
            onMessage
          />
        )}
        draft={
          draft?.comment === comment && !draft.quote ? (
            <PartDraft scope={scope} draft={draft} placeholder="Reply..." />
          ) : null
        }
      />
    </>
  );
}

/**
 * The parts of a thread's message (`comment`): the threads on them, and
 * the one being written, under them (those on the whole message are
 * drawn after the message, by ThreadMessageBody). `single`: a message
 * that is a stop on its own even in one part (a work item's description).
 */
export function threadMessageParts(
  scope: MessageThreadsScope,
  thread: ReviewThread,
  comment: string,
  options: { single?: boolean } = {},
): MessageParts {
  const draft = scope.partDraft;
  return messagePartsOf({
    key: `q:${comment}`,
    threads: splitMessageThreads(scope.byMessage.get(comment)).onParts,
    hidden: scope.hidden,
    renderThread: (nested) => (
      <MessageThread key={nested.id} thread={nested} scope={scope} />
    ),
    draft:
      draft?.comment === comment && draft.quote
        ? {
            quote: draft.quote,
            node: <PartDraft scope={scope} draft={draft} />,
          }
        : null,
    cursor: scope.cursor,
    setCursor: scope.setCursor,
    onComment: (quote) =>
      scope.setPartDraft({
        thread: thread.id,
        comment,
        quote: quote.trim().slice(0, 4000),
      }),
    ...(options.single ? { single: true } : { messageStop: `m:${comment}` }),
  });
}

/**
 * The box of a thread being written on a part of a message, or on the
 * whole of it (`placeholder` says which).
 */
function PartDraft({
  scope,
  draft,
  placeholder = scope.partPlaceholder,
}: {
  scope: MessageThreadsScope;
  draft: ReviewMessagePart;
  placeholder?: string;
}) {
  return (
    <div className="chat-thread is-draft">
      <ThreadEditor
        {...scope.box({ part: draft })}
        placeholder={placeholder}
        onLeave={scope.onLeave}
        onClose={(id) => {
          scope.onCloseBox?.(id);
          scope.setPartDraft(null);
          scope.onLeave();
        }}
        onSave={(text, id) =>
          scope
            .send({
              id,
              kind: "discussion",
              anchor: scope.partAnchor(draft),
              text,
            })
            .then((ok) => {
              if (!ok) return;
              scope.setPartDraft(null);
              scope.onLeave();
            })
        }
      />
    </div>
  );
}

/** Words selected, and where Comment is offered on them. */
export type SelectedAt = { quote: string; x: number; y: number };

/**
 * The words selected now, where `locate` says they are (null: not in
 * what it offers Comment on), and where to put the offer: under the
 * selection, past a touch screen's handles.
 */
export function selectedWords<T>(
  locate: (start: Element, range: Range) => T | null,
): (T & SelectedAt) | null {
  const current = window.getSelection();
  const range =
    current && !current.isCollapsed && current.rangeCount === 1
      ? current.getRangeAt(0)
      : null;
  const start =
    range?.startContainer instanceof Element
      ? range.startContainer
      : range?.startContainer.parentElement;
  const quote = current?.toString().trim() ?? "";
  if (!range || !start || !quote) return null;
  const found = locate(start, range);
  if (!found) return null;
  const rect = range.getBoundingClientRect();
  // On a touch screen the selection's handles hang under its ends: Comment
  // goes below them, 44px high, where a finger reaches it.
  const touch = window.matchMedia?.("(pointer: coarse)").matches;
  return {
    ...found,
    quote,
    x: Math.max(8, Math.min(rect.left, window.innerWidth - 120)),
    y: Math.max(
      8,
      Math.min(
        rect.bottom + (touch ? 32 : 8),
        window.innerHeight - (touch ? 52 : 44),
      ),
    ),
  };
}

/**
 * The words selected as they change (settled for a moment), where
 * `locate` says they are; and a way to let the offer go.
 */
export function useSelectedWords<T>(
  locate: (start: Element, range: Range) => T | null,
): [(T & SelectedAt) | null, () => void] {
  const [selection, setSelection] = useState<(T & SelectedAt) | null>(null);
  const locateRef = useRef(locate);
  locateRef.current = locate;
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setSelection(selectedWords(locateRef.current)),
        200,
      );
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);
  return [selection, () => setSelection(null)];
}

/**
 * Comment, offered on the words selected: a button where they end, and
 * the view's other choices (`more`, Add to Work in a chat) beside it.
 */
export function SelectionOffer({
  at,
  className,
  onClick,
  children = "Comment",
  more,
}: {
  at: { x: number; y: number };
  className?: string;
  onClick: () => void;
  children?: ReactNode;
  more?: readonly { label: string; onClick: () => void }[];
}) {
  // Keeps the selection while a button is pressed.
  const keep = {
    onPointerDown: (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    onMouseDown: (event: { preventDefault: () => void }) =>
      event.preventDefault(),
  };
  const classes = `chat-thread-select${className ? ` ${className}` : ""}`;
  if (more?.length)
    return createPortal(
      <div
        className={`chat-thread-select-group${className ? ` ${className}` : ""}`}
        style={{ left: at.x, top: at.y }}
      >
        <button type="button" className={classes} {...keep} onClick={onClick}>
          {children}
        </button>
        {more.map((each) => (
          <button
            key={each.label}
            type="button"
            className={classes}
            {...keep}
            onClick={each.onClick}
          >
            {each.label}
          </button>
        ))}
      </div>,
      document.body,
    );
  return createPortal(
    <button
      type="button"
      className={classes}
      style={{ left: at.x, top: at.y }}
      {...keep}
      onClick={onClick}
    >
      {children}
    </button>,
    document.body,
  );
}
