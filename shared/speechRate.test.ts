import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPEECH_RATE,
  formatSpeechRate,
  isSpeechRate,
  nextSpeechRate,
  playbackRateFor,
  speechRateOr,
} from "./speechRate";

describe("speech rate", () => {
  test("accepts finite rates from 0.5 to 2 only", () => {
    expect(isSpeechRate(1.2)).toBe(true);
    expect(isSpeechRate(0.5)).toBe(true);
    expect(isSpeechRate(2)).toBe(true);
    expect(isSpeechRate(0.4)).toBe(false);
    expect(isSpeechRate(2.5)).toBe(false);
    expect(isSpeechRate(Number.NaN)).toBe(false);
    expect(isSpeechRate("1.2")).toBe(false);
    expect(speechRateOr(undefined)).toBe(DEFAULT_SPEECH_RATE);
    expect(speechRateOr(9)).toBe(DEFAULT_SPEECH_RATE);
    expect(speechRateOr(1.1)).toBe(1.1);
  });

  test("steps up through the presets, then back to 1", () => {
    expect(nextSpeechRate(1)).toBe(1.1);
    expect(nextSpeechRate(1.2)).toBe(1.3);
    expect(nextSpeechRate(1.5)).toBe(1);
    // A rate set by hand between steps goes to the next one up.
    expect(nextSpeechRate(1.25)).toBe(1.3);
    expect(nextSpeechRate(1.8)).toBe(1);
  });

  test("plays what was made at its own pace faster, the rest as made", () => {
    expect(playbackRateFor(1.2, 1)).toBe(1.2);
    expect(playbackRateFor(1.2, 1.2)).toBe(1);
    // Made at 1.2, wanted at 1.5 after a change.
    expect(playbackRateFor(1.5, 1.2)).toBe(1.25);
    expect(playbackRateFor(1.3, 0)).toBe(1.3);
    expect(playbackRateFor(Number.NaN, 1)).toBe(DEFAULT_SPEECH_RATE);
  });

  test("shows as a multiplier", () => {
    expect(formatSpeechRate(1)).toBe("1x");
    expect(formatSpeechRate(1.2)).toBe("1.2x");
    expect(formatSpeechRate(1.25)).toBe("1.25x");
  });
});
