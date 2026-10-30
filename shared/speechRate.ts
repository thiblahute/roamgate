/**
 * How fast voice replies are read, as a multiple of the voice's own pace:
 * `speech_rate` in voice.json, changed from the voice card. Voices whose
 * model takes a speed are made at that rate; the browser plays the others
 * faster (keeping their pitch).
 */

/**
 * A little faster than the models speak by themselves: the cloned Qwen3-TTS
 * voice reads about 11.6 characters a second, Kokoro 13; at 1.2 both stay as
 * intelligible to a speech recognizer and as close to the speaker.
 */
export const DEFAULT_SPEECH_RATE = 1.2;
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;

/** The rates the voice card's speed button goes through, in order. */
export const SPEECH_RATE_STEPS = [1, 1.1, 1.2, 1.3, 1.5] as const;

export function isSpeechRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SPEECH_RATE &&
    value <= MAX_SPEECH_RATE
  );
}

/** A usable rate: `value` when it is one, the default otherwise. */
export function speechRateOr(value: unknown): number {
  return isSpeechRate(value) ? value : DEFAULT_SPEECH_RATE;
}

/** The speed button's next rate: the next step up, back to 1 after the last. */
export function nextSpeechRate(rate: number): number {
  return (
    SPEECH_RATE_STEPS.find((step) => step > rate + 1e-6) ?? SPEECH_RATE_STEPS[0]
  );
}

/**
 * The playback rate that makes audio already made at `nativeRate` sound at
 * `rate`: 1.2 for a voice made at its own pace, 1 for one made at 1.2.
 */
export function playbackRateFor(rate: number, nativeRate: number): number {
  const native = nativeRate > 0 && Number.isFinite(nativeRate) ? nativeRate : 1;
  const playback = speechRateOr(rate) / native;
  // Rounding keeps 1.2 / 1.2 at exactly 1, so nothing is resampled.
  return Math.round(playback * 1000) / 1000;
}

/** "1.2x", "1x". */
export function formatSpeechRate(rate: number): string {
  return `${Math.round(rate * 100) / 100}x`;
}
