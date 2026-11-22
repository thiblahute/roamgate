import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { arch, cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import {
  GAMEMODE_REASON,
  GAMING_HOLDER,
  type LowGpuModel,
  type LowGpuStatus,
} from "../../../shared/voiceLowGpu";
import {
  CUSTOM_MODEL,
  NO_MODEL,
  VOICE_COMPONENTS,
  type VoiceChoices,
  type VoiceComponent,
  type VoiceHardware,
} from "../../../shared/voiceSetup";
import type { VoiceConfig, VoiceHelper } from "./voice-helper";
import {
  COMPONENTS,
  configPatch,
  type ModelPackage,
  normalizeChoices,
  OPTIONS,
  optionOf,
  PACKAGES,
  type PackageRoots,
  recommendedChoices,
  voiceDataDir,
} from "./voice-models";
import { currentChoices, locatePackages } from "./voice-setup";

/**
 * The low-GPU voice profile: while something else needs the GPU (a game,
 * another job), the voice helper starts with a lighter set of models, the
 * setup assistant's light tier (voice-models.ts recommendedChoices) among
 * the models already here: Parakeet only (no Whisper reading again),
 * Kokoro reading on the CPU (no Qwen3-TTS), the speaker and turn models,
 * which run on the CPU. voice.json is never written: the set is put over
 * it (configPatch) on the configuration the helper starts with.
 *
 * It is on while a holder holds it (`roamgate voice profile low-gpu on
 * --by <name>`, the settings' switch) or GameMode runs as a call starts.
 * The holders are kept in the voice's data directory (lowGpuPath): the CLI
 * writes them there, the server watches the file. A helper running with
 * the other set stops once nothing needs it (a call ending), the next
 * request starting it with the right one; `--now` restarts it at once,
 * its call made again after a short notice.
 *
 * On for a game (the "gaming" holder, GameMode), the helper also yields
 * the CPU to it (yieldCpu): a low priority and CPU weight, idle I/O, and
 * its ONNX models (Parakeet, Kokoro, the speaker and turn checks) sharing
 * a few threads that do not spin, where each would otherwise take one per
 * core: a game freezes when the voice takes the cores it runs on.
 */

export type LowGpuFile = {
  /** Who holds it on, and since when (ms since the epoch). */
  holders: Record<string, number>;
  /** Parts set by hand, over the light tier. */
  models?: VoiceChoices;
  /**
   * Asked to switch now, a call going on (ms since the epoch): the server
   * acts on a newer one than it saw.
   */
  now?: number;
};

export function lowGpuPath(
  home?: string,
  platform?: string,
  appDataDir?: string,
): string {
  return join(voiceDataDir(home, platform, appDataDir), "low-gpu.json");
}

/** A holder's name: letters, digits, dot, dash, underscore. */
export function isHolderName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,40}$/.test(name);
}

export function readLowGpu(path: string): LowGpuFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { holders: {} };
  }
  const file: LowGpuFile = { holders: {} };
  if (!parsed || typeof parsed !== "object") return file;
  const raw = parsed as Record<string, unknown>;
  if (raw.holders && typeof raw.holders === "object")
    for (const [name, since] of Object.entries(raw.holders))
      if (isHolderName(name) && typeof since === "number")
        file.holders[name] = since;
  if (raw.models && typeof raw.models === "object") {
    const models: VoiceChoices = {};
    for (const [part, id] of Object.entries(raw.models))
      if (
        (VOICE_COMPONENTS as readonly string[]).includes(part) &&
        typeof id === "string"
      )
        models[part as VoiceComponent] = id;
    if (Object.keys(models).length) file.models = models;
  }
  if (typeof raw.now === "number") file.now = raw.now;
  return file;
}

/** Writes `file` whole, so a reader never sees half of it. */
export function writeLowGpu(path: string, file: LowGpuFile) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * `holder` holds the profile on, or lets it go; off without a holder lets
 * every holder go. With `now`, a call going on switches at once.
 */
export function holdLowGpu(
  path: string,
  change: { on: boolean; holder?: string; now?: boolean },
  at = Date.now(),
): LowGpuFile {
  const file = readLowGpu(path);
  if (change.holder !== undefined && !isHolderName(change.holder))
    throw new Error(
      `${change.holder}: a holder is letters, digits, dots, dashes or underscores`,
    );
  if (change.on) file.holders[change.holder ?? "manual"] ??= at;
  else if (change.holder === undefined) file.holders = {};
  else delete file.holders[change.holder];
  if (change.now) file.now = at;
  writeLowGpu(path, file);
  return file;
}

/** Sets parts of the low-GPU set by hand; null goes back to the light tier. */
export function setLowGpuModels(
  path: string,
  models: VoiceChoices | null,
): LowGpuFile {
  const file = readLowGpu(path);
  if (models === null || !Object.keys(models).length) delete file.models;
  else {
    // Unknown options fail here, not when the helper starts.
    normalizeChoices(models);
    file.models = { ...file.models, ...models };
  }
  writeLowGpu(path, file);
  return file;
}

/** `gamemoded -s`'s answer: true active, false inactive, null unknown. */
export function parseGameMode(output: string): boolean | null {
  if (/gamemode is active/i.test(output)) return true;
  if (/gamemode is inactive/i.test(output)) return false;
  return null;
}

/**
 * The command asking GameMode whether it runs: on the host through
 * host-spawn when the server runs in a toolbox (gamemoded is the host's).
 */
export function gameModeCommand(inToolbox: boolean): string[] {
  return inToolbox
    ? ["host-spawn", "--no-pty", "gamemoded", "-s"]
    : ["gamemoded", "-s"];
}

/** Whether this process runs in a toolbox (or another podman container). */
export function inToolbox(): boolean {
  return existsSync("/run/.toolboxenv");
}

/** Whether GameMode runs now; null when it cannot tell (none installed). */
export async function gameModeActive(
  command = gameModeCommand(inToolbox()),
  timeoutMs = 3000,
): Promise<boolean | null> {
  if (process.platform !== "linux") return null;
  try {
    const child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return parseGameMode(`${out}\n${err}`);
  } catch {
    return null;
  }
}

/** The machine as recommendedChoices' light tier needs it: its memory. */
function machine(ramBytes: number): VoiceHardware {
  return {
    platform: process.platform,
    arch: arch(),
    cpu: { model: cpus()[0]?.model ?? "", cores: cpus().length },
    ramBytes,
    gpus: [],
    acceleration: "cpu",
    gpuBytes: 0,
  };
}

const installed = (
  component: VoiceComponent,
  id: string | undefined,
  roots: PackageRoots,
) =>
  id === NO_MODEL ||
  (optionOf(component, id)?.packages.every((pkg) => roots[pkg] !== undefined) ??
    false);

/** GPU memory an option takes: none on the CPU. */
const gpuOf = (component: VoiceComponent, id: string | undefined) => {
  const option = optionOf(component, id);
  return option && option.runsOn !== "cpu" ? (option.gpuBytes ?? 0) : 0;
};

/**
 * The low-GPU set among the models at `roots`: for each part, the one set
 * by hand (`overrides`), else the light tier's, when it is here; else the
 * lightest one here (the CPU's first, then the least GPU memory); else
 * none for an optional part, or what voice.json has (`current`). Nothing
 * is downloaded.
 */
export function lowGpuChoices(
  roots: PackageRoots,
  current: VoiceChoices,
  ramBytes: number = totalmem(),
  overrides: VoiceChoices = {},
): VoiceChoices {
  const light = recommendedChoices(machine(ramBytes)).light;
  const choices: VoiceChoices = {};
  for (const spec of COMPONENTS) {
    const wanted = [overrides[spec.id], light[spec.id]].find(
      (id) => id !== undefined && installed(spec.id, id, roots),
    );
    if (wanted !== undefined) {
      choices[spec.id] = wanted;
      continue;
    }
    const here = OPTIONS.filter(
      (option) =>
        option.component === spec.id &&
        installed(spec.id, option.id, roots) &&
        // A heavy model is no lighter choice for an optional part.
        (!spec.optional || option.runsOn !== "gpu"),
    ).sort(
      (a, b) =>
        Number(a.runsOn === "gpu") - Number(b.runsOn === "gpu") ||
        gpuOf(spec.id, a.id) - gpuOf(spec.id, b.id),
    );
    choices[spec.id] =
      here[0]?.id ??
      (spec.optional ? NO_MODEL : (current[spec.id] ?? CUSTOM_MODEL));
  }
  return normalizeChoices(choices);
}

/** The GPU memory the choices take, as the catalog estimates it. */
export function gpuBytesFor(choices: VoiceChoices): number {
  const counted = new Set<string>();
  let bytes = 0;
  for (const spec of COMPONENTS) {
    const id = choices[spec.id];
    const option = optionOf(spec.id, id);
    // Whisper reading again is the same model as Whisper hearing.
    const key = option?.packages[0] ?? "";
    if (!option || counted.has(key)) continue;
    counted.add(key);
    bytes += gpuOf(spec.id, id);
  }
  return bytes;
}

/** The choices for people: each part, its model and where it runs. */
export function describeChoices(choices: VoiceChoices): LowGpuModel[] {
  return COMPONENTS.map((spec) => {
    const id = choices[spec.id];
    const option = optionOf(spec.id, id);
    return {
      component: spec.id,
      title: spec.title,
      name:
        option?.name ??
        (id === CUSTOM_MODEL ? "as in voice.json" : (id ?? NO_MODEL)),
      runsOn: option?.runsOn ?? "none",
    };
  });
}

/**
 * The ONNX threads of a helper yielding the CPU to a game, unless
 * voice.json's gaming_cpu_threads says otherwise.
 */
export const GAMING_CPU_THREADS = 4;

/** Whether the profile is on for a game: the gaming holder or GameMode. */
export function forGaming(reason: string): boolean {
  return reason
    .split(", ")
    .some((name) => name === GAMING_HOLDER || name === GAMEMODE_REASON);
}

/**
 * How the helper yields the CPU while the profile is on for `reason`:
 * undefined when it is not for a game.
 */
export function yieldCpu(
  config: Pick<VoiceConfig, "gaming_cpu_threads">,
  reason: string,
): VoiceConfig["yield_cpu"] {
  if (!forGaming(reason)) return undefined;
  return { threads: config.gaming_cpu_threads ?? GAMING_CPU_THREADS };
}

/**
 * `config` with the low-GPU set's models in place of its own, `low_gpu`
 * saying why and, for a game, `yield_cpu`; its other settings as they are.
 */
export function lowGpuConfig(
  config: VoiceConfig,
  choices: VoiceChoices,
  roots: PackageRoots,
  reason: string,
  packages = PACKAGES,
): VoiceConfig {
  const patched: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(
    configPatch(choices, roots, config, packages),
  ))
    if (value === undefined) delete patched[key];
    else patched[key] = value;
  patched.low_gpu = reason;
  const cpu = yieldCpu(config, reason);
  if (cpu) patched.yield_cpu = cpu;
  return patched as VoiceConfig;
}

type Helper = Pick<
  VoiceHelper,
  | "reloadModels"
  | "reloadModelsAndWait"
  | "restartModels"
  | "runningProfile"
  | "currentCallId"
  | "speakInCall"
>;

export type LowGpuDeps = {
  path: string;
  /** voice.json, as the helper reads it. */
  readConfig: () => VoiceConfig | { error: string };
  /** The models directory, where the setup assistant downloads. */
  modelsDir: string;
  helper: Helper;
  /** Whether GameMode runs, asked as a call starts. */
  gameMode?: () => Promise<boolean | null>;
  ramBytes?: number;
  /** The catalog's packages; tests give small files. */
  packages?: ModelPackage[];
  /** How often a switch waiting for a call's end tries again. */
  retryMs?: number;
};

/** Said on the call before its helper restarts for the other set. */
export const SWITCH_NOTICES = {
  "low-gpu": "Switching to the light voice, one moment.",
  full: "Switching back to the full voice, one moment.",
} as const;

export class VoiceLowGpu {
  private gameMode: boolean | null = null;
  private retry: ReturnType<typeof setInterval> | null = null;
  private seenNow = 0;
  private cache: {
    key: string;
    choices: VoiceChoices;
    roots: PackageRoots;
  } | null = null;
  private lastError: string | undefined;

  constructor(private readonly deps: LowGpuDeps) {
    this.seenNow = readLowGpu(deps.path).now ?? 0;
  }

  private file(): LowGpuFile {
    return readLowGpu(this.deps.path);
  }

  /** Who it is on for, null when off. */
  reason(file = this.file()): string | null {
    const names = Object.keys(file.holders);
    if (this.gameMode) names.push(GAMEMODE_REASON);
    return names.length ? names.join(", ") : null;
  }

  active(): boolean {
    return this.reason() !== null;
  }

  /** The set on this machine for voice.json `config`, and its roots. */
  private set(config: VoiceConfig, file: LowGpuFile) {
    const mtime = (path: string) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return 0;
      }
    };
    const key = JSON.stringify([
      config,
      file.models ?? {},
      mtime(this.deps.modelsDir),
    ]);
    if (this.cache?.key === key) return this.cache;
    const roots = locatePackages(
      config,
      this.deps.modelsDir,
      this.deps.packages,
    );
    const choices = lowGpuChoices(
      roots,
      currentChoices(config, roots, this.deps.packages),
      this.deps.ramBytes,
      file.models,
    );
    this.cache = { key, choices, roots };
    return this.cache;
  }

  /**
   * The configuration the helper starts with: voice.json as it is, or
   * with the low-GPU set while the profile is on. Its error, if any, as
   * readVoiceConfig gives it; a set that cannot be made leaves voice.json's
   * models (logged).
   */
  config(raw = this.deps.readConfig()): VoiceConfig | { error: string } {
    if ("error" in raw) return raw;
    const file = this.file();
    const reason = this.reason(file);
    if (reason === null) return raw;
    try {
      const { choices, roots } = this.set(raw, file);
      this.lastError = undefined;
      return lowGpuConfig(raw, choices, roots, reason, this.deps.packages);
    } catch (error) {
      const message = (error as Error).message;
      if (message !== this.lastError)
        console.error(
          `[voice] the low-GPU set cannot be made (${message}): voice.json's models are used`,
        );
      this.lastError = message;
      return raw;
    }
  }

  status(): LowGpuStatus {
    const file = this.file();
    const reason = this.reason(file);
    const raw = this.deps.readConfig();
    let choices: VoiceChoices = {};
    let error: string | undefined;
    if ("error" in raw) error = raw.error;
    else
      try {
        choices = this.set(raw, file).choices;
      } catch (cause) {
        error = (cause as Error).message;
      }
    return {
      active: reason !== null,
      reason,
      holders: Object.keys(file.holders),
      gameMode: this.gameMode,
      running: this.deps.helper.runningProfile(),
      pending: this.retry !== null,
      choices,
      models: describeChoices(choices),
      gpuBytes: gpuBytesFor(choices),
      overrides: file.models ?? {},
      path: this.deps.path,
      ...(error ? { error } : {}),
    };
  }

  private wanted(): "low-gpu" | "full" {
    return this.active() ? "low-gpu" : "full";
  }

  private stopRetry() {
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
  }

  /**
   * The running helper takes the profile as it is now: one with the other
   * set stops when free (the next request starts the right one), else
   * once its call ends, or with `now` restarts at once after a notice on
   * the call. Answers what happened.
   */
  async apply(
    now = false,
  ): Promise<"in-effect" | "now" | "after-call" | "not-running"> {
    const wanted = this.wanted();
    const running = this.deps.helper.runningProfile();
    if (running === null || running === wanted) {
      this.stopRetry();
      return running === null ? "not-running" : "in-effect";
    }
    const result = this.deps.helper.reloadModels();
    if (result !== "after-call") {
      this.stopRetry();
      return result;
    }
    if (now) {
      this.stopRetry();
      await this.notice(wanted);
      // The call may have ended while the notice was said.
      if (this.deps.helper.runningProfile() === wanted) return "in-effect";
      if (!this.deps.helper.restartModels()) return "not-running";
      console.error(
        `[voice] restarting the voice helper now for its ${wanted === "low-gpu" ? "low-GPU" : "full"} models`,
      );
      return "now";
    }
    if (!this.retry) {
      console.error(
        `[voice] the voice helper switches to its ${wanted === "low-gpu" ? "low-GPU" : "full"} models once the call ends`,
      );
      this.retry = setInterval(
        () => void this.apply(),
        this.deps.retryMs ?? 15_000,
      );
      this.retry.unref?.();
    }
    return "after-call";
  }

  private async notice(wanted: "low-gpu" | "full") {
    const call = this.deps.helper.currentCallId();
    if (call === undefined) return;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.deps.helper.speakInCall(call, SWITCH_NOTICES[wanted], "en"),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 10_000);
        }),
      ]);
      clearTimeout(timer);
    } catch (error) {
      console.error(
        `[voice] the switch notice was not said: ${(error as Error).message}`,
      );
    }
  }

  /** Holds or lets go (the settings' switch), then applies it. */
  async hold(change: { on: boolean; holder?: string; now?: boolean }) {
    const file = holdLowGpu(this.deps.path, change);
    if (file.now) this.seenNow = file.now;
    return this.apply(change.now === true);
  }

  /**
   * As a call starts (VoiceHelper.beforeCall): GameMode asked again, and a
   * helper with the other set, now free, stopped and waited for so the
   * call starts one with the right set.
   */
  async beforeCall(): Promise<void> {
    if (this.deps.gameMode) this.gameMode = await this.deps.gameMode();
    const running = this.deps.helper.runningProfile();
    if (running === null || running === this.wanted()) return;
    const result = await this.deps.helper.reloadModelsAndWait();
    if (result === "now")
      console.error(
        `[voice] a call starts: the voice helper restarts with its ${this.wanted() === "low-gpu" ? "low-GPU" : "full"} models`,
      );
  }

  /**
   * Follows the file the CLI writes: a change applies at once, `now` when
   * it asks for it. Answers how to stop.
   */
  watch(intervalMs = 2000): () => void {
    const listener = () => {
      const file = this.file();
      const now = (file.now ?? 0) > this.seenNow;
      if (file.now) this.seenNow = Math.max(this.seenNow, file.now);
      this.cache = null;
      void this.apply(now);
    };
    watchFile(this.deps.path, { interval: intervalMs }, listener);
    return () => unwatchFile(this.deps.path, listener);
  }
}
