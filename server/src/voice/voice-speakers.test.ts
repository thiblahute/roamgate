import { describe, expect, test } from "bun:test";
import { parseVoiceTag, SpeakerTracker, type VoiceTag } from "./voice-speakers";

/** An utterance of one voice, `id`, with its closeness to each voice. */
function said(
  id: string | null,
  similarity: Record<string, number>,
  more: Partial<VoiceTag> = {},
): VoiceTag {
  return {
    voices: 7,
    id,
    share: 1,
    mixed: false,
    mix: id ? [{ id, share: 1 }] : [],
    similarity,
    ...more,
  };
}

describe("voice tags", () => {
  test("a final's voice is checked, names and numbers only", () => {
    expect(
      parseVoiceTag({
        voices: 1763550000000,
        id: "B",
        share: 0.8,
        mixed: true,
        mix: [
          { id: "B", share: 0.8 },
          { id: "A", share: 0.2 },
          { id: "<x>", share: 1 },
        ],
        similarity: { A: 0.12, B: 0.71, bad: 3, C: "high" },
        merged: { D: "A", E: 3 },
        seconds: 4.2,
      }),
    ).toEqual({
      voices: 1763550000000,
      id: "B",
      share: 0.8,
      mixed: true,
      mix: [
        { id: "B", share: 0.8 },
        { id: "A", share: 0.2 },
      ],
      similarity: { A: 0.12, B: 0.71 },
      merged: { D: "A" },
    });
    expect(parseVoiceTag({ voices: 3, id: null })).toMatchObject({
      id: null,
      mixed: false,
      mix: [],
    });
    for (const bad of [null, "A", 3, { id: "A" }, { voices: "3" }])
      expect(parseVoiceTag(bad)).toBeNull();
  });
});

describe("the user's voice", () => {
  test("is not known from the first sound: labels name the voices", () => {
    const speakers = new SpeakerTracker();
    // The radio first: nothing is taken for the user's.
    const radio = said("A", { A: 0.81 });
    speakers.observe(radio);
    expect(speakers.label(radio)).toBe("voice A");
    expect(speakers.user()).toBeNull();
    expect(speakers.label(said(null, { A: 0.05 }))).toBe("voice unclear");
    expect(speakers.label(null)).toBe("");
  });

  test("is the voice whose words the companion takes up", () => {
    const speakers = new SpeakerTracker();
    const radio = said("A", { A: 0.8 });
    speakers.learn(radio, "nobody");
    const user = said("B", { A: 0.06, B: 0.62 });
    speakers.learn(user, "self");
    expect(speakers.user()).toEqual({ voices: 7, id: "B" });
    expect(speakers.label(user)).toBe("you 0.62");
    expect(speakers.label(said("A", { A: 0.77, B: 0.07 }))).toBe(
      "voice A, 0.07 like you",
    );
    expect(speakers.label(said(null, { A: 0.1, B: 0.31 }))).toBe(
      "voice unclear, 0.31 like you",
    );
  });

  test("moves to another voice only when it has clearly more", () => {
    const speakers = new SpeakerTracker();
    // The radio's words were taken up at first (it asked a question).
    speakers.learn(said("A", { A: 0.8 }), "web");
    expect(speakers.user()?.id).toBe("A");
    speakers.learn(said("B", { A: 0.05, B: 0.6 }), "current");
    expect(speakers.user()?.id).toBe("A");
    speakers.learn(said("B", { A: 0.05, B: 0.6 }), "self");
    expect(speakers.user()?.id).toBe("B");
    // The companion saying it outright counts more.
    const back = new SpeakerTracker();
    back.learn(said("A", { A: 0.8 }), "self");
    back.learn(said("A", { A: 0.8 }), "self");
    back.learn(said("A", { A: 0.75 }), "nobody", "other");
    expect(back.user()).toBeNull();
    back.learn(said("B", { A: 0.1, B: 0.2 }), "self", "user");
    expect(back.user()?.id).toBe("B");
  });

  test("mixed or unclear words teach nothing by their route", () => {
    const speakers = new SpeakerTracker();
    speakers.learn(
      said(
        "A",
        { A: 0.5, B: 0.4 },
        {
          mixed: true,
          mix: [
            { id: "A", share: 0.55 },
            { id: "B", share: 0.45 },
          ],
        },
      ),
      "self",
    );
    speakers.learn(said("A", { A: 0.5 }, { share: 0.5 }), "self");
    speakers.learn(said(null, {}), "self");
    expect(speakers.user()).toBeNull();
  });

  test("mixed words name the user first", () => {
    const speakers = new SpeakerTracker();
    speakers.learn(said("B", { B: 0.6 }), "self");
    const both = said(
      "A",
      { A: 0.41, B: 0.35 },
      {
        mixed: true,
        share: 0.6,
        mix: [
          { id: "A", share: 0.6 },
          { id: "B", share: 0.4 },
        ],
      },
    );
    expect(speakers.label(both)).toBe("mixed: you + A");
    const others = said(
      "A",
      { A: 0.5, B: 0.1, C: 0.4 },
      {
        mixed: true,
        mix: [
          { id: "A", share: 0.6 },
          { id: "C", share: 0.4 },
        ],
      },
    );
    expect(speakers.label(others)).toBe("mixed: A + C, 0.10 like you");
    expect(speakers.isOther(others)).toBe(true);
    expect(speakers.isOther(both)).toBe(false);
  });

  test("a new call forgets the user's voice; merged voices keep what was learnt", () => {
    const speakers = new SpeakerTracker();
    speakers.learn(said("C", { C: 0.6 }), "self");
    // C was found to be A's: the user is A now.
    const merged = said("A", { A: 0.6 }, { merged: { C: "A" } });
    speakers.observe(merged);
    expect(speakers.user()).toEqual({ voices: 7, id: "A" });
    expect(speakers.label(merged)).toBe("you 0.60");
    const next = said("A", { A: 0.7 }, { voices: 8 });
    speakers.observe(next);
    expect(speakers.user()).toBeNull();
    expect(speakers.label(next)).toBe("voice A");
  });

  test("another voice is clearly not the user's only when far from theirs", () => {
    const speakers = new SpeakerTracker();
    expect(speakers.isOther(said("A", { A: 0.8 }))).toBe(false);
    speakers.learn(said("A", { A: 0.6 }), "self");
    expect(speakers.isOther(said("A", { A: 0.6 }))).toBe(false);
    expect(speakers.isOther(said("B", { A: 0.05, B: 0.7 }))).toBe(true);
    expect(speakers.isOther(said("B", { A: 0.3, B: 0.5 }))).toBe(false);
  });
});
