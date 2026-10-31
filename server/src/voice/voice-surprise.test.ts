import { describe, expect, test } from "bun:test";
import {
  pickSurpriseVoice,
  SurprisePicker,
  type SurpriseVoice,
} from "./voice-surprise";

const voices: SurpriseVoice[] = [
  { id: "elo" },
  { id: "oli" },
  { id: "tib2" },
  { id: "papa" },
];

/** Picks in turn the first, second, ... of the choices offered. */
const first = () => 0;
const last = () => 0.999;

describe("surprise voices", () => {
  test("any voice may read a reply", () => {
    expect(pickSurpriseVoice(voices, null, first)).toBe("elo");
    expect(pickSurpriseVoice(voices, null, last)).toBe("papa");
    expect(pickSurpriseVoice([], null, first)).toBeNull();
  });

  test("never the same voice twice in a row, when another may read", () => {
    expect(pickSurpriseVoice(voices, "elo", first)).toBe("oli");
    // The only one there is reads again.
    expect(pickSurpriseVoice([voices[0]!], "elo", first)).toBe("elo");
    let previous: string | null = null;
    for (let turn = 0; turn < 200; turn += 1) {
      const next = pickSurpriseVoice(voices, previous);
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  test("a reply keeps its voice from one sentence to the next", () => {
    const picker = new SurprisePicker(first);
    expect(picker.pick(voices, "r1")).toBe("elo");
    expect(picker.pick(voices, "r1")).toBe("elo");
    // The next reply is someone else.
    expect(picker.pick(voices, "r2")).toBe("oli");
    // A voice deleted meanwhile is picked again.
    expect(
      picker.pick(
        voices.filter((voice) => voice.id !== "elo"),
        "r1",
      ),
    ).toBe("tib2");
  });
});
