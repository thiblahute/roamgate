import { PhoneCall, PhoneOff } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  type CompanionLogEntry,
  companionCallState,
  companionName,
  endCompanionCall,
  startCompanionCall,
  subscribeCompanionCall,
} from "../companionCall";
import { store } from "../store";
import { setPaneView } from "../paneView";
import { parseVoiceSessionId } from "../voiceRoute";
import { companionChipText } from "./CompanionChip";
import { useCompanionReading } from "./CompanionReading";
import { type CompanionReading, isBeingSaid } from "../companionReading";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import "./CompanionPanel.css";

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
 * The companion's own conversation, apart from any workspace: what it
 * heard and said on its calls, and the work it started on which session
 * and how it went. A session's name opens that session's chat.
 */
export function CompanionPanel({ onClose }: { onClose: () => void }) {
  const call = useSyncExternalStore(subscribeCompanionCall, companionCallState);
  const reading = useCompanionReading();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => focusDialogElement(dialogRef.current), []);
  // The newest at the bottom, in view.
  const count = call.log.length;
  useEffect(() => {
    if (count) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [count]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const name = companionName();
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
              {call.open ? "In a call: " : ""}
              {companionChipText(call.presence, 0)}
            </p>
          </div>
          <div className="companion-panel-actions">
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
        <ol className="companion-panel-log" aria-label="Conversation">
          {call.log.length ? null : (
            <li className="companion-panel-empty">
              Nothing said yet. Call {name} and talk: it answers, and starts
              work on your sessions.
            </li>
          )}
          {call.log.map((entry) =>
            entry.kind === "job" ? (
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
                <span className="companion-panel-time">{clock(entry.at)}</span>
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
        </ol>
        <div ref={endRef} />
      </div>
    </div>
  );
}
