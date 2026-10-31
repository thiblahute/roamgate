import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";
import type { Pane, Tab, Workspace } from "./types";

/**
 * Overlay tabs: one tab per Space (Herdr workspace) that Roamgate shows in a
 * floating, resizable overlay instead of its tab strip.
 *
 * The mark lives in the Roamgate server's interface settings, so every browser
 * sees the same overlay tab, keyed by connection, workspace id, and tab id.
 * Herdr persists workspace and tab ids with its session (public tab numbers),
 * so the mark survives restarts of Herdr, Roamgate, and the machine. Herdr has
 * no tab metadata to carry it, and pane metadata is display-only.
 */
export const OVERLAY_TAB_SETTING_KEY = "overlayTabs";
export const OVERLAY_TAB_STORAGE_KEY = "overlayTabs.v1";
/** Label of the tab the overlay shortcut creates when a Space has none. */
export const OVERLAY_TAB_DEFAULT_LABEL = "Float terminal";

const MAX_CONNECTIONS = 64;
const MAX_WORKSPACES = 512;
const MAX_ID_LENGTH = 512;

/** connection id -> workspace id -> overlay tab id */
export type OverlayTabMarks = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

const EMPTY_MARKS: OverlayTabMarks = Object.freeze({});
const EMPTY_IDS: ReadonlySet<string> = new Set();

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validates a stored value; anything malformed is dropped, never thrown. */
export function parseOverlayTabMarks(value: unknown): OverlayTabMarks {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.connections))
    return EMPTY_MARKS;
  const marks: Record<string, Record<string, string>> = {};
  for (const [connectionId, workspaces] of Object.entries(
    value.connections,
  ).slice(0, MAX_CONNECTIONS)) {
    if (!validId(connectionId) || !isRecord(workspaces)) continue;
    const entries: Record<string, string> = {};
    const tabIds = new Set<string>();
    for (const [workspaceId, tabId] of Object.entries(workspaces).slice(
      0,
      MAX_WORKSPACES,
    )) {
      if (!validId(workspaceId) || !validId(tabId) || tabIds.has(tabId))
        continue;
      tabIds.add(tabId);
      entries[workspaceId] = tabId;
    }
    if (Object.keys(entries).length) marks[connectionId] = entries;
  }
  return marks;
}

export function serializeOverlayTabMarks(marks: OverlayTabMarks) {
  return { version: 1 as const, connections: marks };
}

/**
 * Marks `tabId` as the workspace's overlay tab, or clears the workspace's mark
 * with `null`. A Space has one overlay tab, so marking another tab moves the
 * mark: the previous one goes back to the tab strip.
 */
export function withOverlayTab(
  marks: OverlayTabMarks,
  connectionId: string,
  workspaceId: string,
  tabId: string | null,
): OverlayTabMarks {
  const current = marks[connectionId] ?? {};
  const next: Record<string, string> = {};
  for (const [workspace, tab] of Object.entries(current)) {
    if (workspace !== workspaceId && tab !== tabId) next[workspace] = tab;
  }
  if (tabId) next[workspaceId] = tabId;
  const result: Record<string, Readonly<Record<string, string>>> = {
    ...marks,
  };
  if (Object.keys(next).length) result[connectionId] = next;
  else delete result[connectionId];
  return result;
}

export function overlayTabIdsIn(
  marks: OverlayTabMarks,
  connectionId: string,
): ReadonlySet<string> {
  const entries = marks[connectionId];
  return entries ? new Set(Object.values(entries)) : EMPTY_IDS;
}

export type OverlayTopology = {
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
};

export type SplitOverlayTopology = OverlayTopology & {
  overlayTabs: Tab[];
  overlayPanes: Pane[];
};

/**
 * The one place overlay tabs leave Roamgate's lists. Everything that lists or
 * counts tabs and panes (the tab strip, the phone's tabs button, pane search
 * and switchers, workspace rows, Ranger's lists) reads the store's `tabs` and
 * `panes`, which hold the result of this split. The overlay tab and its panes
 * move to `overlayTabs` and `overlayPanes`, and each workspace's counts and
 * active tab are corrected so nothing counts the overlay tab either.
 */
export function splitOverlayTopology(
  topology: OverlayTopology,
  overlayTabIds: ReadonlySet<string>,
): SplitOverlayTopology {
  if (overlayTabIds.size === 0)
    return { ...topology, overlayTabs: [], overlayPanes: [] };
  const tabs: Tab[] = [];
  const overlayTabs: Tab[] = [];
  for (const tab of topology.tabs)
    (overlayTabIds.has(tab.tab_id) ? overlayTabs : tabs).push(tab);
  if (overlayTabs.length === 0)
    return { ...topology, overlayTabs: [], overlayPanes: [] };
  const panes: Pane[] = [];
  const overlayPanes: Pane[] = [];
  for (const pane of topology.panes)
    (overlayTabIds.has(pane.tab_id) ? overlayPanes : panes).push(pane);
  const workspaces = topology.workspaces.map((workspace) => {
    const hidden = overlayTabs.filter(
      (tab) => tab.workspace_id === workspace.workspace_id,
    );
    if (hidden.length === 0) return workspace;
    const hiddenPanes = overlayPanes.filter(
      (pane) => pane.workspace_id === workspace.workspace_id,
    ).length;
    const activeTabId =
      workspace.active_tab_id && overlayTabIds.has(workspace.active_tab_id)
        ? tabs.find((tab) => tab.workspace_id === workspace.workspace_id)
            ?.tab_id
        : workspace.active_tab_id;
    return {
      ...workspace,
      tab_count: Math.max(0, workspace.tab_count - hidden.length),
      pane_count: Math.max(0, workspace.pane_count - hiddenPanes),
      active_tab_id: activeTabId,
    };
  });
  // Herdr's own focus can sit on the overlay tab (its TUI shows every tab).
  // Roamgate then shows the workspace's first other tab behind the overlay.
  const focusedOverlay = overlayTabs.some((tab) => tab.focused);
  const tabsWithFocus = focusedOverlay
    ? tabs.map((tab) => {
        const workspace = workspaces.find(
          (each) => each.workspace_id === tab.workspace_id,
        );
        return workspace?.active_tab_id === tab.tab_id &&
          overlayTabs.some(
            (hidden) =>
              hidden.focused && hidden.workspace_id === tab.workspace_id,
          )
          ? { ...tab, focused: true }
          : tab;
      })
    : tabs;
  return {
    workspaces,
    tabs: tabsWithFocus,
    panes,
    overlayTabs,
    overlayPanes,
  };
}

/** The overlay tab of a workspace, if it has one that Herdr still lists. */
export function overlayTabOf(
  overlayTabs: readonly Tab[],
  workspaceId: string | null | undefined,
): Tab | null {
  if (!workspaceId) return null;
  return overlayTabs.find((tab) => tab.workspace_id === workspaceId) ?? null;
}

/**
 * Marks whose tab or workspace is gone. A workspace missing from a non-empty
 * list was closed, and closing it closed its overlay tab. A tab is forgotten
 * only once this page has seen it alive: a mark set for a tab just created
 * must survive a list read before the creation landed.
 */
export function vanishedOverlayMarks(
  entries: Readonly<Record<string, string>>,
  liveWorkspaceIds: ReadonlySet<string>,
  liveTabIds: ReadonlySet<string>,
  seenTabIds: ReadonlySet<string>,
): string[] {
  if (liveWorkspaceIds.size === 0) return [];
  return Object.entries(entries)
    .filter(
      ([workspaceId, tabId]) =>
        !liveWorkspaceIds.has(workspaceId) ||
        (!liveTabIds.has(tabId) && seenTabIds.has(tabId)),
    )
    .map(([workspaceId]) => workspaceId);
}

// Module state: the marks every browser shares, mirrored to localStorage so a
// reload hides the overlay tab before the socket answers.

export type OverlayTabTransport = (value: unknown) => Promise<void>;
let transport: OverlayTabTransport | null = null;
let serverKnown = false;
let marks: OverlayTabMarks | null = null;
const listeners = new Set<() => void>();
const seenTabIds = new Map<string, Set<string>>();
let unsubscribeStorage: (() => void) | undefined;

function readCache(): OverlayTabMarks {
  try {
    const raw = roamgateLocalStorage.getItem(OVERLAY_TAB_STORAGE_KEY);
    return raw ? parseOverlayTabMarks(JSON.parse(raw)) : EMPTY_MARKS;
  } catch {
    return EMPTY_MARKS;
  }
}

function writeCache(next: OverlayTabMarks) {
  try {
    roamgateLocalStorage.setItem(
      OVERLAY_TAB_STORAGE_KEY,
      JSON.stringify(serializeOverlayTabMarks(next)),
    );
  } catch {
    // The server keeps the marks; this cache only speeds up a reload.
  }
}

function publish(next: OverlayTabMarks) {
  if (marks && JSON.stringify(marks) === JSON.stringify(next)) return;
  marks = next;
  for (const listener of listeners) listener();
}

export function overlayTabMarks(): OverlayTabMarks {
  if (!marks) marks = readCache();
  return marks;
}

export function overlayTabIdsFor(connectionId: string): ReadonlySet<string> {
  return overlayTabIdsIn(overlayTabMarks(), connectionId);
}

export function overlayTabIdFor(
  connectionId: string,
  workspaceId: string,
): string | null {
  return overlayTabMarks()[connectionId]?.[workspaceId] ?? null;
}

function save(next: OverlayTabMarks) {
  writeCache(next);
  publish(next);
  if (!transport) return;
  serverKnown = true;
  void transport(serializeOverlayTabMarks(next)).catch(() => {
    // The cache holds the marks; the next change retries the server.
  });
}

export function setOverlayTab(
  connectionId: string,
  workspaceId: string,
  tabId: string | null,
) {
  if (!connectionId || !workspaceId) return;
  const next = withOverlayTab(
    overlayTabMarks(),
    connectionId,
    workspaceId,
    tabId,
  );
  if (tabId) {
    let seen = seenTabIds.get(connectionId);
    if (!seen) seenTabIds.set(connectionId, (seen = new Set()));
    // Created a moment ago: not seen in a list yet, so not forgettable.
    seen.delete(tabId);
  }
  save(next);
}

/** Drops the marks of closed tabs and workspaces after a full list read. */
export function forgetVanishedOverlayTabs(
  connectionId: string,
  workspaces: readonly Pick<Workspace, "workspace_id">[],
  tabs: readonly Pick<Tab, "tab_id">[],
) {
  const entries = overlayTabMarks()[connectionId];
  if (!entries) return;
  const liveTabIds = new Set(tabs.map((tab) => tab.tab_id));
  let seen = seenTabIds.get(connectionId);
  if (!seen) seenTabIds.set(connectionId, (seen = new Set()));
  const gone = vanishedOverlayMarks(
    entries,
    new Set(workspaces.map((workspace) => workspace.workspace_id)),
    liveTabIds,
    seen,
  );
  for (const tabId of Object.values(entries))
    if (liveTabIds.has(tabId)) seen.add(tabId);
  if (!gone.length) return;
  let next = overlayTabMarks();
  for (const workspaceId of gone) {
    next = withOverlayTab(next, connectionId, workspaceId, null);
    // A later overlay tab of a Space with the same id starts hidden.
    rememberOverlayShown(connectionId, workspaceId, false);
  }
  save(next);
}

/**
 * Installs the write path with what the server holds. The server wins; when
 * it holds nothing, marks cached in this browser are promoted to it.
 */
export function connectOverlayTabs(send: OverlayTabTransport, stored: unknown) {
  transport = send;
  if (stored !== undefined && stored !== null) {
    serverKnown = true;
    const next = parseOverlayTabMarks(stored);
    writeCache(next);
    publish(next);
    return;
  }
  const local = overlayTabMarks();
  if (serverKnown || Object.keys(local).length === 0) return;
  serverKnown = true;
  void send(serializeOverlayTabMarks(local)).catch(() => {});
}

export function disconnectOverlayTabs() {
  transport = null;
  serverKnown = false;
}

/** Applies marks another browser changed. */
export function adoptOverlayTabs(stored: unknown) {
  const next = parseOverlayTabMarks(stored);
  writeCache(next);
  publish(next);
}

export function subscribeOverlayTabs(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1)
    unsubscribeStorage = subscribeLocalStorage((key) => {
      if (key === null || key === OVERLAY_TAB_STORAGE_KEY) publish(readCache());
    });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeStorage?.();
      unsubscribeStorage = undefined;
    }
  };
}

export function useOverlayTabMarks(): OverlayTabMarks {
  return useSyncExternalStore(
    subscribeOverlayTabs,
    overlayTabMarks,
    overlayTabMarks,
  );
}

export function __resetOverlayTabsForTests() {
  transport = null;
  serverKnown = false;
  marks = null;
  seenTabIds.clear();
}

/**
 * Whether the overlay was shown, per browser, connection and Space, so a
 * reload brings it back the way it was. Kept in localStorage only: another
 * browser showing its overlay must not open this one's.
 */
export const OVERLAY_SHOWN_STORAGE_KEY = "overlayShown.v1";

/** connection id -> ids of the workspaces whose overlay was shown */
export type OverlayShownSpaces = Readonly<Record<string, readonly string[]>>;

/** Validates the stored value; anything malformed reads as nothing shown. */
export function parseOverlayShown(value: unknown): OverlayShownSpaces {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.connections))
    return {};
  const shown: Record<string, string[]> = {};
  for (const [connectionId, workspaces] of Object.entries(
    value.connections,
  ).slice(0, MAX_CONNECTIONS)) {
    if (!validId(connectionId) || !Array.isArray(workspaces)) continue;
    const ids = [...new Set(workspaces.filter(validId))].slice(
      0,
      MAX_WORKSPACES,
    );
    if (ids.length) shown[connectionId] = ids;
  }
  return shown;
}

/** The shown state with one Space's overlay marked shown or hidden. */
export function withOverlayShown(
  spaces: OverlayShownSpaces,
  connectionId: string,
  workspaceId: string,
  shown: boolean,
): OverlayShownSpaces {
  const others = (spaces[connectionId] ?? []).filter(
    (id) => id !== workspaceId,
  );
  const ids = shown ? [...others, workspaceId] : others;
  const result: Record<string, readonly string[]> = { ...spaces };
  if (ids.length) result[connectionId] = ids;
  else delete result[connectionId];
  return result;
}

function readOverlayShownSpaces(): OverlayShownSpaces {
  try {
    const raw = roamgateLocalStorage.getItem(OVERLAY_SHOWN_STORAGE_KEY);
    return raw ? parseOverlayShown(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Whether this browser last left the Space's overlay shown. */
export function overlayWasShown(connectionId: string, workspaceId: string) {
  return readOverlayShownSpaces()[connectionId]?.includes(workspaceId) ?? false;
}

export function rememberOverlayShown(
  connectionId: string,
  workspaceId: string,
  shown: boolean,
) {
  const spaces = readOverlayShownSpaces();
  if ((spaces[connectionId]?.includes(workspaceId) ?? false) === shown) return;
  try {
    const next = withOverlayShown(spaces, connectionId, workspaceId, shown);
    if (Object.keys(next).length === 0)
      roamgateLocalStorage.removeItem(OVERLAY_SHOWN_STORAGE_KEY);
    else
      roamgateLocalStorage.setItem(
        OVERLAY_SHOWN_STORAGE_KEY,
        JSON.stringify({ version: 1, connections: next }),
      );
  } catch {
    // The overlay still works; a reload just comes back with it hidden.
  }
}
