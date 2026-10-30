import { insertNewlineAndIndent } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderText,
} from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { type RefObject, useEffect, useRef } from "react";

type Handlers = {
  commit: (explicit: boolean) => void;
  cancel: () => void;
  suggest: () => void;
};

/** Vim's ex commands are global; each editor registers its own handlers. */
const editors = new WeakMap<object, Handlers>();
let exCommandsDefined = false;

function defineExCommands() {
  if (exCommandsDefined) return;
  exCommandsDefined = true;
  Vim.defineEx("write", "w", (cm) => editors.get(cm)?.commit(true));
  Vim.defineEx("wq", "wq", (cm) => editors.get(cm)?.commit(true));
  Vim.defineEx("xit", "x", (cm) => editors.get(cm)?.commit(true));
  Vim.defineEx("quit", "q", (cm) => editors.get(cm)?.cancel());
  Vim.defineEx("suggest", "sugg", (cm) => editors.get(cm)?.suggest());
}

/** What the overlay can do to an open editor. */
export type CommentEditorHandle = {
  /** Appends text and puts the cursor `cursorFromEnd` characters before the end. */
  append: (text: string, cursorFromEnd: number) => void;
  /**
   * Esc, for keyboards without one: leaves insert or visual mode, and in
   * normal mode closes the editor as the key does.
   */
  escape: () => void;
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

/** A pasted or dropped image goes in as Markdown once stored. */
function addImage(
  view: EditorView,
  data: DataTransfer | null,
  event: Event,
  store?: (file: File) => Promise<string>,
): boolean {
  const file = [...(data?.files ?? [])].find((f) =>
    f.type.startsWith("image/"),
  );
  if (!file || !store) return false;
  event.preventDefault();
  const token = `![Adding image ${++uploads}...]()`;
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
  store(file).then(replace, () => replace(""));
  return true;
}

export function ReviewCommentEditor({
  value,
  vimMode,
  placeholder,
  handleRef,
  onChange,
  onCommit,
  onCancel,
  onSuggest,
  onPasteImage,
}: {
  value: string;
  vimMode: boolean;
  placeholder: string;
  handleRef?: RefObject<CommentEditorHandle | null>;
  onChange: (text: string) => void;
  /** Explicit: Cmd+Enter or :w, not Esc (a stray key is not sent by Esc). */
  onCommit: (explicit: boolean) => void;
  onCancel: () => void;
  onSuggest: () => void;
  /** Stores a pasted or dropped image; resolves to the Markdown for it. */
  onPasteImage?: (file: File) => Promise<string>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handlers = useRef({
    onChange,
    onCommit,
    onCancel,
    onSuggest,
    onPasteImage,
  });
  handlers.current = { onChange, onCommit, onCancel, onSuggest, onPasteImage };
  // Created once per mount (the parent remounts per comment) from the props
  // it was opened with.
  const initial = useRef({ value, vimMode, placeholder, handleRef });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { value, vimMode, placeholder, handleRef } = initial.current;
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
      state: EditorState.create({
        doc: value,
        selection: { anchor: value.length },
        extensions: [
          ...(vimMode ? [vim({ status: true })] : []),
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
          }),
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
              addImage(
                view,
                event.clipboardData,
                event,
                handlers.current.onPasteImage,
              ),
            drop: (event, view) =>
              addImage(
                view,
                event.dataTransfer,
                event,
                handlers.current.onPasteImage,
              ),
          }),
        ],
      }),
    });
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
      editors.set(cm, {
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
      };
    view.focus();
    if (vimMode && cm) Vim.handleKey(cm, "A", "mapping");
    // A phone's keyboard opening shrinks the screen: keep the editor in view.
    const keepInView = () => {
      if (view.hasFocus) view.dom.scrollIntoView({ block: "nearest" });
    };
    window.visualViewport?.addEventListener("resize", keepInView);
    return () => {
      window.visualViewport?.removeEventListener("resize", keepInView);
      host.removeEventListener("keydown", onCaptureKey, true);
      if (handleRef) handleRef.current = null;
      view.destroy();
    };
  }, []);

  return <div ref={hostRef} className="rc-editor" />;
}
