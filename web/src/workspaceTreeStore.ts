import { useSyncExternalStore } from "react";
import {
  applyWorkspaceTreeOp,
  emptyWorkspaceTree,
  parseWorkspaceTree,
  type WorkspaceTree,
  type WorkspaceTreeOp,
} from "../../shared/workspaceTree";
import { bridge } from "./api";
import { store } from "./store";
import type { Workspace } from "./types";

/**
 * The Workspaces arrangement as the Roamgate server keeps it, followed by
 * every open browser. A change shows at once (the same operations the
 * server applies), then the server's answer replaces it.
 */
let tree: WorkspaceTree = emptyWorkspaceTree();
let installed = false;
let loaded = false;
const listeners = new Set<() => void>();

function set(next: WorkspaceTree) {
  if (next === tree) return;
  tree = next;
  for (const listener of listeners) listener();
}

async function hydrate() {
  try {
    const result = await bridge.call("bridge.workspace_tree.get");
    loaded = true;
    set(parseWorkspaceTree(result?.tree));
  } catch {
    // An older server, or the socket went: the next connect asks again.
  }
}

function install() {
  if (installed) return;
  installed = true;
  bridge.onWorkspaceTree((value) => {
    loaded = true;
    set(parseWorkspaceTree(value));
  });
  bridge.onStatus((status) => {
    if (status === "connected") void hydrate();
  });
  if (bridge.status === "connected") void hydrate();
}

function subscribe(listener: () => void) {
  install();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkspaceTree(): WorkspaceTree {
  return tree;
}

export function workspaceTreeLoaded(): boolean {
  return loaded;
}

export function useWorkspaceTree(): WorkspaceTree {
  return useSyncExternalStore(subscribe, getWorkspaceTree);
}

/** Applies operations here at once, then on the server. */
export async function applyWorkspaceTreeOps(
  ops: WorkspaceTreeOp[],
  { quiet = false }: { quiet?: boolean } = {},
): Promise<boolean> {
  if (!ops.length) return true;
  const before = tree;
  try {
    let next = tree;
    for (const op of ops) next = applyWorkspaceTreeOp(next, op);
    set(next);
  } catch (error) {
    if (!quiet)
      store.notify({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    return false;
  }
  try {
    const result = await bridge.call("bridge.workspace_tree.apply", { ops });
    set(parseWorkspaceTree(result?.tree));
    return true;
  } catch (error) {
    if (tree !== before) set(before);
    void hydrate();
    if (!quiet)
      store.notify({
        kind: "error",
        message: `Could not save the arrangement: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    return false;
  }
}

/** The command menu asking the Workspaces list to arrange something. */
export type WorkspaceArrangeRequest =
  | { type: "move-into"; connectionId: string; workspace: Workspace }
  | { type: "new-group" };
const arrangeListeners = new Set<(request: WorkspaceArrangeRequest) => void>();

export function requestWorkspaceArrange(request: WorkspaceArrangeRequest) {
  for (const listener of arrangeListeners) listener(request);
}

export function onWorkspaceArrangeRequest(
  listener: (request: WorkspaceArrangeRequest) => void,
): () => void {
  arrangeListeners.add(listener);
  return () => arrangeListeners.delete(listener);
}

export const __workspaceTreeTesting = {
  set: (next: WorkspaceTree) => {
    loaded = true;
    set(next);
  },
  reset: () => {
    tree = emptyWorkspaceTree();
    loaded = false;
  },
};
