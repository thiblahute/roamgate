/**
 * The voice setup assistant's shapes, shared by the server (voice-setup.ts),
 * the CLI (`roamgate setup voice`) and the Voice settings' assistant: the
 * hardware found, the models proposed for each part of the voice helper,
 * and the downloads' progress.
 */

export type GpuVendor = "nvidia" | "amd" | "apple" | "intel" | "other";

export type GpuInfo = {
  vendor: GpuVendor;
  name: string;
  /** Its own memory; an Apple GPU shares the machine's (unified). */
  vramBytes?: number;
  unifiedMemory?: boolean;
  driver?: string;
  /** NVIDIA's compute capability ("8.6"), which CUDA code the helper needs. */
  computeCapability?: string;
};

/** What runs the voice helper's GPU models: CUDA, Metal, or nothing. */
export type Acceleration = "cuda" | "metal" | "cpu";

export type VoiceHardware = {
  platform: string;
  arch: string;
  /** "Fedora Linux 43", "macOS 15.1"... when known. */
  osName?: string;
  cpu: { model: string; cores: number };
  ramBytes: number;
  gpus: GpuInfo[];
  acceleration: Acceleration;
  /** Memory the GPU models may take: the best GPU's, or part of unified memory. */
  gpuBytes: number;
  /** Why a GPU found is not used, or what limits it. */
  note?: string;
};

export type VoiceTier = "heavy" | "light";

/** The parts of the voice helper a model is chosen for. */
export const VOICE_COMPONENTS = [
  "speech",
  "reread",
  "tts",
  "stock_voices",
  "speaker",
  "turn",
  "text_turn",
] as const;

export type VoiceComponent = (typeof VOICE_COMPONENTS)[number];

/** No model for an optional part. */
export const NO_MODEL = "none";
/** What voice.json names that the assistant does not know: kept as it is. */
export const CUSTOM_MODEL = "custom";

/** An option id, NO_MODEL or CUSTOM_MODEL for each part. */
export type VoiceChoices = Partial<Record<VoiceComponent, string>>;

export type VoiceModelOption = {
  id: string;
  /** The packages it downloads (VoiceSetupState's packages). */
  packages: string[];
  name: string;
  description: string;
  /** Bytes on disk, every package it needs counted. */
  sizeBytes: number;
  /** Bytes still to download, for what is not on disk yet. */
  downloadBytes: number;
  /** How fast it is, roughly, where it runs best. */
  speed: string;
  /** Where it runs: the GPU (CUDA, Metal), the CPU, or either. */
  runsOn: "gpu" | "cpu" | "any";
  /** GPU memory it takes when it runs there. */
  gpuBytes?: number;
  /** Only with this choice of another part (stock voices of one size). */
  requires?: { component: VoiceComponent; options: string[] };
  installed: boolean;
};

export type VoiceComponentInfo = {
  id: VoiceComponent;
  title: string;
  description: string;
  /** NO_MODEL is a choice. */
  optional: boolean;
  /** Only with this choice of another part (reread only with Parakeet...). */
  requires?: { component: VoiceComponent; options: string[] };
  options: VoiceModelOption[];
};

export type VoiceUnusedModel = {
  /** The package id, or "partial" for a download left unfinished. */
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
};

export type VoiceSetupFile = {
  name: string;
  size: number;
  done: number;
};

export type VoiceSetupJob = {
  state: "downloading" | "writing" | "done" | "failed" | "cancelled";
  files: VoiceSetupFile[];
  totalBytes: number;
  doneBytes: number;
  /** The file downloading now. */
  current?: string;
  bytesPerSecond: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /**
   * What happens to the running helper: stopped so the next voice request
   * loads the new models, or stopped once the call in progress ends.
   */
  reload?: "now" | "after-call" | "not-running";
};

export type VoiceSetupState = {
  hardware: VoiceHardware;
  /** The tier the hardware calls for, and its choices. */
  tier: VoiceTier;
  recommended: Record<VoiceTier, VoiceChoices>;
  /** What voice.json uses now, CUSTOM_MODEL for what is not in the catalog. */
  current: VoiceChoices;
  components: VoiceComponentInfo[];
  modelsDir: string;
  configPath: string;
  /** voice.json's error, as the server reads it, if any. */
  configError?: string;
  helper: { path: string; found: boolean };
  freeBytes?: number;
  /** Each package's size, and what is left to download of it. */
  packages: Record<string, { sizeBytes: number; downloadBytes: number }>;
  unused: VoiceUnusedModel[];
  job: VoiceSetupJob | null;
};

type Requirement = { component: VoiceComponent; options: string[] } | undefined;

/** The parts' rules a choice follows: VoiceComponentInfo, or the catalog. */
export type ChoiceRules = {
  id: VoiceComponent;
  optional: boolean;
  requires?: Requirement;
  options: { id: string; requires?: Requirement }[];
}[];

/** Whether `requires` holds; a part as voice.json has it may well be it. */
export function requirementHolds(
  requires: Requirement,
  choices: VoiceChoices,
): boolean {
  if (!requires) return true;
  const chosen = choices[requires.component];
  return chosen === CUSTOM_MODEL || requires.options.includes(chosen ?? "");
}

/**
 * The choices made consistent: an optional part that does not apply (a
 * second reading without Parakeet) made NO_MODEL, an option needing another
 * choice (stock voices of one size) swapped for the one that fits.
 */
export function settleChoices(
  rules: ChoiceRules,
  choices: VoiceChoices,
): VoiceChoices {
  const settled = { ...choices };
  for (const part of rules) {
    const id = settled[part.id];
    if (id === undefined || id === NO_MODEL || id === CUSTOM_MODEL) continue;
    if (!requirementHolds(part.requires, settled)) {
      if (part.optional) settled[part.id] = NO_MODEL;
      continue;
    }
    const option = part.options.find((entry) => entry.id === id);
    if (requirementHolds(option?.requires, settled)) continue;
    const sibling = part.options.find((entry) =>
      requirementHolds(entry.requires, settled),
    );
    settled[part.id] = sibling ? sibling.id : NO_MODEL;
  }
  return settled;
}

/**
 * The choices to start from: `tier`'s when given, else what voice.json uses,
 * the proposed tier's for the rest.
 */
export function startingChoices(
  state: Pick<
    VoiceSetupState,
    "components" | "current" | "recommended" | "tier"
  >,
  tier?: VoiceTier,
): VoiceChoices {
  if (tier) return settleChoices(state.components, state.recommended[tier]);
  const current = Object.fromEntries(
    Object.entries(state.current).filter(([, id]) => id !== undefined),
  );
  return settleChoices(state.components, {
    ...state.recommended[state.tier],
    ...current,
  });
}

/** Bytes still to download for `choices`, each package counted once. */
export function downloadBytesFor(
  state: Pick<VoiceSetupState, "components" | "packages">,
  choices: VoiceChoices,
): number {
  const ids = new Set<string>();
  for (const part of state.components)
    for (const id of part.options.find(
      (option) => option.id === choices[part.id],
    )?.packages ?? [])
      ids.add(id);
  let bytes = 0;
  for (const id of ids) bytes += state.packages[id]?.downloadBytes ?? 0;
  return bytes;
}

/** Bytes, for people: "4.2 GB", "180 MB". */
export function formatBytes(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GB`;
  if (bytes >= mib) return `${Math.round(bytes / mib)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
