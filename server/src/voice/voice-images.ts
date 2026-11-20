import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localImageFile } from "../review/images";
import type { PromptImage } from "./voice-cleaner";

/** The most images one typed turn gives the front. */
export const MAX_TURN_IMAGES = 8;

/** The largest image the model takes (the page makes them smaller first). */
export const MAX_TURN_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Where the chat composers' images are uploaded on this host (the
 * connection's /upload-image, createTerminalUploadHandler).
 */
export function uploadRoot(): string {
  return join(tmpdir(), `roamgate-uploads-${process.getuid?.() ?? "user"}`);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The images uploaded with words typed to the companion, by their paths
 * in them: only files of the upload folder, read as the model takes them.
 * The others (a path the user wrote, a file too big) stay words.
 */
export async function uploadedImages(
  said: string,
  root = uploadRoot(),
): Promise<PromptImage[]> {
  const pattern = new RegExp(
    `${escaped(root)}/upload-[^/\\s]+/[^/\\s]+\\.(?:png|jpe?g|gif|webp)`,
    "gi",
  );
  const paths = [...new Set(said.match(pattern) ?? [])].slice(
    0,
    MAX_TURN_IMAGES,
  );
  let real: string;
  try {
    real = await realpath(root);
  } catch {
    return [];
  }
  const images: PromptImage[] = [];
  for (const path of paths) {
    try {
      // A link out of the folder is not one of its images.
      if (!(await realpath(path)).startsWith(`${real}/`)) continue;
      const image = await localImageFile(path);
      if (!image) continue;
      const data = await Bun.file(path).bytes();
      if (data.length > MAX_TURN_IMAGE_BYTES) continue;
      images.push({
        media_type: image.type,
        data: Buffer.from(data).toString("base64"),
      });
    } catch {
      // Gone since it was uploaded (a day later): the words stay.
    }
  }
  return images;
}

/**
 * GET /api/voice/image?path=: an image the companion was given or names,
 * by its absolute path on this host, for its conversation to show.
 */
export async function serveVoiceImage(url: URL): Promise<Response> {
  const image = await localImageFile(url.searchParams.get("path") ?? "");
  if (!image) return new Response("not found", { status: 404 });
  return new Response(Bun.file(image.path), {
    headers: {
      "content-type": image.type,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}
