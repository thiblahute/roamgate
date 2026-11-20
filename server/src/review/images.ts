import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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

/**
 * Removes the images of reviews that no longer exist. Run when the bridge
 * starts: a discarded review keeps its images until then, for its undo.
 * Only folders named as review ids are considered.
 */
export function pruneReviewImages(
  directory: string,
  live: ReadonlySet<string>,
): string[] {
  const folder = join(directory, "images");
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const removed = names.filter(
    (name) => SESSION_ID.test(name) && !live.has(name),
  );
  for (const name of removed)
    rmSync(join(folder, name), { recursive: true, force: true });
  return removed;
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

const LOCAL_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/**
 * An image file of this host named by its absolute path in a comment (an
 * agent's screenshot): its type, read from its first bytes, or null for
 * anything that is not a readable PNG, JPEG, GIF or WebP file of at most
 * REVIEW_IMAGE_MAX_BYTES.
 */
export async function localImageFile(
  path: string,
): Promise<{ path: string; type: string } | null> {
  if (!path || path.includes("\0") || !isAbsolute(path)) return null;
  if (!LOCAL_EXTENSION.test(path)) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > REVIEW_IMAGE_MAX_BYTES)
      return null;
    const head = new Uint8Array(12);
    await handle.read(head, 0, head.length, 0);
    for (const [type, { magic }] of Object.entries(TYPES))
      if (magic.every((byte, index) => head[index] === byte))
        if (
          type !== "image/webp" ||
          String.fromCharCode(...head.slice(8, 12)) === "WEBP"
        )
          // RIFF is WebP only with its WEBP tag.
          return { path, type };
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
