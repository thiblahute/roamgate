import {
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  history,
  historyKeymap,
  insertNewline,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
} from "@codemirror/commands";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder as placeholderText,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { type RefObject, useEffect, useRef } from "react";

/** What the message box's buttons can do to the editor. */
export type ComposerVimHandle = {
  /** Esc, for keyboards without one: leaves insert mode. */
  escape: () => void;
};
import { takeRenderCounts } from "../renderTrace";
import { voiceTrace } from "../voiceChat";
import { enterChatParts, scrollChatPage } from "./chatPaging";
import { defineExCommands, vimExEditors } from "./vimEx";

const shellBangMark = Decoration.mark({ class: "cm-shell-bang" });

function shellBang(view: EditorView): DecorationSet {
  const start = /^\s*!/.exec(view.state.doc.sliceString(0, 256));
  return start
    ? Decoration.set([
        shellBangMark.range(start[0].length - 1, start[0].length),
      ])
    : Decoration.none;
}

/**
 * The `!` that makes the box a shell line (Claude Code's bash mode), marked
 * so the box can colour it.
 */
const shellBangPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = shellBang(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = shellBang(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * The agent chat's message box with Vim keys (the one Vim keys setting).
 * It starts in insert mode; Esc goes to normal mode, `:w` sends, `:q`
 * leaves the box. Enter sends where the plain box sends on Enter and adds a
 * line elsewhere; Shift+Enter always adds one.
 */
export function ComposerVimEditor({
  value,
  selection,
  placeholder,
  label,
  enterSends,
  onChange,
  onSelect,
  onSubmit,
  onPasteImages,
  onComposingChange,
  onUpWhenEmpty,
  onSuspend,
  handleRef,
}: {
  /** The box's text; a change from outside (an upload, the terminal's box)
   * replaces it and puts the cursor at `selection`. */
  value: string;
  selection: { start: number; end: number } | null;
  placeholder: string;
  label: string;
  enterSends: boolean;
  onChange: (text: string, start: number, end: number) => void;
  onSelect: (start: number, end: number) => void;
  onSubmit: () => void;
  onPasteImages: (files: File[]) => void;
  onComposingChange: (composing: boolean) => void;
  /** Up in the empty box; true when it did something. */
  onUpWhenEmpty?: () => boolean;
  /** `:suspend` / `:stop`: the conversation stops as a shell job. */
  onSuspend?: () => void;
  handleRef?: RefObject<ComposerVimHandle | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The placeholder changes (a predicted next message shows there).
  const placeholderSlot = useRef(new Compartment());
  // What the box reported and the draft has not caught up with: the draft
  // comes back with each, maybe after more was typed, and must not undo it.
  const reportedRef = useRef(new Set<string>());
  // The draft as last seen: a render that brings the same draft (the chat's
  // history poll, a new selection object) is no change from outside, and
  // the box may be ahead of it with what was just typed.
  const lastValueRef = useRef(value);
  const handlers = useRef({
    onChange,
    onSelect,
    onSubmit,
    onPasteImages,
    onComposingChange,
    onUpWhenEmpty,
    enterSends,
    onSuspend,
  });
  handlers.current = {
    onChange,
    onSelect,
    onSubmit,
    onPasteImages,
    onComposingChange,
    onUpWhenEmpty,
    enterSends,
    onSuspend,
  };
  const initial = useRef({ value, placeholder, label, handleRef });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { value, placeholder, label, handleRef } = initial.current;
    defineExCommands();
    voiceTrace(`composer: box created with ${value.length} characters`);
    const submit = () => {
      handlers.current.onSubmit();
      return true;
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        selection: { anchor: value.length },
        extensions: [
          // Page Up / Down scroll the chat in every mode: ahead of Vim, which
          // would page the box itself in normal mode.
          Prec.highest(
            keymap.of([
              { key: "PageUp", run: (view) => scrollChatPage(view.dom, -1) },
              { key: "PageDown", run: (view) => scrollChatPage(view.dom, 1) },
              // Up into the conversation: Alt+Up, or k in normal mode on
              // the first line.
              { key: "Alt-ArrowUp", run: (view) => enterChatParts(view.dom) },
              {
                key: "k",
                run: (view) =>
                  !getCM(view)?.state.vim?.insertMode &&
                  view.state.doc.lineAt(view.state.selection.main.head)
                    .number === 1 &&
                  enterChatParts(view.dom),
              },
            ]),
          ),
          vim({ status: false }),
          // Undo and redo: vim's u and Ctrl-R, and Mod-Z / Mod-Shift-Z.
          history(),
          keymap.of(historyKeymap),
          // Up, ahead of vim's own: in the empty box, a queued message back;
          // else, from the first line, up into the conversation.
          Prec.highest(
            keymap.of([
              {
                key: "ArrowUp",
                run: (target) =>
                  (target.state.doc.length === 0 &&
                    (handlers.current.onUpWhenEmpty?.() ?? false)) ||
                  (target.state.doc.lineAt(target.state.selection.main.head)
                    .number === 1 &&
                    enterChatParts(target.dom)),
              },
            ]),
          ),
          keymap.of([
            { key: "Mod-Enter", run: submit },
            // Without the default keymap nothing else adds a line.
            {
              key: "Enter",
              run: (view) =>
                handlers.current.enterSends ? submit() : insertNewline(view),
            },
            { key: "Shift-Enter", run: insertNewline },
            // Start and end of the line.
            {
              key: "Home",
              run: cursorLineBoundaryBackward,
              shift: selectLineBoundaryBackward,
            },
            {
              key: "End",
              run: cursorLineBoundaryForward,
              shift: selectLineBoundaryForward,
            },
          ]),
          EditorView.lineWrapping,
          shellBangPlugin,
          EditorView.contentAttributes.of({
            "aria-label": label,
            spellcheck: "true",
            autocorrect: "on",
            autocapitalize: "sentences",
          }),
          placeholderSlot.current.of(placeholderText(placeholder)),
          EditorView.updateListener.of((update) => {
            const { from, to } = update.state.selection.main;
            if (update.docChanged) {
              const text = update.state.doc.toString();
              reportedRef.current.add(text);
              handlers.current.onChange(text, from, to);
            } else if (update.selectionSet) handlers.current.onSelect(from, to);
          }),
          EditorView.domEventHandlers({
            keydown: (event) => {
              // Typing belongs to the box, not to the app's shortcuts.
              event.stopPropagation();
              return false;
            },
            paste: (event) => {
              const images = Array.from(
                event.clipboardData?.files ?? [],
              ).filter((file) => file.type.startsWith("image/"));
              if (!images.length) return false;
              event.preventDefault();
              handlers.current.onPasteImages(images);
              return true;
            },
            compositionstart: () => {
              handlers.current.onComposingChange(true);
              return false;
            },
            compositionend: () => {
              handlers.current.onComposingChange(false);
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    const cm = getCM(view);
    if (cm) {
      vimExEditors.set(cm, {
        commit: () => handlers.current.onSubmit(),
        cancel: () => view.contentDOM.blur(),
        suspend: () => handlers.current.onSuspend?.(),
      });
      // Writing first: insert mode, as a message box is for typing.
      const enterInsert = () => {
        if (!cm.state.vim?.insertMode) Vim.handleKey(cm, "a", "mapping");
      };
      view.contentDOM.addEventListener("focus", enterInsert);
      if (handleRef)
        handleRef.current = {
          escape: () => {
            Vim.handleKey(cm, "<Esc>", "user");
            view.focus();
          },
        };
    }
    return () => {
      if (handleRef) handleRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  // TEMPORARY: with voice debugging on, slow keystrokes in the box and the
  // long frames around them, to find typing latency in the real page.
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    let typedAt = 0;
    const observers: PerformanceObserver[] = [];
    // Renders between keystrokes, and during the last one.
    let between = "";
    const host = hostRef.current;
    const onKeyDown = () => {
      between = takeRenderCounts();
    };
    host?.addEventListener("keydown", onKeyDown, true);
    try {
      const keys = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name !== "keydown") continue;
          const target = (entry as PerformanceEventTiming).target;
          if (!target || !hostRef.current?.contains(target as Node)) continue;
          typedAt = performance.now();
          const timing = entry as PerformanceEventTiming;
          voiceTrace(
            `composer: slow key ${Math.round(entry.duration)} ms (delay ${Math.round(timing.processingStart - entry.startTime)}, handlers ${Math.round(timing.processingEnd - timing.processingStart)}); rendered by it: ${takeRenderCounts() || "nothing"}; before it: ${between || "nothing"}`,
          );
        }
      });
      keys.observe({
        type: "event",
        durationThreshold: 48,
      } as PerformanceObserverInit);
      observers.push(keys);
      const frames = new PerformanceObserver((list) => {
        if (performance.now() - typedAt > 3000) return;
        for (const entry of list.getEntries()) {
          const frame = entry as PerformanceEntry & {
            renderStart: number;
            styleAndLayoutStart: number;
            blockingDuration: number;
            scripts: {
              duration: number;
              invoker: string;
              sourceURL: string;
              sourceFunctionName: string;
            }[];
          };
          const scripts = [...frame.scripts]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 3)
            .map(
              (script) =>
                `${Math.round(script.duration)}ms ${script.invoker} ${script.sourceFunctionName || "?"}@${script.sourceURL.split("/").pop()}`,
            )
            .join("; ");
          const render = frame.renderStart
            ? Math.round(entry.startTime + entry.duration - frame.renderStart)
            : 0;
          const layout = frame.styleAndLayoutStart
            ? Math.round(
                entry.startTime + entry.duration - frame.styleAndLayoutStart,
              )
            : 0;
          voiceTrace(
            `composer: long frame ${Math.round(entry.duration)} ms (render ${render}, style+layout ${layout}): ${scripts || "no script"}`,
          );
        }
      });
      frames.observe({ type: "long-animation-frame", buffered: false });
      observers.push(frames);
    } catch {
      // Not supported here.
    }
    return () => {
      host?.removeEventListener("keydown", onKeyDown, true);
      for (const observer of observers) observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || placeholder === initial.current.placeholder) return;
    initial.current.placeholder = placeholder;
    view.dispatch({
      effects: placeholderSlot.current.reconfigure(
        placeholderText(placeholder),
      ),
    });
  }, [placeholder]);

  // Someone else's change to the draft (an upload, the terminal's box).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    const current = view.state.doc.toString();
    const reported = reportedRef.current;
    if (current === value) {
      reported.clear();
      return;
    }
    // Our own earlier text coming back late: newer typing stays.
    if (reported.has(value)) {
      voiceTrace(
        `composer: late echo kept out (${value.length} < ${current.length})`,
      );
      return;
    }
    reported.clear();
    voiceTrace(
      `composer: draft replaces the box: ${JSON.stringify(current.slice(-20))} -> ${JSON.stringify(value.slice(-20))}`,
    );
    const length = value.length;
    const clamp = (offset: number) => Math.max(0, Math.min(offset, length));
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: selection
        ? EditorSelection.range(clamp(selection.start), clamp(selection.end))
        : EditorSelection.cursor(length),
    });
    // Emptied by a send: ready for the next message, in insert mode as the
    // box starts, so its first letter is not taken as a command.
    const cm = getCM(view);
    if (!value && cm && !cm.state.vim?.insertMode)
      Vim.handleKey(cm, "i", "mapping");
  }, [value, selection]);

  return <div ref={hostRef} className="agent-history-composer-editor" />;
}
