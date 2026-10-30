import { expect, test } from "bun:test";
import {
  formatCallDuration,
  speechRateView,
  voiceCallHungUp,
  voiceCallLeft,
  voiceCallName,
  voiceCallStartedAt,
  voiceControlView,
  voiceMeterLevel,
} from "./voiceChatControl";

test("listening shows the live level and sends on a tap", () => {
  const view = voiceControlView("listening", false, 0.05);
  expect(view.label).toBe("Listening");
  expect(view.ariaLabel).toBe("Listening");
  expect(view.title).toBe("Listening; tap to send now");
  expect(view.icon).toBe("listening");
  expect(view.level).toBeCloseTo(Math.sqrt(0.6));
  expect(view.hint).toBe("Go ahead, I am listening");
  expect(voiceControlView("listening", false, 1).level).toBe(1);
  expect(voiceControlView("listening", false, -1).level).toBe(0);
});

test("muted listening says so and shows no level", () => {
  const view = voiceControlView("listening", true, 0.5);
  expect(view.label).toBe("Muted");
  expect(view.hint).toBe("Microphone muted");
  expect(view.level).toBeNull();
  expect(view.title).toBe("Listening; tap to send now");
});

test("the other states use short words and stop on a tap", () => {
  expect(voiceControlView("transcribing", false, 0.5)).toEqual({
    label: "Transcribing",
    ariaLabel: "Writing down what you said",
    title: "Writing down what you said; tap to stop",
    icon: "busy",
    level: null,
    hint: "Writing down what you said",
  });
  const waiting = voiceControlView("waiting", true, 0);
  expect(waiting.label).toBe("Thinking");
  expect(waiting.title).toBe("Waiting for the agent; tap to stop");
  expect(waiting.icon).toBe("busy");
  const speaking = voiceControlView("speaking", false, 0);
  expect(speaking.title).toBe("Reading the answer; tap to interrupt and talk");
  expect(speaking.label).toBe("Speaking");
  expect(speaking.ariaLabel).toBe("Reading the answer");
  expect(speaking.icon).toBe("speaking");
});

test("the meter lifts quiet speech and stays within 0 and 1", () => {
  expect(voiceMeterLevel(0)).toBe(0);
  expect(voiceMeterLevel(-0.2)).toBe(0);
  expect(voiceMeterLevel(Number.NaN)).toBe(0);
  // Quiet speech already moves the meter a third of the way.
  expect(voiceMeterLevel(0.01)).toBeGreaterThan(0.3);
  expect(voiceMeterLevel(0.05)).toBeLessThan(1);
  expect(voiceMeterLevel(0.5)).toBe(1);
});

test("the speed button shows the rate and the next one", () => {
  expect(speechRateView(1.2)).toEqual({
    label: "1.2x",
    ariaLabel: "Reading speed 1.2x",
    title: "Replies are read at 1.2x; tap for 1.3x",
  });
  expect(speechRateView(1.5).title).toBe(
    "Replies are read at 1.5x; tap for 1x",
  );
});

test("the call is with the agent, where it works", () => {
  expect(voiceCallName("claude", "roamgate")).toBe("Claude \u00b7 roamgate");
  expect(voiceCallName("codex", "  ")).toBe("Codex");
  expect(voiceCallName(undefined, "roamgate")).toBe("Agent \u00b7 roamgate");
  expect(voiceCallName(" ", null)).toBe("Agent");
});

test("the call timer counts like a phone", () => {
  expect(formatCallDuration(0)).toBe("00:00");
  expect(formatCallDuration(999)).toBe("00:00");
  expect(formatCallDuration(42_500)).toBe("00:42");
  expect(formatCallDuration(12 * 60_000 + 5_000)).toBe("12:05");
  expect(formatCallDuration(3_723_000)).toBe("1:02:03");
  expect(formatCallDuration(-5)).toBe("00:00");
  expect(formatCallDuration(Number.NaN)).toBe("00:00");
});

test("a call goes on when its card comes back soon, not after a hang-up", () => {
  voiceCallHungUp();
  expect(voiceCallStartedAt(1_000)).toBe(1_000);
  // The chat rebuilt: the card leaves and comes back.
  voiceCallLeft(5_000);
  expect(voiceCallStartedAt(6_000)).toBe(1_000);
  // Gone for longer: a new call.
  voiceCallLeft(7_000);
  expect(voiceCallStartedAt(20_000)).toBe(20_000);
  voiceCallHungUp();
  expect(voiceCallStartedAt(20_500)).toBe(20_500);
  voiceCallHungUp();
});
