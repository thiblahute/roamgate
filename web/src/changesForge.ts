import { useEffect, useRef, useState } from "react";
import {
  REVIEW_USER,
  type ReviewSession,
  type ReviewSnapshot,
  type ReviewThread,
} from "../../shared/review";
import { reviewCall } from "./review";
import { fileLines, relocateLine } from "./reviewModel";

/*
 * A merge or pull request's review in Changes (plan: review into the
 * inspector, phase 7): what the review pane does with the forge, kept out
 * of Changes' diff. Its discussions are read again while shown, found
 * again in today's file when written on an older head, and drawn on their
 * lines, above the diff, or counted as outside the commit shown. Nothing
 * here writes to the forge but drafts: no control labelled Send reaches
 * it (user decision 2026-11-13).
 */

/** How often a shown merge request's discussions are read again. */
export const FORGE_REFRESH_MS = 60_000;
/** Back in view sooner than this after the last read: not read again. */
export const FORGE_REFRESH_AGAIN_MS = 30_000;

/** "GitHub" for a pull request's review, else "GitLab". */
export function forgeName(session: Pick<ReviewSession, "target"> | undefined) {
  const { target } = session ?? {};
  return target?.kind === "mr" && /\/pull\/\d+/.test(target.url)
    ? "GitHub"
    : "GitLab";
}

/** An older forge discussion found again on today's line. */
export type ForgeRelocation = { line: number; wasLine: number; text: string };

/**
 * Reads the merge request's discussions again while `on` (the review shown
 * with its forge), every minute and as soon as the page is back in view.
 */
export function useForgePoll(
  connectionId: string,
  sessionId: string | null,
  on: boolean,
) {
  const askedAt = useRef(0);
  useEffect(() => {
    if (!on || !sessionId) return;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      if (Date.now() - askedAt.current < FORGE_REFRESH_AGAIN_MS) return;
      busy = true;
      askedAt.current = Date.now();
      try {
        await reviewCall(connectionId, "review.gitlab.refresh", {
          session_id: sessionId,
          poll: true,
        });
      } catch {
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), FORGE_REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connectionId, sessionId, on]);
}

/**
 * The forge discussions written on an older head, found again in today's
 * file (the all-changes view only): each looked for once per head.
 */
export function useForgeRelocations({
  connectionId,
  sessionId,
  threads,
  headSha,
  enabled,
  worktree,
}: {
  connectionId: string;
  sessionId: string | null;
  threads: readonly ReviewThread[];
  /** The head the review's diff shows; null until read. */
  headSha: string | null;
  enabled: boolean;
  /** The checkout's review: today's file is the working tree's. */
  worktree: boolean;
}): ReadonlyMap<string, ForgeRelocation> {
  const [found, setFound] = useState<ReadonlyMap<string, ForgeRelocation>>(
    () => new Map(),
  );
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || !headSha || !sessionId) return;
    const stale = threads.filter(
      (thread) =>
        thread.kind === "merge-request" &&
        thread.gitlab?.headSha &&
        thread.gitlab.headSha !== headSha &&
        thread.anchor.side === "new" &&
        thread.anchor.path &&
        thread.anchor.line &&
        !found.has(thread.id) &&
        !tried.current.has(`${thread.id}\0${headSha}`),
    );
    if (!stale.length) return;
    let cancelled = false;
    void (async () => {
      const files = new Map<string, Promise<string[] | null>>();
      const read = (path: string, rev: string) => {
        const key = `${rev}\0${path}`;
        let pending = files.get(key);
        if (!pending) {
          pending = reviewCall<{ text: string }>(connectionId, "review.file", {
            session_id: sessionId,
            path,
            rev,
          }).then(
            (result) => fileLines(result.text),
            () => null,
          );
          files.set(key, pending);
        }
        return pending;
      };
      const next = new Map(found);
      for (const thread of stale) {
        const path = thread.anchor.path!;
        const [old, current] = await Promise.all([
          read(path, thread.gitlab!.headSha!),
          read(path, worktree ? "" : headSha),
        ]);
        if (cancelled) return;
        tried.current.add(`${thread.id}\0${headSha}`);
        if (!old || !current) continue;
        const line = relocateLine(old, thread.anchor.line!, current);
        if (line === null) continue;
        next.set(thread.id, {
          line,
          wasLine: thread.anchor.line!,
          text: current[line - 1] ?? "",
        });
      }
      if (!cancelled && next.size > found.size) setFound(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, sessionId, threads, headSha, enabled, worktree, found]);
  return found;
}

/**
 * Where a forge discussion shows in the view: on its line (moved there when
 * found again in today's file), on the whole request (above the diff, an
 * older head's not found again), or not in this commit's view (null).
 * Other threads are returned as they are.
 */
export function placeForgeThread(
  thread: ReviewThread,
  {
    viewCommit,
    headSha,
    relocations,
  }: {
    /** The commit shown; null for all the changes; undefined: no views. */
    viewCommit: string | null | undefined;
    headSha: string | null;
    relocations: ReadonlyMap<string, ForgeRelocation>;
  },
): ReviewThread | null {
  if (thread.kind !== "merge-request" || !thread.anchor.path) return thread;
  if (viewCommit) return thread.gitlab?.headSha === viewCommit ? thread : null;
  const moved = relocations.get(thread.id);
  if (moved)
    return {
      ...thread,
      anchor: {
        ...thread.anchor,
        line: moved.line,
        side: "new",
        text: moved.text,
      },
    };
  if (headSha && thread.gitlab?.headSha && thread.gitlab.headSha !== headSha)
    return { ...thread, anchor: {} };
  return thread;
}

/** Forge discussions on code the commit shown does not show. */
export function forgeOutside(
  threads: readonly ReviewThread[],
  viewCommit: string | null | undefined,
): number {
  if (!viewCommit) return 0;
  return threads.filter(
    (thread) =>
      thread.kind === "merge-request" &&
      thread.anchor.path &&
      thread.gitlab?.headSha !== viewCommit,
  ).length;
}

/** An agent's thread in a merge request's review, not yet the user's. */
export function adoptable(
  session: Pick<ReviewSession, "gitlab"> | undefined,
  thread: ReviewThread,
): boolean {
  return (
    !!session?.gitlab &&
    thread.kind !== "merge-request" &&
    !thread.gitlab &&
    !thread.resolved &&
    thread.comments.some((comment) => comment.author !== REVIEW_USER)
  );
}

/** The user's drafts on the forge: their pending review there. */
export function forgeDraftCount(threads: readonly ReviewThread[]): number {
  return (
    threads.filter((thread) => thread.gitlab?.draftId !== undefined).length +
    threads.reduce(
      (count, thread) =>
        count +
        thread.comments.filter((comment) => comment.gitlabDraftId !== undefined)
          .length,
      0,
    )
  );
}

/**
 * The review's comments waiting here to be put on the forge as drafts
 * (the local review's and the agent's), and an overall comment not sent.
 */
export function localDraftCount(snapshot: ReviewSnapshot): number {
  return (
    snapshot.threads.filter(
      (thread) => thread.kind === "draft" && !thread.gitlab,
    ).length + (snapshot.session.summaryUnsent ? 1 : 0)
  );
}

/** Why agents are kept from a merge request's review; null: they are not. */
export function agentsKeptReason(
  snapshot: Pick<ReviewSnapshot, "session" | "mergeRequest"> | null,
): string | null {
  if (!snapshot || snapshot.session.target.kind !== "mr") return null;
  if (snapshot.mergeRequest?.security === false) return null;
  return snapshot.mergeRequest?.security
    ? "This security merge request is not shared with agents."
    : "Agents wait until GitLab tells whether this merge request is confidential.";
}
