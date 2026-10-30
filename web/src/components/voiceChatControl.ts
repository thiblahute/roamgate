import { formatSpeechRate, nextSpeechRate } from "../../../shared/speechRate";
import type { VoiceState } from "./useVoiceChat";

export type ActiveVoiceState = Exclude<VoiceState, "off">;

/** What each voice chat state is called, for screen readers and titles. */
export const VOICE_LABELS: Record<ActiveVoiceState, string> = {
  listening: "Listening",
  transcribing: "Writing down what you said",
  waiting: "Waiting for the agent",
  speaking: "Reading the answer",
};

/** The word shown on the floating control, short enough for a phone. */
const VOICE_SHORT_LABELS: Record<ActiveVoiceState, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  waiting: "Thinking",
  speaking: "Speaking",
};

export type VoiceControlView = {
  /** Short word shown beside the icon. */
  label: string;
  ariaLabel: string;
  title: string;
  icon: "listening" | "speaking" | "busy";
  /** The live microphone level, 0 to 1, while it is heard; else null. */
  level: number | null;
  /** Shown where the words being said appear, until there are some. */
  hint: string;
};

const VOICE_HINTS: Record<ActiveVoiceState, string> = {
  listening: "Go ahead, I am listening",
  transcribing: "Writing down what you said",
  waiting: "Waiting for the agent to answer",
  speaking: "Reading the answer",
};

/**
 * The microphone's loudness (a small RMS value, quiet speech near 0.01) as a
 * 0 to 1 meter level. The square root lifts quiet speech so it shows.
 */
export function voiceMeterLevel(level: number): number {
  if (!(level > 0)) return 0;
  return Math.min(1, Math.sqrt(level * 12));
}

/** How the floating voice control shows a running voice conversation. */
export function voiceControlView(
  state: ActiveVoiceState,
  muted: boolean,
  level: number,
): VoiceControlView {
  const listening = state === "listening";
  return {
    label: listening && muted ? "Muted" : VOICE_SHORT_LABELS[state],
    ariaLabel: VOICE_LABELS[state],
    title: listening
      ? "Listening; tap to send now"
      : `${VOICE_LABELS[state]}; tap to stop`,
    icon: listening ? "listening" : state === "speaking" ? "speaking" : "busy",
    level: listening && !muted ? voiceMeterLevel(level) : null,
    hint: listening && muted ? "Microphone muted" : VOICE_HINTS[state],
  };
}

/** The voice card's speed button: the rate read at, and what a tap does. */
export function speechRateView(rate: number) {
  const shown = formatSpeechRate(rate);
  const next = formatSpeechRate(nextSpeechRate(rate));
  return {
    label: shown,
    ariaLabel: `Reading speed ${shown}`,
    title: `Replies are read at ${shown}; tap for ${next}`,
  };
}
