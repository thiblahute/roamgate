import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReviewMessagePart, ReviewThread } from "../../../shared/review";
import type { MessageParts } from "./ReviewNoteBody";

/*
 * Messages with threads on their parts, as an agent chat's messages
 * (ChatThreads) draw them: a message is drawn by NoteBody in parts, the +
 * beside a part opens a thread on it quoting it, and the threads on a
 * part are drawn under it, their own messages in parts too. j / k stop on
 * the parts (`q:COMMENT:PART` for a thread's message, the list's own key
 * for another message), the threads' messages (`m:COMMENT`) and folded
 * threads (`t:THREAD`); a thread's message in one part is that message's
 * stop. Words selected in a message offer Comment, a thread quoting them.
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
  return (
    !!body &&
    body.querySelectorAll(":scope [data-part]").length -
      body.querySelectorAll(":scope .rc-part-notes [data-part]").length >
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

/** Comment, offered on the words selected: a button where they end. */
export function SelectionOffer({
  at,
  className,
  onClick,
  children = "Comment",
}: {
  at: { x: number; y: number };
  className?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return createPortal(
    <button
      type="button"
      className={`chat-thread-select${className ? ` ${className}` : ""}`}
      style={{ left: at.x, top: at.y }}
      // Keeps the selection while the button is pressed.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>,
    document.body,
  );
}
