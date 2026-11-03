import {
  ArrowDown,
  Globe,
  Mic,
  MicOff,
  PhoneCall,
  SendHorizontal,
  PhoneOff,
  Send,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
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
import { cancelResearch, parseVoiceSessionId, plainText } from "../voiceRoute";
import { sendCompanionText } from "../companionText";
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
  return (
    <li
      className={`companion-panel-job companion-panel-web is-${entry.status}`}
    >
      <div className="companion-panel-job-head">
        <span className="companion-panel-time">{clock(entry.at)}</span>
        <span className="companion-panel-web-title">
          <Globe size={13} aria-hidden="true" /> Web
        </span>
        <span className="companion-panel-status">
          {WEB_STATUS[entry.status]}
        </span>
        {entry.status === "searching" ? (
          <button
            type="button"
            className="companion-panel-cancel"
            onClick={() => void cancelResearch(entry.job)}
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

/** Typing to the companion, as one talks to it on a call. */
function CompanionComposer({
  name,
  onSent,
}: {
  name: string;
  onSent: () => void;
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
 * and how it went. A session's name opens that session's chat.
 */
export function CompanionPanel({ onClose }: { onClose: () => void }) {
  const call = useSyncExternalStore(subscribeCompanionCall, companionCallState);
  const fronting = useSyncExternalStore(subscribeVoiceFronting, voiceFronting);
  const reading = useCompanionReading();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => focusDialogElement(dialogRef.current), []);
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
          <CompanionComposer name={name} onSent={follow.jump} />
        ) : null}
      </div>
    </div>
  );
}
