import { useEffect, useState } from "react";
import {
  type WorkspaceRef,
  type WorkspaceTree,
  workspaceRefKey,
  workspaceTreeAncestors,
} from "../../shared/workspaceTree";
import { mrReviewsCall, onMrReviewsChange } from "./mrReviews";

/**
 * The Workspaces-tree groups headed upstream and the workspaces in them
 * that are not (Reviews' settings), for the tree's menus: read once, then
 * again whenever a page or an agent changes them.
 */

export type UpstreamMarks = { groups: string[]; skip: WorkspaceRef[] };

let marks: UpstreamMarks | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<(marks: UpstreamMarks) => void>();
let following = false;

function load(): Promise<void> {
  loading ??= mrReviewsCall<UpstreamMarks>("upstream.marks")
    .then((answer) => {
      // A bridge without Reviews' marks answers something else.
      const value: UpstreamMarks = {
        groups: Array.isArray(answer?.groups) ? answer.groups : [],
        skip: Array.isArray(answer?.skip) ? answer.skip : [],
      };
      marks = value;
      for (const listener of listeners) listener(value);
    })
    .catch(() => {
      // Asked before the bridge was up: again in a moment, while shown.
      if (listeners.size) setTimeout(() => void load(), 3_000);
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function follow() {
  if (following) return;
  following = true;
  onMrReviewsChange((push) => {
    if (push.changed.includes("upstream")) void load();
  });
}

/** The marks, loaded on first use and kept current. */
export function useUpstreamMarks(): UpstreamMarks | null {
  const [value, setValue] = useState<UpstreamMarks | null>(marks);
  useEffect(() => {
    follow();
    listeners.add(setValue);
    if (!marks) void load();
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

/** The marked group a node is under (itself included), or null. */
export function headedGroupOf(
  tree: WorkspaceTree,
  marks: UpstreamMarks | null,
  nodeId: string | null,
): string | null {
  if (!marks?.groups?.length || !nodeId) return null;
  const set = new Set(marks.groups);
  return workspaceTreeAncestors(tree, nodeId).find((id) => set.has(id)) ?? null;
}

export function isSkipped(marks: UpstreamMarks | null, ref: WorkspaceRef) {
  const key = workspaceRefKey(ref);
  return !!marks?.skip?.some(
    (each) =>
      workspaceRefKey(each) === key ||
      (each.connection_id === ref.connection_id &&
        !!each.path &&
        each.path === ref.path),
  );
}

export async function setGroupHeaded(group: string, headed: boolean) {
  await mrReviewsCall("upstream.group", { group, headed });
  await load();
}

export async function setWorkspaceHeaded(ref: WorkspaceRef, headed: boolean) {
  await mrReviewsCall("upstream.workspace", { ref, headed });
  await load();
}
