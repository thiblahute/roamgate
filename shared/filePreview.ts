// Keep Files, Changes and SSH reads on the same image-format contract.
export const IMAGE_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ["svg", "image/svg+xml"],
  ["apng", "image/apng"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["jpe", "image/jpeg"],
  ["jfif", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["avif", "image/avif"],
]);

// Served inline for <audio>; whether a codec plays depends on the browser.
export const AUDIO_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["weba", "audio/webm"],
]);

// Served inline for <video>, in ranges as the player asks: any size.
export const VIDEO_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["webm", "video/webm"],
  ["ogv", "video/ogg"],
  ["mov", "video/quicktime"],
]);

export const AUDIO_INLINE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
export const HTML_PREVIEW_MAX_BYTES = 512 * 1024;

export function isHtmlPath(path: string) {
  return /\.html?$/i.test(path);
}

export function imageMimeForPath(path: string) {
  return (
    IMAGE_MIME_TYPES.get(path.toLowerCase().split(".").pop() ?? "") ?? null
  );
}

export function audioMimeForPath(path: string) {
  return (
    AUDIO_MIME_TYPES.get(path.toLowerCase().split(".").pop() ?? "") ?? null
  );
}

export function videoMimeForPath(path: string) {
  return (
    VIDEO_MIME_TYPES.get(path.toLowerCase().split(".").pop() ?? "") ?? null
  );
}
