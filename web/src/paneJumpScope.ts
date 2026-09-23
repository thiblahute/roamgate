import { useSyncExternalStore } from "react";
import { roamgateLocalStorage } from "./browserStorage";
import type { PaneJumpScope } from "./paneJump";

/** Global (not per-connection) preference: what the pane switcher lists. */
export const PANE_JUMP_SCOPE_STORAGE_KEY = "paneSwitcherScope";

export function parsePaneJumpScope(raw: string | null): PaneJumpScope {
  return raw === "workspaces" ? "workspaces" : "panes";
}

/**
 * Remembered across sessions: switching the recent switcher to workspaces is
 * a way of working, not a one-off, and its search shares the choice. A
 * `storage` event only reaches other tabs, so same-tab readers are notified
 * directly.
 */
const listeners = new Set<() => void>();

function read(): PaneJumpScope {
  return parsePaneJumpScope(
    roamgateLocalStorage.getItem(PANE_JUMP_SCOPE_STORAGE_KEY),
  );
}

let current = read();

function notify() {
  for (const listener of listeners) listener();
}

export function paneJumpScope(): PaneJumpScope {
  return current;
}

export function setPaneJumpScope(value: PaneJumpScope) {
  if (value === current) return;
  current = value;
  try {
    roamgateLocalStorage.setItem(PANE_JUMP_SCOPE_STORAGE_KEY, value);
  } catch {
    /* Blocked storage keeps the choice for this page only. */
  }
  notify();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && !event.key.endsWith(PANE_JUMP_SCOPE_STORAGE_KEY))
    return;
  const next = read();
  if (next === current) return;
  current = next;
  notify();
}

export function subscribePaneJumpScope(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

export function usePaneJumpScope(): PaneJumpScope {
  return useSyncExternalStore(
    subscribePaneJumpScope,
    paneJumpScope,
    paneJumpScope,
  );
}
