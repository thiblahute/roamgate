import type { ReactNode } from "react";
import {
  REVIEW_USER,
  type ReviewComment,
  type ReviewThread,
} from "../../../shared/review";
import "./ChatThreads.css";
import { summaryLine } from "./reviewImageUpload";

/**
 * Reply on a message of a thread: a thread on the whole of it, drawn under
 * it (MessageThreads). At the right of the author's row; shown as the
 * pointer is over the message or j / k are on it, always on a phone.
 */
export function MessageReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="chat-thread-message-reply"
      title="Reply to this message (R)"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      Reply
    </button>
  );
}

/**
 * A thread drawn where it is, as an agent chat draws its threads: its
 * messages (each with Reply on it, when `onReplyMessage` says what that
 * does), then Reply, Resolve, Fold (and Delete for a lone comment of
 * yours); folded, one line that unfolds it. Resolved threads start folded.
 * j / k stop on its messages (`m:COMMENT`) or its folded line (`t:THREAD`).
 */
export function ThreadCard({
  thread,
  folded,
  cursor,
  onToggleFold,
  onReply,
  onReplyMessage,
  onResolve,
  onDelete,
  head,
  footer,
  messageClass,
  authorExtra,
  body,
  messageBar,
}: {
  thread: ReviewThread;
  folded: boolean;
  /** Where j / k are, to mark it. */
  cursor: string | null;
  onToggleFold: () => void;
  onReply: () => void;
  /** Reply on one of its messages: a thread on the whole of that message. */
  onReplyMessage?: (message: ReviewComment) => void;
  onResolve: () => void;
  /** Offered for a lone comment of yours. */
  onDelete?: () => void;
  /** Drawn before its messages. */
  head?: ReactNode;
  /** In place of the buttons: the answer being written, or nothing. */
  footer?: ReactNode;
  messageClass?: (message: ReviewComment, index: number) => string;
  authorExtra?: (message: ReviewComment, index: number) => ReactNode;
  body: (message: ReviewComment) => ReactNode;
  /** Under a message: its marks and buttons (the review's, in Changes). */
  messageBar?: (message: ReviewComment, index: number) => ReactNode;
}) {
  const first = thread.comments[0];
  if (folded)
    return (
      <button
        type="button"
        className={`chat-thread is-folded${cursor === `t:${thread.id}` ? " is-focused" : ""}`}
        data-thread-id={thread.id}
        data-chat-stop={`t:${thread.id}`}
        onClick={onToggleFold}
        title="Unfold"
      >
        <span className="chat-thread-mark">
          {thread.resolved ? "✓ Resolved" : "▸ Folded"}
        </span>
        <span className="chat-thread-summary">
          {summaryLine(first?.body ?? "")}
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
      {head}
      {thread.comments.map((message, index) => (
        <div
          key={message.id}
          className={`chat-thread-message${message.author === REVIEW_USER ? "" : " from-agent"}${cursor === `m:${message.id}` ? " is-focused" : ""}${messageClass?.(message, index) ?? ""}`}
          data-chat-stop={`m:${message.id}`}
        >
          <div className="chat-thread-message-head">
            <span className="chat-thread-author">
              {message.author === REVIEW_USER ? "You" : message.author}
              {authorExtra?.(message, index)}
            </span>
            {onReplyMessage ? (
              <MessageReplyButton onClick={() => onReplyMessage(message)} />
            ) : null}
          </div>
          {/* Its parts take comments too, drawn under them. */}
          <div className="chat-thread-body" data-message-id={message.id}>
            {body(message)}
          </div>
          {messageBar?.(message, index)}
        </div>
      ))}
      {footer !== undefined ? (
        footer
      ) : (
        <div className="chat-thread-bar">
          <button type="button" onClick={onReply}>
            Reply
          </button>
          <button type="button" onClick={onResolve}>
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
          <button type="button" onClick={onToggleFold}>
            Fold
          </button>
          {onDelete &&
          thread.comments.length === 1 &&
          first?.author === REVIEW_USER ? (
            <button type="button" onClick={onDelete}>
              Delete
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
