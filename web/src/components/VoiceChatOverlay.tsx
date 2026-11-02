import {
  AudioLines,
  LoaderCircle,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
} from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import {
  type ActiveVoiceState,
  formatCallDuration,
  speechRateView,
  voiceCallHungUp,
  voiceCallLeft,
  voiceCallName,
  voiceCallStartedAt,
  voiceControlView,
} from "./voiceChatControl";
import "./VoiceChatOverlay.css";

// Taps keep the focus where it was, such as the message box, like the
// composer's own buttons.
const keepFocus = (event: ReactMouseEvent<HTMLButtonElement>) => {
  event.preventDefault();
};

// The meter's bars, each answering the voice with its own weight.
const METER_BARS = [0.55, 0.85, 1, 0.75, 0.45];

/** How long the call has lasted, ticking every second. */
function useCallDuration(): string {
  const [startedAt, setStartedAt] = useState(() => voiceCallStartedAt());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setStartedAt(voiceCallStartedAt());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
      voiceCallLeft();
    };
  }, []);
  return formatCallDuration(now - startedAt);
}

/**
 * A running voice conversation, as an ongoing call floating over the bottom
 * of the chat. On the left, who the call is with (the agent and its
 * workspace), what it is doing, the call's length and the live microphone
 * level; a tap there sends what was said now, interrupts the reading, or
 * stops. On the right, round call buttons: mute, the reading speed, and the
 * red hang-up. Below, the words being heard (their last lines). Surprise
 * and the voices live in Configuration's Speech section, not here. Its size
 * is fixed, so it stays put while the user talks.
 */
export function VoiceChatOverlay({
  state,
  level,
  muted,
  heard = "",
  speechRate,
  agent,
  place,
  onToggle,
  onToggleMute,
  onEnd,
  onCycleSpeechRate,
  reader = null,
  moveQuestion,
  onAnswerMove,
  notSent = null,
  onSendAnyway,
  said = null,
}: {
  state: ActiveVoiceState;
  level: number;
  muted: boolean;
  /** What the voice helper has heard so far of what is being said. */
  heard?: string;
  /** How fast replies are read; with `onCycleSpeechRate`, a speed button. */
  speechRate?: number;
  /** The agent the call is with, as the pane names it ("claude"). */
  agent?: string;
  /** Where that agent works: its workspace. */
  place?: string;
  onToggle: () => void;
  onToggleMute: () => void;
  /** Ends the voice conversation, whatever it is doing. */
  onEnd: () => void;
  onCycleSpeechRate?: () => void;
  /** Who reads the reply, when the server says. */
  reader?: string | null;
  /**
   * The question about moving to a workspace with no agent, answered here
   * by a tap as well as aloud.
   */
  moveQuestion?: string | null;
  onAnswerMove?: (yes: boolean) => void;
  /**
   * The last sentence taken as not for the agent: shown, marked not sent,
   * with `onSendAnyway` to send it after all.
   */
  notSent?: string | null;
  onSendAnyway?: () => void;
  /**
   * What the one the call is with says now (the voice companion's line),
   * shown in the card's text line rather than over the chat.
   */
  said?: string | null;
}) {
  const view = voiceControlView(state, muted, level, reader);
  const name = voiceCallName(agent, place);
  const duration = useCallDuration();
  const rate =
    speechRate === undefined || !onCycleSpeechRate
      ? null
      : speechRateView(speechRate);
  const hangUp = () => {
    voiceCallHungUp();
    onEnd();
  };
  return (
    <div className="voice-chat-overlay-anchor">
      <div
        className={`voice-chat-overlay is-${state}${muted ? " is-muted" : ""}`}
        role="group"
        aria-label={`Voice call with ${name}`}
        style={
          view.level === null
            ? undefined
            : ({ "--voice-level": view.level } as CSSProperties)
        }
      >
        <div className="voice-chat-overlay-bar">
          <button
            type="button"
            className="voice-chat-overlay-who"
            aria-label={`${name}: ${view.title}`}
            title={view.title}
            onMouseDown={keepFocus}
            onClick={onToggle}
          >
            <span className="voice-chat-overlay-avatar" aria-hidden="true">
              <AgentIcon agent={agent} />
            </span>
            <span className="voice-chat-overlay-text">
              <span className="voice-chat-overlay-name">{name}</span>
              <span className="voice-chat-overlay-status">
                <span className="voice-chat-overlay-icon" aria-hidden="true">
                  {view.icon === "listening" ? (
                    <AudioLines size={13} />
                  ) : view.icon === "speaking" ? (
                    <Volume2 size={13} />
                  ) : (
                    <LoaderCircle size={13} />
                  )}
                </span>
                <span className="voice-chat-overlay-label" aria-live="polite">
                  {view.label}
                </span>
                {view.level === null ? null : (
                  <span className="voice-chat-overlay-meter" aria-hidden="true">
                    {METER_BARS.map((weight) => (
                      <span
                        key={weight}
                        style={{ "--bar-weight": weight } as CSSProperties}
                      />
                    ))}
                  </span>
                )}
                <span
                  className="voice-chat-overlay-timer"
                  role="timer"
                  aria-label={`Call length ${duration}`}
                >
                  {duration}
                </span>
              </span>
            </span>
          </button>
          <div className="voice-chat-overlay-calls">
            <button
              type="button"
              className={`voice-chat-overlay-call voice-chat-overlay-mute${
                muted ? " is-muted" : ""
              }`}
              aria-pressed={muted}
              aria-label={
                muted ? "Unmute the microphone" : "Mute the microphone"
              }
              title={
                muted
                  ? "Unmute: listen again"
                  : "Mute: replies are still read, nothing is listened to"
              }
              onMouseDown={keepFocus}
              onClick={onToggleMute}
            >
              {muted ? (
                <MicOff size={18} aria-hidden="true" />
              ) : (
                <Mic size={18} aria-hidden="true" />
              )}
            </button>
            {rate ? (
              <button
                type="button"
                className="voice-chat-overlay-call voice-chat-overlay-rate"
                aria-label={rate.ariaLabel}
                title={rate.title}
                onMouseDown={keepFocus}
                onClick={onCycleSpeechRate}
              >
                {rate.label}
              </button>
            ) : null}
            <button
              type="button"
              className="voice-chat-overlay-call voice-chat-overlay-hangup"
              aria-label="Hang up: end the voice conversation"
              title="Hang up"
              onMouseDown={keepFocus}
              onClick={hangUp}
            >
              <PhoneOff size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
        {moveQuestion && onAnswerMove ? (
          <div className="voice-chat-overlay-move" role="group">
            <p aria-live="polite">{moveQuestion}</p>
            <div className="voice-chat-overlay-move-actions">
              <button
                type="button"
                className="voice-chat-overlay-move-go"
                title="Move there; voice turns off"
                onMouseDown={keepFocus}
                onClick={() => onAnswerMove(true)}
              >
                Move
              </button>
              <button
                type="button"
                className="voice-chat-overlay-move-stay"
                title="Stay here; voice goes on"
                onMouseDown={keepFocus}
                onClick={() => onAnswerMove(false)}
              >
                Stay
              </button>
            </div>
          </div>
        ) : !heard && notSent && onSendAnyway ? (
          <div
            className="voice-chat-overlay-not-sent"
            role="group"
            aria-label="Not sent"
          >
            <p aria-live="polite">
              <span className="voice-chat-overlay-not-sent-tag">Not sent:</span>{" "}
              {notSent}
            </p>
            <button
              type="button"
              className="voice-chat-overlay-not-sent-send"
              title="It was for the agent: send it"
              onMouseDown={keepFocus}
              onClick={onSendAnyway}
            >
              Send anyway
            </button>
          </div>
        ) : (
          <div className="voice-chat-overlay-heard" aria-live="polite">
            {heard ? (
              <p>{heard}</p>
            ) : said ? (
              <p className="is-said">{said}</p>
            ) : (
              <p className="is-hint">{view.hint}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
