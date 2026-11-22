import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  type DraftImage,
  dropDraftImages,
  keepDraftImages,
  keepReviewDraft,
  peekReviewDraft,
} from "../reviewDrafts";
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
 * Where a box's unsent words are kept in the browser (reviewDrafts): its
 * place (`work:ITEM`, `chat:...`) and the box's key in it.
 */
export type DraftPlace = { session: string; key: string };

/**
 * Keeps a box's unsent words as its draft as it goes away (another view,
 * the page hidden or reloaded) and hands them back when it is drawn
 * again (peekReviewDraft); sending or cancelling forgets them. `text`:
 * the box's words as they are; `images`, those it holds as bytes until it
 * sends (named in its words by their tokens), kept with them.
 */
export function useBoxDraft(
  draft: DraftPlace | undefined,
  text: { current: string },
  images?: { current: readonly DraftImage[] },
) {
  /** Sent or cancelled: nothing to keep. */
  const done = useRef(false);
  const place = useRef(draft);
  place.current = draft;
  const keep = useRef(() => {});
  keep.current = () => {
    const at = place.current;
    if (!at || done.current) return;
    keepReviewDraft(at.session, at.key, text.current);
    if (images)
      keepDraftImages(
        at.session,
        at.key,
        text.current.trim()
          ? images.current.filter((image) => text.current.includes(image.token))
          : [],
      );
  };
  useEffect(() => {
    const onHide = () => keep.current();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") keep.current();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      keep.current();
    };
  }, []);
  const hasImages = !!images;
  // The same functions each render: effects may depend on them.
  return useMemo(
    () => ({
      /** Sent or cancelled: the draft goes. */
      forget: () => {
        done.current = true;
        const at = place.current;
        if (!at) return;
        keepReviewDraft(at.session, at.key, "");
        if (hasImages) dropDraftImages(at.session, at.key);
      },
      /** Its words are the box's again (a send failed, the box stays). */
      resume: () => {
        done.current = false;
      },
    }),
    [hasImages],
  );
}

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
  draft,
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
  /**
   * Where its unsent words outlive it (a reload, another view): drawn
   * again, it has them; Send or Cancel forgets them.
   */
  draft?: DraftPlace;
}) {
  const [initial] = useState(() => {
    if (kept?.text) return kept.text;
    const stored = draft ? peekReviewDraft(draft.session, draft.key) : "";
    if (stored && kept) kept.text = stored;
    return stored ?? "";
  });
  const text = useRef(initial);
  const drafted = useBoxDraft(draft, text);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // A send answered and the box still drawn after (it was not closed: the
  // send failed): its words are its draft again.
  const [answered, setAnswered] = useState(0);
  const { resume } = drafted;
  useEffect(() => {
    if (answered) resume();
  }, [answered, resume]);
  const [vim] = useState(vimKeys);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState("");
  const sent = useRef<{ text: string; id: string } | null>(kept?.sent ?? null);
  const handle = useRef<CommentEditorHandle | null>(null);
  const close = () => {
    drafted.forget();
    onClose(sent.current?.id);
  };
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
    // Sent: the draft goes (the box closes with the answer, the same
    // render); still drawn after it, its words are kept again.
    drafted.forget();
    void onSave(value, sent.current.id).finally(() => {
      sending.current = false;
      if (!mounted.current) return;
      setBusy(false);
      setAnswered((count) => count + 1);
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
