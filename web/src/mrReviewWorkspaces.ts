import { useEffect, useSyncExternalStore } from "react";
import { bridge } from "./api";

/**
 * The review workspaces (one per project, reused for each request), for
 * the Workspaces sidebar: which they are, and the request each is checked
 * out on. Read from the bridge's own records, never from a forge.
 */

export type MrReviewWorkspace = {
  connectionId: string;
  workspaceId: string;
  project: string;
  current?: { key: string; label: string; url: string };
};

let known: MrReviewWorkspace[] = [];
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export async function loadMrReviewWorkspaces() {
  try {
    const reply = (await bridge.call(
      "bridge.mr_reviews.workspaces",
      {},
      15_000,
      { lane: "background" },
    )) as { workspaces?: MrReviewWorkspace[] };
    known = Array.isArray(reply?.workspaces) ? reply.workspaces : [];
    for (const listener of listeners) listener();
  } catch {}
}

/** Read again soon: a request was opened or checked out. */
export function refreshMrReviewWorkspaces() {
  void loadMrReviewWorkspaces();
}

export function mrReviewWorkspaceOf(
  list: readonly MrReviewWorkspace[],
  connectionId: string,
  workspaceId: string,
): MrReviewWorkspace | undefined {
  return list.find(
    (entry) =>
      entry.connectionId === connectionId && entry.workspaceId === workspaceId,
  );
}

/** The review workspaces, read on mount and every minute while shown. */
export function useMrReviewWorkspaces(): readonly MrReviewWorkspace[] {
  useEffect(() => {
    users++;
    if (users === 1) {
      void loadMrReviewWorkspaces();
      timer = setInterval(() => void loadMrReviewWorkspaces(), 60_000);
    }
    return () => {
      users--;
      if (!users && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => known,
    () => known,
  );
}
