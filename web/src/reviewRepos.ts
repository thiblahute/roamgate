import { useEffect, useMemo, useState } from "react";
import type { ReviewSnapshot } from "../../shared/review";
import { BoundedCache } from "./boundedCache";
import { plural } from "./components/MrThreadCard";
import { reviewCall, useReviewState } from "./review";
import type { WorkspaceRepo } from "./reviewModel";

/*
 * The repositories of a review's workspace, for its picker (p) and ( / ):
 * those with a review, those its panes' directories (and their
 * subprojects) have changes in, and those its agents edit.
 */

/** Scans cost a round trip to the host: reuse them for a minute. */
const repoScans = new BoundedCache<string, Promise<WorkspaceRepo[]>>({
  max: 32,
  ttlMs: 60_000,
});

/** Forgets the scans made (tests). */
export function clearRepoScans() {
  repoScans.clear();
}

/** The repositories the host finds under `dirs` and edited from `agentDirs`. */
export function scanRepos(
  connectionId: string,
  dirs: string[],
  agentDirs: string[],
): Promise<WorkspaceRepo[]> {
  const key = `${connectionId}\n${[...dirs].sort().join("\n")}\n-\n${agentDirs.join("\n")}`;
  const cached = repoScans.get(key);
  if (cached) return cached;
  // The picker's list: background work, behind what the user is reading.
  const repos = reviewCall<{ repos: WorkspaceRepo[] }>(
    connectionId,
    "review.repos",
    { paths: dirs, agent_paths: agentDirs },
    undefined,
    { lane: "background" },
  ).then(
    (result) => result.repos,
    () => [],
  );
  repoScans.set(key, repos);
  return repos;
}

/**
 * The scanned repositories with those of the workspace's other reviews
 * (and their comment counts), the review's own always among them; by
 * path, so ( and ) go the same way from every repository.
 */
export function workspaceRepos(
  scanned: readonly WorkspaceRepo[],
  sessions: Iterable<ReviewSnapshot>,
  session: ReviewSnapshot["session"],
): WorkspaceRepo[] {
  const byRoot = new Map<string, WorkspaceRepo>();
  for (const repo of scanned) byRoot.set(repo.root, { ...repo });
  for (const snapshot of sessions) {
    const other = snapshot.session;
    if (
      other.connectionId !== session.connectionId ||
      !session.workspaceId ||
      other.workspaceId !== session.workspaceId ||
      // A chat's threads, a rendered file's or an effort's are not a
      // checkout's.
      other.target.kind === "chat" ||
      other.target.kind === "rendered" ||
      other.target.kind === "effort"
    )
      continue;
    const entry = byRoot.get(other.root) ?? { root: other.root };
    entry.comments =
      (entry.comments ?? 0) +
      snapshot.threads.filter((t) => t.kind !== "merge-request").length;
    byRoot.set(other.root, entry);
  }
  if (!byRoot.has(session.root))
    byRoot.set(session.root, { root: session.root });
  return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * The repositories of the review's workspace (see workspaceRepos); the
 * panes' directories are scanned once the review shows.
 */
export function useWorkspaceRepos(
  connectionId: string,
  session: ReviewSnapshot["session"],
  dirs: string[],
  agentDirs: string[],
  shown: boolean,
): WorkspaceRepo[] {
  const [scanned, setScanned] = useState<WorkspaceRepo[]>([]);
  const dirsKey = dirs.join("\n");
  const agentKey = agentDirs.join("\n");
  useEffect(() => {
    // Out of sight, the panes' directories are scanned once it shows.
    if (!shown) return;
    let cancelled = false;
    const list = dirsKey ? dirsKey.split("\n") : [];
    const agents = agentKey ? agentKey.split("\n") : [];
    void scanRepos(connectionId, [session.root, ...list], agents).then(
      (repos) => {
        if (!cancelled) setScanned(repos);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId, session.root, dirsKey, agentKey, shown]);
  const { sessions } = useReviewState();
  return useMemo(
    () => workspaceRepos(scanned, sessions.values(), session),
    [scanned, sessions, session],
  );
}

/** Nothing committed beyond its default branch, but work in progress. */
export function worktreeOnly(repo: WorkspaceRepo): boolean {
  return !repo.ahead && repo.dirty === true;
}

/** A repository as the picker lists it: its name, then what it has. */
export function repoLabel(repo: WorkspaceRepo): string {
  const name = repo.root.split("/").pop() ?? repo.root;
  const facts = [
    repo.branch,
    repo.ahead ? `${repo.ahead} ahead` : "",
    repo.dirty ? "uncommitted" : "",
    repo.comments ? plural(repo.comments, "comment") : "",
  ].filter(Boolean);
  return facts.length ? `${name} · ${facts.join(", ")}` : name;
}
