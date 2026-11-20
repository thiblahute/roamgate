import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceProfiles } from "./voice-profiles";
import { between, near, person } from "./testdata/prints";
import {
  parseVoiceTag,
  SpeakerTracker,
  type VoiceTag,
  withoutPrints,
} from "./voice-speakers";

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
      seconds: 4.2,
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

/** A confident utterance of voice `id` on call `voices`, with its prints. */
function spoken(
  voices: number,
  id: string,
  print: number[],
  more: Partial<VoiceTag> = {},
): VoiceTag {
  return {
    voices,
    id,
    share: 1,
    mixed: false,
    mix: [{ id, share: 1 }],
    similarity: { [id]: 0.7 },
    seconds: 4,
    print,
    prints: { [id]: print },
    ...more,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function withLibrary(): { speakers: SpeakerTracker; library: VoiceProfiles } {
  const root = mkdtempSync(join(tmpdir(), "roamgate-speakers-"));
  roots.push(root);
  const library = new VoiceProfiles(join(root, "voice-profiles"));
  return { speakers: new SpeakerTracker(library), library };
}

describe("voices kept across calls", () => {
  test("the user's profile makes their voice 'you' from the first utterance", () => {
    const { speakers, library } = withLibrary();
    const me = library.create("Thibault", "user");
    library.learn(me, 1, person(0), 30);
    const first = spoken(2, "A", near(person(0), 0.02, 1));
    speakers.observe(first);
    expect(speakers.label(first)).toBe("Thibault (you) 0.70");
    expect(speakers.user()).toMatchObject({ voices: 2, id: "A" });
    // Kept from the earlier call, and what this one taught already.
    expect(speakers.user()?.prints?.length).toBe(2);
    // A new call's start carries the prints kept, not this call's name.
    expect(speakers.keptUser()).toEqual({
      prints: [expect.any(Array), expect.any(Array)],
    });
  });

  test("known people are named, others unknown or maybe someone", () => {
    const { speakers, library } = withLibrary();
    const simon = library.create("Simon", "family");
    library.learn(simon, 1, person(1), 30);
    const me = library.create("Thibault", "user");
    library.learn(me, 1, person(0), 30);
    const simonSays = spoken(2, "B", near(person(1), 0.02, 2));
    speakers.observe(simonSays);
    expect(speakers.label(simonSays)).toMatch(/^Simon 0\.9\d$/);
    // Simon is someone else: not for the agent without a companion.
    expect(speakers.isOther(simonSays)).toBe(true);
    const stranger = spoken(2, "C", person(3));
    speakers.observe(stranger);
    expect(speakers.label(stranger)).toBe("voice C, unknown");
    const close = spoken(2, "D", between(person(1), person(4), 0.5));
    speakers.observe(close);
    expect(speakers.label(close)).toBe("voice D, maybe Simon 0.50");
    const me2 = spoken(2, "A", near(person(0), 0.02, 3));
    speakers.observe(me2);
    const both = spoken(2, "A", near(person(0), 0.02, 4), {
      mixed: true,
      mix: [
        { id: "B", share: 0.5 },
        { id: "A", share: 0.5 },
      ],
    });
    expect(speakers.label(both)).toBe("mixed: Thibault (you) + Simon");
  });

  test("profiles learn only from confident, unmixed utterances", () => {
    const { speakers, library } = withLibrary();
    const simon = library.create("Simon", "family");
    library.learn(simon, 1, person(1), 30);
    const print = near(person(1), 0.02, 5);
    // Mixed, half the words, short, or far from its voice: nothing learnt.
    speakers.observe(spoken(2, "B", print, { mixed: true }));
    speakers.observe(spoken(2, "B", print, { share: 0.5 }));
    speakers.observe(spoken(2, "B", print, { seconds: 0.5 }));
    speakers.observe(spoken(2, "B", print, { similarity: { B: 0.2 } }));
    // (A new call reads the files again.)
    const kept = () => library.get(simon.id)!.prints;
    expect(kept().map((each) => each.call)).toEqual([1]);
    // Confident ones are this call's print, once a few seconds long.
    speakers.observe(spoken(2, "B", print));
    expect(kept().map((each) => each.call)).toEqual([1, 2]);
    expect(kept()[1]!.seconds).toBe(4);
    speakers.observe(spoken(2, "B", print));
    expect(kept()[1]!.seconds).toBe(8);
  });

  test("the user's voice learnt from the conversation is kept as theirs", () => {
    const { speakers, library } = withLibrary();
    const tag = spoken(2, "A", person(0));
    speakers.observe(tag);
    speakers.learn(tag, "self");
    // One route is a guess: nothing kept yet.
    expect(library.user()).toBeNull();
    speakers.learn(tag, "self", "user");
    expect(library.user()?.prints.length).toBe(1);
    // The next call knows them at once.
    const next = spoken(3, "B", near(person(0), 0.02, 6));
    speakers.observe(next);
    expect(speakers.label(next)).toBe("you 0.70");
  });

  test("a voice wrongly taken for the user's is not, once said", () => {
    const { speakers, library } = withLibrary();
    const me = library.create(null, "user");
    library.learn(me, 1, person(0), 30);
    const tag = spoken(2, "A", near(person(0), 0.02, 7));
    speakers.observe(tag);
    expect(speakers.user()?.id).toBe("A");
    expect(library.get(me.id)!.prints.length).toBe(2);
    speakers.learn(tag, "nobody", "other");
    expect(speakers.user()?.id).toBeUndefined();
    // What it taught the user's profile is undone, and it stays not theirs.
    expect(library.get(me.id)!.prints.map((each) => each.call)).toEqual([1]);
    speakers.observe(tag);
    expect(speakers.label(tag)).not.toContain("you");
  });

  test("the companion names a voice; it is known on the next call", () => {
    const { speakers, library } = withLibrary();
    const tag = spoken(2, "C", person(2));
    speakers.observe(tag);
    expect(speakers.name(tag, { name: "Simon", role: "family" })).toBe(
      "voice C is Simon (family)",
    );
    expect(speakers.label(tag)).toMatch(/^Simon/);
    expect(library.byName("simon")?.prints.length).toBe(1);
    // Read back from its file on the next call.
    const again = new SpeakerTracker(new VoiceProfiles(library.dir));
    const next = spoken(3, "A", near(person(2), 0.02, 8));
    again.observe(next);
    expect(again.label(next)).toMatch(/^Simon 0\.9\d$/);
  });

  test("a wrong name is corrected: the first person unlearns this call", () => {
    const { speakers, library } = withLibrary();
    const elo = library.create("Elo", "family");
    library.learn(elo, 1, person(1), 30);
    // Oli, matched as Elo (a sibling).
    const tag = spoken(2, "B", near(person(1), 0.05, 9));
    speakers.observe(tag);
    expect(speakers.label(tag)).toMatch(/^Elo/);
    expect(library.get(elo.id)!.prints.length).toBe(2);
    expect(
      speakers.name(tag, { voice: "B", name: "Oli", role: "family" }),
    ).toBe("voice B is Oli (family), was Elo");
    expect(library.get(elo.id)!.prints.map((each) => each.call)).toEqual([1]);
    expect(library.byName("Oli")?.prints.length).toBe(1);
    // Elo is not taken for B again on this call.
    speakers.observe(tag);
    expect(speakers.label(tag)).toMatch(/^Oli/);
  });

  test("naming the user's voice names their profile", () => {
    const { speakers, library } = withLibrary();
    const tag = spoken(2, "A", person(0));
    speakers.observe(tag);
    speakers.name(tag, { name: "Thibault", role: "user" });
    expect(library.user()?.name).toBe("Thibault");
    expect(speakers.user()?.id).toBe("A");
    expect(speakers.label(tag)).toBe("Thibault (you) 0.70");
  });

  test("a voice heard long and often is kept unnamed, offered for naming once", () => {
    const { speakers, library } = withLibrary();
    for (let call = 1; call <= 3; call++)
      for (let i = 0; i < 6; i++)
        speakers.observe(
          spoken(call, "B", near(person(5), 0.02, call * 10 + i)),
        );
    const [kept] = library.profiles();
    expect(kept).toMatchObject({ name: null, role: "unknown", calls: 3 });
    const tag = spoken(3, "B", near(person(5), 0.02, 99));
    speakers.observe(tag);
    expect(speakers.label(tag)).toBe("voice B, heard on 3 calls");
    expect(speakers.detail(tag, true)).toContain(
      "voice B was heard on 3 calls and has no name: you may ask once",
    );
    expect(speakers.detail(tag, true)).not.toContain("you may ask");
    // Named: its prints go to the person.
    speakers.name(tag, { name: "Mamie", role: "family" });
    expect(library.profiles().map((each) => [each.name, each.calls])).toEqual([
      ["Mamie", 3],
    ]);
  });

  test("the companion gets every score behind the label", () => {
    const { speakers, library } = withLibrary();
    const simon = library.create("Simon", "family");
    library.learn(simon, 1, person(1), 30);
    const me = library.create("Thibault", "user");
    library.learn(me, 1, person(0), 30);
    const a = spoken(2, "A", person(0));
    speakers.observe(a);
    const tag = spoken(2, "B", near(person(1), 0.02, 11), {
      similarity: { A: 0.05, B: 0.71 },
    });
    speakers.observe(tag);
    const detail = speakers.detail(withoutPrints(tag));
    expect(detail).toMatch(
      /^voices in it: B 100% is Simon \(closest: Simon 0\.9\d, Thibault \(you\) 0\.1\d\) \| the words against people known: Simon 0\.9\d, Thibault \(you\) 0\.1\d \| against this call's voices: B 0\.71, A 0\.05$/,
    );
  });

  test("the page gets tags without prints, and sends back their utterance", () => {
    const tag = parseVoiceTag({
      ...spoken(2, "A", person(0)),
      prints: { A: person(0), "<x>": person(1), B: [1, 2] },
    })!;
    expect(Object.keys(tag.prints!)).toEqual(["A"]);
    const { speakers } = withLibrary();
    speakers.observe(tag);
    expect(tag.utterance).toBe(1);
    const page = withoutPrints(tag);
    expect(page).not.toHaveProperty("print");
    expect(page).not.toHaveProperty("prints");
    expect(parseVoiceTag(JSON.parse(JSON.stringify(page)))).toMatchObject({
      utterance: 1,
      seconds: 4,
    });
  });
});
