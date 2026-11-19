import { useEffect, useState } from "react";
import { applyStateDelta, isStateDelta } from "../../shared/stateDelta";
import { bridge, type ConnectionSummary } from "./api";
import { withAgentActivity } from "./agentOrder";
import { paneHasAgentHistory } from "./components/agentSession";
import { shallowEqual, store, useStoreSelector } from "./store";
import type { Pane, Tab, Workspace } from "./types";
import { workspaceDisplayName } from "./workspaceTreeBadges";

export interface ConnectionAgentSessions {
  connection_id: string;
  connection_generation: number;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  agents: unknown;
  error?: string;
}

export interface ServerAgentPane extends Pane {
  connectionId: string;
  runtimeGeneration: number;
  serverLabel: string;
  workspaceKey: string;
  workspaceLabel: string;
  tabLabel: string;
}

export type ServerSessionSource = Pick<
  ServerAgentPane,
  "connectionId" | "runtimeGeneration" | "serverLabel"
>;

export function isServerSourceAvailable(source: ServerSessionSource): boolean {
  return store
    .get()
    .connections.some(
      (connection) =>
        connection.id === source.connectionId &&
        connection.generation === source.runtimeGeneration &&
        connection.state === "ready",
    );
}

export async function openServerSession(
  source: ServerSessionSource,
  workspaceId: string,
  paneId?: string,
): Promise<boolean> {
  const opened =
    isServerSourceAvailable(source) &&
    (await store.focusWorkspaceSource(
      {
        connectionId: source.connectionId,
        runtimeGeneration: source.runtimeGeneration,
        workspaceId,
        paneId,
      },
      // Picked from a list on screen: shown at once, checked after.
      { fromKnownList: true },
    ));
  if (!opened) store.notify({ kind: "error", message: "Session unavailable." });
  return opened;
}

export function allServerAgentPanes(
  connections: readonly ConnectionSummary[],
  snapshots: readonly ConnectionAgentSessions[],
): ServerAgentPane[] {
  return connections.flatMap((connection) => {
    const snapshot = snapshots.find(
      (entry) =>
        entry.connection_id === connection.id &&
        entry.connection_generation === connection.generation,
    );
    if (connection.state !== "ready" || !snapshot || snapshot.error) return [];
    const workspaces = new Map(
      snapshot.workspaces.map((workspace) => [
        workspace.workspace_id,
        workspace,
      ]),
    );
    const tabs = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
    return withAgentActivity(snapshot.panes, snapshot.agents)
      .filter(paneHasAgentHistory)
      .sort(
        (left, right) =>
          (workspaces.get(left.workspace_id)?.number ?? 0) -
          (workspaces.get(right.workspace_id)?.number ?? 0),
      )
      .map((pane) => {
        const workspace = workspaces.get(pane.workspace_id);
        const tab = tabs.get(pane.tab_id);
        return {
          ...pane,
          connectionId: connection.id,
          runtimeGeneration: connection.generation,
          serverLabel: connection.label,
          workspaceKey: JSON.stringify([
            connection.id,
            connection.generation,
            pane.workspace_id,
          ]),
          workspaceLabel: workspace
            ? workspaceDisplayName(workspace)
            : pane.workspace_id,
          tabLabel: tab?.workspace_id === pane.workspace_id ? tab.label : "",
        };
      });
  });
}

let lastSnapshots: ConnectionAgentSessions[] | null = null;
/** The bridge's stamp of `lastSnapshots`: an unchanged answer sends none. */
let lastVersion: string | undefined;
/**
 * Agents' events come in bursts; the sessions are read again at most this
 * often, which also bounds what a slow link carries.
 */
export const SESSIONS_REFRESH_GAP_MS = 2_000;

/**
 * The summaries last read, for code outside a view: the voice companion
 * lists every connection's sessions from them (voiceRoute voiceSessions).
 * Fresh while a view or voice reads them with the hook below.
 */
export function latestServerAgentSessions():
  | readonly ConnectionAgentSessions[]
  | null {
  return lastSnapshots;
}

export function useAllServerAgentSessions(enabled: boolean) {
  const state = useStoreSelector(
    (snapshot) => ({
      connections: snapshot.connections,
      status: snapshot.status,
      paused: snapshot.connectionPaused,
    }),
    shallowEqual,
  );
  // A view mounted afresh (a connection switch remounts some) starts from
  // the last snapshots read, not from nothing: its rows do not vanish and
  // come back.
  const [snapshots, setSnapshotsState] = useState<
    ConnectionAgentSessions[] | null
  >(() => lastSnapshots);
  const setSnapshots = (next: ConnectionAgentSessions[] | null) => {
    if (next) lastSnapshots = next;
    setSnapshotsState(next);
  };
  const [error, setError] = useState<string | null>(null);
  const connected = state.status === "connected" && !state.paused;

  useEffect(() => {
    if (!enabled) {
      setSnapshots(null);
      setError(null);
      return;
    }
    // Reconnecting, or the catalog changed: the last snapshots stay shown
    // until new ones come, so the lists do not empty and fill again.
    if (!connected) return;
    let disposed = false;
    let running = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishedAt = 0;
    const refresh = async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        const result = await bridge.call(
          "connections.agent_sessions",
          lastVersion && lastSnapshots ? { since: lastVersion } : {},
        );
        if (disposed) return;
        if (result?.unchanged === true && lastSnapshots) {
          setSnapshots(lastSnapshots);
          setError(null);
          return;
        }
        if (result?.sessions_delta) {
          // Changes to the summaries this page holds; against others, the
          // whole summaries are read again at once.
          const next =
            lastSnapshots &&
            result.base === lastVersion &&
            isStateDelta(result.sessions_delta)
              ? applyStateDelta(
                  { connections: lastSnapshots },
                  result.sessions_delta,
                )
              : null;
          if (!next || !Array.isArray(next.connections)) {
            lastVersion = undefined;
            queued = true;
            return;
          }
          setSnapshots(next.connections as ConnectionAgentSessions[]);
          lastVersion =
            typeof result.version === "string" ? result.version : undefined;
          setError(null);
          return;
        }
        if (!Array.isArray(result?.connections)) {
          throw new Error("Invalid session summary");
        }
        setSnapshots(result.connections);
        lastVersion =
          typeof result.version === "string" ? result.version : undefined;
        setError(null);
      } catch (error) {
        if (disposed) return;
        lastVersion = undefined;
        setSnapshots([]);
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
        finishedAt = Date.now();
        if (!disposed) {
          if (queued) {
            queued = false;
            schedule();
          }
        }
      }
    };
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          void refresh();
        },
        Math.max(150, finishedAt + SESSIONS_REFRESH_GAP_MS - Date.now()),
      );
    };
    const unsubscribe = bridge.onEvent(schedule);
    const interval = setInterval(schedule, 15_000);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(interval);
      unsubscribe();
    };
  }, [enabled, connected, state.connections]);

  const loading = snapshots === null;
  const panes =
    connected && snapshots
      ? allServerAgentPanes(state.connections, snapshots)
      : [];
  const messages = !connected
    ? [state.paused ? "Connection paused." : "Connect to load sessions."]
    : error
      ? [`Could not load sessions: ${error}`]
      : [];
  return {
    panes,
    snapshots: connected ? (snapshots ?? []) : [],
    loading: connected && loading,
    messages,
  };
}
