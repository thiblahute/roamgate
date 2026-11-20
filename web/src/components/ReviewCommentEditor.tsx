import { insertNewlineAndIndent } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderText,
} from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { useSpeechEngine } from "../speechEngine";
import { DictationButton, DictationStatus, useDictation } from "./Dictation";
import {
  IMAGE_UPLOADING,
  imageUploadPending,
  imageUploadToken,
} from "./reviewImageUpload";
import { keepAboveKeyboard } from "./keepAboveKeyboard";
import { defineExCommands, vimExEditors } from "./vimEx";
import "./ReviewCard.css";

/** What the overlay can do to an open editor. */
export type CommentEditorHandle = {
  /** Appends text and puts the cursor `cursorFromEnd` characters before the end. */
  append: (text: string, cursorFromEnd: number) => void;
  /**
   * Esc, for keyboards without one: leaves insert or visual mode, and in
   * normal mode closes the editor as the key does.
   */
  escape: () => void;
  /** Puts images picked from a file chooser in, at the cursor, as a paste does. */
  addImages: (files: readonly File[]) => void;
};

export const reviewEditorTheme = EditorView.theme({
  "&": {
    minHeight: "64px",
    border: "1px solid var(--rv-border)",
    borderRadius: "5px",
    background: "var(--rv-surface)",
    color: "var(--rv-text)",
    font: "inherit",
    lineHeight: "1.45",
  },
  "&.cm-focused": { outline: "none", borderColor: "var(--rv-accent)" },
  ".cm-content": {
    minHeight: "64px",
    padding: "6px 4px",
    fontFamily: "inherit",
    caretColor: "var(--rv-text)",
  },
  ".cm-scroller": { fontFamily: "inherit" },
  // The caret is drawn (drawSelection), not the browser's: a thin bar in
  // the text's color while typing (insert mode), Vim's block otherwise.
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--rv-text)",
  },
  ".cm-fat-cursor": {
    background: "var(--rv-accent) !important",
    opacity: "0.6",
  },
  "&:not(.cm-focused) .cm-fat-cursor": { outline: "none !important" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    background: "var(--rv-accent-soft) !important",
  },
  ".cm-placeholder": { color: "var(--rv-faint)" },
  // CodeMirror sticks its panels to the scrolled pane's edge: an editor at
  // the bottom of the review then has the Vim bar over its lines. Keep the
  // bar under the text instead.
  ".cm-panels": { position: "static !important" },
  ".cm-vim-panel": {
    padding: "2px 6px",
    background: "var(--rv-surface-2)",
    color: "var(--rv-text)",
    fontFamily: "var(--rv-mono)",
  },
  ".cm-vim-panel input": { color: "var(--rv-text)" },
});

/**
 * maildesk's review comment editor: CodeMirror with Vim keys, starting in
 * insert mode at the end. Esc leaves insert mode and a second Esc closes;
 * `:w` saves, `:q` drops the edit, `:sugg` inserts a GitLab suggestion.
 * Cmd/Ctrl+Enter saves in either mode. Without Vim, Esc closes too. Closing
 * keeps a draft, but never sends a message (onCommit's `explicit` is false).
 */
let uploads = 0;

export { IMAGE_UPLOADING, imageUploadPending, imageUploadToken };

/**
 * Pasted, dropped or picked images go in as Markdown once stored, each
 * where the cursor was; false when there is none or nowhere to store it.
 */
function addImages(
  view: EditorView,
  files: readonly File[],
  store?: (file: File) => Promise<string>,
  failed?: (message: string) => void,
): boolean {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length || !store) return false;
  for (const file of images) {
    const token = imageUploadToken(++uploads);
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: token },
      selection: EditorSelection.cursor(from + token.length),
    });
    const replace = (text: string) => {
      const at = view.state.doc.toString().indexOf(token);
      if (at >= 0)
        view.dispatch({
          changes: { from: at, to: at + token.length, insert: text },
        });
    };
    store(file).then(replace, (error: unknown) => {
      replace("");
      failed?.(
        `Image not added: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  return true;
}

/** A paste or drop with images: they go in, and the event is taken. */
function addTransferImages(
  view: EditorView,
  data: DataTransfer | null,
  event: Event,
  store?: (file: File) => Promise<string>,
  failed?: (message: string) => void,
): boolean {
  if (!addImages(view, [...(data?.files ?? [])], store, failed)) return false;
  event.preventDefault();
  return true;
}

/**
 * The document or shadow root the editor's own nodes live in. CodeMirror
 * finds its root through `assignedSlot`: an editor slotted into the diff's
 * shadow DOM (a comment under a line in Changes) took the diff's shadow
 * root, whose `activeElement` never is the editor. It then thought itself
 * unfocused: the caret stayed behind after Enter (the next key typed before
 * the line break), and its theme went into the shadow root, where it styles
 * nothing of the editor (no caret, the diff's font).
 */
export function editorRoot(host: HTMLElement): Document | ShadowRoot {
  const root = host.getRootNode();
  // A document (9) or a shadow root (11); detached, the page.
  return root.nodeType === 9 || root.nodeType === 11
    ? (root as Document | ShadowRoot)
    : host.ownerDocument;
}

/**
 * Focuses a new editor. Slotted into the diff's shadow DOM, it is not drawn
 * until the diff makes its slot, in the same commit but after the editor's
 * own effect: the focus is tried again once the commit is done (before the
 * next key), then on the next frames, while it is still where it was when
 * the editor opened (a click elsewhere wins). Returns the cancel.
 */
export function takeFocus(view: EditorView): () => void {
  const document = view.dom.ownerDocument;
  const win = document.defaultView ?? window;
  const from = document.activeElement;
  let done = false;
  let frame = 0;
  let frames = 10;
  const take = () => {
    if (done || !view.dom.isConnected) return;
    if (document.activeElement !== from && !view.hasFocus) return;
    view.focus();
    if (view.contentDOM.ownerDocument.activeElement === view.contentDOM) return;
    if (frames-- > 0) frame = win.requestAnimationFrame(take);
  };
  view.focus();
  if (document.activeElement !== view.contentDOM) queueMicrotask(take);
  return () => {
    done = true;
    win.cancelAnimationFrame(frame);
  };
}

export function ReviewCommentEditor({
  value,
  vimMode,
  autoFocus = true,
  placeholder,
  handleRef,
  onChange,
  onCommit,
  onCancel,
  onSuggest,
  onPasteImage,
  onBlocked,
  label,
  maxLength,
}: {
  value: string;
  vimMode: boolean;
  /**
   * Takes the focus (Vim keys typing at the end) when opened. Without it
   * (a box drawn again with its words), Vim keys type once it is focused.
   */
  autoFocus?: boolean;
  placeholder: string;
  handleRef?: RefObject<CommentEditorHandle | null>;
  onChange: (text: string) => void;
  /** Explicit: Cmd+Enter or :w, not Esc (a stray key is not sent by Esc). */
  onCommit: (explicit: boolean) => void;
  onCancel: () => void;
  onSuggest: () => void;
  /** Stores a pasted or dropped image; resolves to the Markdown for it. */
  onPasteImage?: (file: File) => Promise<string>;
  /** Says why the text cannot be saved or closed yet, or an image was not added. */
  onBlocked?: (message: string) => void;
  /** The editor's accessible name. */
  label?: string;
  /** The most characters it takes, as a textarea's maxlength. */
  maxLength?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handlers = useRef({
    onChange,
    onCommit,
    onCancel,
    onSuggest,
    onPasteImage,
    onBlocked,
  });
  const viewRef = useRef<EditorView | null>(null);
  handlers.current = {
    onChange,
    // Saved or closed while an image uploads, the text would keep its
    // placeholder and lose the image: it waits until the image is in.
    onCommit: (explicit) => {
      if (imageUploadPending(viewRef.current?.state.doc.toString() ?? ""))
        onBlocked?.(IMAGE_UPLOADING);
      else onCommit(explicit);
    },
    onCancel,
    onSuggest,
    onPasteImage,
    onBlocked,
  };
  // Created once per mount (the parent remounts per comment) from the props
  // it was opened with.
  const initial = useRef({
    value,
    vimMode,
    autoFocus,
    placeholder,
    handleRef,
    label,
    maxLength,
  });

  // In the commit that draws it: the focus is the editor's before the
  // next key, not after a paint (a key typed at once went to the diff).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const {
      value,
      vimMode,
      autoFocus,
      placeholder,
      handleRef,
      label,
      maxLength,
    } = initial.current;
    if (vimMode) defineExCommands();
    const save = () => {
      handlers.current.onCommit(true);
      return true;
    };
    const close = () => {
      handlers.current.onCommit(false);
      return true;
    };
    const view = new EditorView({
      parent: host,
      root: editorRoot(host),
      state: EditorState.create({
        doc: value,
        selection: { anchor: value.length },
        extensions: [
          ...(vimMode ? [vim({ status: true })] : []),
          drawSelection(),
          keymap.of([
            { key: "Mod-Enter", run: save },
            // Markdown's Enter only continues lists and quotes. On Android
            // CodeMirror runs the Enter binding instead of the keyboard's
            // own line break, so without this one Enter on an empty line
            // did nothing.
            { key: "Enter", run: insertNewlineAndIndent },
            ...(vimMode ? [] : [{ key: "Escape", run: close }]),
          ]),
          markdown(),
          EditorView.lineWrapping,
          // Scrolling to the cursor keeps the Vim bar under it in view.
          EditorView.scrollMargins.of(() => ({ bottom: 32 })),
          EditorView.contentAttributes.of({
            spellcheck: "true",
            autocorrect: "on",
            ...(label ? { "aria-label": label } : {}),
          }),
          ...(maxLength === undefined
            ? []
            : [
                // Typing past it does nothing; shortening always goes.
                EditorState.changeFilter.of(
                  (transaction) =>
                    transaction.newDoc.length <= maxLength ||
                    transaction.newDoc.length <
                      transaction.startState.doc.length,
                ),
              ]),
          placeholderText(placeholder),
          reviewEditorTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              handlers.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            keydown: (event) => {
              // Typing belongs to the editor, not to the review's keys.
              event.stopPropagation();
              return false;
            },
            paste: (event, view) =>
              addTransferImages(
                view,
                event.clipboardData,
                event,
                handlers.current.onPasteImage,
                handlers.current.onBlocked,
              ),
            drop: (event, view) =>
              addTransferImages(
                view,
                event.dataTransfer,
                event,
                handlers.current.onPasteImage,
                handlers.current.onBlocked,
              ),
          }),
        ],
      }),
    });
    viewRef.current = view;
    const cm = getCM(view);
    // Esc in normal mode saves, as in maildesk. Vim handles Esc itself (and
    // stops other handlers), so this listens in the capture phase, before
    // Vim, and only acts once insert and visual modes are left.
    const onCaptureKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !vimMode || !cm) return;
      const state = cm.state.vim;
      if (state?.insertMode || state?.visualMode) return;
      if (state?.inputState?.keyBuffer?.length) return;
      event.preventDefault();
      event.stopPropagation();
      handlers.current.onCommit(false);
    };
    host.addEventListener("keydown", onCaptureKey, true);
    if (cm)
      vimExEditors.set(cm, {
        commit: (explicit) => handlers.current.onCommit(explicit),
        cancel: () => handlers.current.onCancel(),
        suggest: () => handlers.current.onSuggest(),
      });
    if (handleRef)
      handleRef.current = {
        append: (text, cursorFromEnd) => {
          const doc = view.state.doc.toString();
          const insert = (doc && !doc.endsWith("\n") ? "\n" : "") + text;
          const end = doc.length + insert.length;
          view.dispatch({
            changes: { from: doc.length, insert },
            selection: EditorSelection.cursor(end - cursorFromEnd),
          });
          view.focus();
        },
        escape: () => {
          const state = cm?.state.vim;
          if (cm && (state?.insertMode || state?.visualMode)) {
            Vim.handleKey(cm, "<Esc>", "user");
            view.focus();
          } else handlers.current.onCommit(false);
        },
        addImages: (files) => {
          addImages(
            view,
            files,
            handlers.current.onPasteImage,
            handlers.current.onBlocked,
          );
          view.focus();
        },
      };
    const typeOnFocus = () => {
      if (cm && !cm.state.vim?.insertMode) Vim.handleKey(cm, "i", "mapping");
    };
    let stopTaking = () => {};
    if (autoFocus) {
      if (vimMode && cm) Vim.handleKey(cm, "A", "mapping");
      stopTaking = takeFocus(view);
    } else if (vimMode && cm)
      view.contentDOM.addEventListener("focus", typeOnFocus, { once: true });
    // A phone's keyboard opening shrinks the screen: keep the box the editor
    // is drawn in (the parent of its box with the dictation button: the
    // editor with its bar and buttons) in view.
    const stopKeeping = keepAboveKeyboard(
      () => host.parentElement?.parentElement,
      () => view.hasFocus,
    );
    return () => {
      stopTaking();
      stopKeeping();
      view.contentDOM.removeEventListener("focus", typeOnFocus);
      host.removeEventListener("keydown", onCaptureKey, true);
      if (handleRef) handleRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  // Dictate, on the box as on the message box: needs the server's voice
  // engine. The text goes in at the cursor, as typed text does.
  const dictateHere = useSpeechEngine().listen;
  const dictation = useDictation({
    kind: "text",
    hint: placeholder,
    multiLine: true,
    read: () => {
      const view = viewRef.current;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      return { value: view.state.doc.toString(), start: from, end: to };
    },
    replace: (start, end, text, caret) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: EditorSelection.cursor(caret),
        userEvent: "input.type",
      });
      view.focus();
    },
  });
  return (
    <div className={`rc-editor-box${dictateHere ? " has-dictation" : ""}`}>
      <div ref={hostRef} className="rc-editor" />
      {dictateHere ? <DictationButton dictation={dictation} /> : null}
      <DictationStatus dictation={dictation} />
    </div>
  );
}
