import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { between, near, person } from "./testdata/prints";
import {
  cosine,
  MAX_PRINTS,
  MAX_UNNAMED,
  matchPrint,
  unit,
  type VoiceProfile,
  VoiceProfiles,
} from "./voice-profiles";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function library(): VoiceProfiles {
  const root = mkdtempSync(join(tmpdir(), "roamgate-voice-profiles-"));
  dirs.push(root);
  return new VoiceProfiles(join(root, "voice-profiles"));
}

function profile(
  prints: { print: number[]; call: number }[],
  id = "p",
): VoiceProfile {
  return {
    id,
    name: id,
    role: "family",
    prints: prints.map((each) => ({ ...each, seconds: 10, at: 0 })),
    seconds: 10,
    calls: prints.length,
    first: 0,
    last: 0,
  };
}

describe("matching a voice with the people known", () => {
  test("sure above the threshold with a margin over the next", () => {
    const simon = profile([{ print: person(0), call: 1 }], "simon");
    const elo = profile([{ print: person(1), call: 1 }], "elo");
    const found = matchPrint(between(person(0), person(3), 0.7), [simon, elo]);
    expect(found.sure).toBe(true);
    expect(found.best?.profile.id).toBe("simon");
    expect(found.best?.score).toBeCloseTo(0.7, 2);
  });

  test("two close people: not sure without the margin, only maybe", () => {
    // Siblings: their prints score 0.6 against each other.
    const elo = profile([{ print: person(1), call: 1 }], "elo");
    const oli = profile(
      [{ print: between(person(1), person(2), 0.6), call: 1 }],
      "oli",
    );
    // Between the two.
    const heard = unit(
      elo.prints[0]!.print.map((v, i) => v + oli.prints[0]!.print[i]!),
    )!;
    const found = matchPrint(heard, [elo, oli]);
    expect(found.best!.score).toBeGreaterThan(0.6);
    expect(found.best!.score - found.second).toBeLessThan(0.15);
    expect(found.sure).toBe(false);
    expect(found.maybe).toBe(true);
  });

  test("below the threshold: maybe, then nobody", () => {
    const simon = profile([{ print: person(0), call: 1 }], "simon");
    const close = matchPrint(between(person(0), person(3), 0.5), [simon]);
    expect(close).toMatchObject({ sure: false, maybe: true });
    const far = matchPrint(between(person(0), person(3), 0.3), [simon]);
    expect(far).toMatchObject({ sure: false, maybe: false });
  });

  test("the call's own print and rejected people do not count", () => {
    const simon = profile([{ print: person(0), call: 5 }], "simon");
    expect(matchPrint(person(0), [simon], 5).best).toBeNull();
    expect(matchPrint(person(0), [simon], 6).sure).toBe(true);
    expect(
      matchPrint(person(0), [simon], 6, new Set(["simon"])).best,
    ).toBeNull();
  });

  test("a person's closest print counts: one per microphone", () => {
    const phone = between(person(0), person(4), 0.4);
    const simon = profile(
      [
        { print: person(0), call: 1 },
        { print: phone, call: 2 },
      ],
      "simon",
    );
    expect(matchPrint(near(phone, 0.02, 3), [simon]).sure).toBe(true);
  });
});

describe("the voice library", () => {
  test("keeps one print per call, replaced as the call goes", () => {
    const voices = library();
    const simon = voices.create("Simon", "family");
    voices.learn(simon, 1, person(0), 4);
    voices.learn(simon, 1, near(person(0), 0.02, 1), 9);
    voices.learn(simon, 2, near(person(0), 0.02, 2), 5);
    expect(simon.prints.map((each) => [each.call, each.seconds])).toEqual([
      [1, 9],
      [2, 5],
    ]);
    expect(simon.calls).toBe(2);
    expect(simon.seconds).toBe(14);
  });

  test("keeps a bounded set of prints, merging the closest, the call's own kept", () => {
    const voices = library();
    const simon = voices.create("Simon", "family");
    // Two microphones, many calls each.
    for (let call = 1; call <= MAX_PRINTS + 4; call++)
      voices.learn(
        simon,
        call,
        near(
          call % 2 ? person(0) : between(person(0), person(5), 0.5),
          0.02,
          call,
        ),
        5,
      );
    expect(simon.prints.length).toBe(MAX_PRINTS);
    expect(simon.prints.some((each) => each.call === MAX_PRINTS + 4)).toBe(
      true,
    );
    // Both microphones are still there.
    expect(
      Math.max(...simon.prints.map((each) => cosine(each.print, person(0)))),
    ).toBeGreaterThan(0.95);
    expect(
      Math.min(...simon.prints.map((each) => cosine(each.print, person(0)))),
    ).toBeLessThan(0.6);
  });

  test("is kept in private files, read back, prints only (no audio)", () => {
    const voices = library();
    const simon = voices.create("Simon", "family");
    voices.learn(simon, 1, person(0), 6);
    const files = readdirSync(voices.dir);
    expect(files).toEqual([`${simon.id}.json`]);
    const file = join(voices.dir, files[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(voices.dir).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(stored).sort()).toEqual(
      ["calls", "first", "last", "name", "prints", "role", "seconds"].sort(),
    );
    const again = new VoiceProfiles(voices.dir);
    const read = again.byName("simon")!;
    expect(read).toMatchObject({ id: simon.id, name: "Simon", role: "family" });
    expect(cosine(read.prints[0]!.print, person(0))).toBeGreaterThan(0.9999);
  });

  test("a file deleted stays deleted; a file it cannot read is skipped", () => {
    const voices = library();
    const simon = voices.create("Simon", "family");
    voices.learn(simon, 1, person(0), 6);
    writeFileSync(join(voices.dir, "0123456789abcdef.json"), "{not json");
    rmSync(join(voices.dir, `${simon.id}.json`));
    // Learnt again before the next call reads the files: not written back.
    voices.learn(simon, 1, person(0), 8);
    expect(existsSync(join(voices.dir, `${simon.id}.json`))).toBe(false);
    expect(voices.byName("Simon")).toBeNull();
    voices.reload();
    expect(voices.profiles()).toEqual([]);
  });

  test("a call's print is undone; an unnamed voice left empty goes", () => {
    const voices = library();
    const simon = voices.create("Simon", "family");
    voices.learn(simon, 1, person(0), 6);
    voices.learn(simon, 2, person(1), 4);
    voices.forgetCall(simon, 2);
    expect(simon.prints.map((each) => each.call)).toEqual([1]);
    expect(simon).toMatchObject({ seconds: 6, calls: 1 });
    const stranger = voices.create(null, "unknown");
    voices.learn(stranger, 3, person(2), 30);
    voices.forgetCall(stranger, 3);
    expect(voices.get(stranger.id)).toBeNull();
    expect(existsSync(join(voices.dir, `${stranger.id}.json`))).toBe(false);
  });

  test("an unnamed voice given a name moves its prints over", () => {
    const voices = library();
    const stranger = voices.create(null, "unknown");
    voices.learn(stranger, 1, person(2), 30);
    voices.learn(stranger, 2, person(2), 25);
    const oli = voices.create("Oli", "family");
    voices.absorb(oli, stranger);
    expect(oli.prints.length).toBe(2);
    expect(oli).toMatchObject({ seconds: 55, calls: 2 });
    expect(voices.get(stranger.id)).toBeNull();
  });

  test("one user; few unnamed voices", () => {
    const voices = library();
    const a = voices.create("A", "user");
    const b = voices.create("B", "family");
    voices.update(b, { role: "user" });
    expect(voices.user()?.id).toBe(b.id);
    expect(a.role).toBe("other");
    for (let i = 0; i < MAX_UNNAMED + 3; i++) voices.create(null, "unknown");
    expect(
      voices.profiles().filter((each) => each.role === "unknown").length,
    ).toBe(MAX_UNNAMED);
  });

  test("names are kept short and printable", () => {
    const voices = library();
    const elo = voices.create("  Élodie <b>\n", "family");
    expect(elo.name).toBe("Élodie b");
    expect(voices.byName("élodie b")?.id).toBe(elo.id);
  });
});
