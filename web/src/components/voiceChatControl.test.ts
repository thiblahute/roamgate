import { expect, test } from "bun:test";
import {
  speechRateView,
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
