import { Suspense, useRef, useState } from "react";
import { vimKeys } from "../vimKeys";
import { lazyWithReload } from "../lazyWithReload";
import { newClientId } from "../reviewPending";
import "./ChatThreads.css";

/** A comment box's words, and the id they were last sent with. */
export type ThreadBox = { text: string; sent?: { text: string; id: string } };

// The editor is loaded with the first comment box, not with the chat.
const ReviewCommentEditor = lazyWithReload("review-comment-editor", () =>
  import("./ReviewCommentEditor").then((module) => ({
    default: module.ReviewCommentEditor,
  })),
);

/**
 * A comment box: Cmd+Enter or :w saves, Esc on an empty one closes. A save
 * is sent once: until it is answered (the box closes, or stays to try
 * again), Send says so and further saves are ignored. Each text goes with
 * an id made for it; sent again unchanged, the same id, so the server
 * writes it once.
 */
export function ThreadEditor({
  placeholder,
  onSave,
  onClose,
  onLeave,
  kept,
  autoFocus = true,
  onChange,
  sendLabel = "Send",
}: {
  placeholder: string;
  /** Sends the text with its id; settles once it is saved or failed. */
  onSave: (text: string, id: string) => Promise<unknown>;
  /** Closed: with the id of the text last sent, if any. */
  onClose: (id?: string) => void;
  /** Esc with words written: they stay, the keys go back to the chat. */
  onLeave: () => void;
  /**
   * Where its words (and the id they were sent with) are kept as they
   * change: the box drawn again, after the chat was not shown, has them.
   */
  kept?: ThreadBox;
  /** Takes the focus when drawn: not a box drawn again. */
  autoFocus?: boolean;
  onChange?: (text: string) => void;
  /** What its button says. */
  sendLabel?: string;
}) {
  const text = useRef(kept?.text ?? "");
  const [initial] = useState(() => kept?.text ?? "");
  const [vim] = useState(vimKeys);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const sent = useRef<{ text: string; id: string } | null>(kept?.sent ?? null);
  const close = () => onClose(sent.current?.id);
  const save = () => {
    if (sending.current || !text.current.trim()) return;
    sending.current = true;
    setBusy(true);
    const value = text.current;
    if (sent.current?.text !== value) {
      sent.current = { text: value, id: newClientId() };
      if (kept) kept.sent = sent.current;
    }
    void onSave(value, sent.current.id).finally(() => {
      sending.current = false;
      setBusy(false);
    });
  };
  return (
    <div className="chat-thread-editor">
      <Suspense fallback={null}>
        <ReviewCommentEditor
          value={initial}
          vimMode={vim}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(value) => {
            text.current = value;
            if (kept) kept.text = value;
            onChange?.(value);
          }}
          onCommit={(explicit) => {
            if (explicit && text.current.trim()) save();
            // Leaving a box with words in it keeps them.
            else if (!text.current.trim()) close();
            else if (!explicit) onLeave();
          }}
          onCancel={close}
          onSuggest={() => {}}
        />
      </Suspense>
      <div className="chat-thread-bar">
        <span className="chat-thread-hint">Cmd+Enter sends</span>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={busy}
          aria-busy={busy}
          onClick={save}
        >
          {busy ? "Sending..." : sendLabel}
        </button>
      </div>
    </div>
  );
}
