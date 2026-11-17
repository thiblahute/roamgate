import type { ReviewThread } from "../../shared/review";
import type { ReviewAnnotation } from "./annotations";
import type { Pane } from "./types";

/*
 * The repository Changes shows:
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

/** Where a pane is: its foreground program's directory, else its own. */
export function paneDir(pane: Pane | undefined): string {
  return pane?.foreground_cwd ?? pane?.cwd ?? "";
}

/** The directories holding a workspace's repositories, and its agents'. */
export function workspaceRepoDirs(panes: readonly Pane[]): {
  dirs: string[];
  agentDirs: string[];
} {
  const dirs = panes.map(paneDir).filter((dir) => dir.startsWith("/"));
  const agentDirs = panes
    .filter((pane) => pane.agent)
    .map((pane) => pane.cwd ?? paneDir(pane))
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

const trimRoot = (root: string) => root.replace(/\/+$/, "") || "/";

/** The repository Changes shows, and whether it is the workspace's own. */
export type ShownRepo = { root: string; own: boolean };

/**
 * The comments of the repository Changes shows: a thread is its review's
 * repository's (the session's root), a comment not yet a thread the one it
 * names (`root`), else the workspace's own. Threads are matched by their
 * file's path within a repository, so another repository's file of the
 * same path never gets them. Without a repository named, all of them.
 */
export function repoFeedback(
  annotations: readonly ReviewAnnotation[],
  threads: readonly ReviewThread[],
  sessionRoot: (sessionId: string) => string | undefined,
  repo: ShownRepo | undefined,
): { annotations: ReviewAnnotation[]; threads: ReviewThread[] } {
  if (!repo) return { annotations: [...annotations], threads: [...threads] };
  const shown = trimRoot(repo.root);
  const noteRoot = (note: ReviewAnnotation) =>
    note.source === "diff" ? note.root : undefined;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const isShown = (root: string | undefined) =>
    root === undefined ? repo.own : trimRoot(root) === shown;
  const threadShown = (thread: ReviewThread, note?: ReviewAnnotation) => {
    const root = sessionRoot(thread.sessionId);
    return root !== undefined
      ? trimRoot(root) === shown
      : isShown(note && noteRoot(note));
  };
  const notes = new Map(annotations.map((note) => [note.id, note]));
  return {
    annotations: annotations.filter((note) => {
      const thread = byId.get(note.id);
      return thread ? threadShown(thread, note) : isShown(noteRoot(note));
    }),
    threads: threads.filter((thread) =>
      threadShown(thread, notes.get(thread.id)),
    ),
  };
}
