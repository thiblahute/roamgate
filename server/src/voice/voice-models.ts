import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ChoiceRules,
  CUSTOM_MODEL,
  NO_MODEL,
  requirementHolds,
  settleChoices,
  type VoiceChoices,
  type VoiceComponent,
  type VoiceHardware,
  type VoiceTier,
} from "../../../shared/voiceSetup";
import { dataRoot } from "../config/data-paths";
import { GIB } from "./voice-hardware";
import { VOICE_MODELS } from "../assets";
import { MODEL_FILES, type ModelFile } from "./voice-model-files";
import type { VoiceConfig } from "./voice-helper";

/**
 * The models the voice helper loads (voice-helper.ts's VoiceConfig, the
 * helper's --*-model arguments), as the setup assistant offers them: the
 * packages downloaded (a file or a directory of files, voice-model-files.ts)
 * and, for each part of the helper, the options made of them and what each
 * writes to voice.json.
 */

export type ModelPackage = {
  id: string;
  name: string;
  /**
   * Its directory under the models directory; "" for a package of loose
   * files (a single model file), kept in the models directory itself.
   */
  dir: string;
  files: ModelFile[];
};

/**
 * Directory names as the desktop's models were laid out by hand. The
 * catalog is data (contract/assets/data/voice-models.json), shared with
 * the Rust server.
 */
export const PACKAGES: ModelPackage[] = VOICE_MODELS.packages.map(
  ({ id, name, dir }) => {
    const files = MODEL_FILES[id];
    if (!files) throw new Error(`no files for the voice model ${id}`);
    return { id, name, dir, files };
  },
);

export function packageById(id: string, packages = PACKAGES): ModelPackage {
  const found = packages.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown voice model package: ${id}`);
  return found;
}

export function packageBytes(entry: ModelPackage): number {
  return entry.files.reduce((sum, file) => sum + file.size, 0);
}

/** Where a package is, or goes: its directory, or the loose files' one. */
export type PackageRoots = Record<string, string>;

/** The voice.json keys the assistant writes; the others are never touched. */
export const SETUP_KEYS = [
  "whisper_model",
  "parakeet_model",
  "kokoro_model",
  "kokoro_voices",
  "tts_models",
  "clone_model",
  "stock_model",
  "speaker_model",
  "turn_model",
  "text_turn_model",
] as const;

export type ConfigPatch = Partial<Record<string, unknown>>;

export type ModelOption = {
  id: string;
  component: VoiceComponent;
  name: string;
  description: string;
  packages: string[];
  speed: string;
  runsOn: "gpu" | "cpu" | "any";
  gpuBytes?: number;
  /** Only with this choice of another part. */
  requires?: { component: VoiceComponent; options: string[] };
};

export type ComponentSpec = {
  id: VoiceComponent;
  title: string;
  description: string;
  optional: boolean;
  requires?: { component: VoiceComponent; options: string[] };
};

export const COMPONENTS = VOICE_MODELS.components as ComponentSpec[];

export const OPTIONS: ModelOption[] = VOICE_MODELS.options.map(
  ({ gpuGib, ...option }) =>
    ({
      ...option,
      ...(gpuGib === undefined ? {} : { gpuBytes: gpuGib * GIB }),
    }) as ModelOption,
);

export function optionsOf(component: VoiceComponent): ModelOption[] {
  return OPTIONS.filter((option) => option.component === component);
}

export function optionOf(
  component: VoiceComponent,
  id: string | undefined,
): ModelOption | undefined {
  return OPTIONS.find(
    (option) => option.component === component && option.id === id,
  );
}

/** The catalog as rules for settleChoices. */
const RULES: ChoiceRules = COMPONENTS.map((spec) => ({
  id: spec.id,
  optional: spec.optional,
  requires: spec.requires,
  options: OPTIONS.filter((option) => option.component === spec.id),
}));

/** Whether a part applies, given the others (reread needs Parakeet...). */
export function applies(
  component: VoiceComponent,
  choices: VoiceChoices,
): boolean {
  const spec = COMPONENTS.find((entry) => entry.id === component);
  return requirementHolds(spec?.requires, choices);
}

/**
 * The choices checked and made consistent (settleChoices): an unknown
 * option, or none for a part that needs one, throws; "customvoice" names
 * the stock voices of the reading voice's size.
 */
export function normalizeChoices(choices: VoiceChoices): VoiceChoices {
  const named: VoiceChoices = { ...choices };
  for (const spec of COMPONENTS) {
    const id = named[spec.id];
    if (id === undefined || id === CUSTOM_MODEL) continue;
    if (id === NO_MODEL) {
      if (!spec.optional) throw new Error(`${spec.title} needs a model`);
      continue;
    }
    if (spec.id === "stock_voices" && id === "customvoice") {
      named[spec.id] = optionsOf("stock_voices")[0]?.id;
      continue;
    }
    if (!optionOf(spec.id, id))
      throw new Error(`no ${spec.title.toLowerCase()} model named ${id}`);
  }
  return settleChoices(RULES, named);
}

/** Every package the choices need. */
export function packagesFor(choices: VoiceChoices): string[] {
  const ids = new Set<string>();
  const normalized = normalizeChoices(choices);
  for (const spec of COMPONENTS)
    for (const id of optionOf(spec.id, normalized[spec.id])?.packages ?? [])
      ids.add(id);
  return [...ids];
}

/** GPU memory the heavy tier's 1.7B reading voice wants (an 8 GB card). */
const BIG_TTS_GPU = 7.5 * GIB;
/** Below this, nothing goes on the GPU. */
const HEAVY_GPU = 5.5 * GIB;

export function tierFor(hardware: VoiceHardware): VoiceTier {
  return hardware.acceleration !== "cpu" && hardware.gpuBytes >= HEAVY_GPU
    ? "heavy"
    : "light";
}

/**
 * Each tier's choices on this hardware: heavy as the desktop runs (Parakeet,
 * Whisper reading again, Qwen3-TTS on the GPU, every turn and speaker
 * model), light all on the CPU (Pocket TTS, Kokoro's int8 ONNX model short
 * of memory).
 */
export function recommendedChoices(
  hardware: VoiceHardware,
): Record<VoiceTier, VoiceChoices> {
  const ram = hardware.ramBytes;
  return {
    heavy: {
      speech: "parakeet",
      reread: "whisper-large-v3-turbo",
      tts:
        hardware.gpuBytes >= BIG_TTS_GPU ? "qwen3-tts-1.7b" : "qwen3-tts-0.6b",
      stock_voices: NO_MODEL,
      speaker: "wespeaker",
      turn: "smart-turn",
      text_turn: "qwen3-0.6b",
    },
    light: {
      speech: "parakeet",
      reread: NO_MODEL,
      tts: ram < 8 * GIB ? "kokoro-onnx-int8" : "pocket-tts",
      stock_voices: NO_MODEL,
      speaker: "wespeaker",
      turn: "smart-turn",
      text_turn: ram >= 12 * GIB ? "qwen3-0.6b" : NO_MODEL,
    },
  };
}

/**
 * Where the voice's files live: ~/.local/share/roamgate/voice (the helper
 * as installed and models/), %APPDATA%\roamgate\voice on Windows as
 * voice-library.ts keeps the voices.
 */
export function voiceDataDir(
  home = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return platform === "win32"
    ? join(dataRoot(home, platform, appDataDir), "voice")
    : join(home, ".local", "share", "roamgate", "voice");
}

export function defaultModelsDir(
  home = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return join(voiceDataDir(home, platform, appDataDir), "models");
}

export function defaultHelperPath(
  home = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return join(
    voiceDataDir(home, platform, appDataDir),
    platform === "win32" ? "roamgate-voice.exe" : "roamgate-voice",
  );
}

/** The path of a package's main thing, as voice.json names it. */
export function packagePath(
  roots: PackageRoots,
  id: string,
  packages = PACKAGES,
): string {
  const entry = packageById(id, packages);
  const root = roots[id];
  if (root === undefined) throw new Error(`${entry.name} is not installed`);
  return entry.dir ? root : join(root, entry.files[0]?.path ?? "");
}

type TtsModel = NonNullable<VoiceConfig["tts_models"]>[number];

/**
 * Pocket TTS's languages in the catalog: the package, the language's model
 * directory in it, and the voice it reads with unless voice.json names
 * another (as recommended, pending the user's word: estelle for French,
 * Kyutai's default English voice alba for English).
 */
export const POCKET_VOICES = [
  {
    language: "fr",
    package: "pocket-tts-fr",
    dir: "languages/french",
    voice: "estelle",
  },
  {
    language: "en",
    package: "pocket-tts-en",
    dir: "languages/english",
    voice: "alba",
  },
] as const;

/** The model of Pocket TTS's entries in `tts_models`. */
export const POCKET_MODEL = "pocket-tts";

/** The directory of a Pocket TTS language's model, its package at `root`. */
export function pocketModelDir(
  root: string,
  voice: (typeof POCKET_VOICES)[number],
): string {
  return join(root, voice.dir);
}

/**
 * voice.json's setup keys for the choices: the packages at `roots`, the
 * entries the user made kept where they still apply (a Qwen3-TTS entry
 * reading a recorded voice, a Kokoro entry's own fields). A part chosen
 * CUSTOM_MODEL keeps its keys; undefined in the patch removes a key.
 */
export function configPatch(
  choices: VoiceChoices,
  roots: PackageRoots,
  config: Partial<VoiceConfig>,
  packages = PACKAGES,
): ConfigPatch {
  const chosen = normalizeChoices(choices);
  const patch: ConfigPatch = {};
  const packagePathOf = (id: string) => packagePath(roots, id, packages);
  const speech = chosen.speech;
  if (speech === "parakeet") {
    patch.parakeet_model = packagePathOf("parakeet-tdt-0.6b-v3");
    const reread = optionOf("reread", chosen.reread);
    if (reread) patch.whisper_model = packagePathOf(reread.packages[0]!);
    else if (chosen.reread === NO_MODEL) patch.whisper_model = undefined;
  } else {
    const whisper = optionOf("speech", speech);
    if (whisper) {
      patch.parakeet_model = undefined;
      patch.whisper_model = packagePathOf(whisper.packages[0]!);
    }
  }

  const tts = optionOf("tts", chosen.tts);
  const previous = config.tts_models ?? [];
  // Pocket TTS's entries for its packages among `ids`, a language each,
  // with the fields voice.json gave them (a voice chosen) kept.
  const pocketEntries = (ids: string[]): TtsModel[] =>
    POCKET_VOICES.filter((voice) => ids.includes(voice.package)).map(
      (voice) => ({
        voice: voice.voice,
        ...(previous.find(
          (model) =>
            model.model === POCKET_MODEL && model.languages === voice.language,
        ) ?? {}),
        model: POCKET_MODEL,
        path: pocketModelDir(packagePathOf(voice.package), voice),
        languages: voice.language,
      }),
    );
  if (tts?.id === "pocket-tts") {
    // Kokoro's ONNX model, when it is here, reads the languages Pocket TTS
    // lacks (its entry, read by the helper's ONNX speaker).
    const onnx = ["kokoro-onnx", "kokoro-onnx-int8"].find(
      (id) => roots[id] !== undefined,
    );
    const kokoro: TtsModel[] = [];
    if (onnx && roots["kokoro-onnx-voices"] !== undefined) {
      patch.kokoro_model = packagePathOf(onnx);
      patch.kokoro_voices = packagePathOf("kokoro-onnx-voices");
      kokoro.push({ model: "kokoro", path: packagePathOf(onnx) });
    }
    patch.tts_models = [...pocketEntries(tts.packages), ...kokoro];
    patch.clone_model = undefined;
    patch.stock_model = undefined;
  } else if (tts?.id === "kokoro-onnx" || tts?.id === "kokoro-onnx-int8") {
    patch.kokoro_model = packagePathOf(tts.packages[0]!);
    patch.kokoro_voices = packagePathOf("kokoro-onnx-voices");
    patch.tts_models = undefined;
    patch.clone_model = undefined;
    patch.stock_model = undefined;
  } else if (tts) {
    const base = tts.packages.find((id) => id.includes("-base"));
    const basePath = base ? packagePathOf(base) : undefined;
    const stock = optionOf("stock_voices", chosen.stock_voices)?.packages[0];
    const stockPath = stock
      ? packagePathOf(stock)
      : chosen.stock_voices === CUSTOM_MODEL
        ? config.stock_model
        : undefined;
    // Qwen3-TTS entries reading a recorded voice (Base) or a stock one
    // (CustomVoice) stay while their model is the one chosen.
    const qwen = previous.filter(
      (model) =>
        model.model === "qwen3-tts" &&
        typeof model.path === "string" &&
        (model.path === basePath || model.path === stockPath),
    );
    const kokoro: TtsModel = {
      ...(previous.find((model) => model.model === "kokoro") ?? {}),
      model: "kokoro",
      path: packagePathOf("kokoro-82m"),
    };
    // kokoro_model and kokoro_voices, unused beside tts_models, stay: a
    // switch back to Kokoro's ONNX model finds them. Pocket TTS's entries
    // come last: the light voice, read when Qwen3-TTS fails.
    patch.tts_models = [...qwen, kokoro, ...pocketEntries(tts.packages)];
    patch.clone_model = basePath;
    if (
      chosen.stock_voices !== undefined &&
      chosen.stock_voices !== CUSTOM_MODEL
    )
      patch.stock_model = stockPath;
  }

  const single = (
    component: VoiceComponent,
    key: "speaker_model" | "turn_model" | "text_turn_model",
  ) => {
    const option = optionOf(component, chosen[component]);
    if (option) patch[key] = packagePathOf(option.packages[0]!);
    else if (chosen[component] === NO_MODEL) patch[key] = undefined;
  };
  single("speaker", "speaker_model");
  single("turn", "turn_model");
  single("text_turn", "text_turn_model");
  return patch;
}
