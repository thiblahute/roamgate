/** What stands in for a pasted image until it is stored. */
export function imageUploadToken(n: number): string {
  return `![Adding image ${n}...]()`;
}

/** Whether a text still waits for one of its images to be stored. */
export function imageUploadPending(text: string): boolean {
  return /!\[Adding image \d+\.\.\.\]\(\)/.test(text);
}

/** Said when a save waits for an image. */
export const IMAGE_UPLOADING =
  "An image is still uploading: save once it is in.";

/**
 * A comment's first line as a folded thread shows it: its images by their
 * names, not the Markdown linking their files.
 */
export function summaryLine(text: string): string {
  return (text.split("\n")[0] ?? "").replace(
    /!\[([^\]\n]*)\]\((?:<[^>\n]*>|[^)\s]*)\)/g,
    (_, alt: string) => `[${alt || "image"}]`,
  );
}
