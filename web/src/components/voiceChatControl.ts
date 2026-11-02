import { formatSpeechRate, nextSpeechRate } from "../../../shared/speechRate";
import type { VoiceState } from "./useVoiceChat";

export type ActiveVoiceState = Exclude<VoiceState, "off">;

/** What each voice chat state is called, for screen readers and titles. */
export const VOICE_LABELS: Record<ActiveVoiceState, string> = {
  listening: "Listening",
  transcribing: "Writing down what you said",
  routing: "Choosing who it's for",
  waiting: "Waiting for the agent",
  speaking: "Reading the answer",
};

/** The word shown on the floating control, short enough for a phone. */
const VOICE_SHORT_LABELS: Record<ActiveVoiceState, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  routing: "Choosing",
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
  routing: "Choosing who it's for",
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
  /** Who reads the reply, when the server says (Surprise). */
  reader?: string | null,
): VoiceControlView {
  const listening = state === "listening";
  const speaker = state === "speaking" && reader ? reader : null;
  const speaking = speaker ? `${speaker} is speaking` : null;
  return {
    label:
      listening && muted ? "Muted" : (speaking ?? VOICE_SHORT_LABELS[state]),
    ariaLabel: speaking ?? VOICE_LABELS[state],
    title: listening
      ? "Listening; tap to send now"
      : state === "speaking"
        ? `${VOICE_LABELS[state]}; tap to interrupt and talk`
        : `${VOICE_LABELS[state]}; tap to stop`,
    icon: listening ? "listening" : state === "speaking" ? "speaking" : "busy",
    level: listening && !muted ? voiceMeterLevel(level) : null,
    hint:
      listening && muted
        ? "Microphone muted"
        : speaker
          ? `${speaker} reads the answer`
          : VOICE_HINTS[state],
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

/**
 * Who a voice conversation is "on the call" with: the agent, capitalized,
 * and the workspace it works in, joined by a middle dot, short enough for
 * the call bar.
 */
export function voiceCallName(agent?: string | null, place?: string | null) {
  const trimmed = agent?.trim() ?? "";
  const who = trimmed
    ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
    : "Agent";
  const where = place?.trim();
  return where ? `${who} \u00b7 ${where}` : who;
}

/** A call's length as the phone shows it: 00:42, 12:05, 1:02:03. */
export function formatCallDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/*
 * When the voice conversation started, for the call timer. The card goes
 * when voice chat stops and a new one comes when a chat picks it up again
 * (a reconnect rebuilds the chat): one that comes back within a moment
 * goes on with the same call, a hang-up starts the next one from zero.
 */
const CALL_CARRY_MS = 3000;
let call: { startedAt: number; leftAt: number | null } | null = null;

/** The current call's start, starting one if none is going on. */
export function voiceCallStartedAt(now = Date.now()): number {
  if (!call || (call.leftAt !== null && now - call.leftAt > CALL_CARRY_MS)) {
    call = { startedAt: now, leftAt: null };
  } else {
    call.leftAt = null;
  }
  return call.startedAt;
}

/** The card went away; the call goes on if one comes back soon. */
export function voiceCallLeft(now = Date.now()) {
  if (call) call.leftAt = now;
}

/** The user hung up: the next call starts from zero. */
export function voiceCallHungUp() {
  call = null;
}
