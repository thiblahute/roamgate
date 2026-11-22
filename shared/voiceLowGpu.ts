import type { VoiceChoices } from "./voiceSetup";

/**
 * The low-GPU voice profile's shapes, shared by the server
 * (server/src/voice/voice-low-gpu.ts), the CLI (`roamgate voice profile
 * low-gpu`) and the Voice settings: a lighter set of voice models the
 * helper starts with while something else needs the GPU (a game, another
 * job), voice.json left as it is.
 */

export const LOW_GPU_PROFILE = "low-gpu";

/** Who holds the profile on when nobody names themselves. */
export const MANUAL_HOLDER = "manual";

/** The holder `roamgate voice gaming` uses. */
export const GAMING_HOLDER = "gaming";

/** Said for GameMode found running as a call starts (`gamemoded -s`). */
export const GAMEMODE_REASON = "GameMode";

export type LowGpuModel = {
  component: string;
  /** The part, as the setup assistant names it ("Reading voice"). */
  title: string;
  /** The model, or "none". */
  name: string;
  runsOn: "gpu" | "cpu" | "any" | "none";
};

export type LowGpuStatus = {
  /** Whether a helper starting now loads the low-GPU set. */
  active: boolean;
  /** Who it is on for ("gaming, GameMode"), null when off. */
  reason: string | null;
  /** The holders set with the CLI or the settings (not GameMode). */
  holders: string[];
  /** GameMode as found at the last call start; null when not checked. */
  gameMode: boolean | null;
  /** The models the running helper has: null when none runs. */
  running: "low-gpu" | "full" | null;
  /** The running helper switches once the call or listening ends. */
  pending: boolean;
  /** The low-GPU set on this machine, as the setup assistant's options. */
  choices: VoiceChoices;
  models: LowGpuModel[];
  /** GPU memory the set takes, as the catalog estimates it. */
  gpuBytes: number;
  /** The parts set by hand (`low-gpu models`), the light tier for the rest. */
  overrides: VoiceChoices;
  /** Where the profile's state is kept. */
  path: string;
  /** Why the set could not be made: the full set is used. */
  error?: string;
};
