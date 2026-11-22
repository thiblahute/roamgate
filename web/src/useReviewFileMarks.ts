import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSnapshot, ReviewThread } from "../../shared/review";
import type { ConnectionClient } from "./api";
import { worktreeReview } from "./changesReview";
import { useGitDiffSummaryState } from "./gitDiffSummaryStore";
import {
  rememberReviewSnapshot,
  reviewCall,
  useReviewSnapshots,
  useReviewState,
} from "./review";
import {
  changedFileMarks,
  changedFileReviewed,
  hasFileMarks,
  otherFileMarks,
  otherReviewFiles,
  reviewedFileOf,
} from "./reviewFiles";
import type { ReviewedFile } from "./reviewNavigation";
import type { GitDiffFile } from "./types";

/*
 * The checkout's review as Files shows it: which files are the review's and
 * ticked reviewed, the same marks Changes reads (a changed file's tick from
 * its combined diff, as Changes reads it), and the tick toggled from Files.
 */

/** A file of the review, as Files marks it. */
export type ReviewFileMark = {
  reviewed: boolean;
  /** A file with no change, in the review by a comment or its tick. */
  other: boolean;
};

export type ReviewFileMarks = {
  /** The repository's root the paths are relative to, once known. */
  root: string | undefined;
  /** The review's files, by their path in the repository. */
  marks: ReadonlyMap<string, ReviewFileMark>;
  /** Whether a path (in the repository) is changed in the checkout. */
  changed: (path: string) => boolean;
  /** Ticks a file of the checkout reviewed, or unticks it. */
  toggle: (path: string) => Promise<void>;
};

const NO_MARKS: ReadonlyMap<string, ReviewFileMark> = new Map();

/** The review's files and ticks for Files' tree and preview. */
export function useReviewFileMarks(args: {
  client: Pick<ConnectionClient, "connectionId" | "generation" | "call">;
  workspaceId: string | undefined;
  resourceKey: string;
  /** The checkout's threads written from the views (App's feedback). */
  threads: readonly ReviewThread[];
  enabled: boolean;
}): ReviewFileMarks {
  const { client, workspaceId, resourceKey, threads, enabled } = args;
  const summary = useGitDiffSummaryState(
    client,
    enabled ? workspaceId : undefined,
    "working",
    resourceKey,
  ).summary;
  const root = summary?.root;
  const { summaries } = useReviewState();
  // The checkout's worktree review, found among the summaries; its marks
  // once its snapshot is read.
  const foundId = useMemo(
    () =>
      enabled && root
        ? (worktreeReview(summaries.values(), client.connectionId, root)
            ?.session.id ?? null)
        : null,
    [client.connectionId, enabled, root, summaries],
  );
  const snapshots = useReviewSnapshots(
    enabled && root
      ? { connectionId: client.connectionId, roots: [root] }
      : null,
  );
  const snapshot = (foundId && snapshots.get(foundId)) || null;
  const reviewed = snapshot?.session.reviewed;
  const changedPaths = useMemo(
    () => new Set((summary?.entries ?? []).map((entry) => entry.path)),
    [summary],
  );
  /*
   * Each changed file's lines as Changes reads them, for its tick: read
   * only for files with a mark, and again once the changes read say the
   * file changed (`changes`: each entry's kind, path and line counts; the
   * summary is read again often with nothing changed).
   */
  const changes = useMemo(
    () =>
      (summary?.entries ?? [])
        .map(
          (entry) =>
            `${entry.kind}:${entry.path}:${entry.additions ?? ""}:${entry.deletions ?? ""}`,
        )
        .join("\n"),
    [summary],
  );
  const [diffs, setDiffs] = useState<{
    changes: string | null;
    files: ReadonlyMap<string, ReviewedFile | null>;
  }>({ changes: null, files: new Map() });
  const loading = useRef(new Set<string>());
  const readFile = useCallback(
    async (path: string): Promise<ReviewedFile | null> => {
      const read = (await client.call("git.diff_file", {
        workspace_id: workspaceId,
        mode: "working",
        path,
        kind: "combined",
      })) as GitDiffFile;
      return reviewedFileOf(path, read.diff ?? "");
    },
    [client, workspaceId],
  );
  useEffect(() => {
    if (!enabled || !summary || !reviewed) return;
    const known = diffs.changes === changes ? diffs.files : new Map();
    const wanted = [...changedPaths].filter(
      (path) =>
        hasFileMarks(path, reviewed) &&
        !known.has(path) &&
        !loading.current.has(path),
    );
    if (!wanted.length) {
      if (diffs.changes !== changes) setDiffs({ changes, files: known });
      return;
    }
    // Always kept, under the changes they were read for: a read the
    // changes moved on from is asked again (the state changed), never lost.
    for (const path of wanted) loading.current.add(path);
    void Promise.all(
      wanted.map(async (path) => {
        try {
          return [path, await readFile(path)] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((read) => {
      for (const [path] of read) loading.current.delete(path);
      setDiffs((current) => {
        const files = new Map(current.changes === changes ? current.files : []);
        for (const [path, file] of read) files.set(path, file);
        return { changes, files };
      });
    });
  }, [changedPaths, changes, diffs, enabled, readFile, reviewed, summary]);
  const ownThreads = useMemo(() => {
    // The worktree review's own: an older rendered file's review keeps its
    // threads (shown in the file's preview, and in Changes on a change).
    return foundId
      ? threads.filter((thread) => thread.sessionId === foundId)
      : [];
  }, [foundId, threads]);
  const marks = useMemo(() => {
    if (!enabled || !root) return NO_MARKS;
    const found = new Map<string, ReviewFileMark>();
    for (const other of otherReviewFiles(
      ownThreads,
      reviewed ?? {},
      changedPaths,
    ))
      found.set(other.path, { reviewed: other.reviewed, other: true });
    if (reviewed && diffs.changes === changes)
      for (const [path, file] of diffs.files)
        if (
          file &&
          changedPaths.has(path) &&
          changedFileReviewed(file, reviewed)
        )
          found.set(path, { reviewed: true, other: false });
    return found;
  }, [changedPaths, ownThreads, diffs, enabled, reviewed, root, changes]);
  const snapshotRef = useRef<ReviewSnapshot | null>(snapshot);
  snapshotRef.current = snapshot;
  const foundIdRef = useRef(foundId);
  foundIdRef.current = foundId;
  const toggle = useCallback(
    async (path: string) => {
      if (!root) throw new Error("no repository to review");
      const id = foundIdRef.current;
      // Not read yet: read now, its marks are what the change is made on.
      const current =
        snapshotRef.current ??
        (id
          ? await reviewCall<ReviewSnapshot>(
              client.connectionId,
              "review.get",
              {
                session_id: id,
              },
            )
          : null);
      const now = current?.session.reviewed ?? {};
      let writes: Record<string, string | null>;
      if (changedPaths.has(path)) {
        const file = await readFile(path);
        if (!file) throw new Error(`${path} has no change to review`);
        writes = changedFileMarks(file, !changedFileReviewed(file, now), now);
        setDiffs((was) => ({
          changes,
          files: new Map([
            ...(was.changes === changes ? was.files : []),
            [path, file],
          ]),
        }));
      } else {
        const ticked = marks.get(path)?.reviewed ?? false;
        writes = otherFileMarks(path, !ticked);
      }
      if (!Object.keys(writes).length) return;
      // The checkout's review, opened for a first mark as a comment opens it.
      const sessionId =
        current?.session.id ??
        (
          await reviewCall<ReviewSnapshot>(client.connectionId, "review.open", {
            workspace_id: workspaceId,
            path: root,
            target: { kind: "worktree" },
          })
        ).session.id;
      rememberReviewSnapshot(
        await reviewCall<ReviewSnapshot>(client.connectionId, "review.update", {
          session_id: sessionId,
          reviewed: writes,
        }),
      );
    },
    [changedPaths, client, marks, readFile, root, changes, workspaceId],
  );
  const changed = useCallback(
    (path: string) => changedPaths.has(path),
    [changedPaths],
  );
  return { root, marks, changed, toggle };
}
