/**
 * Images the user sent inline in a message (conversation mode, a pasted
 * image), loaded from the session by the message's uuid: as object URLs,
 * kept for the most recent ones so a chat redrawn does not load them again.
 */
const MAX_KEPT = 64;
const kept = new Map<string, Promise<string>>();

export type SentImage = { media_type: string; data: string };

/** The code the bridge answers a sent image that will never load with. */
export const SENT_IMAGE_GONE = "image_gone";

/** What came back is not an image: asking again would bring the same. */
export class SentImageGoneError extends Error {
  readonly code = SENT_IMAGE_GONE;
}

/**
 * A load that failed for good: the bridge said the image is not there, or
 * sent something that is not one. A timeout, a busy lane or a socket away
 * is not: those are tried again.
 */
export function isSentImageGone(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SENT_IMAGE_GONE
  );
}

export function sentImageBlob(image: SentImage): Blob {
  const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: image.media_type });
}

export function isSentImage(value: unknown): value is SentImage {
  if (typeof value !== "object" || value === null) return false;
  const { media_type, data } = value as Record<string, unknown>;
  return (
    typeof media_type === "string" &&
    media_type.startsWith("image/") &&
    typeof data === "string"
  );
}

/** The object URL of an image, loaded once per key while it is kept. */
export function sentImageUrl(
  key: string,
  load: () => Promise<unknown>,
): Promise<string> {
  const known = kept.get(key);
  if (known) {
    kept.delete(key);
    kept.set(key, known);
    return known;
  }
  const url = load().then((image) => {
    if (!isSentImage(image)) throw new SentImageGoneError("Not an image");
    return URL.createObjectURL(sentImageBlob(image));
  });
  kept.set(key, url);
  // A failure is tried again next time.
  url.catch(() => kept.delete(key));
  while (kept.size > MAX_KEPT) {
    const [oldest, value] = kept.entries().next().value as [
      string,
      Promise<string>,
    ];
    kept.delete(oldest);
    value.then(URL.revokeObjectURL, () => {});
  }
  return url;
}
