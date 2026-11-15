import type { Pane } from "./types";

/*
 * The repository Changes shows (plan: review into the inspector, phase 7):
 * the workspace's own checkout, or another repository of the workspace
 * picked in its scope line (p, ( and )). Another repository's diffs are
 * kept apart by their resource key, which carries its root, and asked for
 * with that root.
 */

const REPO_MARK = "\nrepo:";

/** The resource key of `root`'s changes, in the workspace's `resourceKey`. */
export function repoResourceKey<T extends string | undefined>(
  resourceKey: T,
  root: string | null | undefined,
): T | string {
  return root ? `${resourceKey ?? ""}${REPO_MARK}${root}` : resourceKey;
}

/** The repository a resource key is of, when not the workspace's own. */
export function repoRootOf(
  resourceKey: string | undefined,
): string | undefined {
  const at = resourceKey?.indexOf(REPO_MARK) ?? -1;
  return resourceKey && at >= 0
    ? resourceKey.slice(at + REPO_MARK.length)
    : undefined;
}

/** The directories holding a workspace's repositories, and its agents'. */
export function workspaceRepoDirs(panes: readonly Pane[]): {
  dirs: string[];
  agentDirs: string[];
} {
  const dirOf = (pane: Pane) => pane.foreground_cwd ?? pane.cwd ?? "";
  const dirs = panes.map(dirOf).filter((dir) => dir.startsWith("/"));
  const agentDirs = panes
    .filter((pane) => pane.agent)
    .map((pane) => pane.cwd ?? dirOf(pane))
    .filter((dir) => dir.startsWith("/"));
  return { dirs: [...new Set(dirs)], agentDirs: [...new Set(agentDirs)] };
}

/**
 * The repository Changes last showed in each workspace (by the inspector's
 * resource key): the review toggle shows it again.
 */
const lastRepos = new Map<string, string>();

/** The root shown last, "" for the workspace's own, absent when none. */
export function lastChangesRepo(resourceKey: string): string | undefined {
  return lastRepos.get(resourceKey);
}

export function rememberChangesRepo(
  resourceKey: string,
  root: string | undefined,
) {
  lastRepos.set(resourceKey, root ?? "");
}
