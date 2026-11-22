import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  CUSTOM_MODEL,
  NO_MODEL,
  type VoiceChoices,
  type VoiceComponent,
  type VoiceComponentInfo,
  type VoiceHardware,
  type VoiceSetupJob,
  type VoiceSetupState,
  type VoiceUnusedModel,
} from "../../../shared/voiceSetup";
import { downloadFile, partPath } from "./voice-download";
import {
  readVoiceConfig,
  updateVoiceConfig,
  type VoiceConfig,
} from "./voice-helper";
import {
  COMPONENTS,
  configPatch,
  type ModelPackage,
  normalizeChoices,
  OPTIONS,
  optionOf,
  PACKAGES,
  POCKET_MODEL,
  POCKET_VOICES,
  type PackageRoots,
  packageBytes,
  packageById,
  packagePath,
  packagesFor,
  pocketModelDir,
  recommendedChoices,
  tierFor,
} from "./voice-models";

/**
 * The voice setup assistant (`roamgate setup voice`, the Voice settings'
 * "Set up voice"): the hardware, the models it calls for, what voice.json
 * uses now and which of those files are here; then the chosen models
 * downloaded into the models directory (voice-download.ts) and voice.json
 * pointed at them, its other settings untouched.
 */

export type VoiceSetupPaths = {
  modelsDir: string;
  configPath: string;
  /** The helper as installed, written to voice.json when it names none. */
  helperPath: string;
};

export type VoiceSetupDeps = VoiceSetupPaths & {
  hardware: () => VoiceHardware;
  /** The catalog's packages; tests give small files served locally. */
  packages?: ModelPackage[];
  fetch?: typeof fetch;
  /** Free bytes where `dir` is; undefined when unknown. */
  freeBytes?: (dir: string) => number | undefined;
  /** Retry delay for downloads, in ms. */
  retryDelayMs?: number;
};

/** voice.json as written, whatever readVoiceConfig thinks of it. */
export function rawVoiceConfig(path: string): Partial<VoiceConfig> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Partial<VoiceConfig>)
      : {};
  } catch {
    return {};
  }
}

export function diskFree(dir: string): number | undefined {
  // The models directory may not exist yet: the nearest one that does.
  let at = resolve(dir);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const stats = statfsSync(at);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

function sizeAt(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** The package's directory, or the loose files', in the models directory. */
export function defaultRoot(entry: ModelPackage, modelsDir: string): string {
  return entry.dir ? join(modelsDir, entry.dir) : modelsDir;
}

/** Whether every file of `entry` is under `root`, of the right size. */
function completeAt(entry: ModelPackage, root: string): boolean {
  return entry.files.every(
    (file) => sizeAt(join(root, file.path)) === file.size,
  );
}

/** The paths voice.json names that a package may be at. */
function configuredPaths(config: Partial<VoiceConfig>): string[] {
  const paths: unknown[] = [
    config.whisper_model,
    config.parakeet_model,
    config.kokoro_model,
    config.kokoro_voices,
    config.clone_model,
    config.stock_model,
    config.speaker_model,
    config.turn_model,
    config.text_turn_model,
    ...(config.tts_models ?? []).map((model) => model.path),
  ];
  return paths.filter(
    (path): path is string => typeof path === "string" && !!path,
  );
}

/**
 * Where each package is complete: where voice.json points at it first (the
 * desktop's models were put in place by hand), else in the models directory.
 */
export function locatePackages(
  config: Partial<VoiceConfig>,
  modelsDir: string,
  packages = PACKAGES,
): PackageRoots {
  const candidates = new Set<string>();
  for (const path of configuredPaths(config)) {
    candidates.add(resolve(path));
    candidates.add(dirname(resolve(path)));
  }
  const roots: PackageRoots = {};
  for (const entry of packages) {
    const root = [...candidates, defaultRoot(entry, modelsDir)].find(
      (candidate) => completeAt(entry, candidate),
    );
    if (root !== undefined) roots[entry.id] = root;
  }
  return roots;
}

const same = (a: unknown, b: string | undefined) =>
  typeof a === "string" && b !== undefined && resolve(a) === resolve(b);

/** What voice.json uses now, as the catalog's options. */
export function currentChoices(
  config: Partial<VoiceConfig>,
  roots: PackageRoots,
  packages = PACKAGES,
): VoiceChoices {
  const at = (id: string) =>
    roots[id] === undefined ? undefined : packagePath(roots, id, packages);
  const matching = (component: VoiceComponent, path: unknown) =>
    OPTIONS.find(
      (option) =>
        option.component === component &&
        option.packages[0] !== undefined &&
        same(path, at(option.packages[0])),
    )?.id ?? CUSTOM_MODEL;
  const choices: VoiceChoices = {};
  // No model set up yet: nothing is in use, the tier's choices stand.
  if (!configuredPaths(config).length) return choices;
  if (config.parakeet_model) {
    choices.speech = matching("speech", config.parakeet_model);
    choices.reread = config.whisper_model
      ? matching("reread", config.whisper_model)
      : NO_MODEL;
  } else if (config.whisper_model) {
    choices.speech = matching("speech", config.whisper_model);
  }

  const models = config.tts_models;
  if (models?.length) {
    const qwen = [
      config.clone_model,
      ...models
        .filter((model) => model.model === "qwen3-tts")
        .map((model) => model.path),
    ].filter((path) => typeof path === "string");
    const kokoro = models.find((model) => model.model === "kokoro");
    const kokoroOk = !kokoro || same(kokoro.path, at("kokoro-82m"));
    // Pocket TTS's entries, each its language's model in the catalog.
    const pocket = models.filter((model) => model.model === POCKET_MODEL);
    const pocketOk = pocket.every((model) =>
      POCKET_VOICES.some((voice) => {
        const root = roots[voice.package];
        return (
          model.languages === voice.language &&
          root !== undefined &&
          same(model.path, pocketModelDir(root, voice))
        );
      }),
    );
    // The light set: Pocket TTS, Kokoro's ONNX model beside it.
    const light =
      pocket.length > 0 &&
      !qwen.length &&
      (!kokoro || same(kokoro.path, config.kokoro_model));
    const others = models.some(
      (model) =>
        model.model !== "qwen3-tts" &&
        model.model !== "kokoro" &&
        model.model !== POCKET_MODEL,
    );
    const base = ["qwen3-tts-1.7b", "qwen3-tts-0.6b"].find((id) =>
      qwen.some((path) =>
        same(path, at(optionOf("tts", id)?.packages[0] ?? "")),
      ),
    );
    choices.tts =
      others || !pocketOk
        ? CUSTOM_MODEL
        : light
          ? "pocket-tts"
          : !kokoroOk
            ? CUSTOM_MODEL
            : base
              ? base
              : qwen.length
                ? CUSTOM_MODEL
                : kokoro
                  ? "kokoro-82m"
                  : CUSTOM_MODEL;
    choices.stock_voices = config.stock_model
      ? matching("stock_voices", config.stock_model)
      : NO_MODEL;
  } else if (config.kokoro_model) {
    choices.tts = ["kokoro-onnx", "kokoro-onnx-int8"].includes(
      matching("tts", config.kokoro_model),
    )
      ? matching("tts", config.kokoro_model)
      : CUSTOM_MODEL;
    if (
      choices.tts !== CUSTOM_MODEL &&
      !same(config.kokoro_voices, at("kokoro-onnx-voices"))
    )
      choices.tts = CUSTOM_MODEL;
    choices.stock_voices = NO_MODEL;
  }

  const single = (component: VoiceComponent, path: unknown) => {
    choices[component] = path ? matching(component, path) : NO_MODEL;
  };
  single("speaker", config.speaker_model);
  single("turn", config.turn_model);
  single("text_turn", config.text_turn_model);
  return choices;
}

/** The packages the models directory holds that voice.json does not use. */
export function unusedModels(
  config: Partial<VoiceConfig>,
  roots: PackageRoots,
  modelsDir: string,
  packages = PACKAGES,
): VoiceUnusedModel[] {
  const used = new Set<string>();
  try {
    for (const id of packagesFor(currentChoices(config, roots, packages)))
      used.add(id);
  } catch {
    // An option voice.json names that the catalog lost: nothing known used.
  }
  const referenced = configuredPaths(config).map((path) => resolve(path));
  const unused: VoiceUnusedModel[] = [];
  for (const entry of packages) {
    const root = roots[entry.id];
    if (root === undefined || used.has(entry.id)) continue;
    if (resolve(root) !== resolve(defaultRoot(entry, modelsDir))) continue;
    const path = packagePath(roots, entry.id, packages);
    if (referenced.some((ref) => ref === resolve(path))) continue;
    unused.push({
      id: entry.id,
      name: entry.name,
      path,
      sizeBytes: packageBytes(entry),
    });
  }
  for (const part of partialDownloads(modelsDir))
    unused.push({
      id: "partial",
      name: "Unfinished download",
      path: part,
      sizeBytes: sizeAt(part) ?? 0,
    });
  return unused;
}

/** The .part files left in the models directory, two levels deep. */
function partialDownloads(modelsDir: string, depth = 3): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(modelsDir);
  } catch {
    return found;
  }
  for (const name of names) {
    const path = join(modelsDir, name);
    if (name.endsWith(".part")) found.push(path);
    else if (depth > 1) {
      try {
        if (statSync(path).isDirectory())
          found.push(...partialDownloads(path, depth - 1));
      } catch {}
    }
  }
  return found;
}

/** The assistant's view: hardware, choices, what is here. */
export function voiceSetupState(
  deps: VoiceSetupDeps,
  job: VoiceSetupJob | null = null,
): VoiceSetupState {
  const packages = deps.packages ?? PACKAGES;
  const hardware = deps.hardware();
  const config = rawVoiceConfig(deps.configPath);
  const configRead = existsSync(deps.configPath)
    ? readVoiceConfig(deps.configPath)
    : null;
  const roots = locatePackages(config, deps.modelsDir, packages);
  const current = currentChoices(config, roots, packages);
  const missing = (ids: string[]) =>
    ids
      .filter((id) => roots[id] === undefined)
      .reduce((sum, id) => sum + packageBytes(packageById(id, packages)), 0);
  const components: VoiceComponentInfo[] = COMPONENTS.map((spec) => ({
    id: spec.id,
    title: spec.title,
    description: spec.description,
    optional: spec.optional,
    ...(spec.requires ? { requires: spec.requires } : {}),
    options: OPTIONS.filter((option) => option.component === spec.id).map(
      (option) => ({
        id: option.id,
        packages: option.packages,
        name: option.name,
        description: option.description,
        sizeBytes: option.packages.reduce(
          (sum, id) => sum + packageBytes(packageById(id, packages)),
          0,
        ),
        downloadBytes: missing(option.packages),
        speed: option.speed,
        runsOn: option.runsOn,
        ...(option.gpuBytes ? { gpuBytes: option.gpuBytes } : {}),
        ...(option.requires ? { requires: option.requires } : {}),
        installed: option.packages.every((id) => roots[id] !== undefined),
      }),
    ),
  }));
  const helperPath =
    typeof config.helper === "string" && config.helper
      ? config.helper
      : deps.helperPath;
  const freeBytes = (deps.freeBytes ?? diskFree)(deps.modelsDir);
  return {
    hardware,
    tier: tierFor(hardware),
    recommended: recommendedChoices(hardware),
    current,
    components,
    modelsDir: deps.modelsDir,
    configPath: deps.configPath,
    ...(configRead && "error" in configRead
      ? { configError: configRead.error }
      : {}),
    helper: { path: helperPath, found: existsSync(helperPath) },
    ...(freeBytes !== undefined ? { freeBytes } : {}),
    packages: Object.fromEntries(
      packages.map((entry) => [
        entry.id,
        {
          sizeBytes: packageBytes(entry),
          downloadBytes:
            roots[entry.id] === undefined ? packageBytes(entry) : 0,
        },
      ]),
    ),
    unused: unusedModels(config, roots, deps.modelsDir, packages),
    job,
  };
}

/** What `choices` downloads, file by file, and the roots it ends with. */
export function setupPlan(
  choices: VoiceChoices,
  deps: Pick<VoiceSetupDeps, "modelsDir" | "configPath" | "packages">,
) {
  const packages = deps.packages ?? PACKAGES;
  const normalized = normalizeChoices(choices);
  const config = rawVoiceConfig(deps.configPath);
  const roots = locatePackages(config, deps.modelsDir, packages);
  const downloads: {
    name: string;
    url: string;
    path: string;
    size: number;
    sha256: string;
  }[] = [];
  for (const id of packagesFor(normalized)) {
    if (roots[id] !== undefined) continue;
    const entry = packageById(id, packages);
    const root = defaultRoot(entry, deps.modelsDir);
    for (const file of entry.files)
      downloads.push({
        name:
          entry.files.length > 1 ? `${entry.name}: ${file.path}` : entry.name,
        url: file.url,
        path: join(root, file.path),
        size: file.size,
        sha256: file.sha256,
      });
    roots[id] = root;
  }
  return { choices: normalized, config, roots, downloads };
}

export type InstallOptions = {
  signal?: AbortSignal;
  /** The job as it goes, for progress. */
  onProgress?: (job: VoiceSetupJob) => void;
  /** Hash files already in place. */
  verify?: boolean;
  /** Set voice.json's helper, whatever it names. */
  helper?: string;
};

/**
 * Downloads what `choices` needs and points voice.json at it. Fails before
 * downloading when the disk has too little room.
 */
export async function installVoiceModels(
  choices: VoiceChoices,
  deps: VoiceSetupDeps,
  options: InstallOptions = {},
): Promise<{ job: VoiceSetupJob; patch: Record<string, unknown> }> {
  const plan = setupPlan(choices, deps);
  const job: VoiceSetupJob = {
    state: "downloading",
    files: plan.downloads.map((file) => ({
      name: file.name,
      size: file.size,
      done: 0,
    })),
    totalBytes: plan.downloads.reduce((sum, file) => sum + file.size, 0),
    doneBytes: 0,
    bytesPerSecond: 0,
    startedAt: Date.now(),
  };
  const report = () => options.onProgress?.({ ...job, files: [...job.files] });
  const free = (deps.freeBytes ?? diskFree)(deps.modelsDir);
  const partial = plan.downloads.reduce(
    (sum, file) => sum + (sizeAt(partPath(file.path)) ?? 0),
    0,
  );
  if (free !== undefined && free < job.totalBytes - partial)
    throw new Error(
      `${deps.modelsDir} has ${Math.floor(free / 1e6)} MB free, the models need ${Math.ceil((job.totalBytes - partial) / 1e6)} MB`,
    );
  report();
  let lastReport = 0;
  const speedFrom = { at: Date.now(), bytes: 0 };
  for (const [index, file] of plan.downloads.entries()) {
    job.current = file.name;
    const before = job.doneBytes;
    await downloadFile(file, {
      fetch: deps.fetch,
      signal: options.signal,
      verify: options.verify,
      retryDelayMs: deps.retryDelayMs,
      onProgress: (done) => {
        const entry = job.files[index];
        if (entry) entry.done = done;
        job.doneBytes = before + done;
        const now = Date.now();
        if (now - speedFrom.at >= 1000) {
          job.bytesPerSecond = Math.max(
            0,
            ((job.doneBytes - speedFrom.bytes) * 1000) / (now - speedFrom.at),
          );
          speedFrom.at = now;
          speedFrom.bytes = job.doneBytes;
        }
        if (now - lastReport >= 250) {
          lastReport = now;
          report();
        }
      },
    });
    job.doneBytes = before + file.size;
  }
  job.current = undefined;
  job.state = "writing";
  report();
  const patch = configPatch(
    plan.choices,
    plan.roots,
    plan.config,
    deps.packages ?? PACKAGES,
  );
  if (options.helper) patch.helper = options.helper;
  else if (!plan.config.helper && existsSync(deps.helperPath))
    patch.helper = deps.helperPath;
  updateVoiceConfig(patch, deps.configPath);
  job.state = "done";
  job.finishedAt = Date.now();
  report();
  return { job, patch };
}

/**
 * Deletes unused models (unusedModels' ids, "partial" for unfinished
 * downloads), only ever inside the models directory. Returns the bytes freed.
 */
export function removeUnusedModels(
  ids: string[] | "all",
  deps: Pick<VoiceSetupDeps, "modelsDir" | "configPath" | "packages">,
): { removed: VoiceUnusedModel[]; freedBytes: number } {
  const packages = deps.packages ?? PACKAGES;
  const config = rawVoiceConfig(deps.configPath);
  const roots = locatePackages(config, deps.modelsDir, packages);
  const inside = resolve(deps.modelsDir) + sep;
  const removed: VoiceUnusedModel[] = [];
  for (const model of unusedModels(config, roots, deps.modelsDir, packages)) {
    if (ids !== "all" && !ids.includes(model.id)) continue;
    const entry =
      model.id === "partial" ? null : packageById(model.id, packages);
    const paths = entry?.dir
      ? [roots[entry.id] as string]
      : entry
        ? entry.files.map((file) => join(deps.modelsDir, file.path))
        : [model.path];
    for (const path of paths) {
      if (!resolve(path).startsWith(inside))
        throw new Error(`${path} is not in ${deps.modelsDir}`);
      rmSync(path, { recursive: true, force: true });
    }
    removed.push(model);
  }
  return {
    removed,
    freedBytes: removed.reduce((sum, model) => sum + model.sizeBytes, 0),
  };
}

/**
 * The one download the server runs at a time, for the Voice settings'
 * assistant: started, followed by polling, cancelled.
 */
export class VoiceSetupRunner {
  private current: VoiceSetupJob | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly deps: VoiceSetupDeps,
    /**
     * voice.json changed: the running helper takes the new models; says
     * whether it stopped now, will once a call ends, or was not running.
     */
    private readonly reload: () => VoiceSetupJob["reload"] = () =>
      "not-running",
  ) {}

  get job(): VoiceSetupJob | null {
    return this.current;
  }

  get running(): boolean {
    return this.abort !== null;
  }

  state(): VoiceSetupState {
    return voiceSetupState(this.deps, this.current);
  }

  /** Starts installing `choices`; throws when one already runs. */
  start(choices: VoiceChoices): VoiceSetupJob {
    if (this.abort) throw new Error("A voice setup is already downloading");
    // Unknown options fail here, before anything starts.
    const plan = setupPlan(choices, this.deps);
    const abort = new AbortController();
    this.abort = abort;
    this.current = {
      state: "downloading",
      files: plan.downloads.map((file) => ({
        name: file.name,
        size: file.size,
        done: 0,
      })),
      totalBytes: plan.downloads.reduce((sum, file) => sum + file.size, 0),
      doneBytes: 0,
      bytesPerSecond: 0,
      startedAt: Date.now(),
    };
    void installVoiceModels(choices, this.deps, {
      signal: abort.signal,
      onProgress: (job) => {
        if (this.abort === abort) this.current = job;
      },
    })
      .then(({ job }) => {
        this.current = { ...job, reload: this.reload() };
      })
      .catch((error: Error) => {
        const job = this.current ?? {
          files: [],
          totalBytes: 0,
          doneBytes: 0,
          bytesPerSecond: 0,
          startedAt: Date.now(),
          state: "failed" as const,
        };
        this.current = {
          ...job,
          state: abort.signal.aborted ? "cancelled" : "failed",
          ...(abort.signal.aborted ? {} : { error: error.message }),
          current: undefined,
          finishedAt: Date.now(),
        };
      })
      .finally(() => {
        if (this.abort === abort) this.abort = null;
      });
    return this.current;
  }

  cancel(): boolean {
    if (!this.abort) return false;
    this.abort.abort(new Error("cancelled"));
    return true;
  }

  removeUnused(ids: string[] | "all") {
    if (this.abort)
      throw new Error("Wait for the download to end before removing models");
    return removeUnusedModels(ids, this.deps);
  }
}
