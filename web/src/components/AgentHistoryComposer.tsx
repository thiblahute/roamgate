import { useRenderTrace } from "../renderTrace";
import { voiceFronting } from "../voiceFrontFlag";
import { enterChatParts, scrollChatPage } from "./chatPaging";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVimKeys } from "../vimKeys";
import { lazyWithReload } from "../lazyWithReload";
import {
  AtSign,
  CornerDownRight,
  ImagePlus,
  ListPlus,
  Mic,
  PhoneCall,
  Route,
  Send,
  Square,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { shellLine } from "../../../shared/bashMode";
import { shortCwd } from "../shortCwd";
import { detectShortcutPlatform } from "../shortcutBindings";
import { useLayoutPreferences } from "../layoutPreferences";
import {
  shortcutLabel,
  shortcutMatches,
  useShortcutPreferences,
} from "../shortcutPreferences";
import {
  beginTerminalComposerUpload,
  finishTerminalComposerUpload,
  insertIntoTerminalComposerDraft,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  retainTerminalComposerUploadPaths,
  submitTerminalComposerDraft,
  subscribeTerminalComposerDraft,
  subscribeTerminalComposerSubmission,
  subscribeTerminalComposerUpload,
  terminalComposerDraftKeyIsActive,
  terminalComposerSubmissionPending,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
  terminalComposerDraftSaved,
} from "../terminalComposer";
import { terminalUploadedPathsText } from "../terminalFileDrop";
import {
  attachmentDisplay,
  rememberComposerAttachment,
  withoutAttachment,
} from "../composerAttachments";
import { type AgentCommand, matchCommands } from "../claudeCommands";
import { agentPromptWarning, agentStateKind } from "./agentSession";
import { useTouchReleaseSubmit } from "./useTouchReleaseSubmit";
import type { Heard } from "../voiceChat";
import { type Dictating, insertDictation, startDictation } from "../dictation";
import {
  type RouterNoteTarget,
  showRouterNote,
  useRouterNote,
} from "../voiceRoute";
import { openAssistant } from "../assistant";
import { adjustAssistantMentions } from "../assistantMentions";
import {
  type ComposerMentions,
  type MentionField,
  useMentionPicker,
} from "./MessageMentions";
import { openMrReviews } from "../mrReviewsOpen";
import { setPaneView } from "../paneView";
import { store } from "../store";

/** Shows where a card's full answer is: Ranger's chat, or a session's. */
function openRouterNote(target: RouterNoteTarget) {
  showRouterNote(null);
  if ("ranger" in target) {
    openAssistant();
    return;
  }
  if ("reviews" in target) {
    openMrReviews(undefined, "chat");
    return;
  }
  setPaneView(target.connectionId, target.paneId, "chat");
  void store.jumpToConnectionPane(target.connectionId, target.paneId);
}
import type { VoiceState } from "./useVoiceChat";
import "./AgentHistoryComposer.css";

// CodeMirror comes with the first box that needs Vim keys.
import type { ComposerVimHandle } from "./ComposerVimEditor";
const ComposerVimEditor = lazyWithReload("composer-vim-editor", () =>
  import("./ComposerVimEditor").then((module) => ({
    default: module.ComposerVimEditor,
  })),
);

const altEnter =
  detectShortcutPlatform() === "mac" ? "Option+Enter" : "Alt+Enter";

// Grow with the draft up to this height, then scroll inside the textarea.
const MAX_INPUT_HEIGHT_PX = 160;

/**
 * Message input under the chat-style session history. It shares the pane's
 * terminal composer draft, so text moves with the user between the terminal
 * and the history panel, and both surfaces send through the same submission
 * contract.
 *
 * Text reaches the agent by being typed into its terminal. When the agent is
 * not waiting at its prompt, a send attempt only shows where the text will
 * land; it goes out after an explicit Send anyway, never a repeated Enter.
 * Touch keyboards cannot type Shift+Enter, so there Enter adds a line and
 * sending uses the button or the composer send shortcut.
 */
export function AgentHistoryComposer({
  draftKey,
  agent,
  status,
  stateSeq,
  onSend,
  onUploadImage,
  commands = [],
  vimKeys: vimKeysProp,
  onError,
  voice,
  onRecallQueued,
  onStop,
  onSuspend,
  placeholder: placeholderProp,
  sendTo = "the agent's terminal",
  sendBlocked = false,
  onQueue,
  stop: stopText = {
    label: "Stop the agent",
    title: "Stop the agent: Esc in its terminal",
  },
  shell,
  nextPrompt,
  mentions,
  label: labelProp,
  enterSends: enterSendsProp = false,
}: {
  draftKey: string;
  agent?: string;
  status?: string;
  // Herdr's agent state-change sequence; it advances on every transition.
  stateSeq?: number;
  onSend: (text: string) => Promise<void>;
  /** Without it, the box takes no images. */
  onUploadImage?: (file: File) => Promise<string>;
  /** The agent's /commands, offered while one is being typed. */
  commands?: AgentCommand[];
  /** Vim keys in the box; the one Vim keys setting by default. */
  vimKeys?: boolean;
  onError: (message: string) => void;
  /**
   * With messages queued, Up in the empty box takes them back into it to
   * edit, as Up does in Claude Code's own prompt.
   */
  onRecallQueued?: () => void;
  /** While the agent works: stop it, beside Send. */
  onStop?: () => void;
  /** The box's placeholder; "Message <agent>..." by default. */
  placeholder?: string;
  /** Where Send sends, for its title. */
  sendTo?: string;
  /** Nothing can be sent now, whatever the box holds. */
  sendBlocked?: boolean;
  /**
   * While the agent answers: Send steers its turn, and this queues the
   * message for after it, from a Queue button beside Send or Alt+Enter.
   */
  onQueue?: (text: string) => Promise<void>;
  /** What the Stop button says. */
  stop?: { label: string; title: string };
  /**
   * `:suspend` / `:stop` in the Vim box: the conversation stops as a job
   * of the pane's shell (the chat catches Ctrl+Z itself).
   */
  onSuspend?: () => void;
  /**
   * A line starting with `!` runs as a shell command (Claude Code's bash
   * mode): where. Without it, `!` is plain text.
   */
  shell?: { host?: string; cwd?: string | null };
  /**
   * What the agent guesses the user will say next (Claude Code's prompt
   * suggestion): offered in the empty box as grey text, which Tab or Right
   * puts in the box to edit, or on a phone as a chip above it. Never sent
   * by itself; typing anything puts it away.
   */
  nextPrompt?: { key: string; text: string } | null;
  /**
   * The @mention picker (Ranger's): @ or the box's @ button opens it, in
   * the plain box and in the Vim one, and a pick is a chip bound to the
   * message as a reference.
   */
  mentions?: ComposerMentions;
  /** The box's accessible name; "Message <agent>" by default. */
  label?: string;
  /**
   * Enter sends on touch keyboards too, as in a one-line box (the
   * companion's); elsewhere they add a line and the button sends.
   */
  enterSends?: boolean;
  /**
   * Hands-free chat; `listen` false when the server has no voice engine:
   * the button then says why it cannot listen.
   */
  voice?: {
    listen: boolean;
    state: VoiceState;
    level: number;
    muted: boolean;
    /** What was said to someone else: sent only when asked. */
    held: Heard[];
    onSendHeld: (said: Heard) => void;
    onDropHeld: (said: Heard) => void;
    onToggle: () => void;
    onToggleMute: () => void;
  };
}) {
  useRenderTrace("AgentHistoryComposer");
  useShortcutPreferences();
  const { mobile } = useLayoutPreferences();
  // What the voice router said, kept apart from the agent's conversation.
  const routerNote = useRouterNote();
  const [text, setText] = useState(() => readTerminalComposerDraft(draftKey));
  const [submissionPending, setSubmissionPending] = useState(() =>
    terminalComposerSubmissionPending(draftKey),
  );
  const [uploadCount, setUploadCount] = useState(() =>
    terminalComposerUploadCount(draftKey),
  );
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const compositionUploadsRef = useRef<Array<() => void>>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const vimHandleRef = useRef<ComposerVimHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Shell mode: the box starts with `!`, and Send runs it.
  const shellMode = !!shell && /^\s*!/.test(text);
  // Dictation into the box (dictation.ts): the words as heard while they
  // are said, the cleaned text put at the cursor when the user stops.
  const [dictation, setDictation] = useState<{
    state: "starting" | "listening" | "cleaning";
    heard: string;
    error?: string;
  } | null>(null);
  const dictatingRef = useRef<Dictating | null>(null);
  useEffect(
    () => () => {
      dictatingRef.current?.cancel();
      dictatingRef.current = null;
    },
    [],
  );
  const toggleDictation = async () => {
    if (dictation?.state === "listening" && dictatingRef.current) {
      const dictating = dictatingRef.current;
      dictatingRef.current = null;
      setDictation((now) => (now ? { ...now, state: "cleaning" } : now));
      const result = await dictating.finish();
      // The box as it is now: the user may have typed meanwhile.
      const draft = readTerminalComposerDraft(draftKey);
      const selection = readTerminalComposerSelection(draftKey) ?? {
        start: draft.length,
        end: draft.length,
      };
      const next = insertDictation(
        draft,
        selection.start,
        selection.end,
        result.text,
      );
      writeTerminalComposerDraft(draftKey, next.value);
      writeTerminalComposerSelection(draftKey, next.caret, next.caret);
      setDictation(null);
      return;
    }
    if (dictation) return;
    const draft = readTerminalComposerDraft(draftKey);
    const selection = readTerminalComposerSelection(draftKey) ?? {
      start: draft.length,
      end: draft.length,
    };
    setDictation({ state: "starting", heard: "" });
    try {
      dictatingRef.current = await startDictation(
        {
          kind: shellMode ? "code" : "chat",
          before: draft.slice(0, selection.start),
          after: draft.slice(selection.end),
        },
        (heard) => setDictation((now) => (now ? { ...now, heard } : now)),
      );
      setDictation((now) => (now ? { ...now, state: "listening" } : now));
    } catch (error) {
      setDictation({
        state: "starting",
        heard: "",
        error: (error as Error).message || "Dictation failed",
      });
      setTimeout(() => setDictation(null), 3000);
    }
  };
  const shellCommand = shellMode ? shellLine(text) : null;
  const shellHost = shell?.host?.trim() || "this host";
  const shellCwd = shell?.cwd ? shortCwd(shell.cwd) : null;
  const shellWhere = `${shellHost}${shellCwd ? ` in ${shellCwd}` : ""}`;
  const warning = shellMode ? null : agentPromptWarning(agent, status);
  const agentState = agentStateKind(status);
  // What a warning was shown for: the draft, the agent, and its state.
  const context = JSON.stringify([text, agent, agentState, stateSeq]);
  // The context the open warning belongs to. Any change revokes it, even one
  // that later changes back, so Send anyway never confirms stale context.
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirming = warning !== null && confirmation === context;
  const touch =
    mobile || globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;
  const enterAddsLine = touch && !enterSendsProp;

  const resumeUploads = useCallback(() => {
    for (const resume of compositionUploadsRef.current.splice(0)) resume();
  }, []);

  useEffect(
    () => () => {
      if (compositionEndTimerRef.current !== null)
        clearTimeout(compositionEndTimerRef.current);
      composingRef.current = false;
      resumeUploads();
    },
    [resumeUploads],
  );

  useEffect(() => {
    if (confirmation !== null && confirmation !== context)
      setConfirmation(null);
  }, [confirmation, context]);

  useEffect(() => {
    setText(readTerminalComposerDraft(draftKey));
    setSubmissionPending(terminalComposerSubmissionPending(draftKey));
    setUploadCount(terminalComposerUploadCount(draftKey));
    const unsubscribeDraft = subscribeTerminalComposerDraft(draftKey, setText);
    const unsubscribeSubmission = subscribeTerminalComposerSubmission(
      draftKey,
      setSubmissionPending,
    );
    const unsubscribeUpload = subscribeTerminalComposerUpload(
      draftKey,
      setUploadCount,
    );
    return () => {
      unsubscribeDraft();
      unsubscribeSubmission();
      unsubscribeUpload();
    };
  }, [draftKey]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    void text;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
    const selection = readTerminalComposerSelection(draftKey);
    if (selection) {
      // The shared selection is in the draft; the box shows attachments short.
      const shown = attachmentDisplay(text);
      textarea.setSelectionRange(
        shown.shownOffset(selection.start),
        shown.shownOffset(selection.end),
      );
    }
  }, [draftKey, text]);

  const busy = submissionPending || uploadCount > 0;
  const sendDisabled =
    !text.trim() || busy || composing || (shellMode && shellCommand === null);

  const uploadImages = async (files: File[]) => {
    if (
      files.length === 0 ||
      composingRef.current ||
      terminalComposerSubmissionPending(draftKey) ||
      !beginTerminalComposerUpload(draftKey)
    )
      return;
    const paths: string[] = [];
    let failed = false;
    try {
      for (const file of files) {
        if (file.type && !file.type.startsWith("image/"))
          throw new Error("Choose an image to attach.");
        if (!onUploadImage) throw new Error("This chat takes no images.");
        const path = await onUploadImage(file);
        rememberComposerAttachment(path, file);
        paths.push(path);
      }
    } catch (error) {
      failed = true;
      onError(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      try {
        if (paths.length) {
          // Recovery also edits the draft; both outcomes must wait for IME input.
          if (composingRef.current)
            await new Promise<void>((resolve) =>
              compositionUploadsRef.current.push(resolve),
            );
          const active = terminalComposerDraftKeyIsActive(draftKey);
          if (failed || !active)
            retainTerminalComposerUploadPaths(
              draftKey,
              terminalUploadedPathsText(paths),
            );
          else
            insertIntoTerminalComposerDraft(
              draftKey,
              terminalUploadedPathsText(paths),
            );
          if (!active)
            onError(
              "Connection or pane changed; image paths retained in the original draft.",
            );
        }
      } finally {
        finishTerminalComposerUpload(draftKey);
      }
    }
  };

  const send = async (confirmed: boolean, queue = false) => {
    const draft = text;
    if (
      !draft.trim() ||
      composingRef.current ||
      terminalComposerUploadCount(draftKey) > 0
    )
      return;
    if (warning !== null && !confirmed) {
      setConfirmation(context);
      return;
    }
    try {
      await submitTerminalComposerDraft(
        draftKey,
        draft,
        queue && onQueue ? onQueue : onSend,
        () => setConfirmation(null),
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Failed to send message",
      );
    }
  };

  const keepTextareaFocus = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };
  // The phone keyboard can move these bottom-anchored buttons before click.
  const touchSubmit = useTouchReleaseSubmit({
    submitKey: draftKey,
    resetKey: JSON.stringify([draftKey, context]),
    canStart: () =>
      !composingRef.current &&
      terminalComposerUploadCount(draftKey) === 0 &&
      !terminalComposerSubmissionPending(draftKey),
    canFinish: () => true,
  });
  const sendShortcut = shortcutLabel("composer.send");
  const sendTitle = shellMode
    ? enterAddsLine
      ? `Run on ${shellWhere} (${sendShortcut})`
      : `Run on ${shellWhere} (Enter); Shift+Enter for a new line`
    : enterAddsLine
      ? `Send to ${sendTo} (${sendShortcut})`
      : `Send to ${sendTo} (Enter); Shift+Enter for a new line`;
  const name = agent?.trim();
  const placeholder =
    placeholderProp ?? (name ? `Message ${name}...` : "Message...");
  const shown = attachmentDisplay(text);
  // A /command being typed: the matching commands, until Esc puts them away
  // for this draft.
  const [focused, setFocused] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState<string | null>(
    null,
  );
  const commandMatches =
    focused && commandsDismissed !== text ? matchCommands(text, commands) : [];
  const commandSelected =
    commandMatches[Math.min(commandIndex, commandMatches.length - 1)];
  const completeCommand = (command: AgentCommand) => {
    const draft = `/${command.name} `;
    writeTerminalComposerDraft(draftKey, draft);
    writeTerminalComposerSelection(draftKey, draft.length, draft.length);
    setCommandIndex(0);
  };
  // Keys for the list, ahead of the box: arrows move, Tab
  // completes, Enter completes unless the name is already whole, Esc closes.
  const onCommandKeys = (event: React.KeyboardEvent) => {
    if (!commandMatches.length || event.nativeEvent.isComposing) return;
    const exact = commandMatches.some((each) => `/${each.name}` === text);
    const plain =
      !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    let handled = true;
    if (event.key === "ArrowDown" && plain)
      setCommandIndex((index) => (index + 1) % commandMatches.length);
    else if (event.key === "ArrowUp" && plain)
      setCommandIndex(
        (index) => (index - 1 + commandMatches.length) % commandMatches.length,
      );
    else if (event.key === "Tab" && plain && commandSelected)
      completeCommand(commandSelected);
    else if (event.key === "Enter" && plain && !exact && commandSelected)
      completeCommand(commandSelected);
    else if (event.key === "Escape") {
      // The box (and Vim) still gets its Esc.
      setCommandsDismissed(text);
      return;
    } else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.nativeEvent.stopPropagation();
  };
  // The predicted next message: offered while the box is empty, until
  // something is typed (it does not come back once the box empties again).
  const [nextPromptGone, setNextPromptGone] = useState<string | null>(null);
  const nextPromptKey = nextPrompt?.key ?? null;
  useEffect(() => {
    if (text && nextPromptKey) setNextPromptGone(nextPromptKey);
  }, [text, nextPromptKey]);
  // Dictate, the microphone on the box: hidden during a voice call, which
  // the server's helper would refuse it for, and without a voice engine.
  const dictateHere = !!voice?.listen && voice.state === "off";
  const offered =
    nextPrompt &&
    nextPrompt.text.trim() &&
    !text &&
    nextPromptGone !== nextPrompt.key &&
    !composing &&
    // Never during a voice call.
    (!voice || voice.state === "off")
      ? nextPrompt
      : null;
  const acceptNextPrompt = () => {
    if (!offered) return;
    const draft = offered.text;
    setNextPromptGone(offered.key);
    writeTerminalComposerDraft(draftKey, draft);
    writeTerminalComposerSelection(draftKey, draft.length, draft.length);
  };
  const onNextPromptKeys = (event: React.KeyboardEvent) => {
    if (
      !offered ||
      commandMatches.length ||
      event.nativeEvent.isComposing ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.key !== "Tab" && event.key !== "ArrowRight")
    )
      return false;
    event.preventDefault();
    event.nativeEvent.stopPropagation();
    acceptNextPrompt();
    return true;
  };
  // Grey text in the box itself, but a chip on a phone.
  const ghost = offered && !mobile ? offered : null;
  const vimSetting = useVimKeys();
  const vimKeys = vimKeysProp ?? vimSetting;
  const stored = vimKeys ? readTerminalComposerSelection(draftKey) : null;
  const shownSelection = stored
    ? {
        start: shown.shownOffset(stored.start),
        end: shown.shownOffset(stored.end),
      }
    : null;

  // The @mention picker, on whichever input the box has.
  const mentionField = (): MentionField | null => {
    if (vimKeys) {
      const handle = vimHandleRef.current;
      return handle
        ? {
            selection: handle.selection,
            replace: handle.replace,
            focus: handle.focus,
          }
        : null;
    }
    const textarea = textareaRef.current;
    if (!textarea) return null;
    return {
      selection: () => ({
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      }),
      replace: (start, end, insert) => {
        textarea.setSelectionRange(start, end);
        // Native insertion keeps the browser's undo where it has insertText;
        // the draft is written after it either way.
        try {
          document.execCommand?.("insertText", false, insert);
        } catch {
          // Written below.
        }
      },
      focus: () => textarea.focus({ preventScroll: true }),
    };
  };
  const picker = useMentionPicker({
    config: mentions,
    draftKey,
    text: shown.text,
    draft: text,
    draftOffset: (offset) => shown.draftOffset(shown.text, offset),
    field: mentionField,
    composing: () => composingRef.current,
    onPicked: (draft, caret) => {
      writeTerminalComposerDraft(draftKey, draft);
      writeTerminalComposerSelection(draftKey, caret, caret);
    },
    onError,
  });
  /**
   * The draft goes from what it holds to `next` by an edit of `start`..`end`
   * of the box's text (`edit`): the references it binds follow.
   */
  const moveMentions = (
    next: string,
    edit?: { start: number; end: number; inputType?: string },
  ) => {
    if (!mentions) return;
    const previous = readTerminalComposerDraft(draftKey);
    const before = attachmentDisplay(previous);
    const bound = mentions.read(previous);
    if (!bound.length) {
      mentions.write(next, []);
      return;
    }
    mentions.write(
      next,
      adjustAssistantMentions(
        previous,
        next,
        bound,
        edit && {
          start: before.draftOffset(before.text, edit.start),
          end: before.draftOffset(before.text, edit.end),
          inputType: edit.inputType,
        },
      ),
    );
  };
  // The textarea's edit, as the browser is about to make it.
  const textareaEditRef = useRef<
    { start: number; end: number; inputType?: string } | undefined
  >(undefined);
  const mentionsOn = !!mentions;
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !mentionsOn) return;
    const capture = (event: InputEvent) => {
      textareaEditRef.current = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        inputType: event.inputType,
      };
    };
    textarea.addEventListener("beforeinput", capture);
    return () => textarea.removeEventListener("beforeinput", capture);
  }, [mentionsOn, vimKeys]);

  return (
    <div
      className={`agent-history-composer${shellMode ? " is-shell" : ""}${mobile ? " is-mobile" : ""}`}
      // Its draft outlives a reload: a newer build need not wait for it.
      data-draft-saved={terminalComposerDraftSaved(draftKey) || undefined}
      onKeyDownCapture={(event) => {
        if (!picker.keys(event) && !onNextPromptKeys(event))
          onCommandKeys(event);
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      {routerNote ? (
        <div className="agent-history-composer-router" role="status">
          <Route size={14} aria-hidden="true" />
          <p title={routerNote.text}>
            <strong>{routerNote.from}</strong> {routerNote.text}
          </p>
          {routerNote.open ? (
            <button
              type="button"
              className="agent-history-composer-router-open"
              onClick={() => openRouterNote(routerNote.open!)}
            >
              Open
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => showRouterNote(null)}
            aria-label="Close"
            title="Close"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {dictation ? (
        <div
          className={`agent-history-composer-dictation${dictation.error ? " is-error" : ""}`}
          role="status"
        >
          {dictation.error ??
            (dictation.heard ||
              (dictation.state === "starting"
                ? "Opening the microphone..."
                : dictation.state === "cleaning"
                  ? "Cleaning..."
                  : "Listening: speak, then press the button again"))}
          {dictation.heard && dictation.state === "cleaning" ? " ..." : null}
        </div>
      ) : null}
      {voice?.held.length ? (
        <ul className="agent-history-composer-held" aria-label="Not sent">
          {voice.held.map((said, index) => (
            <li
              key={`${index}-${said.text}`}
              title={
                said.raw ? `Heard as: ${said.raw}` : "Said to someone else"
              }
            >
              <span>{said.text}</span>
              <button
                type="button"
                onClick={() => voice.onSendHeld(said)}
                aria-label="Send it to the agent"
                title="It was for the agent: send it"
              >
                <Send size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => voice.onDropHeld(said)}
                aria-label="Forget it"
                title="Forget it"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {commandMatches.length ? (
        <ul
          className="agent-history-composer-commands"
          role="listbox"
          aria-label="Commands"
        >
          {commandMatches.map((command) => (
            <li key={command.name}>
              <button
                type="button"
                role="option"
                aria-selected={command === commandSelected}
                className={command === commandSelected ? "is-selected" : ""}
                // Keep the box focused, and its keyboard up on a phone.
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => completeCommand(command)}
              >
                <strong>/{command.name}</strong>
                {command.description ? (
                  <span>{command.description}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {confirming ? (
        <div className="agent-history-composer-warning" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <p>{warning}</p>
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
              disabled={sendDisabled}
              onMouseDown={keepTextareaFocus}
              {...touchSubmit.buttonProps(() => void send(true))}
            >
              Send anyway
            </button>
          </div>
        </div>
      ) : null}
      {shown.attachments.length ? (
        <div className="agent-history-composer-attachments">
          {shown.attachments.map((attachment, index) => (
            <span key={attachment.path} title={attachment.name}>
              {attachment.url ? (
                <img src={attachment.url} alt={attachment.name} />
              ) : null}
              <span>#{index + 1}</span>
              <button
                type="button"
                aria-label={`Remove image ${index + 1}`}
                onMouseDown={keepTextareaFocus}
                onClick={() =>
                  writeTerminalComposerDraft(
                    draftKey,
                    withoutAttachment(text, attachment.path),
                  )
                }
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {picker.chips}
      {offered && mobile ? (
        <div className="agent-history-composer-next">
          <button
            type="button"
            title="Put it in the box to edit"
            aria-label={`Suggested message: ${offered.text}. Put it in the box`}
            // Fills the box without bringing the keyboard up.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.preventDefault()}
            onClick={acceptNextPrompt}
          >
            {offered.text}
          </button>
        </div>
      ) : null}
      {shell ? (
        // Said once, when the box turns into a shell line and back.
        <div className="agent-history-composer-shell" aria-live="polite">
          {shellMode ? (
            <>
              <Terminal size={13} aria-hidden="true" />
              <strong>Shell</strong>
              <span className="agent-history-composer-shell-where">
                <span aria-hidden="true">{" \u00b7 "}</span>
                runs on {shellHost}
                {shellCwd ? (
                  <>
                    {" in "}
                    <code title={shell.cwd ?? undefined}>{shellCwd}</code>
                  </>
                ) : null}
              </span>
              <span className="agent-history-composer-shell-hint">
                Delete the ! to write to Claude
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="agent-history-composer-row">
        {onUploadImage ? (
          <button
            type="button"
            className="agent-history-composer-attach"
            aria-label="Add images"
            title="Add images"
            disabled={busy || composing}
            onMouseDown={keepTextareaFocus}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={17} aria-hidden="true" />
          </button>
        ) : null}
        {voice?.state === "off" ? (
          // A running call is controlled from over the chat.
          <button
            type="button"
            className={`agent-history-composer-attach agent-history-composer-voice is-off${voice.listen ? "" : " is-unavailable"}`}
            aria-label={
              voice.listen
                ? voiceFronting()
                  ? "Call the companion"
                  : "Start a voice call with the agent"
                : "Voice calls need the server's voice engine"
            }
            aria-pressed={false}
            title={
              voice.listen
                ? voiceFronting()
                  ? "Call the companion: this session is where work goes by default"
                  : "Start a voice call with the agent"
                : "Voice calls cannot listen: the server has no voice engine"
            }
            onMouseDown={keepTextareaFocus}
            onClick={voice.onToggle}
          >
            <PhoneCall size={17} aria-hidden="true" />
          </button>
        ) : null}
        {vimKeys && touch ? (
          // Phone keyboards have no Esc key, and Vim needs one.
          <button
            type="button"
            className="agent-history-composer-escape"
            aria-label="Esc: Vim normal mode"
            title="Esc: Vim normal mode"
            onMouseDown={keepTextareaFocus}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => vimHandleRef.current?.escape()}
          >
            Esc
          </button>
        ) : null}
        {/* The box, with Dictate's microphone on it, at its right edge. */}
        <div
          className={`agent-history-composer-field${mentions ? " has-mention" : ""}${dictateHere ? " has-voice" : ""}${voice && voice.state !== "off" ? " has-mute" : ""}${ghost ? " has-next-prompt" : ""}`}
        >
          {picker.popup}
          {vimKeys ? (
            <Suspense fallback={null}>
              <ComposerVimEditor
                value={shown.text}
                selection={shownSelection}
                label={labelProp ?? `Message ${name || "agent"}`}
                placeholder={ghost ? ghost.text : placeholder}
                attributes={picker.aria}
                enterSends={!enterAddsLine}
                onUpWhenEmpty={
                  onRecallQueued
                    ? () => {
                        onRecallQueued();
                        return true;
                      }
                    : undefined
                }
                onChange={(value, start, end, edit) => {
                  const draft = shown.toDraft(value);
                  const next = attachmentDisplay(draft);
                  moveMentions(draft, edit);
                  writeTerminalComposerDraft(draftKey, draft);
                  writeTerminalComposerSelection(
                    draftKey,
                    next.draftOffset(value, start),
                    next.draftOffset(value, end),
                  );
                  // The picker follows typing, not Vim's commands.
                  if (vimHandleRef.current?.insertMode())
                    picker.update(value, start, end, true);
                  else picker.hide();
                }}
                onSelect={(start, end, value) => {
                  const committed = attachmentDisplay(
                    readTerminalComposerDraft(draftKey),
                  );
                  writeTerminalComposerSelection(
                    draftKey,
                    committed.draftOffset(committed.text, start),
                    committed.draftOffset(committed.text, end),
                  );
                  if (vimHandleRef.current?.insertMode())
                    picker.update(value, start, end);
                }}
                onSubmit={(options) => {
                  // Alt+Enter queues while the agent answers; else it sends
                  // as Enter does.
                  if (options?.queue && !onQueue && enterAddsLine) return;
                  void send(false, !!options?.queue && !!onQueue);
                }}
                onPasteImages={
                  onUploadImage
                    ? (files) => void uploadImages(files)
                    : () => undefined
                }
                handleRef={vimHandleRef}
                onSuspend={onSuspend}
                onComposingChange={(composing) => {
                  composingRef.current = composing;
                  setComposing(composing);
                  if (composing) picker.hide();
                  else {
                    resumeUploads();
                    const at = vimHandleRef.current?.selection();
                    if (at && vimHandleRef.current?.insertMode())
                      picker.update(
                        vimHandleRef.current.text(),
                        at.start,
                        at.end,
                      );
                  }
                }}
              />
            </Suspense>
          ) : (
            <textarea
              ref={textareaRef}
              value={shown.text}
              rows={1}
              aria-label={
                shellMode
                  ? "Shell command"
                  : (labelProp ?? `Message ${name || "agent"}`)
              }
              placeholder={ghost ? ghost.text : placeholder}
              aria-description={
                ghost
                  ? "Tab or Right puts the suggestion in the box"
                  : undefined
              }
              enterKeyHint={enterAddsLine ? "enter" : "send"}
              autoComplete="off"
              {...picker.aria}
              onInput={(event) => {
                if (!mentions) return;
                const textarea = event.currentTarget;
                const edit = textareaEditRef.current;
                textareaEditRef.current = undefined;
                moveMentions(shown.toDraft(textarea.value), {
                  ...(edit ?? {
                    start: textarea.selectionStart,
                    end: textarea.selectionStart,
                  }),
                  inputType: (event.nativeEvent as InputEvent).inputType,
                });
                picker.update(
                  textarea.value,
                  textarea.selectionStart,
                  textarea.selectionEnd,
                  true,
                );
              }}
              onChange={(event) => {
                const textarea = event.currentTarget;
                const draft = shown.toDraft(textarea.value);
                const next = attachmentDisplay(draft);
                writeTerminalComposerDraft(draftKey, draft);
                writeTerminalComposerSelection(
                  draftKey,
                  next.draftOffset(textarea.value, textarea.selectionStart),
                  next.draftOffset(textarea.value, textarea.selectionEnd),
                );
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                const images = (
                  files.length
                    ? files
                    : Array.from(event.clipboardData.items)
                        .map((item) => item.getAsFile())
                        .filter((file): file is File => file !== null)
                ).filter((file) => file.type.startsWith("image/"));
                if (images.length === 0 || !onUploadImage) return;
                event.preventDefault();
                void uploadImages(images);
              }}
              onSelect={(event) => {
                const textarea = event.currentTarget;
                // Skip selections of a value the shared draft has not committed.
                const committed = attachmentDisplay(
                  readTerminalComposerDraft(draftKey),
                );
                if (textarea.value !== committed.text) return;
                picker.update(
                  textarea.value,
                  textarea.selectionStart,
                  textarea.selectionEnd,
                );
                writeTerminalComposerSelection(
                  draftKey,
                  committed.draftOffset(
                    textarea.value,
                    textarea.selectionStart,
                  ),
                  committed.draftOffset(textarea.value, textarea.selectionEnd),
                );
              }}
              onCompositionStart={() => {
                touchSubmit.cancel();
                if (compositionEndTimerRef.current !== null) {
                  clearTimeout(compositionEndTimerRef.current);
                  compositionEndTimerRef.current = null;
                }
                composingRef.current = true;
                setComposing(true);
                picker.hide();
              }}
              onCompositionEnd={(event) => {
                const textarea = event.currentTarget;
                // The final native input can follow compositionend in the same task.
                compositionEndTimerRef.current = setTimeout(() => {
                  compositionEndTimerRef.current = null;
                  composingRef.current = false;
                  setComposing(false);
                  resumeUploads();
                  picker.update(
                    textarea.value,
                    textarea.selectionStart,
                    textarea.selectionEnd,
                  );
                }, 0);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "ArrowUp" &&
                  !shown.text &&
                  onRecallQueued &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  onRecallQueued();
                  return;
                }
                if (
                  event.nativeEvent.isComposing ||
                  composingRef.current ||
                  event.keyCode === 229
                )
                  return;
                if (
                  event.key === "ArrowUp" &&
                  event.altKey &&
                  enterChatParts(event.currentTarget)
                ) {
                  event.preventDefault();
                  return;
                }
                if (
                  (event.key === "PageUp" || event.key === "PageDown") &&
                  scrollChatPage(
                    event.currentTarget,
                    event.key === "PageUp" ? -1 : 1,
                  )
                ) {
                  event.preventDefault();
                  return;
                }
                if (event.key === "Escape" && confirming) {
                  event.preventDefault();
                  event.stopPropagation();
                  setConfirmation(null);
                  return;
                }
                if (
                  (onQueue || !enterAddsLine) &&
                  event.key === "Enter" &&
                  event.altKey &&
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  // Queues while the agent answers; else sends, as Enter.
                  event.preventDefault();
                  if (!event.repeat) void send(false, !!onQueue);
                  return;
                }
                const plainEnter =
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey;
                if (
                  (plainEnter && !enterAddsLine) ||
                  shortcutMatches(event.nativeEvent, "composer.send")
                ) {
                  event.preventDefault();
                  if (!event.repeat) void send(false);
                }
              }}
            />
          )}
          <div className="agent-history-composer-inline">
            {mentions ? (
              <button
                type="button"
                className="agent-history-composer-mention"
                aria-label="Mention workspace or agent"
                title="Mention a workspace or agent"
                aria-expanded={picker.open}
                onMouseDown={keepTextareaFocus}
                onClick={picker.toggle}
              >
                <AtSign size={15} aria-hidden="true" />
              </button>
            ) : null}
            {ghost ? (
              <span
                className="agent-history-composer-next-key"
                title="Tab or Right puts it in the box to edit"
                aria-hidden="true"
              >
                Tab
              </span>
            ) : null}
            {dictateHere ? (
              // Never during a voice call: the helper listens to one at a time.
              <button
                type="button"
                className={`agent-history-composer-voice agent-history-composer-dictate${dictation?.state === "listening" ? " is-listening" : ""}`}
                aria-label={
                  dictation?.state === "listening"
                    ? "Stop dictating and put the text in the box"
                    : "Dictate"
                }
                aria-pressed={dictation?.state === "listening"}
                title={
                  dictation?.state === "listening"
                    ? "Stop: the cleaned text goes in the box"
                    : "Dictate"
                }
                disabled={
                  dictation?.state === "starting" ||
                  dictation?.state === "cleaning"
                }
                onMouseDown={keepTextareaFocus}
                onClick={() => void toggleDictation()}
              >
                <Mic size={17} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
        {onStop ? (
          <button
            type="button"
            className="agent-history-composer-stop"
            aria-label={stopText.label}
            title={stopText.title}
            onMouseDown={keepTextareaFocus}
            onClick={onStop}
          >
            <Square size={10} fill="currentColor" aria-hidden="true" />
          </button>
        ) : null}
        {onQueue && !shellMode ? (
          <button
            type="button"
            className="agent-history-composer-send agent-history-composer-queue"
            aria-label="Queue"
            title={`Queue: send after ${name || "the agent"} finishes (${altEnter})`}
            disabled={sendDisabled || confirming || sendBlocked}
            onMouseDown={keepTextareaFocus}
            {...touchSubmit.buttonProps(() => void send(false, true))}
          >
            <ListPlus size={13} aria-hidden="true" />
            <span className="agent-history-composer-label">Queue</span>
          </button>
        ) : null}
        <button
          type="button"
          className="agent-history-composer-send"
          aria-label={
            shellMode
              ? `Run the command on ${shellWhere}`
              : onQueue
                ? "Steer"
                : "Send message to the agent"
          }
          title={
            onQueue && !shellMode
              ? "Steer: join the current answer after its next step (Enter)"
              : sendTitle
          }
          disabled={sendDisabled || confirming || sendBlocked}
          onMouseDown={keepTextareaFocus}
          {...touchSubmit.buttonProps(() => void send(false))}
        >
          {shellMode ? (
            <Terminal size={13} aria-hidden="true" />
          ) : onQueue ? (
            <CornerDownRight size={13} aria-hidden="true" />
          ) : (
            <Send size={13} aria-hidden="true" />
          )}
          <span className="agent-history-composer-label">
            {uploadCount > 0
              ? "Uploading..."
              : submissionPending
                ? shellMode
                  ? "Starting..."
                  : "Sending..."
                : shellMode
                  ? "Run"
                  : onQueue
                    ? "Steer"
                    : "Send"}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadImages(files);
          }}
        />
      </div>
    </div>
  );
}
