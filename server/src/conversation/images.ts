import { realpath, readFile, stat } from "node:fs/promises";
import { sshReadCommandArgv } from "../bridge/ssh-command";
import type { ConversationImage } from "./session";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Only images Roamgate staged itself (POST /upload-image): a file named
 * img-*.<ext> in an upload folder of the private uploads directory.
 */
const UPLOAD_PATH =
  /^\/(?:[^/\0]+\/)*roamgate-uploads-[\w-]+\/upload-[\w-]+\/img-[\w-]+\.(png|jpe?g|gif|webp)$/i;

export function uploadedImageType(path: string): string | null {
  if (path.includes("/../") || path.includes("/./")) return null;
  const match = UPLOAD_PATH.exec(path);
  return match ? (MEDIA_TYPES[match[1]!.toLowerCase()] ?? null) : null;
}

type Run = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: Uint8Array | string; stderr: string }>;

/** Reads an uploaded image, here or on the connection's host, as base64. */
export function createImageReader(args: {
  sshHost?: string;
  run?: Run;
  shQuote: (value: string) => string;
}) {
  return async (path: string): Promise<ConversationImage> => {
    const media_type = uploadedImageType(path);
    if (!media_type)
      throw new Error("Only images uploaded to Roamgate can be sent");
    if (!args.sshHost) {
      const real = await realpath(path);
      if (uploadedImageType(real) !== media_type)
        throw new Error("Only images uploaded to Roamgate can be sent");
      const info = await stat(real);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
        throw new Error("The image is too large or missing");
      return { media_type, data: (await readFile(real)).toString("base64") };
    }
    if (!args.run) throw new Error("Cannot read images on this host");
    const result = await args.run(
      sshReadCommandArgv(
        args.sshHost,
        `f=${args.shQuote(path)}; [ -f "$f" ] && [ ! -L "$f" ] && [ "$(wc -c < "$f")" -le ${MAX_IMAGE_BYTES} ] && base64 < "$f"`,
        [],
        "agent_chat.image",
      ),
      30_000,
    );
    const text =
      typeof result.stdout === "string"
        ? result.stdout
        : new TextDecoder().decode(result.stdout);
    if (result.code !== 0 || !text.trim())
      throw new Error("The image could not be read on the host");
    return { media_type, data: text.replace(/\s+/g, "") };
  };
}
