import { useEffect, useState } from "react";
import {
  type WorkspaceRef,
  type WorkspaceTree,
  workspaceTreeAncestors,
} from "../../shared/workspaceTree";
import {
  sameUpstreamWorkspace,
  upstreamWorkspaceHome,
} from "../../shared/mrReviews";
import { mrReviewsCall, onMrReviewsChange } from "./mrReviews";

/**
 * The Workspaces-tree groups headed upstream and the workspaces in them
 * that are not (Reviews' settings), with the workspaces headed upstream by
 * themselves, for the tree's menus: read once, then again whenever a page
 * or an agent changes them.
 */

export type UpstreamMarks = {
  groups: string[];
  skip: WorkspaceRef[];
  /** Headed upstream by themselves, in no marked group. */
  workspaces: WorkspaceRef[];
};

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
        workspaces: Array.isArray(answer?.workspaces) ? answer.workspaces : [],
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
  return !!marks?.skip?.some((each) => sameUpstreamWorkspace(each, ref));
}

/** The mark of a workspace headed upstream by itself, or undefined. */
export function ownUpstreamMark(
  marks: UpstreamMarks | null,
  ref: WorkspaceRef,
): WorkspaceRef | undefined {
  return marks?.workspaces?.find((each) => sameUpstreamWorkspace(each, ref));
}

export async function setGroupHeaded(group: string, headed: boolean) {
  await mrReviewsCall("upstream.group", { group, headed });
  await load();
}

/**
 * A workspace headed upstream or not: in a marked group it is skipped or
 * back; elsewhere it is marked by itself or unmarked.
 */
export async function setWorkspaceHeaded(ref: WorkspaceRef, headed: boolean) {
  await mrReviewsCall("upstream.workspace", { ref, headed });
  await load();
}

/** What a menu opens the declaring of an effort with. */
export type UpstreamDeclarePrefill = { home?: string; source?: string };

export type UpstreamMenuItem = {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  title?: string;
  action: () => void;
};

/**
 * A workspace's Headed upstream items: in a marked group, as the group
 * (and the workspace skipped there or back); elsewhere the workspace by
 * itself. Declaring an effort on its home when it is headed upstream.
 */
export function workspaceUpstreamItems(input: {
  tree: WorkspaceTree;
  marks: UpstreamMarks | null;
  /** The workspace: its node's reference, else the live one's. */
  ref: WorkspaceRef;
  /** Its node's parent, when it has a node. */
  parent: string | null;
  /** Its checkout's branch, the source an effort is declared with. */
  branch?: string | undefined;
  declare: (prefill: UpstreamDeclarePrefill) => void;
}): UpstreamMenuItem[] {
  const { tree, marks, ref } = input;
  const group = headedGroupOf(tree, marks, input.parent);
  const groupNode = group
    ? tree.nodes.find((each) => each.id === group)
    : undefined;
  const skipped = !!group && isSkipped(marks, ref);
  const own = group ? undefined : ownUpstreamMark(marks, ref);
  const home = group
    ? skipped
      ? undefined
      : group
    : own && upstreamWorkspaceHome(own);
  const items: UpstreamMenuItem[] = [
    group
      ? {
          label: `Headed upstream (as ${groupNode?.kind === "group" ? groupNode.label : "its group"})`,
          checked: !skipped,
          disabled: true,
          title:
            "Its group is headed upstream: Reviews lists its branch until its request opens",
          action: () => {},
        }
      : {
          label: "Headed upstream",
          checked: !!own,
          title:
            "This workspace holds work meant to go upstream: Reviews lists its branch until its request opens",
          action: () => void setWorkspaceHeaded(ref, !own).catch(() => {}),
        },
  ];
  // In a group headed upstream: this one may not be.
  if (group)
    items.push({
      label: skipped ? "Headed upstream again" : "Not headed upstream",
      action: () => void setWorkspaceHeaded(ref, skipped).catch(() => {}),
    });
  if (home)
    items.push({
      label: "Declare an upstreaming effort…",
      title:
        "Follow a large branch of this workspace commit by commit until it is all upstream",
      action: () =>
        input.declare({
          home,
          ...(input.branch ? { source: input.branch } : {}),
        }),
    });
  return items;
}
