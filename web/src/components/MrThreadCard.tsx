import type { ReactNode } from "react";
import type { ReviewComment, ReviewThread } from "../../../shared/review";
import { NoteBody } from "./ReviewNoteBody";
import "./ReviewCard.css";
import "./MrThreadCard.css";

/** maildesk's dates: today HH:MM, this week the weekday, else the date. */
export function fmtDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

export function plural(count: number, word: string, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

/**
 * A merge or pull request's discussion (maildesk's .mrt), as the review
 * pane draws it and as a rendered file shows it: its notes, your draft
 * replies (Edit, Delete), and Draft reply, which writes a draft on the
 * forge, never published from here. A pull request's conversation comment
 * has no draft reply.
 */
export function MrThreadCard({
  thread,
  forge,
  top = false,
  outdatedLine,
  flipped = false,
  focusedComment,
  newLines,
  replying,
  editing,
  onDraftReply,
  onEditReply,
  onDeleteReply,
}: {
  thread: ReviewThread;
  /** "GitLab" or "GitHub". */
  forge: string;
  /** Listed with the review's general comments: open unless resolved. */
  top?: boolean;
  /** Found again in today's file: the line it was written on. */
  outdatedLine?: number;
  /** Folded or unfolded by hand (r): the other way from how it opens. */
  flipped?: boolean;
  focusedComment?: string | null;
  newLines?: ReadonlyMap<number, string>;
  /** The reply being written, drawn in place of the bar. */
  replying?: ReactNode;
  /** A draft reply being rewritten: its box, drawn in its place. */
  editing?: (comment: ReviewComment) => ReactNode | undefined;
  onDraftReply: () => void;
  onEditReply: (comment: ReviewComment) => void;
  onDeleteReply: (comment: ReviewComment) => void;
}) {
  const replies = thread.comments.length - 1;
  const first = thread.comments[0];
  const body = (comment: ReviewComment) => (
    <NoteBody
      text={comment.body}
      newLines={newLines}
      line={thread.anchor.line}
      path={thread.anchor.path}
    />
  );
  return (
    <details
      className={`mrt${thread.resolved ? " resolved" : ""}`}
      data-thread-id={thread.id}
      open={
        (top ? !thread.resolved : !thread.resolved && !outdatedLine) !== flipped
      }
    >
      <summary className="mr-head" data-chat-stop={`t:${thread.id}`}>
        <span className="mr-tag">{forge}</span>{" "}
        {first?.author.replace(/^@/, "")}
        {replies > 0 ? ` + ${plural(replies, "reply", "replies")}` : ""}
        {thread.resolved ? (
          <span className="mr-resolved"> · resolved</span>
        ) : null}
        {outdatedLine ? (
          <span className="mr-resolved">
            {" "}
            · outdated (was line {outdatedLine})
          </span>
        ) : null}
        {top && thread.anchor.path ? (
          <code className="mr-where">
            {thread.anchor.path}
            {thread.anchor.line ? `:${thread.anchor.line}` : ""}
          </code>
        ) : null}
      </summary>
      {thread.comments.map((comment) => {
        if (comment.gitlabDraftId === undefined)
          return (
            <div
              key={comment.id}
              data-comment-id={comment.id}
              data-chat-stop={`m:${comment.id}`}
              className={`mr-note${comment.id === focusedComment ? " focused" : ""}`}
            >
              <div className="mr-who">
                <strong>{comment.author.replace(/^@/, "")}</strong> ·{" "}
                {fmtDate(comment.createdAt)}
              </div>
              <div className="mr-body">{body(comment)}</div>
            </div>
          );
        const box = editing?.(comment);
        if (box !== undefined) return <div key={comment.id}>{box}</div>;
        return (
          <div
            key={comment.id}
            data-comment-id={comment.id}
            data-chat-stop={`m:${comment.id}`}
            className={`mr-note mr-draft${comment.id === focusedComment ? " focused" : ""}`}
          >
            <div className="mr-who">
              <span className="mr-draft-tag">Your draft reply</span>, not
              submitted
            </div>
            <div className="mr-body">{body(comment)}</div>
            <div className="rc-bar">
              <span className="spacer" />
              <button
                type="button"
                className="btn ghost"
                onClick={() => onEditReply(comment)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => onDeleteReply(comment)}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
      {replying !== undefined ? (
        replying
      ) : !thread.gitlab?.discussionId ? (
        <div className="rc-bar">
          <span className="spacer" />
          <span
            className="rc-kind"
            title="GitHub keeps no draft of a reply to a conversation comment, and Roamgate never publishes: answer it on GitHub"
          >
            Conversation comment: reply on {forge}
          </span>
        </div>
      ) : (
        <div className="rc-bar">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onDraftReply}>
            Draft reply
          </button>
        </div>
      )}
    </details>
  );
}
