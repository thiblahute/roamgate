import { Suspense, useRef, useState } from "react";
import { vimKeys } from "../vimKeys";
import { ImagePickButton } from "./ImagePickButton";
import type { CommentEditorHandle } from "./ReviewCommentEditor";
import { ReviewCommentEditorLazy } from "./ReviewCommentEditorLazy";
import { IMAGE_UPLOADING, imageUploadPending } from "./reviewImageUpload";
import { newClientId } from "../reviewPending";
import "./ChatThreads.css";

/** A comment box's words, and the id they were last sent with. */
export type ThreadBox = { text: string; sent?: { text: string; id: string } };

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
  onAddImage,
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
  /**
   * Stores an image pasted, dropped or picked; resolves to the Markdown
   * for it. Without it, the box takes no images.
   */
  onAddImage?: (file: File) => Promise<string>;
}) {
  const text = useRef(kept?.text ?? "");
  const [initial] = useState(() => kept?.text ?? "");
  const [vim] = useState(vimKeys);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState("");
  const sent = useRef<{ text: string; id: string } | null>(kept?.sent ?? null);
  const handle = useRef<CommentEditorHandle | null>(null);
  const close = () => onClose(sent.current?.id);
  const save = () => {
    if (sending.current || !text.current.trim()) return;
    // Sent now, it would keep the placeholder and lose the image.
    if (imageUploadPending(text.current)) return setWaiting(IMAGE_UPLOADING);
    setWaiting("");
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
        <ReviewCommentEditorLazy
          value={initial}
          vimMode={vim}
          autoFocus={autoFocus}
          placeholder={placeholder}
          handleRef={handle}
          {...(onAddImage ? { onPasteImage: onAddImage } : {})}
          onBlocked={setWaiting}
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
        <span
          className="chat-thread-hint"
          role={waiting ? "status" : undefined}
        >
          {waiting || "Cmd+Enter sends"}
        </span>
        {onAddImage ? (
          <ImagePickButton
            className="chat-thread-image"
            onPick={(files) => handle.current?.addImages(files)}
          />
        ) : null}
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
