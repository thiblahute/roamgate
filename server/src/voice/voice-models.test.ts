import { describe, expect, test } from "bun:test";
import { CUSTOM_MODEL, NO_MODEL } from "../../../shared/voiceSetup";
import {
  configPatch,
  defaultHelperPath,
  defaultModelsDir,
  normalizeChoices,
  OPTIONS,
  PACKAGES,
  packageBytes,
  packagesFor,
  recommendedChoices,
  tierFor,
} from "./voice-models";
import { CPU_LAPTOP, GIB, NVIDIA_DESKTOP } from "./voice-setup-testing";

/** Pocket TTS's entries, its packages at `roots`. */
const POCKET = [
  {
    model: "pocket-tts",
    path: "/models/pocket-tts-fr/languages/french",
    languages: "fr",
    voice: "estelle",
  },
  {
    model: "pocket-tts",
    path: "/models/pocket-tts-en/languages/english",
    languages: "en",
    voice: "alba",
  },
];

const roots = Object.fromEntries(
  PACKAGES.map((entry) => [
    entry.id,
    entry.dir ? `/models/${entry.dir}` : "/models",
  ]),
);

describe("catalog", () => {
  test("every option's packages exist, with pinned files and checksums", () => {
    const ids = new Set(PACKAGES.map((entry) => entry.id));
    for (const option of OPTIONS)
      for (const id of option.packages) expect(ids.has(id)).toBe(true);
    for (const entry of PACKAGES)
      for (const file of entry.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.url).toMatch(/^https:\/\/(huggingface\.co|github\.com)\//);
        expect(file.size).toBeGreaterThan(0);
      }
  });

  test("the heavy desktop set is about the size the desktop holds", () => {
    const heavy = recommendedChoices(NVIDIA_DESKTOP).heavy;
    const bytes = packagesFor(heavy)
      .map((id) => PACKAGES.find((entry) => entry.id === id)!)
      .reduce((sum, entry) => sum + packageBytes(entry), 0);
    expect(bytes / GIB).toBeGreaterThan(6);
    expect(bytes / GIB).toBeLessThan(8);
  });

  test("the models directory, Windows under %APPDATA%", () => {
    expect(defaultModelsDir("/home/u", "linux")).toBe(
      "/home/u/.local/share/roamgate/voice/models",
    );
    expect(defaultHelperPath("/home/u", "darwin")).toBe(
      "/home/u/.local/share/roamgate/voice/roamgate-voice",
    );
    expect(
      defaultHelperPath(
        "C:\\Users\\u",
        "win32",
        "C:\\Users\\u\\AppData\\Roaming",
      ),
    ).toContain("roamgate-voice.exe");
  });
});

describe("tiers", () => {
  test("an 8 GB NVIDIA card is heavy with Qwen3-TTS 1.7B", () => {
    expect(tierFor(NVIDIA_DESKTOP)).toBe("heavy");
    expect(recommendedChoices(NVIDIA_DESKTOP).heavy.tts).toBe("qwen3-tts-1.7b");
  });

  test("a 6 GB card is heavy with the 0.6B model", () => {
    const hardware = { ...NVIDIA_DESKTOP, gpuBytes: 6 * GIB };
    expect(tierFor(hardware)).toBe("heavy");
    expect(recommendedChoices(hardware).heavy.tts).toBe("qwen3-tts-0.6b");
  });

  test("a 4 GB card, or no usable GPU, is light", () => {
    expect(tierFor({ ...NVIDIA_DESKTOP, gpuBytes: 4 * GIB })).toBe("light");
    expect(tierFor(CPU_LAPTOP)).toBe("light");
    expect(
      tierFor({ ...CPU_LAPTOP, gpus: NVIDIA_DESKTOP.gpus, gpuBytes: 8 * GIB }),
    ).toBe("light");
  });

  test("light is all CPU, int8 Kokoro and no text turn model short of memory", () => {
    const light = recommendedChoices(CPU_LAPTOP).light;
    expect(light).toMatchObject({
      speech: "parakeet",
      reread: NO_MODEL,
      tts: "pocket-tts",
      text_turn: "qwen3-0.6b",
    });
    const small = recommendedChoices({
      ...CPU_LAPTOP,
      ramBytes: 6 * GIB,
    }).light;
    expect(small.tts).toBe("kokoro-onnx-int8");
    expect(small.text_turn).toBe(NO_MODEL);
    for (const id of packagesFor(light))
      for (const option of OPTIONS.filter((entry) =>
        entry.packages.includes(id),
      ))
        if (option.id === light[option.component])
          expect(option.runsOn).not.toBe("gpu");
  });
});

describe("normalizeChoices", () => {
  test("Whisper alone has no second reading nor text turn model", () => {
    expect(
      normalizeChoices({
        speech: "whisper-small",
        reread: "whisper-large-v3-turbo",
        text_turn: "qwen3-0.6b",
      }),
    ).toEqual({
      speech: "whisper-small",
      reread: NO_MODEL,
      text_turn: NO_MODEL,
    });
  });

  test("stock voices follow the reading voice's size, none without Qwen3-TTS", () => {
    expect(
      normalizeChoices({ tts: "qwen3-tts-0.6b", stock_voices: "customvoice" })
        .stock_voices,
    ).toBe("customvoice-0.6b");
    expect(
      normalizeChoices({
        tts: "qwen3-tts-1.7b",
        stock_voices: "customvoice-0.6b",
      }).stock_voices,
    ).toBe("customvoice-1.7b");
    expect(
      normalizeChoices({ tts: "kokoro-onnx", stock_voices: "customvoice" })
        .stock_voices,
    ).toBe(NO_MODEL);
  });

  test("a part voice.json has its own way keeps what depends on it", () => {
    expect(
      normalizeChoices({ speech: CUSTOM_MODEL, text_turn: "qwen3-0.6b" }),
    ).toEqual({ speech: CUSTOM_MODEL, text_turn: "qwen3-0.6b" });
  });

  test("unknown models and a required part left out are refused", () => {
    expect(() => normalizeChoices({ speech: "whisper-huge" })).toThrow(
      "no speech recognition model named whisper-huge",
    );
    expect(() => normalizeChoices({ tts: NO_MODEL })).toThrow(
      "Reading voice needs a model",
    );
  });
});

describe("configPatch", () => {
  test("heavy: Parakeet with Whisper, Qwen3-TTS with Kokoro beside it", () => {
    const patch = configPatch(
      recommendedChoices(NVIDIA_DESKTOP).heavy,
      roots,
      {},
    );
    expect(patch).toEqual({
      parakeet_model: "/models/parakeet-tdt-0.6b-v3",
      whisper_model: "/models/ggml-large-v3-turbo-q5_0.bin",
      tts_models: [{ model: "kokoro", path: "/models/Kokoro-82M" }, ...POCKET],
      clone_model: "/models/Qwen3-TTS-1.7B-Base",
      stock_model: undefined,
      speaker_model: "/models/wespeaker_en_voxceleb_resnet34.onnx",
      turn_model: "/models/smart-turn-v3.2-cpu.onnx",
      text_turn_model: "/models/qwen3-0.6b",
    });
  });

  test("light: Pocket TTS in place of any-tts, Kokoro's ONNX model beside it", () => {
    const old = {
      tts_models: [{ model: "kokoro", path: "/old" }],
      clone_model: "/old/base",
      whisper_model: "/old/whisper.bin",
    };
    const patch = configPatch(recommendedChoices(CPU_LAPTOP).light, roots, old);
    expect(patch).toMatchObject({
      parakeet_model: "/models/parakeet-tdt-0.6b-v3",
      kokoro_model: "/models/kokoro-v1.0.onnx",
      kokoro_voices: "/models/voices-v1.0.bin",
      tts_models: [
        ...POCKET,
        { model: "kokoro", path: "/models/kokoro-v1.0.onnx" },
      ],
    });
    for (const key of ["clone_model", "stock_model", "whisper_model"]) {
      expect(key in patch).toBe(true);
      expect(patch[key]).toBeUndefined();
    }
    // Without Kokoro's ONNX model, Pocket TTS alone, voice.json's Kokoro
    // keys left as they are.
    const noOnnx = Object.fromEntries(
      Object.entries(roots).filter(([id]) => !id.startsWith("kokoro-onnx")),
    );
    const alone = configPatch(recommendedChoices(CPU_LAPTOP).light, noOnnx, {
      ...old,
      kokoro_model: "/elsewhere/kokoro.onnx",
    });
    expect(alone.tts_models).toEqual(POCKET);
    expect("kokoro_model" in alone).toBe(false);
  });

  test("light, as before: Kokoro's ONNX model in place of any-tts", () => {
    const patch = configPatch(
      { ...recommendedChoices(CPU_LAPTOP).light, tts: "kokoro-onnx" },
      roots,
      {
        tts_models: [{ model: "kokoro", path: "/old" }],
        clone_model: "/old/base",
        whisper_model: "/old/whisper.bin",
      },
    );
    expect(patch).toMatchObject({
      parakeet_model: "/models/parakeet-tdt-0.6b-v3",
      kokoro_model: "/models/kokoro-v1.0.onnx",
      kokoro_voices: "/models/voices-v1.0.bin",
    });
    for (const key of [
      "tts_models",
      "clone_model",
      "stock_model",
      "whisper_model",
    ]) {
      expect(key in patch).toBe(true);
      expect(patch[key]).toBeUndefined();
    }
  });

  test("a recorded voice and Kokoro's own fields stay", () => {
    const base = "/models/Qwen3-TTS-1.7B-Base";
    const patch = configPatch(
      { tts: "qwen3-tts-1.7b", stock_voices: "customvoice" },
      roots,
      {
        tts_models: [
          {
            model: "qwen3-tts",
            path: base,
            voice_embedding: "/voices/me.json",
          },
          { model: "qwen3-tts", path: "/elsewhere/Qwen3-TTS-0.6B-Base" },
          { model: "kokoro", path: "/old/Kokoro-82M", voice: "ff_siwis" },
          {
            model: "pocket-tts",
            path: "/old/pocket/fr",
            languages: "fr",
            voice: "lola",
          },
        ],
      },
    );
    expect(patch.tts_models).toEqual([
      { model: "qwen3-tts", path: base, voice_embedding: "/voices/me.json" },
      { model: "kokoro", path: "/models/Kokoro-82M", voice: "ff_siwis" },
      { ...POCKET[0], voice: "lola" },
      POCKET[1],
    ]);
    expect(patch.stock_model).toBe("/models/Qwen3-TTS-1.7B-CustomVoice");
  });

  test("custom parts and unset ones are not touched", () => {
    expect(
      configPatch(
        { speech: CUSTOM_MODEL, tts: CUSTOM_MODEL, speaker: NO_MODEL },
        roots,
        {},
      ),
    ).toEqual({ speaker_model: undefined });
  });
});
