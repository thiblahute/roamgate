import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READING_TEXTS } from "../../../shared/voiceLibrary";
import type { VoiceConfig } from "./voice-helper";
import {
  assignmentsFrom,
  type ClonedVoice,
  cloningModel,
  defaultVoicesDir,
  KOKORO,
  modelsFor,
  VoiceError,
  VoiceLibrary,
} from "./voice-library";

/**
 * A voice.json with a Qwen3-TTS Base model, a French voice and an English
 * one made elsewhere, then Kokoro; the voices directory empty.
 */
function setup(models?: VoiceConfig["tts_models"]) {
  const root = mkdtempSync(join(tmpdir(), "voice-library-"));
  const base = join(root, "Qwen3-TTS-Base");
  mkdirSync(join(base, "speech_tokenizer"), { recursive: true });
  writeFileSync(
    join(base, "config.json"),
    JSON.stringify({ speaker_encoder_config: { enc_dim: 2048 } }),
  );
  writeFileSync(join(base, "speech_tokenizer", "model.safetensors"), "");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  for (const name of ["papa-fr", "papa"])
    writeFileSync(join(elsewhere, `${name}.json`), "{}");
  const configPath = join(root, "voice.json");
  const config = {
    helper: "/bin/true",
    parakeet_model: "/models/parakeet",
    voices_dir: join(root, "voices"),
    tts_models: models ?? [
      {
        model: "qwen3-tts",
        path: base,
        voice_embedding: join(elsewhere, "papa-fr.json"),
        languages: "fr",
        temperature: 0.7,
      },
      {
        model: "qwen3-tts",
        path: base,
        voice_embedding: join(elsewhere, "papa.json"),
      },
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config));
  const cloned: Parameters<
    ConstructorParameters<typeof VoiceLibrary>[0]["clone"]
  >[0][] = [];
  let applied = 0;
  let answer: ClonedVoice | Error = {
    embedding: [0.5, -0.25],
    codes: [
      [1, 2],
      [3, 4],
    ],
    heard: "",
    seconds: 12,
  };
  const library = new VoiceLibrary({
    configPath,
    readConfig: () =>
      JSON.parse(readFileSync(configPath, "utf8")) as VoiceConfig,
    clone: async (request) => {
      cloned.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    applied: () => {
      applied += 1;
    },
    now: () => new Date("2026-10-30T12:00:00Z"),
  });
  const readConfig = () =>
    JSON.parse(readFileSync(configPath, "utf8")) as VoiceConfig;
  return {
    root,
    base,
    elsewhere,
    library,
    cloned,
    readConfig,
    applied: () => applied,
    answer: (next: ClonedVoice | Error) => {
      answer = next;
    },
  };
}

describe("voice library", () => {
  test("voices go to ~/.local/share/roamgate/voices", () => {
    expect(defaultVoicesDir("/home/kid", "linux")).toBe(
      "/home/kid/.local/share/roamgate/voices",
    );
  });

  test("the voices voice.json reads with are listed, and stay listed", async () => {
    const t = setup();
    const state = t.library.state();
    expect(state.voices.map((voice) => [voice.id, voice.owned])).toEqual([
      ["papa-fr", false],
      ["papa", false],
    ]);
    expect(state.voices[0]!.languages).toEqual(["fr"]);
    expect(state.assignments).toEqual({
      all: "papa",
      languages: { fr: "papa-fr" },
    });
    expect(state.kokoro).toBe(true);
    expect(state.can_clone).toBe(true);
    // Once Kokoro reads, they are still there to choose again.
    await t.library.assign(KOKORO, null);
    expect(t.library.state().voices.map((voice) => voice.id)).toEqual([
      "papa-fr",
      "papa",
    ]);
    expect(t.library.state().assignments).toEqual({
      all: KOKORO,
      languages: {},
    });
  });

  test("a recording becomes a voice, with the text shown when read", async () => {
    const t = setup();
    const shown = READING_TEXTS.en[0]!;
    t.answer({
      embedding: [0.5],
      codes: [[7, 8]],
      heard: shown.toLowerCase().replace(/[,.]/g, ""),
      seconds: 11,
    });
    const created = await t.library.create({
      name: " Léa ",
      language: "en",
      text: shown,
      audio: "/tmp/rec.wav",
    });
    expect(created.kind).toBe("shown");
    expect(created.transcript).toBe(shown);
    expect(created.voice).toMatchObject({
      id: "lea",
      name: "Léa",
      languages: ["en"],
      owned: true,
      created: "2026-10-30T12:00:00.000Z",
    });
    expect(t.cloned).toEqual([
      {
        audio: "/tmp/rec.wav",
        model: t.base,
        reference: join(t.root, "voices", "lea.wav"),
        language: "en",
      },
    ]);
    // any-tts's VoiceEmbedding.
    expect(
      JSON.parse(readFileSync(join(t.root, "voices", "lea.json"), "utf8")),
    ).toEqual({
      data: [0.5],
      shape: [1],
      model_type: "qwen3-tts",
      prompt: { codes: [[7, 8]], text: shown },
    });
    // A second Léa does not replace the first.
    const second = await t.library.create({
      name: "Léa",
      language: "fr",
      text: READING_TEXTS.fr[0],
      audio: "/tmp/rec2.wav",
    });
    expect(second.voice.id).toBe("lea-2");
    expect(t.library.state().voices.map((voice) => voice.id)).toEqual([
      "papa-fr",
      "papa",
      "lea",
      "lea-2",
    ]);
  });

  test("what was heard is kept when it is not the text shown", async () => {
    const t = setup();
    t.answer({
      embedding: [1],
      codes: [[1]],
      heard: "Arr, I am a pirate and I love treasure.",
      seconds: 6,
    });
    const created = await t.library.create({
      name: "Pirate",
      language: "en",
      text: READING_TEXTS.en[1],
      audio: "/tmp/rec.wav",
    });
    expect(created.kind).toBe("heard");
    expect(
      JSON.parse(readFileSync(created.voice.path, "utf8")).prompt.text,
    ).toBe("Arr, I am a pirate and I love treasure.");
  });

  test("a recording cut mid-speech keeps only what it says", async () => {
    const t = setup();
    const shown = READING_TEXTS.en[0]!;
    t.answer({ embedding: [1], codes: [[1]], heard: shown, seconds: 29 });
    const created = await t.library.create({
      name: "Oli",
      language: "en",
      text: shown,
      audio: "/tmp/rec.wav",
      cut: true,
    });
    expect(created.kind).toBe("partial");
    expect(
      JSON.parse(readFileSync(created.voice.path, "utf8")).prompt.text,
    ).toBe(shown.replace(/\.$/, ""));
  });

  test("a recording that fails to clone leaves nothing", async () => {
    const t = setup();
    t.answer(new Error("No speech in the recording"));
    const failed = t.library.create({
      name: "Tom",
      language: "en",
      text: "hi",
      audio: "/tmp/rec.wav",
    });
    expect(failed).rejects.toThrow("No speech in the recording");
    await failed.catch((error: VoiceError) => expect(error.status).toBe(422));
    expect(existsSync(join(t.root, "voices", "tom.json"))).toBe(false);
    expect(t.library.state().voices).toHaveLength(2);
  });

  test("bad names and languages are refused", () => {
    const t = setup();
    expect(
      t.library.create({ name: " ", language: "en", text: "", audio: "x" }),
    ).rejects.toThrow("name");
    expect(
      t.library.create({ name: "Tom", language: "xx", text: "", audio: "x" }),
    ).rejects.toThrow("language");
  });

  test("choosing a voice for all languages drops their own voices", async () => {
    const t = setup();
    const lea = await t.library.create({
      name: "Léa",
      language: "fr",
      text: "",
      audio: "/tmp/rec.wav",
    });
    const state = await t.library.assign("lea", null);
    expect(state.assignments).toEqual({ all: "lea", languages: {} });
    expect(t.applied()).toBe(1);
    const models = t.readConfig().tts_models!;
    expect(models).toEqual([
      {
        model: "qwen3-tts",
        path: t.base,
        voice_embedding: lea.voice.path,
      },
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ]);
    // The rest of voice.json stays.
    expect(t.readConfig().parakeet_model).toBe("/models/parakeet");
  });

  test("a language gets a voice of its own, and gives it back", async () => {
    const t = setup();
    await t.library.create({
      name: "Pirate",
      language: "en",
      text: "",
      audio: "/tmp/rec.wav",
    });
    await t.library.assign("pirate", "en");
    expect(t.library.state().assignments).toEqual({
      all: "papa",
      languages: { fr: "papa-fr", en: "pirate" },
    });
    const models = t.readConfig().tts_models!;
    // The French entry keeps its temperature; languages first, then all.
    expect(
      models.map((model) => [model.languages, model.temperature] as unknown[]),
    ).toEqual([
      ["fr", 0.7],
      ["en", undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    await t.library.assign(null, "en");
    expect(t.library.state().assignments.languages).toEqual({ fr: "papa-fr" });
    // The voice of all languages for a language: nothing of its own.
    await t.library.assign("papa", "fr");
    expect(t.library.state().assignments.languages).toEqual({});
  });

  test("Kokoro reads every language or none", async () => {
    const t = setup();
    expect(t.library.assign(KOKORO, "fr")).rejects.toThrow("Kokoro");
    expect(t.library.assign("nobody", null)).rejects.toThrow("No such voice");
    await t.library.assign(KOKORO, null);
    expect(t.readConfig().tts_models).toEqual([
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ]);
  });

  test("a voice to hear reads everything, before Kokoro", () => {
    const t = setup();
    expect(t.library.sampleModels("papa-fr")).toEqual([
      {
        model: "qwen3-tts",
        path: t.base,
        voice_embedding: join(t.elsewhere, "papa-fr.json"),
      },
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ]);
    expect(t.library.sampleModels(KOKORO)).toEqual([
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ]);
  });

  test("renaming keeps the files; deleting removes only recorded ones", async () => {
    const t = setup();
    const lea = await t.library.create({
      name: "Léa",
      language: "fr",
      text: "",
      audio: "/tmp/rec.wav",
    });
    writeFileSync(lea.voice.reference!, "wav");
    expect(t.library.rename("lea", "Léa la pirate").name).toBe("Léa la pirate");
    expect(t.library.state().voices.find((v) => v.id === "lea")!.name).toBe(
      "Léa la pirate",
    );
    t.library.delete("lea");
    expect(existsSync(lea.voice.path)).toBe(false);
    expect(existsSync(lea.voice.reference!)).toBe(false);
    // In use: choose another first.
    expect(() => t.library.delete("papa")).toThrow("choose another voice");
    await t.library.assign(KOKORO, null);
    t.library.delete("papa");
    // Made elsewhere: forgotten, not deleted.
    expect(existsSync(join(t.elsewhere, "papa.json"))).toBe(true);
    expect(t.library.state().voices.map((voice) => voice.id)).toEqual([
      "papa-fr",
    ]);
  });

  test("without a Base model, voices cannot be recorded", () => {
    const t = setup([{ model: "kokoro", path: "/models/Kokoro-82M" }]);
    const state = t.library.state();
    expect(state.can_clone).toBe(false);
    expect(state.clone_detail).toContain("Base");
    expect(cloningModel({ helper: "", clone_model: t.base })).toBe(t.base);
  });

  test("assignments and models read each other", () => {
    const models: NonNullable<VoiceConfig["tts_models"]> = [
      {
        model: "qwen3-tts",
        path: "/base",
        voice_embedding: "/v/a.json",
        languages: "fr,es",
      },
      { model: "kokoro", path: "/k" },
    ];
    const assignments = assignmentsFrom(models, (path) =>
      path === "/v/a.json" ? "a" : undefined,
    );
    expect(assignments).toEqual({
      all: KOKORO,
      languages: { fr: "a", es: "a" },
    });
    expect(
      modelsFor(
        models,
        assignments,
        (id) => ({ voice_embedding: `/v/${id}.json` }),
        "/base",
      ),
    ).toEqual([
      {
        model: "qwen3-tts",
        path: "/base",
        voice_embedding: "/v/a.json",
        languages: "fr",
      },
      {
        model: "qwen3-tts",
        path: "/base",
        voice_embedding: "/v/a.json",
        languages: "es",
      },
      { model: "kokoro", path: "/k" },
    ]);
  });
});

describe("surprise", () => {
  test("is kept in voice.json, and choosing a voice turns it off", async () => {
    const t = setup();
    expect(t.library.state().surprise).toBe(false);
    expect(t.library.surpriseVoices()).toBeNull();
    expect(t.library.setSurprise(true).surprise).toBe(true);
    expect(t.readConfig().voice_surprise).toBe(true);
    // Every voice is picked from, those made elsewhere included.
    expect(t.library.surpriseVoices()?.map((voice) => voice.id)).toEqual([
      "papa-fr",
      "papa",
    ]);
    // Who reads every language: Surprise off.
    await t.library.assign("papa", "fr");
    expect(t.readConfig().voice_surprise).toBeUndefined();
    t.library.setSurprise(true);
    await t.library.assign(null, "fr");
    expect(t.readConfig().voice_surprise).toBe(true);
    expect(t.library.setSurprise(false).surprise).toBe(false);
    expect("voice_surprise" in t.readConfig()).toBe(false);
    t.library.setSurprise(true);
    await t.library.assign(KOKORO, null);
    expect(t.library.state().surprise).toBe(false);
  });

  test("needs voices and a model to read them with", () => {
    const t = setup([{ model: "kokoro", path: "/models/Kokoro-82M" }]);
    expect(() => t.library.setSurprise(true)).toThrow(
      "No Qwen3-TTS model to read with.",
    );
    expect(t.library.setSurprise(false).surprise).toBe(false);
  });
});

/** A Qwen3-TTS CustomVoice model with three stock speakers, next to `dir`. */
function customVoice(dir: string, name = "Qwen3-TTS-CustomVoice") {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "config.json"),
    JSON.stringify({
      tts_model_type: "custom_voice",
      talker_config: { spk_id: { vivian: 3065, Ryan: 3061, newbie: 1 } },
    }),
  );
  return path;
}

describe("stock voices", () => {
  test("are those of the CustomVoice model next to the Base one", () => {
    const t = setup();
    expect(t.library.state().stock).toEqual([]);
    expect(t.library.state().stock_detail).toContain("CustomVoice");
    const custom = customVoice(t.root);
    const state = t.library.state();
    expect(state.stock_detail).toBeUndefined();
    expect(state.stock).toEqual([
      {
        id: "qwen3-tts:ryan",
        speaker: "ryan",
        name: "Ryan",
        native: "en",
        description: "Lively man, strong rhythm",
      },
      {
        id: "qwen3-tts:vivian",
        speaker: "vivian",
        name: "Vivian",
        native: "zh",
        description: "Bright young woman, a little edgy",
      },
      {
        id: "qwen3-tts:newbie",
        speaker: "newbie",
        name: "Newbie",
        native: "",
        description: "",
      },
    ]);
    // A sample reads with the CustomVoice model and that speaker.
    expect(t.library.sampleModels("qwen3-tts:ryan")).toEqual([
      { model: "qwen3-tts", path: custom, voice: "ryan" },
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ]);
    expect(() => t.library.sampleModels("qwen3-tts:nobody")).toThrow(
      "No such voice",
    );
  });

  test("read every language, or one, and the cloned voices still can", async () => {
    const t = setup();
    const custom = customVoice(t.root);
    let state = await t.library.assign("qwen3-tts:ryan", null);
    expect(state.assignments).toEqual({ all: "qwen3-tts:ryan", languages: {} });
    expect(t.readConfig().tts_models).toEqual([
      { model: "qwen3-tts", path: custom, voice: "ryan" },
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ]);
    // The Base model is no longer read with: kept, to record voices with.
    expect(t.readConfig().clone_model).toBe(t.base);
    expect(t.library.state().can_clone).toBe(true);
    // French in a cloned voice, the rest in Ryan's.
    state = await t.library.assign("papa-fr", "fr");
    expect(state.assignments).toEqual({
      all: "qwen3-tts:ryan",
      languages: { fr: "papa-fr" },
    });
    expect(t.readConfig().tts_models).toEqual([
      {
        model: "qwen3-tts",
        path: t.base,
        voice_embedding: join(t.elsewhere, "papa-fr.json"),
        languages: "fr",
      },
      { model: "qwen3-tts", path: custom, voice: "ryan" },
      { model: "kokoro", path: "/models/Kokoro-82M" },
    ]);
    // Back to a cloned voice for everything: the stock model stays known.
    await t.library.assign("papa", null);
    expect(t.readConfig().tts_models?.[0]).toEqual({
      model: "qwen3-tts",
      path: t.base,
      voice_embedding: join(t.elsewhere, "papa.json"),
    });
    expect(t.readConfig().stock_model).toBe(custom);
    expect(t.library.state().stock.length).toBe(3);
    expect(t.library.assign("qwen3-tts:nobody", null)).rejects.toThrow(
      "No such voice",
    );
  });

  test("named with speaker or voice in voice.json", () => {
    const t = setup([
      { model: "qwen3-tts", path: "/cv", speaker: "Vivian", languages: "zh" },
      { model: "qwen3-tts", path: "/cv", voice: "ryan" },
      { model: "kokoro", path: "/k" },
    ]);
    expect(t.library.state().assignments).toEqual({
      all: "qwen3-tts:ryan",
      languages: { zh: "qwen3-tts:vivian" },
    });
  });

  test("a stock_model that is not a CustomVoice model gives none", () => {
    const t = setup();
    customVoice(t.root);
    const raw = JSON.parse(readFileSync(join(t.root, "voice.json"), "utf8"));
    writeFileSync(
      join(t.root, "voice.json"),
      JSON.stringify({ ...raw, stock_model: t.base }),
    );
    expect(t.library.state().stock).toEqual([]);
  });
});
