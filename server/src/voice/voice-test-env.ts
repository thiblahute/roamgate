/**
 * What a test server gives the voice setup instead of the real world, like
 * the test clock: honoured only when the server runs from source, never by
 * the standalone binary.
 *
 * - `ROAMGATE_TEST_VOICE_HARDWARE`: a JSON file holding the VoiceHardware
 *   GET /api/voice/setup reports (and its tier and recommendation follow),
 *   instead of this host's CPU, RAM and GPUs.
 * - `ROAMGATE_TEST_VOICE_MODELS_URL`: a base URL the model catalog's
 *   downloads go to instead of Hugging Face and GitHub: `https://host/path`
 *   becomes `<base>/host/path`.
 */
import { readFileSync } from "node:fs";
import { isStandaloneBinary } from "../config/standalone";
import type { VoiceHardware } from "../../../shared/voiceSetup";
import { type ModelPackage, PACKAGES } from "./voice-models";

export const TEST_VOICE_HARDWARE_ENV = "ROAMGATE_TEST_VOICE_HARDWARE";
export const TEST_VOICE_MODELS_URL_ENV = "ROAMGATE_TEST_VOICE_MODELS_URL";

export type VoiceTestOverrides = {
  hardware?: () => VoiceHardware;
  packages?: ModelPackage[];
};

/** A catalog URL sent to `base` instead. */
export function testModelUrl(url: string, base: string): string {
  return `${base.replace(/\/+$/, "")}/${url.replace(/^[a-z]+:\/\//i, "")}`;
}

/**
 * The overrides the environment asks for (none when it names neither
 * variable). Throws when the standalone binary is given one.
 */
export function voiceTestOverrides(
  environment: Record<string, string | undefined> = process.env,
  runtime: { execPath: string; argv: readonly string[] } = process,
  packages: ModelPackage[] = PACKAGES,
): VoiceTestOverrides {
  const hardwarePath = environment[TEST_VOICE_HARDWARE_ENV];
  const modelsUrl = environment[TEST_VOICE_MODELS_URL_ENV];
  if (!hardwarePath && !modelsUrl) return {};
  if (isStandaloneBinary(runtime))
    throw new Error(
      `${TEST_VOICE_HARDWARE_ENV} and ${TEST_VOICE_MODELS_URL_ENV} are only honoured when the server runs from source, never by the standalone binary.`,
    );
  const overrides: VoiceTestOverrides = {};
  if (hardwarePath) {
    // Read on each request, so a test can change it.
    overrides.hardware = () =>
      JSON.parse(readFileSync(hardwarePath, "utf8")) as VoiceHardware;
  }
  if (modelsUrl)
    overrides.packages = packages.map((entry) => ({
      ...entry,
      files: entry.files.map((file) => ({
        ...file,
        url: testModelUrl(file.url, modelsUrl),
      })),
    }));
  return overrides;
}
