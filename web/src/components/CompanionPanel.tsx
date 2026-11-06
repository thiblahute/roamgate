import {
  ArrowDown,
  Check,
  Globe,
  Mic,
  MicOff,
  PhoneCall,
  SendHorizontal,
  PhoneOff,
  Send,
  Wrench,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
} from "../voiceRoute";
import { sendCompanionText } from "../companionText";
import { answerCompanionTool } from "../companionWeb";
import { subscribeVoiceFronting, voiceFronting } from "../voiceFrontFlag";
import { companionChipText, hearingNow } from "./CompanionChip";
import { useCompanionReading } from "./CompanionReading";
import { type CompanionReading, isBeingSaid } from "../companionReading";
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

/**
 * Typing to the companion, as one talks to it on a call, or instead of a
 * call: Enter sends, the answer is written above.
 */
function CompanionComposer({
  name,
  onSent,
  inputRef,
}: {
  name: string;
  onSent: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = text.trim();
    if (!typed) return;
    setText("");
    // What one writes is read with its answer: back to the newest.
    onSent();
    void sendCompanionText(typed);
  };
  return (
    <form className="companion-panel-composer" onSubmit={submit}>
      <input
        ref={inputRef}
        type="text"
        value={text}
        aria-label={`Write to ${name}`}
        placeholder={`Ask ${name} anything`}
        enterKeyHint="send"
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="submit"
        className="primary-btn"
        aria-label="Send"
        disabled={!text.trim()}
      >
        <Send size={15} aria-hidden="true" />
      </button>
    </form>
  );
}

/**
 * The companion's own conversation, apart from any workspace: what it
 * heard and said on its calls, and the work it started on which session
 * and how it went. A session's name opens that session's chat. It takes
 * text too, in a call or without one; each new `ask` (its shortcut, the
 * menus, its chip outside a call) focuses its message box.
 */
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  useEffect(
    () =>
      focusDialogElement(
        ask && composerRef.current ? composerRef.current : dialogRef.current,
      ),
    [ask],
  );
  // The newest at the bottom, in view as it comes (lines, streamed words,
  // a search's steps), unless the reader scrolled up to read.
  const follow = useFollowScroll<HTMLOListElement>();
  const hearingRef = useRef(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      // Mod+Enter: what is being said goes now (the composer's Enter is
      // plain, so the two never meet).
      else if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        hearingRef.current
      ) {
        event.preventDefault();
        sendCompanionHeard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const name = companionName();
  // What the user says now, written as the transcriber hears it; once the
  // utterance ends it is logged as their line and this goes.
  const hearing = call.open ? hearingNow(call) : null;
  hearingRef.current = hearing !== null;
  const open = (session: string) => {
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
                ? call.muted
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
            <CloseButton onClick={onClose} />
          </div>
        </div>
        <div className="companion-panel-body">
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
                      title="Open this session's chat"
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
            inputRef={composerRef}
          />
        ) : null}
      </div>
    </div>
  );
}
