import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { VoiceConfig } from "./voice-helper";

/**
 * Qwen3-TTS's stock speakers: the named voices a CustomVoice model comes
 * with (Ryan, Vivian, ...), read with its `voice` field instead of a cloned
 * `voice_embedding`, which needs the Base model. Every speaker speaks all
 * of Qwen3-TTS's languages; each sounds most natural in its own.
 *
 * A stock voice's id is `qwen3-tts:<speaker>`, which no recorded voice's
 * id (a slug, voiceSlug) can be.
 */

export const STOCK_PREFIX = "qwen3-tts:";

export type StockVoice = {
  id: string;
  /** The model's name for it, as the helper takes it. */
  speaker: string;
  name: string;
  /** The language it sounds most natural in (ISO 639-1). */
  native: string;
  description: string;
};

/**
 * What Qwen's model card says of the speakers it ships, in its order;
 * those a model adds later are listed after them, by name.
 */
const KNOWN: Record<string, Omit<StockVoice, "id" | "speaker">> = {
  ryan: {
    name: "Ryan",
    native: "en",
    description: "Lively man, strong rhythm",
  },
  aiden: {
    name: "Aiden",
    native: "en",
    description: "Sunny American man, clear midrange",
  },
  vivian: {
    name: "Vivian",
    native: "zh",
    description: "Bright young woman, a little edgy",
  },
  serena: {
    name: "Serena",
    native: "zh",
    description: "Warm, gentle young woman",
  },
  uncle_fu: {
    name: "Uncle Fu",
    native: "zh",
    description: "Seasoned man, low and mellow",
  },
  dylan: {
    name: "Dylan",
    native: "zh",
    description: "Young Beijing man, clear and natural",
  },
  eric: {
    name: "Eric",
    native: "zh",
    description: "Lively Chengdu man, a little husky",
  },
  ono_anna: {
    name: "Ono Anna",
    native: "ja",
    description: "Playful young woman, light and nimble",
  },
  sohee: {
    name: "Sohee",
    native: "ko",
    description: "Warm woman, full of feeling",
  },
};

export function isStockVoiceId(id: string): boolean {
  return id.startsWith(STOCK_PREFIX);
}

export function stockVoiceId(speaker: string): string {
  return `${STOCK_PREFIX}${speaker.toLowerCase()}`;
}

function readModelConfig(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(path, "config.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The stock speakers of the model directory `path`; none when not one. */
export function modelSpeakers(path: string): string[] {
  const config = readModelConfig(path);
  if (!config || config.tts_model_type === "base") return [];
  const talker = config.talker_config as Record<string, unknown> | undefined;
  const ids = talker?.spk_id;
  if (!ids || typeof ids !== "object") return [];
  const order = Object.keys(KNOWN);
  const rank = (name: string) =>
    order.includes(name) ? order.indexOf(name) : order.length;
  return Object.keys(ids)
    .map((name) => name.toLowerCase())
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Whether `path` is a Qwen3-TTS model with stock speakers (CustomVoice). */
export function isStockModel(path: string): boolean {
  return modelSpeakers(path).length > 0;
}

/**
 * The CustomVoice model stock voices read with: `stock_model`, else the
 * first Qwen3-TTS model of `tts_models` that is one, else one next to them
 * (Qwen3-TTS-1.7B-CustomVoice beside Qwen3-TTS-1.7B-Base).
 */
export function stockModel(config: VoiceConfig): string | null {
  if (config.stock_model)
    return isStockModel(config.stock_model) ? config.stock_model : null;
  const qwen = [
    ...(config.tts_models ?? [])
      .filter((model) => model.model === "qwen3-tts")
      .map((model) => model.path),
    config.clone_model,
  ].filter((path): path is string => typeof path === "string" && !!path);
  for (const path of qwen) if (isStockModel(path)) return path;
  for (const parent of new Set(qwen.map((path) => dirname(resolve(path))))) {
    let names: string[];
    try {
      names = readdirSync(parent).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(parent, name);
      if (/customvoice/i.test(name) && existsSync(join(path, "config.json")))
        if (isStockModel(path)) return path;
    }
  }
  return null;
}

/** The stock voices of the model at `path`. */
export function stockVoices(path: string | null): StockVoice[] {
  if (!path) return [];
  return modelSpeakers(path).map((speaker) => {
    const known = KNOWN[speaker];
    return {
      id: stockVoiceId(speaker),
      speaker,
      name:
        known?.name ??
        speaker
          .split("_")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" "),
      native: known?.native ?? "",
      description: known?.description ?? "",
    };
  });
}

/** The stock speaker a Qwen3-TTS entry of `tts_models` names, if any. */
export function entrySpeaker(
  model: NonNullable<VoiceConfig["tts_models"]>[number],
): string | undefined {
  if (model.model !== "qwen3-tts" || typeof model.voice_embedding === "string")
    return undefined;
  const speaker = model.voice ?? model.speaker;
  return typeof speaker === "string" && speaker
    ? speaker.toLowerCase()
    : undefined;
}
