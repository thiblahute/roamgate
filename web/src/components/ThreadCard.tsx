import type { ReactNode } from "react";
import {
  REVIEW_USER,
  type ReviewComment,
  type ReviewThread,
} from "../../../shared/review";
import "./ChatThreads.css";

/**
 * A thread drawn where it is, as an agent chat draws its threads: its
 * messages, then Reply, Resolve, Fold (and Delete for a lone comment of
 * yours); folded, one line that unfolds it. Resolved threads start folded.
 * j / k stop on its messages (`m:COMMENT`) or its folded line (`t:THREAD`).
 */
export function ThreadCard({
  thread,
  folded,
  cursor,
  onToggleFold,
  onReply,
  onResolve,
  onDelete,
  head,
  footer,
  messageClass,
  authorExtra,
  body,
}: {
  thread: ReviewThread;
  folded: boolean;
  /** Where j / k are, to mark it. */
  cursor: string | null;
  onToggleFold: () => void;
  onReply: () => void;
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
      {head}
      {thread.comments.map((message, index) => (
        <div
          key={message.id}
          className={`chat-thread-message${message.author === REVIEW_USER ? "" : " from-agent"}${cursor === `m:${message.id}` ? " is-focused" : ""}${messageClass?.(message, index) ?? ""}`}
          data-chat-stop={`m:${message.id}`}
        >
          <span className="chat-thread-author">
            {message.author === REVIEW_USER ? "You" : message.author}
            {authorExtra?.(message, index)}
          </span>
          {/* Its parts take comments too, drawn under them. */}
          <div className="chat-thread-body" data-message-id={message.id}>
            {body(message)}
          </div>
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
