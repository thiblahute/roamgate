import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewError } from "./service";

/** Images pasted into comments: kept with the reviews, read by agents. */
export const REVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const TYPES: Record<string, { extension: string; magic: number[] }> = {
  "image/png": { extension: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { extension: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/gif": { extension: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
  "image/webp": { extension: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
};

const CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(TYPES).map(([type, { extension }]) => [extension, type]),
);

const SESSION_ID = /^[0-9a-f]{16}$/;
const NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

/**
 * Stores an image of a review under `directory/images/<session>/`, named by
 * its content, and returns its absolute path (what a comment links to).
 */
export function saveReviewImage(
  directory: string,
  sessionId: string,
  type: string,
  data: Uint8Array,
): string {
  const known = TYPES[type];
  if (!known) throw new ReviewError("only PNG, JPEG, GIF or WebP images");
  if (!data.length || data.length > REVIEW_IMAGE_MAX_BYTES)
    throw new ReviewError("an image is at most 10 MiB");
  if (!known.magic.every((byte, index) => data[index] === byte))
    throw new ReviewError(`that is not a ${known.extension.toUpperCase()}`);
  if (!SESSION_ID.test(sessionId)) throw new ReviewError("no such review", 404);
  const folder = join(directory, "images", sessionId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = `${createHash("sha256").update(data).digest("hex").slice(0, 16)}.${known.extension}`;
  const path = join(folder, name);
  if (!existsSync(path)) {
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return path;
}

/** A stored image by its session and name, or null for anything else. */
export function reviewImageFile(
  directory: string,
  sessionId: string,
  name: string,
): { path: string; type: string } | null {
  if (!SESSION_ID.test(sessionId) || !NAME.test(name)) return null;
  const extension = name.slice(name.lastIndexOf(".") + 1);
  return {
    path: join(directory, "images", sessionId, name),
    type: CONTENT_TYPES[extension]!,
  };
}
