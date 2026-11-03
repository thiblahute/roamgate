import { expect, test } from "bun:test";
import { hearingNow, stripLine } from "./CompanionChip";

const call = {
  heard: "",
  line: null as string | null,
  presence: "listening" as const,
  muted: false,
};

test("the strip says who speaks: the companion's own words are never the user's", () => {
  const line = "It's a past session, so it's most likely not running anymore.";
  // While it speaks, what the microphone picks up is its own voice.
  expect(
    stripLine(
      { ...call, presence: "speaking", line, heard: "It's a past session" },
      "Companion",
    ),
  ).toEqual(["Companion", line]);
  // Its words heard back once it stopped: still its own.
  expect(
    stripLine(
      { ...call, line, heard: "it's a past session so it's" },
      "Companion",
    ),
  ).toEqual(["Companion", line]);
  // The user speaking.
  expect(
    stripLine({ ...call, line, heard: "Is the deploy done?" }, "Companion"),
  ).toEqual(["You", "Is the deploy done?"]);
  // Nothing said yet.
  expect(stripLine(call, "Jarvis")).toEqual(["Jarvis", "Listening."]);
  expect(stripLine({ ...call, muted: true }, "Companion")).toEqual([
    "Companion",
    "Muted: it still speaks.",
  ]);
});

test("what the user says now: not while muted, while it speaks, or its echo", () => {
  const call = {
    heard: "  Quel temps fait-il ",
    line: null,
    presence: "hearing" as const,
    muted: false,
  };
  expect(hearingNow(call)).toBe("Quel temps fait-il");
  expect(hearingNow({ ...call, heard: " " })).toBeNull();
  expect(hearingNow({ ...call, muted: true })).toBeNull();
  expect(hearingNow({ ...call, presence: "speaking" })).toBeNull();
  expect(
    hearingNow({ ...call, line: "Il fait beau.", heard: "il fait beau" }),
  ).toBeNull();
});
