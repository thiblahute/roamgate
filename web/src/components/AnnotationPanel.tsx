import {
  ArrowDown,
  ArrowUp,
  Clipboard,
  Crosshair,
  MessageSquareText,
  Pin,
  PinOff,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  diffReviewLineLabel,
  fileReviewLineLabel,
  terminalAnnotationTitle,
  type ReviewAnnotation,
} from "../annotations";
import {
  shortcutLabel,
  shortcutMatches,
  shortcutTitle,
  useShortcutPreferences,
} from "../shortcutPreferences";
import type { Pane } from "../types";
import { vimKeys } from "../vimKeys";
import { ReviewCommentEditorLazy } from "./ReviewCommentEditorLazy";
import { ConfirmDialog } from "./ModalDialogs";
import { ThemedSelect } from "./ThemedSelect";
import "./AnnotationPanel.css";

/** The most a held comment takes, as typed. */
const COMMENT_MAX_LENGTH = 10_000;

/**
 * A held comment's words in the comment editors' Vim editor (the review's
 * `:vim` setting): each change is kept as typed, as in the plain box. Esc in
 * normal mode, `:w` or `:q` leave it with its words. A change made
 * elsewhere (the comment's chat) is drawn again.
 */
function HeldCommentEditor({
  comment,
  label,
  onChange,
  onKeys,
  onAddImage,
}: {
  comment: string;
  label: string;
  onChange: (comment: string) => void;
  /** Stores an image pasted or dropped in; the Markdown for it. */
  onAddImage?: (file: File) => Promise<string>;
  /** The panel's own keys (Copy, Pre-fill), ahead of the editor's. */
  onKeys: (event: ReactKeyboardEvent) => void;
}) {
  const typed = useRef(comment);
  const [drawn, setDrawn] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (comment === typed.current) return;
    typed.current = comment;
    setDrawn((count) => count + 1);
  }, [comment]);
  const leave = () =>
    hostRef.current?.querySelector<HTMLElement>(".cm-content")?.blur();
  return (
    <div
      ref={hostRef}
      className="annotation-card-editor"
      onKeyDownCapture={onKeys}
    >
      <Suspense fallback={null}>
        <ReviewCommentEditorLazy
          key={drawn}
          value={comment}
          vimMode
          autoFocus={false}
          label={label}
          maxLength={COMMENT_MAX_LENGTH}
          placeholder="Comment"
          onChange={(value) => {
            typed.current = value;
            onChange(value);
          }}
          {...(onAddImage ? { onPasteImage: onAddImage } : {})}
          onCommit={leave}
          onCancel={leave}
          onSuggest={() => {}}
        />
      </Suspense>
    </div>
  );
}

function annotationLocation(annotation: ReviewAnnotation) {
  if (annotation.source === "terminal")
    return `Terminal · ${annotation.title} · selected passage`;
  if (annotation.source === "diff") {
    return `Diff · ${annotation.path} · ${diffReviewLineLabel(annotation)}`;
  }
  if (annotation.anchor === "line") {
    return `File · ${annotation.path} · ${fileReviewLineLabel(annotation)}`;
  }
  return annotation.section.length
    ? `Markdown · ${annotation.path} · ${annotation.section.join(" › ")}`
    : `Markdown · ${annotation.path} · selected passage`;
}

function paneLabel(pane: Pane) {
  return terminalAnnotationTitle(pane);
}

/**
 * The workspace's threads: the comments held for Send (a terminal's, and
 * notes moved from this browser), edited, ordered and handed to an agent in
 * one prompt (Send, Pre-fill, Copy), above every thread of the workspace's
 * reviews (diffs, files, sites, chats), each going to its review at its
 * place.
 */
export function AnnotationPanel({
  open,
  floating,
  onToggleFloating,
  annotations,
  agentPanes,
  preferredPaneId,
  busy,
  focusedAnnotationId,
  onClose,
  onUpdateComment,
  onAddImage,
  onDelete,
  onMove,
  onClear,
  onCopy,
  onSend,
  onGoToAgent,
  onGo,
  conversations,
}: {
  open: boolean;
  floating: boolean;
  onToggleFloating?: () => void;
  annotations: readonly ReviewAnnotation[];
  agentPanes: readonly Pane[];
  preferredPaneId?: string;
  busy: boolean;
  focusedAnnotationId?: string | null;
  onClose: () => void;
  /** The workspace's threads, below the comments to send. */
  conversations?: ReactNode;
  /** Goes to a held comment where it was written (its pane, its file). */
  onGo?: (id: string) => void;
  onUpdateComment: (id: string, comment: string) => void;
  /** Stores an image put in a comment; the Markdown for it. */
  onAddImage?: (file: File) => Promise<string>;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onClear: () => void;
  onCopy: () => void;
  /** Pre-fills the agent's input, or with `submit`, sends it. */
  onSend: (paneId: string | null, submit?: boolean) => void;
  onGoToAgent?: () => void;
}) {
  useShortcutPreferences();
  const copyShortcut = shortcutLabel("annotations.copy");
  const prefillShortcut = shortcutLabel("annotations.prefill");
  const hasFeedback = annotations.some((annotation) =>
    annotation.comment.trim(),
  );
  const [targetPaneId, setTargetPaneId] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [vim] = useState(vimKeys);

  useEffect(() => {
    if (preferredPaneId) setTargetPaneId(preferredPaneId);
  }, [preferredPaneId]);

  useEffect(() => {
    const preferred = agentPanes.find(
      (pane) => pane.pane_id === preferredPaneId,
    );
    setTargetPaneId((current) => {
      if (agentPanes.some((pane) => pane.pane_id === current)) return current;
      return preferred?.pane_id ?? agentPanes[0]?.pane_id ?? "";
    });
  }, [agentPanes, preferredPaneId]);

  useEffect(() => {
    if (!open || !focusedAnnotationId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const card = Array.from(
          document.querySelectorAll<HTMLElement>("[data-review-annotation-id]"),
        ).find(
          (element) =>
            element.dataset.reviewAnnotationId === focusedAnnotationId,
        );
        card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        // The Vim editor may still be on its way: a few tries.
        let tries = 0;
        const focus = () => {
          const box = card?.querySelector<HTMLElement>("textarea, .cm-content");
          if (box) box.focus({ preventScroll: true });
          else if (card && ++tries < 20) timer = setTimeout(focus, 50);
        };
        focus();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [focusedAnnotationId, open]);

  if (!open) return null;

  /** Copy and Pre-fill from anywhere in the panel. */
  const deliveryKeys = (event: ReactKeyboardEvent) => {
    if (
      event.defaultPrevented ||
      confirmClear ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    )
      return;
    const copy = shortcutMatches(event.nativeEvent, "annotations.copy");
    const prefill = shortcutMatches(event.nativeEvent, "annotations.prefill");
    if (!copy && !prefill) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || !hasFeedback || event.repeat) return;
    if (copy) onCopy();
    else onSend(targetPaneId || null);
  };

  return (
    <aside
      className={`annotation-panel ${floating ? "is-floating" : ""}`}
      aria-label="Workspace threads"
      onKeyDown={deliveryKeys}
    >
      <header className="annotation-panel-head">
        <div>
          <strong>Threads</strong>
          <span>{annotations.length} to send</span>
        </div>
        {onToggleFloating ? (
          <button
            type="button"
            className="annotation-icon-button annotation-mode-button"
            aria-label={floating ? "Pin annotations" : "Float annotations"}
            title={floating ? "Fixed layout" : "Floating layout"}
            aria-pressed={!floating}
            onClick={onToggleFloating}
          >
            {floating ? <Pin size={16} /> : <PinOff size={16} />}
          </button>
        ) : null}
        <button
          type="button"
          className="annotation-icon-button"
          aria-label="Close the workspace's threads"
          title="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      <div className="annotation-panel-list">
        {annotations.length === 0 ? (
          <div className="annotation-panel-empty">
            <MessageSquareText size={24} />
            <strong>Nothing waiting to send</strong>
            <span>
              Select terminal text to comment on it: the comment waits here, in
              its agent's chat, until you send it. Comments on diffs, files and
              chats go to their review at once.
            </span>
          </div>
        ) : (
          annotations.map((annotation, index) => (
            <article
              key={annotation.id}
              data-review-annotation-id={annotation.id}
              className={`annotation-card ${
                annotation.id === focusedAnnotationId ? "is-focused" : ""
              }`}
            >
              <div className="annotation-card-head">
                <strong title={annotationLocation(annotation)}>
                  {index + 1}. {annotationLocation(annotation)}
                </strong>
                {annotation.stale ? (
                  <span>
                    {annotation.source === "terminal"
                      ? "Pane unavailable"
                      : "Stale anchor"}
                  </span>
                ) : null}
              </div>
              <blockquote
                tabIndex={0}
                aria-label={`Selected text for comment ${index + 1}`}
              >
                {annotation.quote || "Blank line"}
              </blockquote>
              {vim ? (
                <HeldCommentEditor
                  comment={annotation.comment}
                  label={`Comment ${index + 1}`}
                  onChange={(comment) =>
                    onUpdateComment(annotation.id, comment)
                  }
                  onKeys={deliveryKeys}
                  {...(onAddImage ? { onAddImage } : {})}
                />
              ) : (
                <textarea
                  value={annotation.comment}
                  rows={3}
                  maxLength={COMMENT_MAX_LENGTH}
                  aria-label={`Comment ${index + 1}`}
                  onChange={(event) =>
                    onUpdateComment(annotation.id, event.currentTarget.value)
                  }
                />
              )}
              <div className="annotation-card-actions">
                <button
                  type="button"
                  className="annotation-icon-button"
                  disabled={index === 0}
                  aria-label={`Move comment ${index + 1} up`}
                  title="Move up"
                  onClick={() => onMove(annotation.id, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="annotation-icon-button"
                  disabled={index === annotations.length - 1}
                  aria-label={`Move comment ${index + 1} down`}
                  title="Move down"
                  onClick={() => onMove(annotation.id, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                {onGo ? (
                  <button
                    type="button"
                    className="annotation-icon-button"
                    aria-label={`Go to comment ${index + 1}`}
                    title="Go to it"
                    onClick={() => onGo(annotation.id)}
                  >
                    <Crosshair size={14} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="annotation-icon-button is-danger"
                  aria-label={`Delete comment ${index + 1}`}
                  title="Delete"
                  onClick={() => onDelete(annotation.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      {conversations}

      <footer className="annotation-panel-footer">
        {agentPanes.length > 1 ? (
          <label className="annotation-target-picker">
            <span>Agent pane</span>
            <ThemedSelect
              aria-label="Agent pane"
              value={targetPaneId}
              options={agentPanes.map((pane) => ({
                value: pane.pane_id,
                label: paneLabel(pane),
              }))}
              onChange={setTargetPaneId}
            />
          </label>
        ) : agentPanes.length === 1 ? (
          <div className="annotation-target-summary">
            Agent pane: {paneLabel(agentPanes[0])}
          </div>
        ) : (
          <div className="annotation-target-summary">
            No agent pane; Send uses the clipboard.
          </div>
        )}
        <div className="annotation-delivery-actions">
          <button
            type="button"
            className="ghost"
            disabled={busy || !hasFeedback}
            onClick={onCopy}
            title={shortcutTitle(
              "Copy the comments to send",
              "annotations.copy",
            )}
          >
            <Clipboard size={14} /> Copy
            {copyShortcut !== "Unassigned" ? <kbd>{copyShortcut}</kbd> : null}
          </button>
          <button
            type="button"
            disabled={busy || !hasFeedback}
            onClick={() => onSend(targetPaneId || null)}
            title={shortcutTitle(
              agentPanes.length ? "Pre-fill agent" : "Copy feedback",
              "annotations.prefill",
            )}
          >
            {agentPanes.length ? <Send size={14} /> : <Clipboard size={14} />}
            {agentPanes.length ? "Pre-fill agent" : "Copy feedback"}
            {prefillShortcut !== "Unassigned" ? (
              <kbd>{prefillShortcut}</kbd>
            ) : null}
          </button>
          {agentPanes.length ? (
            <button
              type="button"
              disabled={busy || !hasFeedback || !targetPaneId}
              onClick={() => onSend(targetPaneId || null, true)}
              title="Send the feedback to the agent now"
            >
              <Send size={14} /> Send
            </button>
          ) : null}
        </div>
        {onGoToAgent ? (
          <button type="button" className="ghost" onClick={onGoToAgent}>
            Go to agent
          </button>
        ) : null}
        <button
          type="button"
          className="annotation-clear-button"
          disabled={busy || annotations.length === 0}
          onClick={() => setConfirmClear(true)}
        >
          Clear held
        </button>
      </footer>
      <ConfirmDialog
        open={confirmClear}
        title="Clear the comments to send?"
        message="This deletes every comment waiting to be sent."
        confirmLabel="Delete them"
        danger
        onConfirm={onClear}
        onClose={() => setConfirmClear(false)}
      />
    </aside>
  );
}
