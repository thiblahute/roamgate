import { withAgentActivity } from "./agentOrder";
import type { ConnectionSummary } from "./api";
import type { ConnectionSessionView } from "./connectionSessions";
import { normalizeSearchText } from "./searchText";
import { shortId } from "./utils";
import type { Pane, PaneLayout, Tab, Workspace } from "./types";
import type {
  ConnectionAgentSessions,
  ServerAgentPane,
  ServerSessionSource,
} from "./useAllServerAgentSessions";

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
  /** Set when results span several servers. */
  serverLabel?: string;
  /** Set for panes that live on a server other than the active one. */
  source?: ServerSessionSource & { workspaceId: string };
  /** Set for a pane on a connection other than the displayed one. */
  connectionId?: string;
  /** When the user last had it on screen, on any device (ms). */
  seenAt?: number;
  /** Its agent waits on the user: asking something, or done unseen. */
  needsYou?: "blocked" | "done";
  /** What it waits on, when known: its question, or its last message. */
  waitsOn?: string;
};

/** Typed first in the search: only what needs the user. */
export const NEEDS_YOU_QUERY = "!";

/** What the switcher lists: every recent pane, or one entry per workspace. */
export type PaneJumpScope = "panes" | "workspaces";

export type PaneJumpConnectionTarget = {
  connectionId: string;
  paneId: string;
};

/** Pane IDs are only unique per server, so remote entries add the server. */
export function paneJumpEntryKey(entry: PaneJumpEntry): string {
  return entry.key;
}

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

/** Identifies a workspace across connections: workspace ids repeat. */
export function workspaceHistoryKey(
  connectionId: string,
  workspaceId: string,
): string {
  return `${connectionId}\0${workspaceId}`;
}

const WORKSPACE_HISTORY_LIMIT = 100;

/**
 * Reads a stored history back, dropping anything that is not a history key.
 * Stored values come from this browser but can be stale or hand-edited.
 */
export function parseWorkspaceHistory(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (key): key is string => typeof key === "string" && key.includes("\0"),
        ),
      ),
    ].slice(0, WORKSPACE_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Moves a visited workspace to the front of the most-recent-first history.
 * Returns the same array when it already leads, so callers can skip updates.
 */
export function recordWorkspaceVisit(
  history: readonly string[],
  key: string,
): readonly string[] {
  if (history[0] === key) return history;
  return [key, ...history.filter((entry) => entry !== key)].slice(
    0,
    WORKSPACE_HISTORY_LIMIT,
  );
}

/**
 * When this browser last visited each workspace (ms), by history key: the
 * newest `WORKSPACE_HISTORY_LIMIT` kept.
 */
export type WorkspaceVisitTimes = Readonly<Record<string, number>>;

/** Records a visit at `at`, dropping the oldest beyond the history's size. */
export function recordWorkspaceVisitTime(
  times: WorkspaceVisitTimes,
  key: string,
  at: number,
): WorkspaceVisitTimes {
  return Object.fromEntries(
    Object.entries({ ...times, [key]: at })
      .sort(([, left], [, right]) => right - left)
      .slice(0, WORKSPACE_HISTORY_LIMIT),
  );
}

/** Reads stored visit times back, dropping anything that is not one. */
export function parseWorkspaceVisitTimes(
  raw: string | null,
): WorkspaceVisitTimes {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          (entry): entry is [string, number] =>
            entry[0].includes("\0") &&
            typeof entry[1] === "number" &&
            Number.isFinite(entry[1]),
        )
        .sort(([, left], [, right]) => right - left)
        .slice(0, WORKSPACE_HISTORY_LIMIT),
    );
  } catch {
    return {};
  }
}

/**
 * Projects live pane state into a deduplicated, most-recent-first switcher.
 * `connections` adds the panes of connections that are not displayed (the
 * all-connections view); the displayed one's entry there is ignored.
 * `workspaceHistory` orders the workspace scope by when each workspace was
 * last visited, across every connection, so the shortcut walks back through
 * them in the order they were left. `serverEntries` adds, in workspace
 * scope, connections no session of this browser covers (see
 * `serverSessionPaneEntries`).
 */
export function paneJumpEntries(
  snapshot: PaneJumpSnapshot,
  activePaneId?: string | null,
  connections: readonly ConnectionSessionView[] = [],
  scope: PaneJumpScope = "panes",
  workspaceHistory?: WorkspaceHistory,
  serverEntries: readonly PaneJumpEntry[] = [],
): PaneJumpEntry[] {
  // Workspace scope reads every pane: collapsed to one entry each, the recent
  // panes alone would hide workspaces that were never visited in this browser.
  const everyPane = scope === "workspaces";
  const entries = [
    ...orderedPaneJumpEntries(snapshot, activePaneId, everyPane),
    ...connectionPaneEntries(connections, everyPane),
    ...(everyPane ? serverEntries : []),
  ];
  if (!everyPane) return entries;
  return orderByWorkspaceHistory(
    workspaceJumpEntries(entries),
    workspaceHistory,
  );
}

export type WorkspaceHistory = {
  activeConnectionId: string;
  keys: readonly string[];
  /** When this browser visited them, for those it has a time for. */
  visitedAt?: WorkspaceVisitTimes;
};

/**
 * The current workspace first, then the others by when the user last saw
 * them, newest first: the last look at any of their agents, on any device
 * (agent seen tracking), or this browser's last visit, whichever is later.
 * Visits without a time keep this browser's visit order after those.
 * What needs the user does not move them. Stable: workspaces never seen
 * keep their order at the end.
 */
function orderByWorkspaceHistory(
  workspaces: PaneJumpEntry[],
  history: WorkspaceHistory | undefined,
): PaneJumpEntry[] {
  const rank = new Map(
    (history?.keys ?? []).map((key, index) => [key, index] as const),
  );
  const keyOf = (entry: PaneJumpEntry) =>
    history
      ? workspaceHistoryKey(
          entry.connectionId ??
            entry.source?.connectionId ??
            history.activeConnectionId,
          entry.workspaceId,
        )
      : undefined;
  return workspaces
    .map((entry, index) => {
      const key = keyOf(entry);
      return {
        entry,
        index,
        rank:
          (key !== undefined ? rank.get(key) : undefined) ??
          Number.MAX_SAFE_INTEGER,
        seenAt: Math.max(
          entry.seenAt ?? -1,
          (key !== undefined ? history?.visitedAt?.[key] : undefined) ?? -1,
        ),
      };
    })
    .sort(
      (left, right) =>
        Number(right.entry.current) - Number(left.entry.current) ||
        right.seenAt - left.seenAt ||
        left.rank - right.rank ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
}

/**
 * Searches every live pane instead of the recent ones alone, so a pane that was
 * never visited stays reachable by workspace, tab, directory, or agent name.
 * Matches keep the recent-first order rather than a relevance ranking, which
 * leaves the list stable while the query grows. Workspace scope uses the same
 * visit order as the recent switcher. `serverEntries` adds connections no
 * session of this browser covers (see `serverSessionPaneEntries`).
 */
export function paneSearchEntries(
  snapshot: PaneJumpSnapshot,
  query: string,
  activePaneId?: string | null,
  connections: readonly ConnectionSessionView[] = [],
  scope: PaneJumpScope = "panes",
  workspaceHistory?: WorkspaceHistory,
  serverLabel?: string,
  serverEntries: readonly PaneJumpEntry[] = [],
): PaneJumpEntry[] {
  const entries = orderedPaneJumpEntries(snapshot, activePaneId, true);
  return filterPaneSearchEntries(
    [
      ...(serverLabel
        ? entries.map((entry) => ({ ...entry, serverLabel }))
        : entries),
      ...connectionPaneEntries(connections, true),
      ...serverEntries,
    ],
    query,
    scope,
    workspaceHistory,
  );
}

/**
 * Every pane of the other ready connections, read from the summary the
 * workspace tree lists them by (`connections.agent_sessions`), so a search
 * finds their workspaces by name, directory, tab or agent even when this
 * browser holds no session for them. Opening one goes through its `source`,
 * as the switcher opens another server's agent. Connections in `listed`
 * are skipped: a session this browser has loaded lists them already.
 */
export function serverSessionPaneEntries(
  connections: readonly ConnectionSummary[],
  snapshots: readonly ConnectionAgentSessions[],
  activeConnectionId: string | null | undefined,
  listed: ReadonlySet<string> = new Set(),
): PaneJumpEntry[] {
  const entries: PaneJumpEntry[] = [];
  for (const connection of connections) {
    if (
      connection.id === activeConnectionId ||
      listed.has(connection.id) ||
      connection.state !== "ready"
    )
      continue;
    const snapshot = snapshots.find(
      (entry) =>
        entry.connection_id === connection.id &&
        entry.connection_generation === connection.generation,
    );
    if (!snapshot || snapshot.error) continue;
    const workspaceById = new Map(
      snapshot.workspaces.map((workspace) => [
        workspace.workspace_id,
        workspace,
      ]),
    );
    const tabById = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
    const workspaceNumber = (pane: Pane) =>
      workspaceById.get(pane.workspace_id)?.number ?? Number.MAX_SAFE_INTEGER;
    const panes = withAgentActivity(snapshot.panes, snapshot.agents).sort(
      (left, right) =>
        workspaceNumber(left) - workspaceNumber(right) ||
        Number(right.focused) - Number(left.focused),
    );
    for (const pane of panes) {
      const entry = paneJumpEntry(pane, workspaceById, tabById, false);
      entries.push({
        ...entry,
        key: `${connection.id}:${pane.pane_id}`,
        serverLabel: connection.label,
        source: {
          connectionId: connection.id,
          runtimeGeneration: connection.generation,
          serverLabel: connection.label,
          workspaceId: pane.workspace_id,
        },
      });
    }
  }
  return entries;
}

/**
 * Agent panes from the other ready servers, for the same search. The caller
 * passes them already ordered; panes of the active server are skipped because
 * the live snapshot covers them.
 */
export function serverPaneSearchEntries(
  panes: readonly ServerAgentPane[],
  query: string,
  activeConnectionId: string | null | undefined,
  scope: PaneJumpScope = "panes",
  workspaceHistory?: WorkspaceHistory,
): PaneJumpEntry[] {
  return filterPaneSearchEntries(
    panes
      .filter((pane) => pane.connectionId !== activeConnectionId)
      .map((pane) => ({
        key: `${pane.connectionId}:${pane.pane_id}`,
        paneId: pane.pane_id,
        paneLabel: `Pane ${shortId(pane.pane_id)}`,
        workspaceId: pane.workspace_id,
        title: pane.workspaceLabel,
        tabLabel: pane.tabLabel || pane.tab_id,
        cwd: pane.foreground_cwd ?? pane.cwd ?? "",
        agent: pane.agent,
        agentStatus: pane.agent ? pane.agent_status : undefined,
        current: false,
        serverLabel: pane.serverLabel,
        source: {
          connectionId: pane.connectionId,
          runtimeGeneration: pane.runtimeGeneration,
          serverLabel: pane.serverLabel,
          workspaceId: pane.workspace_id,
        },
      })),
    query,
    scope,
    workspaceHistory,
  );
}

function filterPaneSearchEntries(
  entries: PaneJumpEntry[],
  query: string,
  scope: PaneJumpScope,
  workspaceHistory?: WorkspaceHistory,
): PaneJumpEntry[] {
  // What needs the user leads the search; "!" first keeps only that.
  const only = query.trimStart().startsWith(NEEDS_YOU_QUERY);
  if (only) query = query.trimStart().slice(NEEDS_YOU_QUERY.length);
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  const matches =
    tokens.length === 0
      ? entries
      : entries.filter((entry) => {
          const haystack = normalizeSearchText(paneSearchValue(entry));
          return tokens.every((token) => haystack.includes(token));
        });
  // Collapsed last, so a workspace stays reachable through any of its panes.
  return needsYouFirst(
    scope === "workspaces"
      ? orderByWorkspaceHistory(workspaceJumpEntries(matches), workspaceHistory)
      : matches,
    only,
  );
}

/**
 * One entry per workspace, keeping the pane each was most recently used
 * through. The kept entry is current whenever any pane of its workspace is:
 * the displayed pane is not always the one the workspace leads with.
 */
function workspaceJumpEntries(entries: PaneJumpEntry[]): PaneJumpEntry[] {
  const byWorkspace = new Map<string, PaneJumpEntry>();
  for (const entry of entries) {
    const connectionId = entry.connectionId ?? entry.source?.connectionId;
    const key = `${connectionId ?? ""}:${entry.workspaceId}`;
    const kept = byWorkspace.get(key);
    if (!kept) {
      byWorkspace.set(key, entry);
      continue;
    }
    // A pane that needs the user leads its workspace: going there goes to it.
    const lead = needsRank(entry) < needsRank(kept) ? entry : kept;
    const seenAt = Math.max(entry.seenAt ?? -1, kept.seenAt ?? -1);
    byWorkspace.set(key, {
      ...lead,
      current: kept.current || entry.current,
      ...(seenAt >= 0 ? { seenAt } : {}),
    });
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
    entry.serverLabel,
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
    connectionId:
      entry.connectionId ?? entry.source?.connectionId ?? activeConnectionId,
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
  // Workspace scope is ordered by visit history, whose first other entry is
  // already the workspace left most recently.
  if (
    scope !== "workspaces" &&
    roundTrip &&
    current &&
    at(current, roundTrip.to)
  ) {
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
    ...(pane.seen_at !== undefined ? { seenAt: pane.seen_at } : {}),
    ...(pane.agent &&
    (pane.agent_status === "blocked" || pane.agent_status === "done")
      ? { needsYou: pane.agent_status }
      : {}),
  };
}

const NEEDS_YOU_RANK = { blocked: 0, done: 1 } as const;
const needsRank = (entry: PaneJumpEntry) =>
  entry.needsYou ? NEEDS_YOU_RANK[entry.needsYou] : 2;

/**
 * What needs the user first, the agents asking something before those done
 * unseen, each group keeping its order; with `only`, nothing else.
 */
export function needsYouFirst(
  entries: PaneJumpEntry[],
  only = false,
): PaneJumpEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !only || entry.needsYou)
    .sort(
      (left, right) =>
        needsRank(left.entry) - needsRank(right.entry) ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
}

export type PointerPosition = { screenX: number; screenY: number };

/** Movement that still counts as a resting pointer: mouse and trackpad jitter. */
export const POINTER_REST_TOLERANCE_PX = 4;

/**
 * Whether the pointer left the spot where the switcher first saw it.
 * Browsers fire pointer events at a stationary cursor when rows move
 * underneath it: the overlay opening on top of the pointer, the list
 * reordering, or the selected row scrolling into view. Only a change in
 * screen position beyond the jitter tolerance counts, so a pointer resting
 * over the list never selects or highlights a row. Without an origin there
 * is nothing to compare against yet.
 */
export function pointerLeftOrigin(
  origin: PointerPosition | null,
  event: PointerPosition,
): boolean {
  return (
    origin !== null &&
    Math.hypot(event.screenX - origin.screenX, event.screenY - origin.screenY) >
      POINTER_REST_TOLERANCE_PX
  );
}
