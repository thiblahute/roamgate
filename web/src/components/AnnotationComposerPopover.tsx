import { useShortcutPreferences } from "../shortcutPreferences";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { type ThreadBox, ThreadEditor } from "./ThreadEditor";
import "./AnnotationComposerPopover.css";

export type AnnotationComposerDraft = {
  x: number;
  y: number;
  title: string;
  quote: string;
  /** A picture of the graphic's region commented on. */
  preview?: string;
};

export function AnnotationComposerPopover({
  draft,
  onSave,
  onClose,
  commentValue,
  onCommentChange,
  suspendOnFileTabNavigation = false,
  onAddImage,
}: {
  draft: AnnotationComposerDraft | null;
  onSave: (comment: string) => void | Promise<void>;
  onClose: () => void;
  commentValue?: string;
  onCommentChange?: (comment: string) => void;
  suspendOnFileTabNavigation?: boolean;
  /** Stores an image put in the comment; the Markdown for it. */
  onAddImage?: (file: File) => Promise<string>;
}) {
  useShortcutPreferences();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [internalComment, setInternalComment] = useState("");
  const setComment = onCommentChange ?? setInternalComment;
  const keptBox = useRef<ThreadBox>({ text: "" });
  keptBox.current.text = commentValue ?? internalComment;
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const draftX = draft?.x;
  const draftY = draft?.y;
  const draftTitle = draft?.title;
  const draftQuote = draft?.quote;

  useLayoutEffect(() => {
    if (
      draftX === undefined ||
      draftY === undefined ||
      draftTitle === undefined ||
      draftQuote === undefined
    ) {
      return;
    }
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    returnFocusRef.current = returnFocus;
    const form = formRef.current;
    setInternalComment("");
    setPosition({ x: draftX, y: draftY });
    const place = () => {
      const form = formRef.current;
      if (!form) return;
      const rect = form.getBoundingClientRect();
      const margin = 8;
      setPosition({
        x: Math.min(
          Math.max(margin, draftX),
          Math.max(margin, window.innerWidth - rect.width - margin),
        ),
        y: Math.min(
          Math.max(margin, draftY),
          Math.max(margin, window.innerHeight - rect.height - margin),
        ),
      });
    };
    const frame = requestAnimationFrame(place);
    // The comment box loads after the first measure, and grows as it fills.
    const resized =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (form) resized?.observe(form);
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && formRef.current?.contains(target)) return;
      if (
        suspendOnFileTabNavigation &&
        target instanceof Element &&
        target.closest(
          "[data-file-preview-tab], .inspector-files-resource .workspace-inspector-navigation",
        )
      )
        return;
      onCloseRef.current();
    };
    window.addEventListener("pointerdown", closeOnPointerDown, {
      capture: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      resized?.disconnect();
      if (form?.contains(document.activeElement) && returnFocus?.isConnected)
        returnFocus.focus({ preventScroll: true });
      window.removeEventListener("pointerdown", closeOnPointerDown, {
        capture: true,
      });
    };
  }, [draftQuote, draftTitle, draftX, draftY, suspendOnFileTabNavigation]);

  if (!draft) return null;

  const restoreFocus = () => {
    if (
      formRef.current?.contains(document.activeElement) &&
      returnFocusRef.current?.isConnected
    )
      returnFocusRef.current.focus({ preventScroll: true });
  };
  const close = () => {
    restoreFocus();
    onClose();
  };
  return createPortal(
    <form
      ref={formRef}
      className="annotation-composer-popover"
      style={{ left: position.x, top: position.y }}
      role="dialog"
      aria-label="Add review comment"
      onSubmit={(event: FormEvent) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Tab") {
          const controls = Array.from(
            formRef.current?.querySelectorAll<HTMLElement>(
              "textarea, .cm-content, button:not(:disabled)",
            ) ?? [],
          );
          const next = event.shiftKey
            ? controls[controls.length - 1]
            : controls[0];
          if (
            document.activeElement ===
            (event.shiftKey ? controls[0] : controls[controls.length - 1])
          ) {
            event.preventDefault();
            next?.focus();
          }
        }
        // The comment box has its own Esc (Vim's, or closing when empty).
        if (
          event.key === "Escape" &&
          !(event.target as HTMLElement).closest(".cm-editor")
        ) {
          event.preventDefault();
          close();
        }
      }}
    >
      <strong>{draft.title}</strong>
      <blockquote>{draft.quote || "Blank line"}</blockquote>
      {draft.preview ? (
        <img
          className="annotation-composer-preview"
          src={draft.preview}
          alt="The region commented on"
        />
      ) : null}
      <ThreadEditor
        key={`${draft.title}\n${draft.quote}`}
        placeholder="Add a review comment"
        sendLabel="Add comment"
        {...(onAddImage ? { onAddImage } : {})}
        kept={keptBox.current}
        onChange={setComment}
        onLeave={() => {}}
        onClose={close}
        onSave={async (text) => {
          const value = text.trim();
          if (!value) return;
          restoreFocus();
          await onSave(value);
        }}
      />
    </form>,
    document.body,
  );
}
