/**
 * Images given to a model are made smaller first: a phone's photo is 12
 * megapixels and several megabytes, while a model sees at most about 1568
 * pixels on the long edge and takes at most 5 MB.
 */
export const MODEL_IMAGE_MAX_EDGE = 1568;
export const MODEL_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024;

/** The size an image is drawn at to fit `maxEdge`, or null when it fits. */
export function scaledSize(
  width: number,
  height: number,
  maxEdge = MODEL_IMAGE_MAX_EDGE,
): { width: number; height: number } | null {
  const edge = Math.max(width, height);
  if (edge <= maxEdge || edge <= 0) return null;
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
}

/**
 * The image as a model takes it: smaller when it is larger than that, a
 * screenshot kept as PNG (its text stays sharp) unless that is still too
 * heavy, a photo as JPEG. Anything that cannot be drawn (a GIF, which
 * would lose its frames; a type the browser cannot read) is kept as is.
 */
export async function downscaleImage(
  file: File,
  maxEdge = MODEL_IMAGE_MAX_EDGE,
): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const size = scaledSize(bitmap.width, bitmap.height, maxEdge);
    if (!size && file.size <= MODEL_IMAGE_MAX_BYTES) return file;
    const { width, height } = size ?? bitmap;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    let blob = await encode(
      canvas,
      file.type === "image/png" ? "image/png" : "image/jpeg",
    );
    if (blob && blob.size > MODEL_IMAGE_MAX_BYTES && blob.type === "image/png")
      blob = await encode(canvas, "image/jpeg");
    // Smaller in pixels yet heavier (a tiny PNG made a JPEG): the original.
    if (!blob || (blob.size >= file.size && file.size <= MODEL_IMAGE_MAX_BYTES))
      return file;
    const stem = file.name.replace(/\.[^.]*$/, "") || "image";
    const extension = blob.type === "image/png" ? "png" : "jpg";
    return new File([blob], `${stem}.${extension}`, { type: blob.type });
  } finally {
    bitmap.close();
  }
}
