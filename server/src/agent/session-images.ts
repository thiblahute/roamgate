import { isRecord } from "./session-utils";

const MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type SessionImage = { media_type: string; data: string };

/** Base64 characters: a larger image is left out. */
const MAX_IMAGE_CHARS = 16 * 1024 * 1024;

/** Well-formed base64 a browser decodes: no stray length or padding. */
function validBase64(data: unknown): data is string {
  return (
    typeof data === "string" &&
    data.length > 0 &&
    data.length <= MAX_IMAGE_CHARS &&
    data.length % 4 !== 1 &&
    (!data.endsWith("=") || data.length % 4 === 0) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data)
  );
}

/** The code a sent image that will never load is answered with. */
export const SESSION_IMAGE_GONE = "image_gone";

/**
 * A sent image that is not there to load (not in the session, or asked for
 * wrongly): trying again will not change it, so the chat says so instead of
 * waiting.
 */
export class SessionImageGoneError extends Error {
  readonly code = SESSION_IMAGE_GONE;
}

/**
 * The index-th image the user sent inline in the transcript record with this
 * uuid (a Claude JSONL), or null: a conversation-mode message or a pasted
 * image keeps it there as base64, with no file to load.
 */
export function sessionImage(
  jsonl: string,
  uuid: string,
  index: number,
): SessionImage | null {
  if (!uuid || !Number.isSafeInteger(index) || index < 0) return null;
  const needle = JSON.stringify(uuid);
  for (const line of jsonl.split("\n")) {
    if (!line.includes(needle)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.uuid !== uuid || record.type !== "user")
      continue;
    const message = isRecord(record.message) ? record.message : record;
    if (!Array.isArray(message.content)) return null;
    const image = message.content.filter(
      (part) => isRecord(part) && part.type === "image",
    )[index];
    const source = isRecord(image) ? image.source : null;
    if (
      !isRecord(source) ||
      source.type !== "base64" ||
      typeof source.media_type !== "string" ||
      !MEDIA_TYPES.has(source.media_type) ||
      !validBase64(source.data)
    )
      return null;
    return { media_type: source.media_type, data: source.data };
  }
  return null;
}
