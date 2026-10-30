import { describe, expect, test } from "bun:test";
import {
  type CutOutcome,
  createReadingPlace,
  resumeAfter,
  resumesReading,
} from "./voiceResume";

describe("resumesReading", () => {
  test("goes on when nothing was sent", () => {
    expect(resumesReading("nothing")).toBe(true);
    expect(resumesReading("noise")).toBe(true);
    expect(resumesReading("not-for-agent")).toBe(true);
  });

  test("stays stopped for a message, a stop, or speech taken elsewhere", () => {
    expect(resumesReading("sent")).toBe(false);
    expect(resumesReading("stop")).toBe(false);
    expect(resumesReading("elsewhere")).toBe(false);
  });
});

describe("resumeAfter", () => {
  const cut = { skip: 2, sentence: "Third.", id: "a" };

  test("gives the cut back only when the reading goes on", () => {
    const outcomes: CutOutcome[] = ["nothing", "noise", "not-for-agent"];
    for (const outcome of outcomes) expect(resumeAfter(cut, outcome)).toBe(cut);
    expect(resumeAfter(cut, "sent")).toBeNull();
    expect(resumeAfter(cut, "stop")).toBeNull();
    expect(resumeAfter(null, "noise")).toBeNull();
  });
});

describe("createReadingPlace", () => {
  test("cut before any sentence played: from the start", () => {
    const place = createReadingPlace();
    expect(place.cut()).toEqual({ skip: 0, sentence: null });
  });

  test("cut mid-sentence: that sentence again", () => {
    const place = createReadingPlace();
    place.sentence("One.");
    place.sentence("Two.");
    expect(place.cut()).toEqual({ skip: 1, sentence: "Two." });
  });

  test("the cut stays where it was, whatever the reading says after", () => {
    const place = createReadingPlace();
    place.sentence("One.");
    const cut = place.cut();
    // Stopping the reading ends it: speak says null.
    place.sentence(null);
    place.sentence("Two.");
    expect(place.cut()).toEqual(cut);
    expect(cut).toEqual({ skip: 0, sentence: "One." });
  });

  test("a reading that went on counts from where it went on", () => {
    const place = createReadingPlace(3);
    expect(place.cut()).toEqual({ skip: 3, sentence: null });
    const later = createReadingPlace(3);
    later.sentence("Four.");
    later.sentence("Five.");
    expect(later.cut()).toEqual({ skip: 4, sentence: "Five." });
  });

  test("a reading over: nothing left", () => {
    const place = createReadingPlace();
    place.sentence("One.");
    place.sentence(null);
    expect(place.cut()).toEqual({ skip: 1, sentence: null });
  });
});
