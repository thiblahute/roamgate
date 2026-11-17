import {
  ArrowDown,
  Check,
  Globe,
  Mic,
  MicOff,
  PhoneCall,
  RotateCcw,
  SendHorizontal,
  PhoneOff,
  Wrench,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { resetCompanion } from "../companionMemory";
import {
  type CompanionLogEntry,
  companionCallState,
  companionName,
  endCompanionCall,
  startCompanionCall,
  subscribeCompanionCall,
  sendCompanionHeard,
  toggleCompanionMute,
} from "../companionCall";
import { useFollowScroll } from "../followScroll";
import { store } from "../store";
import { setPaneView } from "../paneView";
import {
  cancelResearch,
  cancelTool,
  parseVoiceSessionId,
  plainText,
  RANGER_VOICE_SESSION,
  REVIEWS_VOICE_SESSION,
} from "../voiceRoute";
import { openAssistant } from "../assistant";
import { openMrReviews } from "../mrReviewsOpen";
import { sendCompanionText } from "../companionText";
import { AgentHistoryComposer } from "./AgentHistoryComposer";
import { answerCompanionTool } from "../companionWeb";
import { subscribeVoiceFronting, voiceFronting } from "../voiceFrontFlag";
import { companionChipText, hearingNow } from "./CompanionChip";
import { useCompanionReading } from "./CompanionReading";
import { type CompanionReading, isBeingSaid } from "../companionReading";
import { CompanionMemories } from "./CompanionMemories";
import {
  CallAppButton,
  CallOutputButton,
  useMicrophonePausedByPhone,
} from "./CallOutputButton";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import "./CompanionPanel.css";

const SEND_NOW_KEY =
  typeof navigator !== "undefined" && /Mac|iP/.test(navigator.platform)
    ? "Cmd+Enter"
    : "Ctrl+Enter";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const JOB_STATUS: Record<
  Extract<CompanionLogEntry, { kind: "job" }>["status"],
  string
> = {
  running: "Working",
  answered: "Answered",
  "no answer": "No answer",
  "not started": "Not started",
};

const WEB_STATUS: Record<
  Extract<CompanionLogEntry, { kind: "web" }>["status"],
  string
> = {
  searching: "Searching the web",
  done: "Found",
  failed: "Not found",
  cancelled: "Cancelled",
};

const TOOL_STATUS: typeof WEB_STATUS = {
  searching: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A held call's status: waiting for the user, then how it ended. */
const HELD_STATUS: Record<
  NonNullable<Extract<CompanionLogEntry, { kind: "web" }>["heldOutcome"]>,
  string
> = {
  confirmed: "Confirmed",
  declined: "Declined",
  expired: "No longer waiting",
};

function webStatus(entry: Extract<CompanionLogEntry, { kind: "web" }>) {
  if (entry.held)
    return entry.heldOutcome
      ? HELD_STATUS[entry.heldOutcome]
      : "Waiting for your OK";
  return (entry.tool ? TOOL_STATUS : WEB_STATUS)[entry.status];
}

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)\]>]+)/g;

/**
 * A web search's answer as text, its links clickable: what it says is
 * web data, shown as such (no HTML), links opening apart.
 */
export function linkedText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const url = match[2] ?? match[3]!;
    parts.push(
      <a key={at} href={url} target="_blank" rel="noopener noreferrer">
        {match[1] ?? url}
      </a>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function WebEntry({
  entry,
}: {
  entry: Extract<CompanionLogEntry, { kind: "web" }>;
}) {
  const waiting = entry.held && !entry.heldOutcome;
  return (
    <li
      className={`companion-panel-job companion-panel-web is-${entry.status}${waiting ? " is-held" : ""}`}
    >
      <div className="companion-panel-job-head">
        <span className="companion-panel-time">{clock(entry.at)}</span>
        <span className="companion-panel-web-title">
          {entry.tool ? (
            <>
              <Wrench size={13} aria-hidden="true" /> Tools
            </>
          ) : (
            <>
              <Globe size={13} aria-hidden="true" /> Web
            </>
          )}
        </span>
        <span className="companion-panel-status">{webStatus(entry)}</span>
        {entry.status === "searching" ? (
          <button
            type="button"
            className="companion-panel-cancel"
            onClick={() =>
              void (entry.tool ? cancelTool : cancelResearch)(entry.job)
            }
          >
            Cancel
          </button>
        ) : null}
      </div>
      <p className="companion-panel-words">{entry.question}</p>
      {entry.status === "searching" && entry.steps.length ? (
        <p className="companion-panel-said">
          {entry.steps[entry.steps.length - 1]}
        </p>
      ) : null}
      {entry.answer ? (
        <p className="companion-panel-answer">
          {linkedText(plainText(entry.answer))}
        </p>
      ) : entry.spoken ? (
        <p className="companion-panel-answer">{entry.spoken}</p>
      ) : entry.error ? (
        <p className="companion-panel-said">{entry.error}</p>
      ) : null}
      {entry.sources?.length ? (
        <ul className="companion-panel-sources" aria-label="Sources">
          {entry.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {waiting ? (
        // The call read back above is made only on the user's yes: said,
        // typed, or here.
        <div
          className="companion-panel-held"
          role="group"
          aria-label="Do what it read back?"
        >
          <button
            type="button"
            className="primary-btn"
            onClick={() => void answerCompanionTool(entry.id, "yes")}
          >
            <Check size={14} aria-hidden="true" /> Yes, do it
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void answerCompanionTool(entry.id, "no")}
          >
            <X size={14} aria-hidden="true" /> No
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * A line the companion says now: the sentence it is at marked, as its
 * strip shows it (CompanionReading.tsx).
 */
function SayingText({ reading }: { reading: CompanionReading }) {
  return (
    <p>
      {reading.sentences.map((sentence, at) => (
        <span
          // Sentences repeat ("Ok."): their place is their key.
          key={at}
          className={at === reading.index ? "companion-panel-now" : undefined}
          aria-current={at === reading.index ? "true" : undefined}
        >
          {sentence}{" "}
        </span>
      ))}
    </p>
  );
}

/** The companion's message box keeps its draft under this key. */
const COMPANION_DRAFT_KEY = "companion";

/**
 * Typing to the companion, as one talks to it on a call, or instead of a
 * call: Enter sends, the answer is written above. It is the agent chats'
 * message box, Vim keys included with the one Vim keys setting.
 */
function CompanionComposer({
  name,
  onSent,
  boxRef,
}: {
  name: string;
  onSent: () => void;
  boxRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={boxRef} className="companion-panel-composer">
      <AgentHistoryComposer
        draftKey={COMPANION_DRAFT_KEY}
        // It always takes text: nothing to warn about before sending.
        status="idle"
        label={`Write to ${name}`}
        placeholder={`Ask ${name} anything`}
        sendTo={name}
        enterSends
        onSend={async (text) => {
          const typed = text.trim();
          if (!typed) return;
          // What one writes is read with its answer: back to the newest.
          onSent();
          void sendCompanionText(typed);
        }}
        onError={(message) => store.notify({ kind: "error", message })}
      />
    </div>
  );
}

/**
 * The companion's own conversation, apart from any workspace: what it
 * heard and said on its calls, and the work it started on which session
 * and how it went. A session's name opens that session's chat. It takes
 * text too, in a call or without one; each new `ask` (its shortcut, the
 * menus, its chip outside a call) focuses its message box.
 */
/** How long the second click may come after the first. */
const START_OVER_CONFIRM_MS = 5000;

/**
 * Clears the companion's memory across calls and its running sessions
 * (voice-memory.ts), after a second click.
 */
function StartOverButton() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), START_OVER_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  return (
    <button
      type="button"
      className="secondary-btn companion-panel-start-over"
      disabled={busy}
      title="Start over: the companion forgets this conversation; its memories stay"
      aria-label="Start over: forget this conversation, the memories stay"
      onClick={() => {
        if (!confirming) return setConfirming(true);
        setConfirming(false);
        setBusy(true);
        void resetCompanion().then((done) => {
          setBusy(false);
          if (!done)
            store.notify({
              kind: "error",
              message: "The companion could not start over",
            });
        });
      }}
    >
      <RotateCcw size={15} aria-hidden="true" />
      {confirming ? "Forget this conversation?" : "Start over"}
    </button>
  );
}

export function CompanionPanel({
  onClose,
  ask = 0,
}: {
  onClose: () => void;
  ask?: number;
}) {
  const call = useSyncExternalStore(subscribeCompanionCall, companionCallState);
  const fronting = useSyncExternalStore(subscribeVoiceFronting, voiceFronting);
  const reading = useCompanionReading();
  const microphonePaused = useMicrophonePausedByPhone();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ask || !composerRef.current)
      return focusDialogElement(dialogRef.current);
    // The box takes the focus once drawn: the Vim one comes with its
    // editor, loaded on first use; the dialog has the keys meanwhile.
    const field = () =>
      composerRef.current?.querySelector<HTMLElement>(
        "textarea, [contenteditable='true']",
      ) ?? null;
    let stop = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const take = () => {
      const box = field();
      if (box) stop = focusDialogElement(box);
      else {
        if (tries === 0) dialogRef.current?.focus({ preventScroll: true });
        if (++tries < 80) timer = setTimeout(take, 25);
      }
    };
    take();
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [ask]);
  // The newest at the bottom, in view as it comes (lines, streamed words,
  // a search's steps), unless the reader scrolled up to read.
  const follow = useFollowScroll<HTMLOListElement>();
  const hearingRef = useRef(false);
  useEffect(() => {
    // Ahead of the message box, whose Vim editor keeps its keys.
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        // Vim's insert mode takes the first Esc, to normal mode; the next
        // closes, as from anywhere else in the dialog.
        const editor =
          event.target instanceof Element
            ? event.target.closest(".cm-editor")
            : null;
        if (editor && !editor.querySelector(".cm-scroller.cm-vimMode")) return;
        onClose();
      }
      // Mod+Enter: what is being said goes now, not the box's draft.
      else if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        hearingRef.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        sendCompanionHeard();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);
  const name = companionName();
  // What the user says now, written as the transcriber hears it; once the
  // utterance ends it is logged as their line and this goes.
  const hearing = call.open ? hearingNow(call) : null;
  hearingRef.current = hearing !== null;
  const open = (session: string) => {
    // Ranger's or the reviews agent's chat: a question the companion gave.
    if (session === RANGER_VOICE_SESSION) {
      onClose();
      openAssistant();
      return;
    }
    if (session === REVIEWS_VOICE_SESSION) {
      onClose();
      openMrReviews(undefined, "chat");
      return;
    }
    const target = parseVoiceSessionId(session);
    if (!target) return;
    onClose();
    setPaneView(target.connectionId, target.paneId, "chat");
    void store.jumpToConnectionPane(target.connectionId, target.paneId);
  };
  return (
    <div
      className="modal-backdrop companion-panel-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal companion-panel"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${name}'s conversation`}
      >
        <div className="modal-head">
          <div>
            <h2>{name}</h2>
            <p>
              {call.open
                ? microphonePaused
                  ? "In a call, microphone paused by the phone: "
                  : call.muted
                    ? "In a call, muted: "
                    : "In a call: "
                : ""}
              {companionChipText(call.presence, 0)}
            </p>
          </div>
          <div className="companion-panel-actions">
            {call.open ? (
              <button
                type="button"
                className={`secondary-btn companion-panel-mute${call.muted ? " is-muted" : ""}`}
                aria-pressed={call.muted}
                title={
                  call.muted
                    ? "Unmute: listen again"
                    : "Mute: it still speaks, nothing is listened to"
                }
                onClick={toggleCompanionMute}
              >
                {call.muted ? (
                  <MicOff size={15} aria-hidden="true" />
                ) : (
                  <Mic size={15} aria-hidden="true" />
                )}
                {call.muted ? "Muted" : "Mute"}
              </button>
            ) : null}
            {call.open ? (
              <CallAppButton className="secondary-btn" withLabel />
            ) : null}
            {call.open ? (
              <CallOutputButton className="secondary-btn" withLabel />
            ) : null}
            {call.open ? (
              <button
                type="button"
                className="secondary-btn companion-panel-hang-up"
                onClick={() => endCompanionCall()}
              >
                <PhoneOff size={15} aria-hidden="true" /> Hang up
              </button>
            ) : (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => startCompanionCall()}
              >
                <PhoneCall size={15} aria-hidden="true" /> Call
              </button>
            )}
            <StartOverButton />
            <CloseButton onClick={onClose} />
          </div>
        </div>
        <div className="companion-panel-body">
          <CompanionMemories />
          <ol
            ref={follow.ref}
            className="companion-panel-log"
            aria-label="Conversation"
          >
            {call.log.length ? null : (
              <li className="companion-panel-empty">
                Nothing said yet. Call {name} and talk, or write below: it
                answers, looks things up on the web, and starts work on your
                sessions.
              </li>
            )}
            {call.log.map((entry) =>
              entry.kind === "web" ? (
                <WebEntry key={entry.id} entry={entry} />
              ) : entry.kind === "job" ? (
                <li
                  key={entry.id}
                  className={`companion-panel-job is-${entry.status.replace(" ", "-")}`}
                >
                  <div className="companion-panel-job-head">
                    <span className="companion-panel-time">
                      {clock(entry.at)}
                    </span>
                    <button
                      type="button"
                      className="companion-panel-session"
                      title={
                        entry.session === RANGER_VOICE_SESSION
                          ? "Open Ranger's chat"
                          : entry.session === REVIEWS_VOICE_SESSION
                            ? "Open the reviews agent's chat"
                            : "Open this session's chat"
                      }
                      onClick={() => open(entry.session)}
                    >
                      {entry.label}
                    </button>
                    <span className="companion-panel-status">
                      {JOB_STATUS[entry.status]}
                    </span>
                  </div>
                  <p className="companion-panel-words">{entry.words}</p>
                  {entry.said ? (
                    <p className="companion-panel-said">
                      <span>You said:</span> {entry.said}
                    </p>
                  ) : null}
                  {entry.context ? (
                    <p className="companion-panel-said">
                      <span>With context:</span> {entry.context}
                    </p>
                  ) : null}
                  {entry.answer ? (
                    <p className="companion-panel-answer">{entry.answer}</p>
                  ) : null}
                </li>
              ) : (
                <li
                  key={entry.id}
                  className={`companion-panel-line is-${entry.kind}${isBeingSaid(reading, entry.id) ? " is-saying" : ""}`}
                  aria-current={
                    isBeingSaid(reading, entry.id) ? "true" : undefined
                  }
                >
                  <span className="companion-panel-time">
                    {clock(entry.at)}
                  </span>
                  <span className="companion-panel-who">
                    {entry.kind === "heard" ? "You" : name}
                  </span>
                  {reading && isBeingSaid(reading, entry.id) ? (
                    <SayingText reading={reading} />
                  ) : (
                    <p>{entry.text}</p>
                  )}
                </li>
              ),
            )}
            {!call.open && call.presence === "thinking" ? (
              // Something typed, the front deciding what to do with it.
              <li className="companion-panel-thinking" aria-live="polite">
                {name} is thinking...
              </li>
            ) : null}
            {hearing ? (
              <li className="companion-panel-hearing" aria-live="polite">
                <Mic size={12} aria-label="Hearing you" />
                <span>{hearing}</span>
                <button
                  type="button"
                  className="companion-panel-send-now"
                  aria-label="Send what you said now"
                  title={`Send now, without waiting for the pause (${SEND_NOW_KEY})`}
                  onClick={sendCompanionHeard}
                >
                  <SendHorizontal size={14} aria-hidden="true" />
                </button>
              </li>
            ) : null}
          </ol>
          {follow.following ? null : (
            <button
              type="button"
              className="companion-panel-latest"
              onClick={follow.jump}
            >
              <ArrowDown size={14} aria-hidden="true" /> Jump to latest
            </button>
          )}
        </div>
        {fronting ? (
          <CompanionComposer
            name={name}
            onSent={follow.jump}
            boxRef={composerRef}
          />
        ) : null}
      </div>
    </div>
  );
}
