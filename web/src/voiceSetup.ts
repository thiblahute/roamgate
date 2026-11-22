import type { LowGpuStatus } from "../../shared/voiceLowGpu";
import type { VoiceChoices, VoiceSetupState } from "../../shared/voiceSetup";

/**
 * The server's voice setup assistant (server/src/http/voice-setup.ts): the
 * hardware and models, a download started, followed and cancelled, unused
 * models removed.
 */

const VOICE_HEADERS = { "x-roamgate-voice": "1" };

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export async function fetchVoiceSetup(): Promise<VoiceSetupState> {
  return answer(await fetch("/api/voice/setup", { cache: "no-store" }));
}

export async function startVoiceSetup(
  choices: VoiceChoices,
): Promise<VoiceSetupState> {
  return answer(await post("/api/voice/setup", { choices }));
}

export async function cancelVoiceSetup(): Promise<VoiceSetupState> {
  return answer(await post("/api/voice/setup/cancel", {}));
}

export async function removeUnusedVoiceModels(
  ids: string[] | "all",
): Promise<VoiceSetupState & { freedBytes: number }> {
  return answer(await post("/api/voice/setup/remove", { ids }));
}

/** Whether a download is going on, the page following it. */
export function setupRunning(state: VoiceSetupState | null): boolean {
  return state?.job?.state === "downloading" || state?.job?.state === "writing";
}

/** The low-GPU voice profile (server/src/http/voice-low-gpu.ts). */
export async function fetchLowGpu(): Promise<LowGpuStatus> {
  return answer(await fetch("/api/voice/low-gpu", { cache: "no-store" }));
}

/**
 * Holds the low-GPU profile on from these settings, or lets every holder
 * go; with `now`, a call going on switches at once.
 */
export async function setLowGpu(
  on: boolean,
  now = false,
): Promise<LowGpuStatus> {
  return answer(await post("/api/voice/low-gpu", { on, now }));
}

/** A call going on takes the profile as it is now, not when it ends. */
export async function switchLowGpuNow(): Promise<LowGpuStatus> {
  return answer(await post("/api/voice/low-gpu", { now: true }));
}
