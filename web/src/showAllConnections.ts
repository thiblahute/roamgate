import { useSyncExternalStore } from "react";
import { roamgateLocalStorage } from "./browserStorage";

/** Global (not per-connection) preference: is the all-connections view on. */
export const SHOW_ALL_CONNECTIONS_STORAGE_KEY = "showAllConnectionsWorkspaces";

export function parseShowAllConnectionsPreference(raw: string | null): boolean {
  return raw === "true";
}

/**
 * The workspace tree's "show all connections" toggle, shared with every other
 * reader in the page. The tree owns the button, but the pane switchers scope
 * themselves by it and the store only reads other connections' topology while
 * it is on. A `storage` event only reaches other tabs, so same-tab readers are
 * notified directly.
 */
const listeners = new Set<() => void>();

function read(): boolean {
  return parseShowAllConnectionsPreference(
    roamgateLocalStorage.getItem(SHOW_ALL_CONNECTIONS_STORAGE_KEY),
  );
}

let current = read();

function notify() {
  for (const listener of listeners) listener();
}

export function showAllConnections(): boolean {
  return current;
}

export function setShowAllConnections(value: boolean) {
  if (value === current) return;
  current = value;
  try {
    roamgateLocalStorage.setItem(
      SHOW_ALL_CONNECTIONS_STORAGE_KEY,
      value ? "true" : "false",
    );
  } catch {
    /* Blocked storage keeps the choice for this page only. */
  }
  notify();
}

function onStorage(event: StorageEvent) {
  if (
    event.key !== null &&
    !event.key.endsWith(SHOW_ALL_CONNECTIONS_STORAGE_KEY)
  )
    return;
  const next = read();
  if (next === current) return;
  current = next;
  notify();
}

export function subscribeShowAllConnections(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

export function useShowAllConnections(): boolean {
  return useSyncExternalStore(
    subscribeShowAllConnections,
    showAllConnections,
    showAllConnections,
  );
}
