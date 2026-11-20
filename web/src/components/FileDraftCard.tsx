import { type ThreadBox, ThreadEditor } from "./ThreadEditor";

/*
 * A comment being written on a file in the Files preview, drawn where its
 * thread will be: under the block or line it is on, as wide as the column,
 * as the review's diff draws a new comment under a line. What it is on
 * (the path and lines, the words quoted) sits above the box; the box has
 * the editor's keys (Esc closes an empty one, keeps the words of one
 * written in).
 */
export function FileDraftCard({
  title,
  quote,
  preview,
  kept,
  onChange,
  onSave,
  onClose,
  onLeave,
  onAddImage,
}: {
  title: string;
  quote: string;
  /** A picture of the graphic's region commented on. */
  preview?: string;
  kept: ThreadBox;
  onChange: (comment: string) => void;
  onSave: (comment: string) => void | Promise<void>;
  onClose: () => void;
  /** Esc with words written: they stay, the keys go back to the file. */
  onLeave: () => void;
  onAddImage?: (file: File) => Promise<string>;
}) {
  return (
    <div
      className="chat-thread is-draft file-draft"
      role="form"
      aria-label="Add review comment"
    >
      <strong className="file-draft-title" title={title}>
        {title}
      </strong>
      <blockquote className="file-draft-quote">
        {quote || "Blank line"}
      </blockquote>
      {preview ? (
        <img
          className="annotation-composer-preview"
          src={preview}
          alt="The region commented on"
        />
      ) : null}
      <ThreadEditor
        key={`${title}\n${quote}`}
        placeholder="Add a review comment"
        sendLabel="Add comment"
        kept={kept}
        onChange={onChange}
        onLeave={onLeave}
        onClose={onClose}
        {...(onAddImage ? { onAddImage } : {})}
        onSave={async (text) => {
          const value = text.trim();
          if (!value) return;
          await onSave(value);
        }}
      />
    </div>
  );
}
