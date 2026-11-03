import { useRenderTrace } from "../renderTrace";
import {
  shortcutMatches,
  shortcutTitle,
  useShortcutPreferences,
} from "../shortcutPreferences";
import {
  CornerDownLeft,
  Keyboard,
  Paperclip,
  SquareTerminal,
  TextCursorInput,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { roamgateLocalStorage, subscribeLocalStorage } from "../browserStorage";
import {
  type MobileTerminalShortcut,
  mobileTerminalShortcutOption,
} from "../mobileTerminalShortcuts";
import { useVimKeys } from "../vimKeys";
import { lazyWithReload } from "../lazyWithReload";
import type { ComposerVimHandle } from "./ComposerVimEditor";
import {
  beginTerminalComposerUpload,
  finishTerminalComposerUpload,
  insertIntoTerminalComposerDraft,
  readTerminalComposerDraft,
  retainTerminalComposerUploadPaths,
  readTerminalComposerSelection,
  subscribeTerminalComposerDraft,
  subscribeTerminalComposerSubmission,
  submitTerminalComposerDraft,
  subscribeTerminalComposerUpload,
  terminalComposerSubmissionPending,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
  terminalComposerDraftSaved,
} from "../terminalComposer";
import {
  type ComposerCommand,
  completeComposerCommand,
  composerCommandPrefix,
  filterComposerCommands,
  terminalComposerCommands,
} from "../terminalComposerCommands";
import {
  filesFromTerminalDrop,
  isNativeFileDrag,
  terminalUploadedPathsText,
} from "../terminalFileDrop";
import {
  isWorkspacePathDrag,
  workspacePathFromDrag,
} from "../workspacePathDrag";
import { isMobileLayout } from "../layoutPreferences";
import { AgentLauncher } from "./AgentLauncher";
import { useTouchReleaseSubmit } from "./useTouchReleaseSubmit";
import "./TerminalComposer.css";
import type { TerminalInputMode } from "../terminalInputMode";
export type { TerminalInputMode } from "../terminalInputMode";

// The agent chats' Vim box, loaded with the first box that needs Vim keys.
const ComposerVimEditor = lazyWithReload("composer-vim-editor", () =>
  import("./ComposerVimEditor").then((module) => ({
    default: module.ComposerVimEditor,
  })),
);

/** The element typing goes to: the plain box, or the Vim box's content. */
function typingField(
  textarea: HTMLTextAreaElement | null,
  vimHost: HTMLElement | null,
): HTMLElement | null {
  return textarea ?? vimHost?.querySelector<HTMLElement>(".cm-content") ?? null;
}

const SHORTCUTS_OPEN_STORAGE_KEY = "terminalComposerShortcutsOpen.v1";
let unsavedShortcutsOpen: boolean | undefined;

export function readTerminalComposerShortcutsOpen(): boolean {
  return (
    unsavedShortcutsOpen ??
    roamgateLocalStorage.getItem(SHORTCUTS_OPEN_STORAGE_KEY) !== "false"
  );
}

/**
 * Bottom-docked mobile terminal composer. A plain textarea owns all editing
 * (IME, dictation, selection, autocorrect, multiline paste) and text only
 * reaches the PTY when the user explicitly chooses Insert or Send, which
 * sidesteps the xterm helper-textarea races described in the IME recovery
 * code. Drafts are written through the shared store for pane switches,
 * reconnects and browser recovery.
 *
 * The configurable mobile shortcut keys live at the top of the dock so the
 * composer is the single mobile input control surface. Direct mode reuses
 * xterm's input channel; the native editor stays mounted to preserve its caret.
 *
 * With the one Vim keys setting on (the default), the box is the agent
 * chats' Vim editor (ComposerVimEditor) instead of the textarea, with the
 * same modes, picker, uploads and drops; an Esc button stands in for the
 * phone keyboard's missing key.
 *
 * Files arrive through clipboard paste, drop, or the file picker, upload once, and
 * land at the draft caret in Composer. Direct captures a guarded terminal
 * insertion at the initiating gesture, without changing the draft or sending Enter.
 */
export function TerminalComposer({
  draftKey,
  submitWarning,
  submitWarningKey,
  paneId,
  workspaceId,
  tabId,
  terminalId,
  open = true,
  accessoriesVisible = true,
  reserved = false,
  mode,
  onModeChange,
  onFocusDirect,
  directDisabled,
  agent,
  shortcutRows,
  onRunShortcut,
  shortcutDisabledReason,
  onShortcutsVisibleChange,
  onClose,
  onSubmit,
  onUploadImage,
  onUploadFile,
  onPreparePathInsertion,
  onError,
  vimKeys: vimKeysProp,
}: {
  draftKey: string;
  submitWarning?: string | null;
  submitWarningKey?: string;
  paneId?: string;
  workspaceId?: string;
  tabId?: string;
  terminalId?: string;
  open?: boolean;
  // Presentation only: secondary App surfaces keep the editor and input session.
  accessoriesVisible?: boolean;
  reserved?: boolean;
  mode: TerminalInputMode;
  onModeChange: (mode: TerminalInputMode, remember?: boolean) => void;
  onFocusDirect: () => void;
  directDisabled: boolean;
  agent?: string;
  shortcutRows: (MobileTerminalShortcut | null)[][];
  onRunShortcut: (shortcut: MobileTerminalShortcut) => void;
  shortcutDisabledReason?: (shortcut: MobileTerminalShortcut) => string | null;
  onShortcutsVisibleChange?: (visible: boolean) => void;
  onClose: () => void;
  onSubmit: (text: string, submit: boolean) => Promise<void>;
  onUploadImage: (file: File) => Promise<string>;
  onUploadFile: (file: File) => Promise<string>;
  onPreparePathInsertion?: () => (text: string) => Promise<void>;
  onError: (message: string) => void;
  /** Vim keys in the box; the one Vim keys setting by default. */
  vimKeys?: boolean;
}) {
  useRenderTrace("TerminalComposer");
  useShortcutPreferences();
  const [text, setText] = useState(() => readTerminalComposerDraft(draftKey));
  const [submissionPending, setSubmissionPending] = useState(() =>
    terminalComposerSubmissionPending(draftKey),
  );
  const [uploadCount, setUploadCount] = useState(() =>
    terminalComposerUploadCount(draftKey),
  );
  const accessoriesOpen = open && accessoriesVisible;
  const warningContext = JSON.stringify([
    draftKey,
    text,
    submitWarning,
    submitWarningKey,
  ]);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirming =
    accessoriesOpen && !!submitWarning && confirmation === warningContext;
  useEffect(() => {
    if (
      confirmation !== null &&
      (!accessoriesOpen || confirmation !== warningContext)
    )
      setConfirmation(null);
  }, [accessoriesOpen, confirmation, warningContext]);
  const [composing, setComposing] = useState(false);
  const [editorFocused, setEditorFocused] = useState(false);
  // Latch expansion for this focus session: expanding changes the wrapping
  // width, so deriving it continuously from scrollHeight would oscillate.
  const [expanded, setExpanded] = useState(false);
  const [toolPointerPending, setToolPointerPending] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(
    readTerminalComposerShortcutsOpen,
  );
  useEffect(
    () =>
      subscribeLocalStorage((key) => {
        if (key !== null && key !== SHORTCUTS_OPEN_STORAGE_KEY) return;
        unsavedShortcutsOpen = undefined;
        setShortcutsOpen(
          roamgateLocalStorage.getItem(SHORTCUTS_OPEN_STORAGE_KEY) !== "false",
        );
      }),
    [],
  );
  const [pickerMode, setPickerMode] = useState<"browse" | "inline" | null>(
    null,
  );
  const [activeCommand, setActiveCommand] = useState(0);
  const [replacement, setReplacement] = useState<{
    command: ComposerCommand;
    draft: string;
  } | null>(null);
  const commands = terminalComposerCommands(agent);
  const pickerId = useId();
  const commandListRef = useRef<HTMLDivElement | null>(null);
  const commandPickerRef = useRef<HTMLElement | null>(null);
  const commandsButtonRef = useRef<HTMLButtonElement | null>(null);
  const replacementCancelRef = useRef<HTMLButtonElement | null>(null);
  const matches =
    pickerMode === "inline"
      ? filterComposerCommands(commands, /^\/[^\s]*/.exec(text)?.[0] ?? "")
      : commands;
  const pickerOpen = pickerMode !== null && commands.length > 0;
  const presentedPickerOpen = accessoriesOpen && pickerOpen;
  const selectedCommand = matches[activeCommand];

  // Agent metadata can arrive while editing. Reset only its command UI, not
  // the textarea (or its focus, selection, and active IME composition).
  useEffect(() => {
    setPickerMode(null);
    setActiveCommand(0);
    setReplacement(null);
  }, [agent]);

  useEffect(() => {
    if (presentedPickerOpen)
      commandListRef.current?.children[activeCommand]?.scrollIntoView({
        block: "nearest",
      });
  }, [activeCommand, presentedPickerOpen, text]);

  // Async uploads or edits must not be discarded by a stale confirmation.
  useEffect(() => {
    if (replacement && replacement.draft !== text) setReplacement(null);
  }, [replacement, text]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const vimSetting = useVimKeys();
  const vimKeys = vimKeysProp ?? vimSetting;
  const vimHostRef = useRef<HTMLDivElement | null>(null);
  const vimHandleRef = useRef<ComposerVimHandle | null>(null);
  const editorField = () =>
    typingField(textareaRef.current, vimHostRef.current);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const compositionUploadsRef = useRef<Array<() => void>>([]);
  useEffect(
    () => () => {
      if (compositionEndTimerRef.current !== null)
        clearTimeout(compositionEndTimerRef.current);
      composingRef.current = false;
      for (const resume of compositionUploadsRef.current.splice(0)) resume();
    },
    [],
  );
  const temporaryComposerRef = useRef(false);

  useEffect(() => {
    if (open) return;
    temporaryComposerRef.current = false;
    typingField(textareaRef.current, vimHostRef.current)?.blur();
    setPickerMode(null);
    setReplacement(null);
  }, [open]);

  useEffect(() => {
    let pending = false;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const blurOutsideEditor = (event: PointerEvent) => {
      const textarea = typingField(textareaRef.current, vimHostRef.current);
      const inEditor =
        event.target === textarea ||
        (!!vimHostRef.current &&
          event.target instanceof Node &&
          vimHostRef.current.contains(event.target));
      // xterm prevents native focus transfer on terminal touches. End editing
      // explicitly in capture, but never for caret drags, scrolling, IME, or
      // composer tools. Tools keep their DOM/geometry through blur and click;
      // native file pickers may blur without an async completion refocusing.
      const shortcutControl =
        event.target instanceof Element &&
        Boolean(
          event.target.closest(
            ".terminal-mobile-keys, .terminal-mobile-side-shortcuts",
          ),
        );
      const inside =
        composerRef.current?.contains(event.target as Node) || shortcutControl;
      clearTimeout(releaseTimer);
      if (!inside) {
        pending = false;
        setToolPointerPending(false);
      } else if (!inEditor) {
        pending = true;
        setToolPointerPending(true);
      }
      // Submit must not depend on keyboard geometry: an absent/stale signal
      // would blur in capture, restore the header and move the release target.
      const keepEditorFocus = Boolean(
        event.target instanceof Element &&
          event.target.closest(".terminal-composer-submit"),
      );
      if (
        !!textarea &&
        document.activeElement === textarea &&
        (!inside ||
          (event.pointerType === "touch" &&
            !inEditor &&
            !keepEditorFocus &&
            !document.documentElement.classList.contains("keyboard-open")))
      )
        textarea?.blur();
    };
    const release = () => {
      pending = false;
      clearTimeout(releaseTimer);
      setToolPointerPending(false);
    };
    // Native touch blur can precede click. Keep the row's geometry until the
    // pending tool has received that click (including opening a file picker).
    const pointerUp = () => {
      if (!pending) return;
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(release, 500);
    };
    document.addEventListener("pointerdown", blurOutsideEditor, true);
    document.addEventListener("click", release);
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", release);
    return () => {
      clearTimeout(releaseTimer);
      document.removeEventListener("pointerdown", blurOutsideEditor, true);
      document.removeEventListener("click", release);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", release);
    };
  }, []);

  useEffect(() => {
    if (mode !== "composer") temporaryComposerRef.current = false;
    if ((!editorFocused && !toolPointerPending) || !open || mode !== "composer")
      setExpanded(false);
  }, [editorFocused, mode, open, toolPointerPending]);

  // Load the incoming pane's draft and subscribe to updates from async work
  // that may outlive an earlier composer mount for this pane.
  useEffect(() => {
    const applyDraft = (draft: string) => setText(draft);
    applyDraft(readTerminalComposerDraft(draftKey));
    return subscribeTerminalComposerDraft(draftKey, applyDraft);
  }, [draftKey]);

  useEffect(() => {
    setSubmissionPending(terminalComposerSubmissionPending(draftKey));
    return subscribeTerminalComposerSubmission(draftKey, setSubmissionPending);
  }, [draftKey]);

  useEffect(() => {
    setUploadCount(terminalComposerUploadCount(draftKey));
    return subscribeTerminalComposerUpload(draftKey, setUploadCount);
  }, [draftKey]);

  // Measure at the collapsed width first, including soft wraps. CSS caps the
  // unfocused preview to one row; scrollHeight still reports its full content.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (mode !== "composer") {
      textarea.style.height = "";
      return;
    }
    const measure = () => {
      if (!text) {
        textarea.style.height = "";
        return;
      }
      const previousMinHeight = textarea.style.minHeight;
      textarea.style.minHeight = "0px";
      textarea.style.height = "0px";
      const contentHeight = textarea.scrollHeight;
      textarea.style.minHeight = previousMinHeight;
      textarea.style.height = `${contentHeight}px`;
      if (!editorFocused || !open || expanded) return;
      const style = window.getComputedStyle(textarea);
      const oneRow =
        Number.parseFloat(style.lineHeight) +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      if (/\r|\n/.test(text) || contentHeight > oneRow + 1) setExpanded(true);
    };
    measure();
    // Keyboard/viewport rotation and UI scaling can introduce a soft wrap
    // without changing the draft. Do not refocus or replace the editor.
    if (typeof ResizeObserver === "undefined") return;
    let measuredWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = textarea.getBoundingClientRect().width;
      if (width === measuredWidth) return;
      measuredWidth = width;
      measure();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [text, mode, open, editorFocused, expanded]);

  // The Vim box sizes itself; it expands as the plain box does, once its
  // draft takes more than a row while it is being edited.
  useEffect(() => {
    const host = vimHostRef.current;
    if (!host || mode !== "composer") return;
    const measure = () => {
      if (!text || !editorFocused || !open || expanded) return;
      const content = host.querySelector<HTMLElement>(".cm-content");
      if (!content) return;
      const style = window.getComputedStyle(content);
      const oneRow =
        Number.parseFloat(style.lineHeight) +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      if (/\r|\n/.test(text) || content.scrollHeight > oneRow + 1)
        setExpanded(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [text, mode, open, editorFocused, expanded]);

  // Restore the shared selection after a programmatic insertion. The shared
  // value belongs to the draft key, so an upload started by an older mount can
  // place its path at the current mount's completion-time caret.
  useEffect(() => {
    const textarea = textareaRef.current;
    const selection = readTerminalComposerSelection(draftKey);
    if (!textarea || !selection || mode !== "composer") return;
    textarea.setSelectionRange(selection.start, selection.end);
  }, [draftKey, text, mode]);

  // No visualViewport lift here: App.tsx owns keyboard geometry and exposes
  // the measured inset through shared CSS variables.
  const updateText = (value: string, start: number, end: number) => {
    setText(value);
    setReplacement(null);
    if (pickerMode !== "browse") {
      const nextPickerMode =
        composerCommandPrefix(value, start, end) !== null ? "inline" : null;
      setPickerMode(nextPickerMode);
      setActiveCommand(0);
      onShortcutsVisibleChange?.(
        shortcutsOpen && !(nextPickerMode !== null && commands.length > 0),
      );
    }
    writeTerminalComposerDraft(draftKey, value);
    writeTerminalComposerSelection(draftKey, start, end);
  };

  // A caret or selection the user moved in the box.
  const selectionChanged = (value: string, start: number, end: number) => {
    // Ignore hidden or not-yet-committed DOM selections. They belong
    // to an older draft, not the caret advanced by an async insertion.
    if (mode !== "composer" || value !== readTerminalComposerDraft(draftKey))
      return;
    writeTerminalComposerSelection(draftKey, start, end);
    if (
      pickerMode === "inline" &&
      composerCommandPrefix(value, start, end) === null
    )
      dismissCommands();
  };

  const preparePathInsertion = () =>
    onPreparePathInsertion?.() ??
    (async (path: string) => {
      insertIntoTerminalComposerDraft(draftKey, path);
    });
  const prepareUpload = () => ({
    key: draftKey,
    upload: onUploadFile,
    insert: preparePathInsertion(),
  });
  const pickerCleanupRef = useRef<(() => void) | null>(null);

  const uploadAndInsert = async (
    files: File[],
    upload: (file: File) => Promise<string>,
    insert = preparePathInsertion(),
    uploadDraftKey = draftKey,
  ) => {
    if (files.length === 0) return;
    if (
      composingRef.current ||
      terminalComposerSubmissionPending(uploadDraftKey) ||
      !beginTerminalComposerUpload(uploadDraftKey)
    )
      return;
    const paths: string[] = [];
    try {
      for (const file of files) paths.push(await upload(file));
      if (mode === "composer" && composingRef.current)
        await new Promise<void>((resolve) =>
          compositionUploadsRef.current.push(resolve),
        );
      if (composingRef.current)
        throw new Error(
          "Path insertion deferred during text composition; path retained in Message draft",
        );
      await insert(terminalUploadedPathsText(paths));
      paths.length = 0;
    } catch (error) {
      // Keep successful earlier files when a later upload fails. Delivery
      // itself owns its fallback, so do not retry an uncertain PTY write.
      if (paths.length) {
        if (mode === "composer" && composingRef.current)
          await new Promise<void>((resolve) =>
            compositionUploadsRef.current.push(resolve),
          );
        retainTerminalComposerUploadPaths(
          uploadDraftKey,
          terminalUploadedPathsText(paths),
        );
      }
      onError(error instanceof Error ? error.message : "File upload failed");
    } finally {
      finishTerminalComposerUpload(uploadDraftKey);
    }
  };

  const pickFiles = (input: HTMLInputElement, context = prepareUpload()) => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length > 0)
      void uploadAndInsert(files, context.upload, context.insert, context.key);
  };

  const submit = async (sendEnter: boolean, confirmed = false) => {
    const draft = text;
    const submittedDraftKey = draftKey;
    if (
      !accessoriesOpen ||
      !draft ||
      terminalComposerUploadCount(submittedDraftKey) > 0 ||
      composingRef.current
    ) {
      return;
    }

    if (sendEnter && submitWarning && !confirmed) {
      setConfirmation(warningContext);
      return;
    }
    try {
      await submitTerminalComposerDraft(
        submittedDraftKey,
        draft,
        (submitted) => onSubmit(submitted, sendEnter),
        () => {
          dismissCommands();
          setConfirmation(null);
        },
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to send input");
    }
  };

  const keepTextareaFocus = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Cancel the focus-taking mouse event, not pointerdown: WebKit can
    // suppress a touch's click entirely when pointerdown is cancelled.
    e.preventDefault();
  };

  // Only the two destructive actions need the touch release fallback.
  const touchSubmit = useTouchReleaseSubmit({
    submitKey: draftKey,
    resetKey: JSON.stringify([
      draftKey,
      paneId,
      mode,
      open,
      accessoriesVisible,
      warningContext,
    ]),
    canStart: () =>
      !composingRef.current &&
      terminalComposerUploadCount(draftKey) === 0 &&
      !terminalComposerSubmissionPending(draftKey),
    canFinish: () => accessoriesOpen && mode === "composer",
  });
  const cancelSubmitTouch = touchSubmit.cancel;

  const dismissCommands = () => {
    setPickerMode(null);
    setReplacement(null);
    setActiveCommand(0);
    onShortcutsVisibleChange?.(shortcutsOpen);
  };

  const commandEditorFocused = () => {
    const field = editorField();
    return !!field && document.activeElement === field;
  };

  const focusPickerWithoutKeyboard = () => {
    if (!commandEditorFocused())
      commandPickerRef.current?.focus({ preventScroll: true });
  };

  const closeCommandPicker = () => {
    const editorFocused = commandEditorFocused();
    dismissCommands();
    if (!editorFocused)
      commandsButtonRef.current?.focus({ preventScroll: true });
  };

  const selectCommand = (command: ComposerCommand, confirmed = false) => {
    if (busy || composingRef.current) return;
    const draft = readTerminalComposerDraft(draftKey);
    if (confirmed && replacement?.draft !== draft) {
      setReplacement(null);
      return;
    }
    if (pickerMode === "browse" && draft && !confirmed) {
      setReplacement({ command, draft });
      return;
    }
    const textarea = textareaRef.current;
    const caret = textarea
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : vimHandleRef.current?.selection();
    const next =
      pickerMode === "inline"
        ? completeComposerCommand(
            draft,
            command,
            caret?.start ?? 0,
            caret?.end ?? 0,
          )
        : {
            text: `${command.name} `,
            start: command.name.length + 1,
            end: command.name.length + 1,
          };
    if (!next) return;
    writeTerminalComposerDraft(draftKey, next.text);
    writeTerminalComposerSelection(draftKey, next.start, next.end);
    const editorFocused = commandEditorFocused();
    dismissCommands();
    if (!editorFocused)
      commandsButtonRef.current?.focus({ preventScroll: true });
    textarea?.setSelectionRange(next.start, next.end);
  };

  const commandKeyDown = (e: React.KeyboardEvent) => {
    if (
      !presentedPickerOpen ||
      e.nativeEvent.isComposing ||
      composingRef.current ||
      e.keyCode === 229
    )
      return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCommandPicker();
      return true;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || replacement)
      return false;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
      e.preventDefault();
      e.stopPropagation();
      setActiveCommand(
        (index) =>
          (index + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
          matches.length,
      );
      return true;
    }
    if (e.key === "Tab" && selectedCommand && !busy) {
      e.preventDefault();
      e.stopPropagation();
      // Keyboard selection must enter the confirmation's tab order. Touch
      // selection keeps the editor focused so its soft keyboard stays open.
      flushSync(() => selectCommand(selectedCommand));
      replacementCancelRef.current?.focus({ preventScroll: true });
      return true;
    }
    return false;
  };

  const busy = submissionPending || uploadCount > 0;
  useEffect(() => {
    if (busy || composing) cancelSubmitTouch();
  }, [busy, composing, cancelSubmitTouch]);
  const submitDisabled = !text || busy || composing;
  const hasShortcuts = shortcutRows.some((row) =>
    row.some((shortcut) => shortcut !== null),
  );
  const shortcutColumns = Math.max(1, ...shortcutRows.map((row) => row.length));
  useEffect(() => {
    onShortcutsVisibleChange?.(shortcutsOpen && !pickerOpen);
  }, [onShortcutsVisibleChange, pickerOpen, shortcutsOpen]);
  const activateMessage = (remember: boolean) => {
    if (composingRef.current) return;
    flushSync(() => onModeChange("composer", remember));
  };
  const placeholder = agent?.trim() ? `Message ${agent.trim()}…` : "Message…";
  // The command list the box controls, and its active option.
  const listShown = presentedPickerOpen && !replacement;
  const activeOption =
    listShown && selectedCommand ? `${pickerId}-${activeCommand}` : undefined;
  const focusEditor = () => {
    setEditorFocused(true);
    const remember =
      !open || mode !== "composer" || temporaryComposerRef.current;
    temporaryComposerRef.current = false;
    activateMessage(remember);
  };
  const compositionStarted = () => {
    cancelSubmitTouch();
    if (compositionEndTimerRef.current !== null) {
      clearTimeout(compositionEndTimerRef.current);
      compositionEndTimerRef.current = null;
    }
    composingRef.current = true;
    setComposing(true);
  };
  const compositionEnded = () => {
    const finish = () => {
      compositionEndTimerRef.current = null;
      composingRef.current = false;
      setComposing(false);
      for (const resume of compositionUploadsRef.current.splice(0)) resume();
    };
    compositionEndTimerRef.current = setTimeout(finish, 0);
  };
  // Pasted files, images or not, upload and land at the caret.
  const pasteFiles = (files: File[]) =>
    void uploadAndInsert(files, (file) =>
      file.type.startsWith("image/") ? onUploadImage(file) : onUploadFile(file),
    );
  const takesDrag = (data: DataTransfer) =>
    isWorkspacePathDrag(data) || isNativeFileDrag(data);
  /** A drop on the box: a workspace path, or files to upload; true if taken. */
  const dropOnEditor = (data: DataTransfer): boolean => {
    if (isWorkspacePathDrag(data)) {
      const path = workspacePathFromDrag(data);
      if (
        path &&
        !composingRef.current &&
        !terminalComposerSubmissionPending(draftKey)
      )
        void preparePathInsertion()(path);
      return true;
    }
    if (!isNativeFileDrag(data)) return false;
    const files = filesFromTerminalDrop(data);
    if (files === "directory") {
      onError("Drop files only; directories are not supported.");
    } else if (files?.length) {
      void uploadAndInsert(files, onUploadFile);
    }
    return true;
  };
  /** The box's own keys; true when one was taken. */
  const editorKeyDown = (e: React.KeyboardEvent): boolean => {
    if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229)
      return false;
    if (e.key === "Escape" && confirming) {
      e.preventDefault();
      e.stopPropagation();
      setConfirmation(null);
      return true;
    }
    if (shortcutMatches(e.nativeEvent, "composer.send")) {
      e.preventDefault();
      if (!e.repeat) void submit(true);
      return true;
    }
    return commandKeyDown(e);
  };

  return (
    <>
      <div
        ref={composerRef}
        className="terminal-composer"
        // Its draft outlives a reload: a newer build need not wait for it.
        data-draft-saved={terminalComposerDraftSaved(draftKey) || undefined}
        data-expanded={
          (expanded &&
            (editorFocused || toolPointerPending) &&
            accessoriesOpen &&
            mode === "composer") ||
          undefined
        }
        data-input-mode={mode}
        data-pane-id={paneId}
        data-open={open || undefined}
        data-reserved={reserved || undefined}
        role="group"
        aria-label="Terminal input"
        tabIndex={-1}
        onFocus={(event) => {
          // Composer dock/background focus stays neutral. Only its native
          // editor opens the keyboard; Direct retains its explicit handoff.
          if (event.target !== event.currentTarget) return;
          if (mode === "direct" && !directDisabled) onFocusDirect();
        }}
      >
        {confirming ? (
          <div className="agent-history-composer-warning" role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            <p>{submitWarning}</p>
            <div className="agent-history-composer-warning-actions">
              <button
                type="button"
                className="ghost"
                onMouseDown={keepTextareaFocus}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitDisabled}
                onMouseDown={keepTextareaFocus}
                {...touchSubmit.buttonProps(() => void submit(true, true))}
              >
                Send anyway
              </button>
            </div>
          </div>
        ) : null}
        <div className="terminal-composer-toolbar" hidden={!accessoriesOpen}>
          <button
            type="button"
            className="terminal-composer-attach"
            title="Add a file"
            aria-label="Add a file"
            disabled={busy || composing}
            onMouseDown={keepTextareaFocus}
            onClick={() => {
              if (composingRef.current) return;
              const input = fileInputRef.current;
              if (!input) return;
              pickerCleanupRef.current?.();
              const context = prepareUpload();
              const cleanup = () => {
                input.removeEventListener("change", selected);
                input.removeEventListener("cancel", cleanup);
                pickerCleanupRef.current = null;
              };
              // The native chooser can finish after React replaces this pane.
              const selected = (event: Event) => {
                event.stopPropagation();
                cleanup();
                pickFiles(input, context);
              };
              input.addEventListener("change", selected);
              input.addEventListener("cancel", cleanup);
              pickerCleanupRef.current = cleanup;
              input.click();
            }}
          >
            <Paperclip size={15} />
          </button>
          {hasShortcuts ? (
            <button
              type="button"
              className="terminal-composer-shortcuts-toggle"
              aria-label={
                shortcutsOpen && !pickerOpen
                  ? "Hide terminal shortcuts"
                  : "Show terminal shortcuts"
              }
              title={
                shortcutsOpen && !pickerOpen
                  ? "Hide terminal shortcuts"
                  : "Show terminal shortcuts"
              }
              aria-expanded={accessoriesOpen && shortcutsOpen && !pickerOpen}
              aria-controls={`${pickerId}-shortcuts`}
              onMouseDown={keepTextareaFocus}
              onClick={() => {
                const open = pickerOpen || !shortcutsOpen;
                dismissCommands();
                setShortcutsOpen(open);
                onShortcutsVisibleChange?.(open);
                try {
                  roamgateLocalStorage.setItem(
                    SHORTCUTS_OPEN_STORAGE_KEY,
                    String(open),
                  );
                  unsavedShortcutsOpen = undefined;
                } catch {
                  // Keep the choice across mounts when storage is unavailable.
                  unsavedShortcutsOpen = open;
                }
              }}
            >
              <Keyboard size={17} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="terminal-composer-commands-toggle"
            aria-label="Commands"
            ref={commandsButtonRef}
            aria-expanded={presentedPickerOpen}
            aria-controls={
              presentedPickerOpen && !replacement ? pickerId : undefined
            }
            disabled={commands.length === 0 || busy || composing}
            title={
              commands.length
                ? "Browse agent commands"
                : "No built-in commands for this agent; type any command in the draft"
            }
            onMouseDown={keepTextareaFocus}
            onClick={() => {
              flushSync(() => {
                if (mode === "direct") {
                  temporaryComposerRef.current = true;
                  onModeChange("composer");
                }
                setPickerMode("browse");
                setActiveCommand(0);
                setReplacement(null);
                onShortcutsVisibleChange?.(false);
              });
              focusPickerWithoutKeyboard();
            }}
          >
            <SquareTerminal size={17} aria-hidden="true" />
          </button>
          <div
            className="terminal-composer-submit-actions"
            hidden={mode !== "composer"}
          >
            <span className="terminal-composer-hint" role="status">
              {uploadCount > 0
                ? "Uploading file…"
                : submissionPending
                  ? "Sending…"
                  : ""}
            </span>
            <button
              type="button"
              className="terminal-composer-submit"
              title="Insert into the terminal without executing"
              aria-label="Insert draft into the terminal"
              disabled={submitDisabled}
              onMouseDown={keepTextareaFocus}
              {...touchSubmit.buttonProps(() => void submit(false))}
            >
              <TextCursorInput size={14} />
              Insert
            </button>
            <button
              type="button"
              className="terminal-composer-submit is-primary"
              title={shortcutTitle(
                "Insert into the terminal and send Enter",
                "composer.send",
              )}
              aria-label="Send draft to the terminal"
              disabled={submitDisabled || confirming}
              onMouseDown={keepTextareaFocus}
              {...touchSubmit.buttonProps(() => void submit(true))}
            >
              <CornerDownLeft size={14} />
              Send
            </button>
          </div>
          <button
            type="button"
            className="terminal-composer-close"
            title="Close terminal input"
            aria-label="Close terminal input"
            onMouseDown={keepTextareaFocus}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        {hasShortcuts ? (
          <div
            className="terminal-composer-shortcuts"
            id={`${pickerId}-shortcuts`}
            hidden={!accessoriesOpen || !shortcutsOpen || pickerOpen}
            style={
              {
                "--mobile-shortcut-columns": shortcutColumns,
              } as CSSProperties
            }
            aria-label="Terminal shortcuts"
          >
            {shortcutRows.map((row, rowIndex) => (
              <div
                className="terminal-composer-shortcut-row"
                key={`composer-shortcut-row-${rowIndex}`}
              >
                {row.map((shortcut, slotIndex) => {
                  if (!shortcut) {
                    return (
                      <span
                        className="terminal-composer-shortcut-spacer"
                        aria-hidden="true"
                        key={`composer-shortcut-${rowIndex}-${slotIndex}`}
                      />
                    );
                  }
                  const option = mobileTerminalShortcutOption(shortcut.action);
                  return (
                    <button
                      type="button"
                      aria-label={`Send ${option?.label ?? shortcut.label}`}
                      onMouseDown={keepTextareaFocus}
                      disabled={
                        composing || !!shortcutDisabledReason?.(shortcut)
                      }
                      title={
                        shortcutDisabledReason?.(shortcut) ??
                        option?.label ??
                        shortcut.label
                      }
                      onClick={() => {
                        if (!composingRef.current) onRunShortcut(shortcut);
                      }}
                      key={shortcut.id}
                    >
                      {shortcut.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
        {presentedPickerOpen ? (
          <section
            ref={commandPickerRef}
            className="terminal-composer-commands"
            role="group"
            tabIndex={-1}
            aria-label="Agent commands"
            aria-activedescendant={
              !replacement && selectedCommand
                ? `${pickerId}-${activeCommand}`
                : undefined
            }
            onKeyDown={commandKeyDown}
          >
            <div className="terminal-composer-command-heading">
              <span>Commands</span>
              <button
                type="button"
                aria-label="Dismiss commands"
                onMouseDown={keepTextareaFocus}
                onClick={closeCommandPicker}
              >
                <X size={14} />
              </button>
            </div>
            {replacement ? (
              <div
                className="terminal-composer-command-confirm"
                role="group"
                aria-label="Confirm draft replacement"
              >
                <p role="status">
                  Replace the entire draft with {replacement.command.name}?
                  Nothing will be sent.
                </p>
                <button
                  type="button"
                  ref={replacementCancelRef}
                  tabIndex={0}
                  onMouseDown={keepTextareaFocus}
                  onClick={() => {
                    setReplacement(null);
                    focusPickerWithoutKeyboard();
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="is-primary"
                  disabled={busy || composing}
                  tabIndex={0}
                  onMouseDown={keepTextareaFocus}
                  onClick={() => selectCommand(replacement.command, true)}
                >
                  Replace draft
                </button>
              </div>
            ) : (
              <>
                <div
                  id={pickerId}
                  ref={commandListRef}
                  role="listbox"
                  aria-label="Agent commands"
                  className="terminal-composer-command-list"
                >
                  {matches.map((command, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`${pickerId}-${index}`}
                      key={command.name}
                      tabIndex={-1}
                      aria-selected={index === activeCommand}
                      disabled={busy || composing}
                      onMouseDown={keepTextareaFocus}
                      onClick={() => selectCommand(command)}
                    >
                      <span className="terminal-composer-command-usage">
                        <strong>{command.name}</strong>
                        {command.arguments ? (
                          <>
                            {" "}
                            <small>{command.arguments}</small>
                          </>
                        ) : null}
                      </span>
                      <span className="terminal-composer-command-description">
                        {command.description}
                      </span>
                    </button>
                  ))}
                </div>
                {matches.length === 0 ? (
                  <span
                    className="terminal-composer-command-note"
                    role="status"
                  >
                    No matching commands. You can still type and send your own.
                  </span>
                ) : null}
              </>
            )}
          </section>
        ) : null}
        <div className="terminal-mobile-input-bar">
          {workspaceId &&
          paneId &&
          tabId &&
          terminalId &&
          !agent?.trim() &&
          isMobileLayout() ? (
            <AgentLauncher
              workspaceId={workspaceId}
              paneId={paneId}
              tabId={tabId}
              terminalId={terminalId}
              disabled={busy || composing || reserved}
              visible={accessoriesVisible}
              onOpen={dismissCommands}
              onSelectCommand={(command) => {
                if (readTerminalComposerDraft(draftKey))
                  throw new Error("Clear Message before choosing an agent.");
                activateMessage(false);
                void submitTerminalComposerDraft(draftKey, command, (text) =>
                  onSubmit(text, true),
                ).catch((error) =>
                  onError(
                    error instanceof Error
                      ? error.message
                      : "Failed to launch agent",
                  ),
                );
              }}
            />
          ) : null}
          {vimKeys && mode === "composer" ? (
            // Phone keyboards have no Esc key, and Vim needs one.
            <button
              type="button"
              className="terminal-composer-escape"
              aria-label="Esc: Vim normal mode"
              title="Esc: Vim normal mode"
              onMouseDown={keepTextareaFocus}
              onClick={() => vimHandleRef.current?.escape()}
            >
              Esc
            </button>
          ) : null}
          {vimKeys ? (
            <div
              ref={vimHostRef}
              className="terminal-composer-input terminal-mobile-message terminal-composer-vim"
              onFocus={focusEditor}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setEditorFocused(false);
              }}
              onClick={() => activateMessage(true)}
              // Ahead of Vim: the confirmation, the send shortcut and the
              // command picker take their keys first, as in the plain box.
              onKeyDownCapture={(e) => {
                if (editorKeyDown(e)) e.stopPropagation();
              }}
            >
              <Suspense fallback={null}>
                <ComposerVimEditor
                  value={text}
                  selection={
                    mode === "composer"
                      ? readTerminalComposerSelection(draftKey)
                      : null
                  }
                  label="Terminal input draft"
                  placeholder={placeholder}
                  attributes={{
                    role: "combobox",
                    "aria-expanded": String(listShown),
                    "aria-autocomplete": "list",
                    enterkeyhint: "enter",
                    ...(listShown ? { "aria-controls": pickerId } : {}),
                    ...(activeOption
                      ? { "aria-activedescendant": activeOption }
                      : {}),
                  }}
                  enterSends={false}
                  onChange={updateText}
                  onSelect={(start, end, value) =>
                    selectionChanged(value, start, end)
                  }
                  onSubmit={(options) => {
                    // :w sends, as the send shortcut does; Alt+Enter queues
                    // nothing in a terminal.
                    if (!options?.queue) void submit(true);
                  }}
                  onPasteImages={() => undefined}
                  onPasteFiles={pasteFiles}
                  onDragOver={(event) => {
                    if (!event.dataTransfer || !takesDrag(event.dataTransfer))
                      return false;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    return true;
                  }}
                  onDrop={(event) => {
                    if (
                      !event.dataTransfer ||
                      !dropOnEditor(event.dataTransfer)
                    )
                      return false;
                    event.preventDefault();
                    return true;
                  }}
                  onComposingChange={(composing) =>
                    composing ? compositionStarted() : compositionEnded()
                  }
                  handleRef={vimHandleRef}
                />
              </Suspense>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              className="terminal-composer-input terminal-mobile-message"
              value={text}
              rows={1}
              placeholder={placeholder}
              onFocus={focusEditor}
              onBlur={() => {
                setEditorFocused(false);
              }}
              onClick={() => activateMessage(true)}
              autoComplete="off"
              aria-label="Terminal input draft"
              enterKeyHint="enter"
              role="combobox"
              aria-expanded={listShown}
              aria-controls={listShown ? pickerId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={activeOption}
              onChange={(e) =>
                updateText(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                  e.currentTarget.selectionEnd,
                )
              }
              onSelect={(e) =>
                selectionChanged(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                  e.currentTarget.selectionEnd,
                )
              }
              onCompositionStart={compositionStarted}
              onCompositionEnd={compositionEnded}
              onPaste={(e) => {
                const clipboardFiles = Array.from(e.clipboardData?.files ?? []);
                const files = clipboardFiles.length
                  ? clipboardFiles
                  : Array.from(e.clipboardData?.items ?? [])
                      .filter((item) => item.kind === "file")
                      .map((item) => item.getAsFile())
                      .filter((file): file is File => file !== null);
                // No files on the clipboard: let the native text paste proceed.
                if (files.length === 0) return;
                e.preventDefault();
                pasteFiles(files);
              }}
              onDragOver={(e) => {
                if (!takesDrag(e.dataTransfer)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                if (dropOnEditor(e.dataTransfer)) e.preventDefault();
              }}
              onKeyDown={(e) => void editorKeyDown(e)}
            />
          )}
          <button
            type="button"
            className="terminal-mobile-direct"
            aria-label="Type directly into the terminal"
            title="Type directly into the terminal"
            aria-pressed={open && mode === "direct"}
            disabled={directDisabled || composing}
            onMouseDown={keepTextareaFocus}
            onClick={() => {
              if (composingRef.current || directDisabled) return;
              flushSync(() => {
                dismissCommands();
                setEditorFocused(false);
                setToolPointerPending(false);
                setExpanded(false);
                onModeChange("direct", true);
              });
              editorField()?.blur?.();
              onFocusDirect();
            }}
          >
            <SquareTerminal size={19} aria-hidden="true" />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => pickFiles(e.currentTarget)}
        />
      </div>
    </>
  );
}
