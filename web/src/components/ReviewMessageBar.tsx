import {
  commentEdited,
  REVIEW_USER,
  type ReviewComment,
  type ReviewThread,
} from "../../../shared/review";
import type { ThreadDelivery } from "../reviewDelivery";
import type { PendingWrite } from "../reviewPending";
import { HELD_FOR_SEND } from "../workspaceFeedback";

/*
 * The review's bar under one message of a thread: how your comment goes to
 * the agent (sent, on its way, held, not delivered with Retry, not sent with
 * Send), its forge draft and edited marks, Edit and Delete; or, while it is
 * on its way, Sending... then Not saved with Retry and Discard. The review in
 * Changes draws it under each message.
 */

export type ReviewMessageBarProps = {
  thread: ReviewThread;
  comment: ReviewComment;
  index: number;
  /** How the thread's comments go to its agent. */
  delivery: ThreadDelivery;
  /** An agent to send to: named by the review, or in its workspace. */
  canSend: boolean;
  /** What Send reads: "Send", or "Send to Claude" on a request's review. */
  sendLabel: string;
  onSend: () => void;
  /** The forge a draft is for ("GitLab", "GitHub"). */
  forge: string;
  /** The message, or its thread when it is the first, on its way. */
  pending?: PendingWrite;
  onRetryWrite: (write: PendingWrite) => void;
  onDiscardWrite: (write: PendingWrite) => void;
  onEdit: () => void;
  onDelete: () => void;
};

/** A write on its way: Sending..., then Not saved with Retry and Discard. */
export function PendingStatus({
  error,
  onRetry,
  onDiscard,
}: {
  error: string | undefined;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return error === undefined ? (
    <div className="rc-bar" role="status">
      <span className="rc-kind">Sending...</span>
    </div>
  ) : (
    <div className="rc-bar" role="alert">
      <span className="rc-kind rc-failed">Not saved: {error}</span>
      <span className="spacer" />
      <button type="button" className="btn ghost" onClick={onRetry}>
        Retry
      </button>
      <button type="button" className="btn ghost" onClick={onDiscard}>
        Discard
      </button>
    </div>
  );
}

export function ReviewMessageBar({
  thread,
  comment,
  index,
  delivery,
  canSend,
  sendLabel,
  onSend,
  forge,
  pending,
  onRetryWrite,
  onDiscardWrite,
  onEdit,
  onDelete,
}: ReviewMessageBarProps) {
  if (pending)
    return (
      <PendingStatus
        error={pending.error}
        onRetry={() => onRetryWrite(pending)}
        onDiscard={() => onDiscardWrite(pending)}
      />
    );
  const discussion = thread.kind === "discussion";
  const mine = comment.author === REVIEW_USER;
  const { agentName } = delivery;
  const sendButton = (title: string) => (
    <button
      type="button"
      className="btn ghost rc-send"
      title={title}
      onClick={onSend}
    >
      {sendLabel}
    </button>
  );
  const marks =
    discussion && mine ? (
      thread.held !== undefined ? (
        <span className="rc-kind">{HELD_FOR_SEND}</span>
      ) : thread.handedAt && comment.updatedAt <= thread.handedAt ? (
        <span className="rc-kind">sent from the workspace's threads</span>
      ) : delivery.review.deliveredAt &&
        comment.updatedAt <= delivery.review.deliveredAt ? (
        <span className="rc-kind">{`\u2192 ${agentName}`}</span>
      ) : delivery.held ? (
        <>
          <span className="rc-kind">{`held for ${agentName}`}</span>
          {sendButton(`Send your held comments to ${agentName} (:send)`)}
        </>
      ) : delivery.talk && delivery.undeliveredReason ? (
        <>
          <span
            className="rc-kind rc-failed"
            role="status"
            title={`Not delivered to ${agentName}: ${delivery.undeliveredReason}`}
          >
            not delivered: {delivery.undeliveredReason}
          </span>
          <button type="button" className="btn ghost" onClick={delivery.retry}>
            Retry
          </button>
        </>
      ) : delivery.talk ? (
        <span className="rc-kind">{`\u2192 ${agentName}...`}</span>
      ) : canSend ? (
        <>
          <span className="rc-kind">{`for ${agentName}, not sent`}</span>
          {sendButton(`Send your comments to ${agentName} (:send)`)}
        </>
      ) : (
        <span
          className="rc-kind"
          title="Copy the review as Markdown, or start or pick an agent in this workspace"
        >
          No agent in this workspace: Copy or pick one
        </span>
      )
    ) : null;
  return (
    <div className="rc-bar">
      {marks}
      {thread.gitlab?.draftId !== undefined ? (
        <span className="rc-kind">{forge} draft</span>
      ) : null}
      {commentEdited(comment) ? <span className="rc-kind">edited</span> : null}
      <span className="spacer" />
      {(index === 0 && !discussion) || (discussion && mine) ? (
        <button type="button" className="btn ghost" onClick={onEdit}>
          Edit
        </button>
      ) : null}
      {index === 0 && (thread.kind === "draft" || mine) ? (
        <button type="button" className="btn ghost" onClick={onDelete}>
          Delete
        </button>
      ) : null}
    </div>
  );
}
