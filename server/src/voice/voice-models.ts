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

const pkg = (id: string, name: string, dir: string): ModelPackage => {
  const files = MODEL_FILES[id];
  if (!files) throw new Error(`no files for the voice model ${id}`);
  return { id, name, dir, files };
};

/** Directory names as the desktop's models were laid out by hand. */
export const PACKAGES: ModelPackage[] = [
  pkg(
    "parakeet-tdt-0.6b-v3",
    "Parakeet TDT 0.6B v3 (int8)",
    "parakeet-tdt-0.6b-v3",
  ),
  pkg("whisper-large-v3-turbo-q5", "Whisper large-v3-turbo (q5_0)", ""),
  pkg("whisper-small-q5", "Whisper small (q5_1)", ""),
  pkg("whisper-base-q5", "Whisper base (q5_1)", ""),
  pkg("kokoro-onnx", "Kokoro v1.0 ONNX", ""),
  pkg("kokoro-onnx-int8", "Kokoro v1.0 ONNX (int8)", ""),
  pkg("kokoro-onnx-voices", "Kokoro v1.0 voices", ""),
  pkg("kokoro-82m", "Kokoro-82M", "Kokoro-82M"),
  pkg("qwen3-tts-1.7b-base", "Qwen3-TTS 1.7B Base", "Qwen3-TTS-1.7B-Base"),
  pkg("qwen3-tts-0.6b-base", "Qwen3-TTS 0.6B Base", "Qwen3-TTS-0.6B-Base"),
  pkg(
    "qwen3-tts-1.7b-customvoice",
    "Qwen3-TTS 1.7B CustomVoice",
    "Qwen3-TTS-1.7B-CustomVoice",
  ),
  pkg(
    "qwen3-tts-0.6b-customvoice",
    "Qwen3-TTS 0.6B CustomVoice",
    "Qwen3-TTS-0.6B-CustomVoice",
  ),
  pkg("wespeaker-resnet34", "WeSpeaker ResNet34", ""),
  pkg("smart-turn-v3.2", "Smart Turn v3.2 (CPU)", ""),
  pkg("qwen3-0.6b-onnx", "Qwen3 0.6B ONNX (int8)", "qwen3-0.6b"),
];

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

export const COMPONENTS: ComponentSpec[] = [
  {
    id: "speech",
    title: "Speech recognition",
    description: "Turns what is said into text.",
    optional: false,
  },
  {
    id: "reread",
    title: "Second reading",
    description:
      "Whisper hears again what Parakeet wrote in English while the conversation is in another language.",
    optional: true,
    requires: { component: "speech", options: ["parakeet"] },
  },
  {
    id: "tts",
    title: "Reading voice",
    description:
      "Reads the replies aloud. Qwen3-TTS reads with voices recorded in Voices below, Kokoro with its own.",
    optional: false,
  },
  {
    id: "stock_voices",
    title: "Stock voices",
    description:
      "Qwen3-TTS CustomVoice: named voices (Ryan, Vivian...) to choose in Voices below.",
    optional: true,
    requires: {
      component: "tts",
      options: ["qwen3-tts-1.7b", "qwen3-tts-0.6b"],
    },
  },
  {
    id: "speaker",
    title: "Who speaks",
    description:
      "Tells voices apart, so the companion knows you from the people around you.",
    optional: true,
  },
  {
    id: "turn",
    title: "End of turn (voice)",
    description:
      "A pause ends what you say only when your voice sounds finished.",
    optional: true,
  },
  {
    id: "text_turn",
    title: "End of turn (words)",
    description:
      "Reads what was said at each pause: unfinished words keep the turn open.",
    optional: true,
    requires: { component: "speech", options: ["parakeet"] },
  },
];

export const OPTIONS: ModelOption[] = [
  {
    id: "parakeet",
    component: "speech",
    name: "Parakeet TDT 0.6B v3",
    description: "25 European languages, written as spoken. Runs on the CPU.",
    packages: ["parakeet-tdt-0.6b-v3"],
    speed: "about 0.1 s for a few seconds of speech, on a CPU",
    runsOn: "cpu",
  },
  {
    id: "whisper-large-v3-turbo",
    component: "speech",
    name: "Whisper large-v3-turbo",
    description: "About 100 languages, the most accurate Whisper here.",
    packages: ["whisper-large-v3-turbo-q5"],
    speed: "about 0.3 s an utterance on a GPU, several seconds on a CPU",
    runsOn: "gpu",
    gpuBytes: 1.1 * GIB,
  },
  {
    id: "whisper-small",
    component: "speech",
    name: "Whisper small",
    description: "About 100 languages, less accurate, light enough for a CPU.",
    packages: ["whisper-small-q5"],
    speed: "about 1 s an utterance on a CPU",
    runsOn: "any",
    gpuBytes: 0.5 * GIB,
  },
  {
    id: "whisper-base",
    component: "speech",
    name: "Whisper base",
    description: "The smallest Whisper offered: for slow machines.",
    packages: ["whisper-base-q5"],
    speed: "under 0.5 s an utterance on a CPU",
    runsOn: "any",
  },
  {
    id: "whisper-large-v3-turbo",
    component: "reread",
    name: "Whisper large-v3-turbo",
    description: "Loaded beside Parakeet once something was heard.",
    packages: ["whisper-large-v3-turbo-q5"],
    speed: "about 1 s more, only for what it reads again",
    runsOn: "gpu",
    gpuBytes: 1.1 * GIB,
  },
  {
    id: "whisper-small",
    component: "reread",
    name: "Whisper small",
    description: "A lighter second reading, for the CPU.",
    packages: ["whisper-small-q5"],
    speed: "about 1 s more on a CPU, only for what it reads again",
    runsOn: "any",
  },
  {
    id: "qwen3-tts-1.7b",
    component: "tts",
    name: "Qwen3-TTS 1.7B",
    description:
      "Natural voices, and your own voice once recorded; Kokoro-82M reads the languages it lacks.",
    packages: ["qwen3-tts-1.7b-base", "kokoro-82m"],
    speed: "first audio in about 0.3 s, faster than real time on an 8 GB GPU",
    runsOn: "gpu",
    gpuBytes: 6 * GIB,
  },
  {
    id: "qwen3-tts-0.6b",
    component: "tts",
    name: "Qwen3-TTS 0.6B",
    description:
      "The smaller Qwen3-TTS: recorded voices on a GPU with less memory; Kokoro-82M beside it.",
    packages: ["qwen3-tts-0.6b-base", "kokoro-82m"],
    speed: "first audio in about 0.3 s, faster than real time on a 4 GB GPU",
    runsOn: "gpu",
    gpuBytes: 3.5 * GIB,
  },
  {
    id: "kokoro-82m",
    component: "tts",
    name: "Kokoro-82M (any-tts)",
    description: "Kokoro's voices on the GPU, through any-tts.",
    packages: ["kokoro-82m"],
    speed: "much faster than real time on a GPU",
    runsOn: "gpu",
    gpuBytes: 1 * GIB,
  },
  {
    id: "kokoro-onnx",
    component: "tts",
    name: "Kokoro v1.0 (ONNX)",
    description: "Kokoro's voices on the CPU.",
    packages: ["kokoro-onnx", "kokoro-onnx-voices"],
    speed: "faster than real time on a recent CPU",
    runsOn: "cpu",
  },
  {
    id: "kokoro-onnx-int8",
    component: "tts",
    name: "Kokoro v1.0 (ONNX, int8)",
    description: "The smallest Kokoro, for machines short of memory.",
    packages: ["kokoro-onnx-int8", "kokoro-onnx-voices"],
    speed: "faster than real time on most CPUs, slightly rougher",
    runsOn: "cpu",
  },
  {
    id: "customvoice-1.7b",
    component: "stock_voices",
    name: "Qwen3-TTS 1.7B CustomVoice",
    description: "Nine named voices for Qwen3-TTS 1.7B.",
    packages: ["qwen3-tts-1.7b-customvoice"],
    speed: "as the reading voice",
    runsOn: "gpu",
    gpuBytes: 6 * GIB,
    requires: { component: "tts", options: ["qwen3-tts-1.7b"] },
  },
  {
    id: "customvoice-0.6b",
    component: "stock_voices",
    name: "Qwen3-TTS 0.6B CustomVoice",
    description: "Nine named voices for Qwen3-TTS 0.6B.",
    packages: ["qwen3-tts-0.6b-customvoice"],
    speed: "as the reading voice",
    runsOn: "gpu",
    gpuBytes: 3.5 * GIB,
    requires: { component: "tts", options: ["qwen3-tts-0.6b"] },
  },
  {
    id: "wespeaker",
    component: "speaker",
    name: "WeSpeaker ResNet34",
    description: "Voice prints, kept on this machine.",
    packages: ["wespeaker-resnet34"],
    speed: "a few ms a stretch of speech, on a CPU",
    runsOn: "cpu",
  },
  {
    id: "smart-turn",
    component: "turn",
    name: "Smart Turn v3.2",
    description: "Pipecat's turn model, for the CPU.",
    packages: ["smart-turn-v3.2"],
    speed: "about 10 ms a pause, on a CPU",
    runsOn: "cpu",
  },
  {
    id: "qwen3-0.6b",
    component: "text_turn",
    name: "Qwen3 0.6B (int8)",
    description: "A small language model reading the words at each pause.",
    packages: ["qwen3-0.6b-onnx"],
    speed: "about 0.1 to 0.3 s a pause, on a CPU",
    runsOn: "cpu",
  },
];

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
 * model), light all on the CPU (Kokoro's ONNX model, int8 short of memory).
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
      tts: ram < 8 * GIB ? "kokoro-onnx-int8" : "kokoro-onnx",
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
  if (tts?.id === "kokoro-onnx" || tts?.id === "kokoro-onnx-int8") {
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
    const previous = config.tts_models ?? [];
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
    // switch back to Kokoro's ONNX model finds them.
    patch.tts_models = [...qwen, kokoro];
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
