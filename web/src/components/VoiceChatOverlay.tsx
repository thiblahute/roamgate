import {
  AudioLines,
  LoaderCircle,
  Mic,
  MicOff,
  Speech,
  Volume2,
} from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import {
  type ActiveVoiceState,
  speechRateView,
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

/**
 * A running voice conversation, as a card floating over the bottom of the
 * chat: what it is doing, the live microphone level, the words being heard
 * (their last lines), the mute toggle, the reading speed, the voices (who
 * reads, new ones), and a tap to send what was said now or to stop. Its size is fixed, so it stays put while the user talks.
 */
export function VoiceChatOverlay({
  state,
  level,
  muted,
  heard = "",
  speechRate,
  onToggle,
  onToggleMute,
  onCycleSpeechRate,
  moveQuestion,
  onAnswerMove,
  onOpenVoices,
}: {
  state: ActiveVoiceState;
  level: number;
  muted: boolean;
  /** What the voice helper has heard so far of what is being said. */
  heard?: string;
  /** How fast replies are read; with `onCycleSpeechRate`, a speed button. */
  speechRate?: number;
  onToggle: () => void;
  onToggleMute: () => void;
  onCycleSpeechRate?: () => void;
  /**
   * The question about moving to a workspace with no agent, answered here
   * by a tap as well as aloud.
   */
  moveQuestion?: string | null;
  onAnswerMove?: (yes: boolean) => void;
  /** Opens the voices: who reads the replies, new ones. */
  onOpenVoices?: () => void;
}) {
  const view = voiceControlView(state, muted, level);
  const rate =
    speechRate === undefined || !onCycleSpeechRate
      ? null
      : speechRateView(speechRate);
  return (
    <div className="voice-chat-overlay-anchor">
      <div
        className={`voice-chat-overlay is-${state}${muted ? " is-muted" : ""}`}
        role="group"
        aria-label="Voice conversation"
        style={
          view.level === null
            ? undefined
            : ({ "--voice-level": view.level } as CSSProperties)
        }
      >
        <div className="voice-chat-overlay-controls">
          <button
            type="button"
            className="voice-chat-overlay-state"
            aria-label={view.ariaLabel}
            aria-pressed={true}
            title={view.title}
            onMouseDown={keepFocus}
            onClick={onToggle}
          >
            <span className="voice-chat-overlay-icon" aria-hidden="true">
              {view.icon === "listening" ? (
                <AudioLines size={18} />
              ) : view.icon === "speaking" ? (
                <Volume2 size={18} />
              ) : (
                <LoaderCircle size={18} />
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
          </button>
          <button
            type="button"
            className={`voice-chat-overlay-mute${muted ? " is-muted" : ""}`}
            aria-pressed={muted}
            aria-label={muted ? "Unmute the microphone" : "Mute the microphone"}
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
              className="voice-chat-overlay-rate"
              aria-label={rate.ariaLabel}
              title={rate.title}
              onMouseDown={keepFocus}
              onClick={onCycleSpeechRate}
            >
              {rate.label}
            </button>
          ) : null}
          {onOpenVoices ? (
            <button
              type="button"
              className="voice-chat-overlay-voices"
              aria-label="Voices"
              title="Voices: who reads the replies, and new ones"
              onMouseDown={keepFocus}
              onClick={onOpenVoices}
            >
              <Speech size={18} aria-hidden="true" />
            </button>
          ) : null}
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
        ) : (
          <div className="voice-chat-overlay-heard" aria-live="polite">
            {heard ? <p>{heard}</p> : <p className="is-hint">{view.hint}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
