import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entrySpeaker,
  isStockVoiceId,
  modelSpeakers,
  stockModel,
  stockVoiceId,
} from "./voice-stock";

function model(dir: string, name: string, config: object) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "config.json"), JSON.stringify(config));
  return path;
}

describe("stock voices", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-stock-"));
  const base = model(dir, "Qwen3-TTS-1.7B-Base", {
    tts_model_type: "base",
    talker_config: { spk_id: {} },
  });
  const custom = model(dir, "Qwen3-TTS-1.7B-CustomVoice", {
    tts_model_type: "custom_voice",
    talker_config: { spk_id: { sohee: 1, aiden: 2, Ryan: 3 } },
  });

  test("are the speakers of a CustomVoice model, in the model card's order", () => {
    expect(modelSpeakers(custom)).toEqual(["ryan", "aiden", "sohee"]);
    expect(modelSpeakers(base)).toEqual([]);
    expect(modelSpeakers(join(dir, "missing"))).toEqual([]);
  });

  test("the model is the one named, read with, or next to the Base", () => {
    const qwen = (path: string) => ({
      helper: "",
      tts_models: [{ model: "qwen3-tts", path }],
    });
    expect(stockModel({ helper: "", stock_model: custom })).toBe(custom);
    expect(stockModel({ helper: "", stock_model: base })).toBeNull();
    expect(stockModel(qwen(custom))).toBe(custom);
    expect(stockModel(qwen(base))).toBe(custom);
    expect(stockModel({ helper: "" })).toBeNull();
  });

  test("an entry names its speaker with voice or speaker, not with a clone", () => {
    expect(entrySpeaker({ model: "qwen3-tts", voice: "Ryan" })).toBe("ryan");
    expect(entrySpeaker({ model: "qwen3-tts", speaker: "vivian" })).toBe(
      "vivian",
    );
    expect(
      entrySpeaker({
        model: "qwen3-tts",
        voice: "ryan",
        voice_embedding: "me.json",
      }),
    ).toBeUndefined();
    expect(
      entrySpeaker({ model: "kokoro", voice: "af_heart" }),
    ).toBeUndefined();
    expect(stockVoiceId("Ono_Anna")).toBe("qwen3-tts:ono_anna");
    expect(isStockVoiceId("qwen3-tts:ryan")).toBe(true);
    expect(isStockVoiceId("ryan")).toBe(false);
  });
});
