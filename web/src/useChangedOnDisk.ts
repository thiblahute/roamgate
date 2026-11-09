import { useEffect, useRef, useState } from "react";
import type { ConnectionClient } from "./api";
import {
  fileExplorerRefreshKey,
  subscribeFileExplorerRefresh,
} from "./fileExplorerRefresh";
import {
  lastStepCompletionKey,
  subscribeLastStepCompletion,
} from "./lastStepCompletionStore";

/*
 * "Changed on disk": the Files preview tells when the file it shows was
 * written since it was read, and leaves the reload to the reader (their
 * place and comments stay). Nothing pushes a file's changes, so its stat
 * (size and modification time, one call, nothing read) is checked while
 * the preview is seen: every few seconds, and at once when an agent step
 * completes in the workspace or a Git action changes its files. Over SSH
 * the check runs in the host's background lane, behind what the user does.
 */

/** How often a shown file's stat is checked, while it is seen. */
export const CHANGED_ON_DISK_POLL_MS = 4000;

export type FileStat = { size: number; mtime_ms: number };

/** Whether what `stat` says differs from what the preview read. */
export function changedOnDisk(shown: FileStat, stat: FileStat): boolean {
  return shown.size !== stat.size || shown.mtime_ms !== stat.mtime_ms;
}

/**
 * Whether the file shown changed on disk since it was read. `shown` is the
 * preview read (a new one, the preview's own reload, starts over); `seen`
 * says whether the preview is on screen now.
 */
export function useChangedOnDisk({
  client,
  workspaceId,
  path,
  shown,
  seen,
  pollMs = CHANGED_ON_DISK_POLL_MS,
}: {
  client: Pick<ConnectionClient, "connectionId" | "generation" | "call">;
  workspaceId: string | undefined;
  path: string | undefined;
  /** The preview read, compared by identity: a new read is a new start. */
  shown: (FileStat & object) | null;
  seen: () => boolean;
  pollMs?: number;
}): boolean {
  const [changedFor, setChangedFor] = useState<object | null>(null);
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const changed = !!shown && changedFor === shown;
  useEffect(() => {
    if (!shown || !workspaceId || !path || changed) return;
    let live = true;
    let running = false;
    const check = () => {
      if (!live || running) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (!seenRef.current()) return;
      running = true;
      void Promise.resolve(
        client.call("file.stat", { workspace_id: workspaceId, path }, 15_000, {
          lane: "background",
        }),
      )
        .then((stat: FileStat) => {
          // A stat taken for a read since replaced says nothing of it.
          if (live && stat && changedOnDisk(shown, stat)) setChangedFor(shown);
        })
        .catch(() => {
          /* Gone or unreachable: the next check, or nothing to tell. */
        })
        .finally(() => {
          running = false;
        });
    };
    const timer = setInterval(check, pollMs);
    const stopStep = subscribeLastStepCompletion(
      lastStepCompletionKey(client.connectionId, workspaceId),
      check,
    );
    const stopGit = subscribeFileExplorerRefresh(
      fileExplorerRefreshKey(client, workspaceId),
      check,
    );
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      stopStep();
      stopGit();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, workspaceId, path, shown, changed, pollMs]);
  return changed;
}
