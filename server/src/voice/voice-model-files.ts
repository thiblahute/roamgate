import { VOICE_MODELS } from "../assets";

/**
 * The files of each voice model package (voice-models.ts): where they are
 * downloaded from, pinned to one revision, with their size and SHA-256.
 * Hugging Face's sizes and checksums come from its tree API (its LFS ids are
 * the files' SHA-256), the small files' are of the files at that revision;
 * the GitHub release assets' from the release's digests, or of the files.
 * The list is data: contract/assets/data/voice-models.json.
 */

export type ModelFile = {
  /** The file's path in the package's directory. */
  path: string;
  url: string;
  size: number;
  sha256: string;
};

export const MODEL_FILES: Record<string, ModelFile[]> = VOICE_MODELS.files;
