import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";
import { isMobileLayout, LAYOUT_CHANGE_EVENT } from "./layoutPreferences";

/** How an agent pane shows: its terminal, or its conversation as a chat. */
export type PaneView = "terminal" | "chat";

const STORAGE_KEY = "paneViews";
/**
 * How an agent pane shows on the desktop until it is switched: its terminal
 * by default. A phone opens it as a chat.
 */
const DEFAULT_STORAGE_KEY = "paneViewDefault";
/** Panes come and go; only the most recent choices are kept. */
const MAX_REMEMBERED = 200;

const listeners = new Set<() => void>();
let cache: Record<string, PaneView> | null = null;
let defaultCache: PaneView | null = null;

/**
 * The view an agent pane opens in on the desktop, as soon as its agent is
 * detected: the Open agents as a chat setting.
 */
export function defaultPaneView(): PaneView {
  if (defaultCache) return defaultCache;
  let stored: string | null;
  try {
    stored = roamgateLocalStorage.getItem(DEFAULT_STORAGE_KEY);
  } catch {
    stored = null;
  }
  defaultCache = stored === "chat" ? "chat" : "terminal";
  return defaultCache;
}

export function setDefaultPaneView(view: PaneView) {
  defaultCache = view;
  try {
    roamgateLocalStorage.setItem(DEFAULT_STORAGE_KEY, view);
  } catch {
    // Storage may be unavailable; the choice still holds for this page.
  }
  for (const listener of listeners) listener();
}

function read(): Record<string, PaneView> {
  if (cache) return cache;
  let parsed: unknown;
  try {
    parsed = JSON.parse(roamgateLocalStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    parsed = null;
  }
  const views: Record<string, PaneView> = {};
  if (parsed && typeof parsed === "object")
    for (const [key, value] of Object.entries(parsed))
      if (value === "chat" || value === "terminal") views[key] = value;
  cache = views;
  return views;
}

function paneKey(connectionId: string | null, paneId: string): string {
  return `${connectionId ?? ""}:${paneId}`;
}

export function paneView(
  connectionId: string | null,
  paneId: string | null | undefined,
): PaneView {
  if (!paneId) return "terminal";
  // Until switched, an agent pane opens as a chat on a phone.
  return (
    read()[paneKey(connectionId, paneId)] ??
    (isMobileLayout() ? "chat" : defaultPaneView())
  );
}

export function setPaneView(
  connectionId: string | null,
  paneId: string,
  view: PaneView,
) {
  const key = paneKey(connectionId, paneId);
  const views = { ...read() };
  delete views[key];
  // Kept either way: a pane switched by hand stays so when the default
  // changes.
  views[key] = view;
  const keys = Object.keys(views);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED)))
    delete views[old];
  cache = views;
  try {
    roamgateLocalStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Storage may be unavailable; the choice still holds for this page.
  }
  for (const listener of listeners) listener();
}

export function togglePaneView(connectionId: string | null, paneId: string) {
  setPaneView(
    connectionId,
    paneId,
    paneView(connectionId, paneId) === "chat" ? "terminal" : "chat",
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window's choice shows here too.
  const unsubscribe = subscribeLocalStorage((key) => {
    if (key !== null && key !== STORAGE_KEY && key !== DEFAULT_STORAGE_KEY)
      return;
    cache = null;
    defaultCache = null;
    listener();
  });
  // Turning to or from the phone layout changes the panes not switched yet.
  const target = typeof window === "undefined" ? null : window;
  target?.addEventListener(LAYOUT_CHANGE_EVENT, listener);
  return () => {
    listeners.delete(listener);
    unsubscribe();
    target?.removeEventListener(LAYOUT_CHANGE_EVENT, listener);
  };
}

export function usePaneView(
  connectionId: string | null,
  paneId: string | null | undefined,
): PaneView {
  return useSyncExternalStore(subscribe, () => paneView(connectionId, paneId));
}

/** The view kept for a pane, null when none was ever kept for it. */
export function storedPaneView(
  connectionId: string | null,
  paneId: string | null | undefined,
): PaneView | null {
  if (!paneId) return null;
  return read()[paneKey(connectionId, paneId)] ?? null;
}

export function useStoredPaneView(
  connectionId: string | null,
  paneId: string | null | undefined,
): PaneView | null {
  return useSyncExternalStore(subscribe, () =>
    storedPaneView(connectionId, paneId),
  );
}

export function useDefaultPaneView(): PaneView {
  return useSyncExternalStore(subscribe, defaultPaneView);
}
