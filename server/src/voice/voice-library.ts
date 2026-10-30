import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  chooseTranscript,
  cleanVoiceName,
  isVoiceLanguage,
  uniqueVoiceId,
  type VoiceLanguage,
  voiceSlug,
} from "../../../shared/voiceLibrary";
import { dataRoot } from "../config/data-paths";
import {
  readVoiceConfig,
  type VoiceConfig,
  voiceConfigPath,
} from "./voice-helper";

/**
 * The voices replies can be read with, and which reads what.
 *
 * A voice is an any-tts voice embedding (JSON) for Qwen3-TTS: those
 * recorded from the page live in the voices directory (`voices_dir` in
 * voice.json, ~/.local/share/roamgate/voices by default) as `<id>.json`,
 * with their recording as `<id>.wav`; `voices.json` there lists every voice
 * with its name and languages, those made elsewhere included (the
 * `voice_embedding` files voice.json reads with are added the first time
 * they are seen, so they stay listed once no longer used).
 *
 * Which voice reads which language is voice.json's `tts_models`, the order
 * the helper picks from: a Qwen3-TTS entry per language with a voice of its
 * own (`languages`), then one for every other language, then the other
 * models (Kokoro) as they were, reading whatever no voice does.
 */

export type VoiceInfo = {
  id: string;
  name: string;
  /** What it was recorded speaking. */
  languages: string[];
  /** The voice embedding. */
  path: string;
  /** Its recording, for voices recorded here. */
  reference?: string;
  /** Recorded here: renaming and deleting it touch its files. */
  owned: boolean;
  created?: string;
};

/** Which voice reads what: a voice id, or "kokoro" for Kokoro's voices. */
export type VoiceAssignments = {
  /** Every language without a voice of its own; null when none is set. */
  all: string | null;
  languages: Partial<Record<VoiceLanguage, string>>;
};

export const KOKORO = "kokoro";
const QWEN = "qwen3-tts";

type TtsModel = NonNullable<VoiceConfig["tts_models"]>[number];

/** What a voice says when cloned (clone_voice). */
export type ClonedVoice = {
  embedding: number[];
  codes: number[][];
  heard: string;
  seconds: number;
};

export type VoiceCloneRequest = {
  /** The recording. */
  audio: string;
  /** The Qwen3-TTS Base model directory. */
  model: string;
  /** Where to keep the recording, as cut. */
  reference: string;
  language: string;
};

export function defaultVoicesDir(
  home = homedir(),
  platform: string = process.platform,
): string {
  return platform === "win32"
    ? join(dataRoot(home, platform), "voices")
    : join(home, ".local", "share", "roamgate", "voices");
}

export function voicesDir(config: VoiceConfig): string {
  return config.voices_dir ?? defaultVoicesDir();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Written whole then moved into place: a reader never sees half of it. */
function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Whether the model directory `path` is a Qwen3-TTS Base, which clones. */
export function isCloningModel(path: string): boolean {
  try {
    const config = readJson(join(path, "config.json")) as Record<
      string,
      unknown
    >;
    return (
      !!config.speaker_encoder_config &&
      existsSync(join(path, "speech_tokenizer", "model.safetensors"))
    );
  } catch {
    return false;
  }
}

/**
 * The Qwen3-TTS Base model voices are cloned for, and read with:
 * `clone_model`, or the first Qwen3-TTS model voice.json reads with.
 */
export function cloningModel(config: VoiceConfig): string | null {
  const candidates = [
    config.clone_model,
    ...(config.tts_models ?? [])
      .filter((model) => model.model === QWEN)
      .map((model) => model.path),
  ];
  for (const candidate of candidates)
    if (typeof candidate === "string" && isCloningModel(candidate))
      return candidate;
  return null;
}

/** Which voice reads what, as `tts_models` says. */
export function assignmentsFrom(
  models: TtsModel[],
  idOfPath: (path: string) => string | undefined,
): VoiceAssignments {
  const assignments: VoiceAssignments = { all: null, languages: {} };
  for (const model of models) {
    if (model.model !== QWEN || typeof model.voice_embedding !== "string")
      continue;
    const id = idOfPath(model.voice_embedding);
    if (!id) continue;
    const languages =
      typeof model.languages === "string"
        ? model.languages.split(",").map((code) => code.trim())
        : [];
    if (!languages.length) assignments.all ??= id;
    for (const code of languages)
      if (isVoiceLanguage(code)) assignments.languages[code] ??= id;
  }
  if (!assignments.all && models.some((model) => model.model === KOKORO))
    assignments.all = KOKORO;
  return assignments;
}

/**
 * `tts_models` reading as `assignments` says with the voices at
 * `pathOf(id)`: the Qwen3-TTS entries made again (keeping the other fields
 * of the one they replace, such as a temperature), the other models after
 * them as they were.
 */
export function modelsFor(
  models: TtsModel[],
  assignments: VoiceAssignments,
  pathOf: (id: string) => string | undefined,
  qwenPath: string,
): TtsModel[] {
  const qwen = models.filter((model) => model.model === QWEN);
  const others = models.filter((model) => model.model !== QWEN);
  const base = (languages: string | undefined): TtsModel => {
    const previous =
      qwen.find((model) => model.languages === languages) ??
      qwen.find((model) => model.languages === undefined) ??
      qwen[0];
    const entry: TtsModel = { ...(previous ?? { model: QWEN }) };
    delete entry.languages;
    // Cloned voices need the Base model, whatever read before.
    return { ...entry, model: QWEN, path: qwenPath || entry.path || "" };
  };
  const entries: TtsModel[] = [];
  for (const [language, id] of Object.entries(assignments.languages)) {
    const path = pathOf(id);
    if (!path) continue;
    entries.push({
      ...base(language),
      voice_embedding: path,
      languages: language,
    });
  }
  const all =
    assignments.all && assignments.all !== KOKORO
      ? pathOf(assignments.all)
      : undefined;
  if (all) entries.push({ ...base(undefined), voice_embedding: all });
  return [...entries, ...others];
}

type Index = { voices: Omit<VoiceInfo, "owned">[] };

/**
 * The voice library on disk, and voice.json's choice of voices. The helper
 * hooks are the voice helper's (VoiceHelper), given so tests can fake it.
 */
export class VoiceLibrary {
  constructor(
    private readonly options: {
      readConfig?: () => VoiceConfig | { error: string };
      configPath?: string;
      clone: (request: VoiceCloneRequest) => Promise<ClonedVoice>;
      /** voice.json changed which models read: tell the running helper. */
      applied?: () => Promise<void> | void;
      now?: () => Date;
    },
  ) {}

  private configPath() {
    return this.options.configPath ?? voiceConfigPath();
  }

  config(): VoiceConfig {
    const config = (
      this.options.readConfig ?? (() => readVoiceConfig(this.configPath()))
    )();
    if ("error" in config) throw new Error(config.error);
    return config;
  }

  private indexPath(config = this.config()) {
    return join(voicesDir(config), "voices.json");
  }

  private readIndex(config: VoiceConfig): Index {
    const path = this.indexPath(config);
    if (!existsSync(path)) return { voices: [] };
    const index = readJson(path) as Partial<Index>;
    return { voices: Array.isArray(index.voices) ? index.voices : [] };
  }

  private owned(config: VoiceConfig, path: string) {
    return resolve(path).startsWith(resolve(voicesDir(config)) + sep);
  }

  /**
   * Every voice, those voice.json reads with added to the list if new
   * (named after their file).
   */
  list(config = this.config()): VoiceInfo[] {
    const index = this.readIndex(config);
    let changed = false;
    for (const model of config.tts_models ?? []) {
      const path = model.voice_embedding;
      if (model.model !== QWEN || typeof path !== "string") continue;
      if (index.voices.some((voice) => resolve(voice.path) === resolve(path)))
        continue;
      const stem = basename(path).replace(/\.json$/i, "");
      index.voices.push({
        id: uniqueVoiceId(voiceSlug(stem), (id) =>
          index.voices.some((voice) => voice.id === id),
        ),
        name: stem,
        languages:
          typeof model.languages === "string"
            ? model.languages.split(",").filter(isVoiceLanguage)
            : [],
        path,
      });
      changed = true;
    }
    if (changed) writeJson(this.indexPath(config), index);
    return index.voices
      .filter((voice) => existsSync(voice.path))
      .map((voice) => ({ ...voice, owned: this.owned(config, voice.path) }));
  }

  /** The voices, which reads what, and whether new ones can be recorded. */
  state() {
    const config = this.config();
    const voices = this.list(config);
    const models = config.tts_models ?? [];
    const model = cloningModel(config);
    return {
      voices,
      kokoro: models.some((entry) => entry.model === KOKORO),
      assignments: assignmentsFrom(
        models,
        (path) =>
          voices.find((voice) => resolve(voice.path) === resolve(path))?.id,
      ),
      can_clone: model !== null,
      ...(model
        ? {}
        : {
            clone_detail: config.tts_models
              ? "Recording voices needs a Qwen3-TTS Base model (clone_model in voice.json)."
              : "Recording voices needs any-tts models (tts_models in voice.json).",
          }),
    };
  }

  /**
   * A new voice from the recording at `audio`: cloned by the helper, which
   * also hears what it says; the words kept are those it says
   * (chooseTranscript): the text shown, read whole, or as far as it was
   * read, or what was heard. `cut`: the recording ended mid-speech.
   */
  async create(input: {
    name: unknown;
    language: unknown;
    text: unknown;
    audio: string;
    cut?: boolean;
  }): Promise<{
    voice: VoiceInfo;
    heard: string;
    /** The words kept with the voice, and where they come from. */
    transcript: string;
    kind: "shown" | "partial" | "heard";
  }> {
    const name = cleanVoiceName(input.name);
    if (!name) throw new VoiceError(400, "The voice needs a name.");
    if (!isVoiceLanguage(input.language))
      throw new VoiceError(400, "Unknown language.");
    const language = input.language;
    const shown =
      typeof input.text === "string" ? input.text.slice(0, 2000) : "";
    const config = this.config();
    const model = cloningModel(config);
    if (!model)
      throw new VoiceError(
        409,
        "Recording voices needs a Qwen3-TTS Base model (clone_model in voice.json).",
      );
    const dir = voicesDir(config);
    mkdirSync(dir, { recursive: true });
    // Those voice.json reads with first, listed in the order they came.
    this.list(config);
    const index = this.readIndex(config);
    const id = uniqueVoiceId(
      voiceSlug(name),
      (taken) =>
        index.voices.some((voice) => voice.id === taken) ||
        existsSync(join(dir, `${taken}.json`)),
    );
    const path = join(dir, `${id}.json`);
    const reference = join(dir, `${id}.wav`);
    let cloned: ClonedVoice;
    try {
      cloned = await this.options.clone({
        audio: input.audio,
        model,
        reference,
        language,
      });
    } catch (error) {
      rmSync(reference, { force: true });
      throw new VoiceError(422, (error as Error).message);
    }
    const { text, kind } = chooseTranscript(shown, cloned.heard, {
      cut: input.cut === true,
    });
    writeJson(path, {
      data: cloned.embedding,
      shape: [cloned.embedding.length],
      model_type: QWEN,
      ...(text ? { prompt: { codes: cloned.codes, text } } : {}),
    });
    const voice = {
      id,
      name,
      languages: [language],
      path,
      reference,
      created: (this.options.now?.() ?? new Date()).toISOString(),
    };
    // Read again: another voice may have been added while this one cloned.
    const latest = this.readIndex(config);
    latest.voices.push(voice);
    writeJson(this.indexPath(config), latest);
    return {
      voice: { ...voice, owned: true },
      heard: cloned.heard,
      transcript: text,
      kind,
    };
  }

  private find(config: VoiceConfig, id: string): VoiceInfo {
    const voice = this.list(config).find((entry) => entry.id === id);
    if (!voice) throw new VoiceError(404, "No such voice.");
    return voice;
  }

  rename(id: string, name: unknown): VoiceInfo {
    const clean = cleanVoiceName(name);
    if (!clean) throw new VoiceError(400, "The voice needs a name.");
    const config = this.config();
    const voice = this.find(config, id);
    const index = this.readIndex(config);
    for (const entry of index.voices) if (entry.id === id) entry.name = clean;
    writeJson(this.indexPath(config), index);
    return { ...voice, name: clean };
  }

  /**
   * Forgets the voice, and deletes its files when recorded here. One
   * reading replies is kept: another must be chosen first.
   */
  delete(id: string) {
    const config = this.config();
    const voice = this.find(config, id);
    if (
      (config.tts_models ?? []).some(
        (model) =>
          typeof model.voice_embedding === "string" &&
          resolve(model.voice_embedding) === resolve(voice.path),
      )
    )
      throw new VoiceError(
        409,
        `${voice.name} reads replies: choose another voice first.`,
      );
    const index = this.readIndex(config);
    index.voices = index.voices.filter((entry) => entry.id !== id);
    writeJson(this.indexPath(config), index);
    if (voice.owned) {
      rmSync(voice.path, { force: true });
      if (voice.reference && this.owned(config, voice.reference))
        rmSync(voice.reference, { force: true });
    }
  }

  /** `tts_models` with the voice `id` reading everything, for a sample. */
  sampleModels(id: string): TtsModel[] {
    const config = this.config();
    const models = config.tts_models ?? [];
    if (id === KOKORO) {
      const kokoro = models.filter((model) => model.model === KOKORO);
      if (!kokoro.length) throw new VoiceError(404, "No Kokoro voice.");
      return kokoro;
    }
    const voice = this.find(config, id);
    const model = cloningModel(config);
    if (!model) throw new VoiceError(409, "No Qwen3-TTS model to read with.");
    return modelsFor(
      models,
      { all: id, languages: {} },
      (wanted) => (wanted === id ? voice.path : undefined),
      model,
    );
  }

  /**
   * Has `voice` read `language` (or every language, its own voices
   * dropped, when none), or stops giving `language` a voice of its own
   * (`voice` null); kept in voice.json, and told to the running helper.
   */
  async assign(voice: string | null, language: unknown) {
    const config = this.config();
    if (
      language !== undefined &&
      language !== null &&
      !isVoiceLanguage(language)
    )
      throw new VoiceError(400, "Unknown language.");
    if (!config.tts_models)
      throw new VoiceError(
        409,
        "Choosing voices needs any-tts models (tts_models in voice.json).",
      );
    const { voices, assignments, kokoro } = this.state();
    if (
      voice !== null &&
      voice !== KOKORO &&
      !voices.some((v) => v.id === voice)
    )
      throw new VoiceError(404, "No such voice.");
    if (voice === KOKORO && !kokoro)
      throw new VoiceError(404, "No Kokoro voice.");
    // Kokoro reads what no cloned voice does: all of it, or nothing.
    if (voice === KOKORO && isVoiceLanguage(language))
      throw new VoiceError(
        400,
        "Kokoro reads every language or none: choose it for all of them.",
      );
    const next: VoiceAssignments = {
      all: assignments.all,
      languages: { ...assignments.languages },
    };
    if (isVoiceLanguage(language)) {
      if (voice === null || voice === next.all) delete next.languages[language];
      else next.languages[language] = voice;
    } else if (voice === null) {
      throw new VoiceError(400, "Choose a voice.");
    } else {
      next.all = voice;
      next.languages = {};
    }
    const qwen =
      cloningModel(config) ??
      config.tts_models.find((model) => model.model === QWEN)?.path;
    if (
      typeof qwen !== "string" &&
      (next.all !== KOKORO || Object.keys(next.languages).length)
    )
      throw new VoiceError(409, "No Qwen3-TTS model to read with.");
    const models = modelsFor(
      config.tts_models,
      next,
      (id) => voices.find((entry) => entry.id === id)?.path,
      String(qwen ?? ""),
    );
    if (!models.length)
      throw new VoiceError(409, "That would leave no voice to read with.");
    const raw = readJson(this.configPath()) as Record<string, unknown>;
    raw.tts_models = models;
    writeJson(this.configPath(), raw);
    await this.options.applied?.();
    return this.state();
  }
}

/** A refused request, with the HTTP status that says why. */
export class VoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
