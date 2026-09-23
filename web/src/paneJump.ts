import type { ConnectionSessionView } from "./connectionSessions";
import { normalizeSearchText } from "./searchText";
import { shortId } from "./utils";
import type { Pane, PaneLayout, Tab, Workspace } from "./types";

export type PaneJumpEntry = {
  /** Unique across connections: pane ids are only unique within one. */
  key: string;
  paneId: string;
  paneLabel: string;
  workspaceId: string;
  title: string;
  tabLabel: string;
  cwd: string;
  agent?: string;
  agentStatus?: string;
  current: boolean;
  /** Set for a pane on a connection other than the displayed one. */
  connectionId?: string;
};

/** What the switcher lists: every recent pane, or one entry per workspace. */
export type PaneJumpScope = "panes" | "workspaces";

export type PaneJumpConnectionTarget = {
  connectionId: string;
  paneId: string;
};

type ActivePaneSnapshot = {
  selectedPaneId?: string | null;
  layout?: Pick<PaneLayout, "panes" | "focused_pane_id"> | null;
};

type PaneJumpSnapshot = {
  layout?: Pick<PaneLayout, "panes"> | null;
  panes: Pane[];
  recentPaneIds: string[];
  tabs: Tab[];
  workspaces: Workspace[];
};

/** Resolves selection only when it still belongs to the active layout. */
export function activePaneIdForSnapshot(
  snapshot: ActivePaneSnapshot,
): string | undefined {
  return snapshot.selectedPaneId &&
    snapshot.layout?.panes.some(
      (pane) => pane.pane_id === snapshot.selectedPaneId,
    )
    ? snapshot.selectedPaneId
    : snapshot.layout?.focused_pane_id;
}

/** A pane can be closed inline only while a sibling keeps its tab alive. */
export function paneCanClose(
  panes: readonly Pick<Pane, "pane_id" | "tab_id">[],
  paneId: string,
): boolean {
  const target = panes.find((pane) => pane.pane_id === paneId);
  return (
    !!target &&
    panes.some(
      (pane) => pane.pane_id !== paneId && pane.tab_id === target.tab_id,
    )
  );
}

/**
 * Panes on the connections that are not displayed, listed after every
 * displayed pane so a browser's own work always leads, in catalog order. Each
 * connection is the same kind of entry as a displayed pane — a real pane with
 * its workspace, tab, cwd, and agent — labelled with its connection. The
 * recent switcher takes one pane per workspace (the one most recently used
 * there, else the focused one) so a connection reads as its workspaces
 * instead of flooding the list; search takes every pane.
 */
function connectionPaneEntries(
  connections: readonly ConnectionSessionView[],
  includeAllPanes: boolean,
): PaneJumpEntry[] {
  const entries: PaneJumpEntry[] = [];
  for (const view of connections) {
    if (view.active) continue;
    const workspaceById = new Map(
      view.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
    );
    const tabById = new Map(view.tabs.map((tab) => [tab.tab_id, tab]));
    const recentRank = new Map(
      view.recentPaneIds.map((paneId, index) => [paneId, index]),
    );
    const workspaceNumber = (pane: Pane) =>
      workspaceById.get(pane.workspace_id)?.number ?? Number.MAX_SAFE_INTEGER;
    const ordered = [...view.panes].sort(
      (left, right) =>
        workspaceNumber(left) - workspaceNumber(right) ||
        (recentRank.get(left.pane_id) ?? Number.MAX_SAFE_INTEGER) -
          (recentRank.get(right.pane_id) ?? Number.MAX_SAFE_INTEGER) ||
        Number(right.focused) - Number(left.focused),
    );
    const seenWorkspaces = new Set<string>();
    for (const pane of ordered) {
      if (!includeAllPanes) {
        if (seenWorkspaces.has(pane.workspace_id)) continue;
        seenWorkspaces.add(pane.workspace_id);
      }
      const entry = paneJumpEntry(pane, workspaceById, tabById, false);
      entries.push({
        ...entry,
        key: `${view.connection.id}:${pane.pane_id}`,
        paneLabel: `${view.connection.label} · ${entry.paneLabel}`,
        connectionId: view.connection.id,
      });
    }
  }
  return entries;
}

/**
 * Projects live pane state into a deduplicated, most-recent-first switcher.
 * `connections` adds the panes of connections that are not displayed (the
 * all-connections view); the displayed one's entry there is ignored.
 */
export function paneJumpEntries(
  snapshot: PaneJumpSnapshot,
  activePaneId?: string | null,
  connections: readonly ConnectionSessionView[] = [],
  scope: PaneJumpScope = "panes",
): PaneJumpEntry[] {
  // Workspace scope reads every pane: collapsed to one entry each, the recent
  // panes alone would hide workspaces that were never visited in this browser.
  const everyPane = scope === "workspaces";
  const entries = [
    ...orderedPaneJumpEntries(snapshot, activePaneId, everyPane),
    ...connectionPaneEntries(connections, everyPane),
  ];
  return everyPane ? workspaceJumpEntries(entries) : entries;
}

/**
 * Searches every live pane instead of the recent ones alone, so a pane that was
 * never visited stays reachable by workspace, tab, directory, or agent name.
 * Matches keep the recent-first order rather than a relevance ranking, which
 * leaves the list stable while the query grows.
 */
export function paneSearchEntries(
  snapshot: PaneJumpSnapshot,
  query: string,
  activePaneId?: string | null,
  connections: readonly ConnectionSessionView[] = [],
  scope: PaneJumpScope = "panes",
): PaneJumpEntry[] {
  const entries = [
    ...orderedPaneJumpEntries(snapshot, activePaneId, true),
    ...connectionPaneEntries(connections, true),
  ];
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  const matches =
    tokens.length === 0
      ? entries
      : entries.filter((entry) => {
          const haystack = normalizeSearchText(paneSearchValue(entry));
          return tokens.every((token) => haystack.includes(token));
        });
  // Collapsed last, so a workspace stays reachable through any of its panes.
  return scope === "workspaces" ? workspaceJumpEntries(matches) : matches;
}

/**
 * One entry per workspace, keeping the pane each was most recently used
 * through. The kept entry is current whenever any pane of its workspace is:
 * the displayed pane is not always the one the workspace leads with.
 */
function workspaceJumpEntries(entries: PaneJumpEntry[]): PaneJumpEntry[] {
  const byWorkspace = new Map<string, PaneJumpEntry>();
  for (const entry of entries) {
    const key = `${entry.connectionId ?? ""}:${entry.workspaceId}`;
    const kept = byWorkspace.get(key);
    if (!kept) byWorkspace.set(key, entry);
    else if (entry.current && !kept.current)
      byWorkspace.set(key, { ...kept, current: true });
  }
  return [...byWorkspace.values()];
}

function orderedPaneJumpEntries(
  snapshot: PaneJumpSnapshot,
  activePaneId: string | null | undefined,
  includeAllPanes: boolean,
): PaneJumpEntry[] {
  const paneById = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  const workspaceById = new Map(
    snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
  );
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  const fallbackPaneIds =
    snapshot.layout?.panes.map((pane) => pane.pane_id) ?? [];
  const seen = new Set<string>();
  const orderedPaneIds = [
    ...snapshot.recentPaneIds,
    ...fallbackPaneIds,
    ...(includeAllPanes ? snapshot.panes.map((pane) => pane.pane_id) : []),
  ];

  return orderedPaneIds
    .filter((paneId) => {
      if (seen.has(paneId)) return false;
      seen.add(paneId);
      return paneById.has(paneId);
    })
    .map((paneId) =>
      paneJumpEntry(
        paneById.get(paneId)!,
        workspaceById,
        tabById,
        paneId === activePaneId,
      ),
    );
}

function paneSearchValue(entry: PaneJumpEntry): string {
  return [
    entry.title,
    entry.tabLabel,
    entry.cwd,
    entry.paneLabel,
    entry.agent,
    entry.agentStatus,
    entry.paneId,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Returns a real focus target, excluding an invalid or already-current item. */
export function paneJumpTargetId(
  entries: PaneJumpEntry[],
  index: number,
): string | null {
  const entry = entries[index];
  return entry && !entry.current && !entry.connectionId ? entry.paneId : null;
}

/** Returns the target of an entry on a connection that is not displayed. */
export function paneJumpConnectionTarget(
  entries: PaneJumpEntry[],
  index: number,
): PaneJumpConnectionTarget | null {
  const entry = entries[index];
  return entry?.connectionId
    ? { connectionId: entry.connectionId, paneId: entry.paneId }
    : null;
}

/** Where a jump started or landed; pane ids repeat across connections. */
export type PaneJumpLocation = {
  connectionId: string;
  paneId: string;
  workspaceId: string;
};

export type PaneJumpRoundTrip = {
  from: PaneJumpLocation;
  to: PaneJumpLocation;
};

export function paneJumpLocation(
  entry: PaneJumpEntry,
  activeConnectionId: string,
): PaneJumpLocation {
  return {
    connectionId: entry.connectionId ?? activeConnectionId,
    paneId: entry.paneId,
    workspaceId: entry.workspaceId,
  };
}

/**
 * The entry a freshly opened switcher starts on. Recency alone does not make
 * the round trip exact: panes of the connections that are not displayed are
 * listed after every displayed one, so the pane a cross-connection jump came
 * from is never the first candidate, and a focus that settles on another pane
 * of the target tab reorders the recent list underneath. Remembering the last
 * jump keeps the shortcut pressed twice on the pane it started from;
 * everything else falls back to the most recent other pane.
 */
export function paneJumpDefaultIndex(
  entries: PaneJumpEntry[],
  activeConnectionId: string,
  roundTrip: PaneJumpRoundTrip | null,
  scope: PaneJumpScope = "panes",
): number {
  const at = (entry: PaneJumpEntry, location: PaneJumpLocation) => {
    const entryLocation = paneJumpLocation(entry, activeConnectionId);
    return (
      entryLocation.connectionId === location.connectionId &&
      (scope === "workspaces"
        ? entryLocation.workspaceId === location.workspaceId
        : entryLocation.paneId === location.paneId)
    );
  };
  const current = entries.find((entry) => entry.current);
  if (roundTrip && current && at(current, roundTrip.to)) {
    const back = entries.findIndex(
      (entry) => !entry.current && at(entry, roundTrip.from),
    );
    if (back >= 0) return back;
  }
  const recent = entries.findIndex((entry) => !entry.current);
  return recent >= 0 ? recent : 0;
}

function paneJumpEntry(
  pane: Pane,
  workspaceById: Map<string, Workspace>,
  tabById: Map<string, Tab>,
  current: boolean,
): PaneJumpEntry {
  const workspace = workspaceById.get(pane.workspace_id);
  const tab = tabById.get(pane.tab_id);
  const cwd = pane.foreground_cwd ?? pane.cwd ?? "";
  const workspaceLabel = workspace?.label ?? pane.workspace_id;
  const tabLabel = tab
    ? tab.label && tab.label !== String(tab.number)
      ? tab.label
      : `Tab ${tab.number}`
    : pane.tab_id;

  return {
    key: pane.pane_id,
    paneId: pane.pane_id,
    paneLabel: `Pane ${shortId(pane.pane_id)}`,
    workspaceId: pane.workspace_id,
    title: workspaceLabel,
    tabLabel,
    cwd,
    agent: pane.agent,
    agentStatus: pane.agent ? pane.agent_status : undefined,
    current,
  };
}
