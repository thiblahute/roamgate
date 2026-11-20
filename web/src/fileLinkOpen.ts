import type { FileLink } from "./reviewFileLinks";

/**
 * A file a comment links to, asked open in a workspace's Files preview by a
 * view outside the inspector (an agent chat in its pane): App opens it, at
 * the link's line or rendered, in a new tab when asked.
 */
export type FileLinkOpenRequest = {
  connectionId: string;
  workspaceId: string;
  link: FileLink;
  newTab: boolean;
};

const listeners = new Set<(request: FileLinkOpenRequest) => void>();

/** Asks App to open the file; false when no App is listening. */
export function requestFileLinkOpen(request: FileLinkOpenRequest): boolean {
  if (!listeners.size) return false;
  for (const listener of [...listeners]) listener(request);
  return true;
}

export function onFileLinkOpen(
  listener: (request: FileLinkOpenRequest) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
