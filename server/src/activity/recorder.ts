import { createHash } from "node:crypto";
import type { GuiActivitySettings } from "../config/gui-settings";
import { herdrEventName } from "../utils/herdr-events";
import { type Logger, silentLogger } from "../utils/logger";
import {
  type AgentState,
  type BlurReason,
  type ClientKind,
  type EventCause,
  type EventSource,
  type ReportedCause,
  agentState,
} from "./protocol";
import { readRepoInfo, type RunHostScript } from "./repo-info";
import { type ActivityStore, type NewEvent, openActivityStore } from "./store";

/**
 * The activity recorder: turns what the bridge already sees into the
 * activity log (store.ts). It records, per connection,
 *
 * - agent states from Herdr's per-pane status events, consecutive identical
 *   states once, with each `pane.list` reconcile catching missed changes;
 *   for the agents Roamgate runs itself (`ownedAgents`), their state as
 *   Roamgate knows it, never Herdr's;
 * - attention spans: a browser's presence reports (`activity.presence`)
 *   become `workspace.focus` / `workspace.blur` pairs, and Herdr's own TUI
 *   focus becomes low-confidence spans with `source: "herdr"`;
 * - the periods a connection was not ready, and those the recorder itself
 *   was not running, so "nothing happened" can be told from "not recorded".
 *
 * Only a person opens a browser span: a page that loads, reloads or
 * reconnects, or whose view moves without input (following Herdr, or moved
 * by Roamgate), opens none until a real input follows. Every attention
 * event says its cause (protocol EventCause).
 *
 * Every focus gets a blur with a reason. Signals are applied in the order
 * they arrive, each with the time it arrived, through one queue: resolving a
 * Herdr workspace to its stable id may need a Herdr call first.
 */
export type ActivityRecorder = {
  /** True once recording, false when off or the log could not be opened. */
  ready(): Promise<boolean>;
  /** `ts`: when the signal arrived, when it is applied later (held). */
  connectionStatus(connectionId: string, state: string, ts?: number): void;
  herdrEvent(connectionId: string, event: unknown, ts?: number): void;
  /** A `pane.list` result, and when that listing was started. */
  paneList(
    connectionId: string,
    result: unknown,
    startedAt: number,
    ts?: number,
  ): void;
  /** An agent Roamgate runs itself (`ownedAgents`) changed state. */
  ownedAgentChanged(connectionId: string, paneId: string, ts?: number): void;
  /** A browser's presence report; `socket` identifies the browser page. */
  presence(
    socket: object,
    connectionId: string,
    params: unknown,
  ): Promise<PresenceReply>;
  socketClosed(socket: object, ts?: number): void;
  /** Resolves once every signal received so far is applied. */
  flush(): Promise<void>;
  /** Applies pending signals (bounded), then ends every span and the session. */
  stop(): Promise<void>;
  /** Ends every span and the session now, without waiting. */
  stopNow(): void;
  /** The open log, for tests and the readers to come. */
  store(): ActivityStore | null;
};

export type PresenceReply = {
  recording: boolean;
  idle_seconds: number;
  /** Whether this page's report counts as attention: else it reports its next input. */
  attention: boolean;
};

/**
 * An agent Roamgate runs in a Herdr pane itself (conversation mode's
 * headless claude): Herdr's state for that pane does not follow it.
 */
export type OwnedAgent = {
  pane_id: string;
  session_id: string | null;
  agent_status: string;
};

export type HerdrCall = (
  connectionId: string,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export const PRESENCE_TIMEOUT_MS = 150_000;
export const ALIVE_INTERVAL_MS = 60_000;
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A Herdr workspace still unknown after a listing is not re-listed sooner. */
const MISS_REFRESH_MS = 5_000;
/** How often a workspace's branch and remote are read again. */
export const REPO_INFO_INTERVAL_MS = 10 * 60_000;
/** At most this many paths per host command. */
const REPO_INFO_BATCH = 24;
const STOP_DRAIN_MS = 2_000;
const MAX_INPUT_AGE_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPORTED_CAUSES: ReadonlySet<string> = new Set([
  "user_input",
  "user_focus",
  "page_load",
  "follow_herdr",
  "app",
  "repeat",
]);

type Client = { id: string; kind: ClientKind };

type Span = {
  seq: number;
  start: number;
  connectionId: string;
  workspaceId: string;
  herdrWorkspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  client: Client | null;
  source: EventSource;
};

type Resolved = { stableId: string; name: string; path: string | null };

type PaneInfo = {
  workspaceId: string;
  tabId: string | null;
  agent: string | null;
  sessionId: string | null;
  title: string | null;
  focused: boolean;
};

type AgentRecord = {
  name: string;
  state: AgentState;
  sessionId: string | null;
  workspaceId: string;
  /** Stable id it was recorded under: the workspace may be gone at the end. */
  stableId: string | null;
  tabId: string | null;
  at: number;
};

type Connection = {
  id: string;
  ready: boolean;
  gap: number | null;
  workspaces: Map<string, Resolved>;
  stale: boolean;
  refreshedAt: number;
  panes: Map<string, PaneInfo>;
  agents: Map<string, AgentRecord>;
  herdrFocus: Span | null;
  /** Ready once since the recorder started. */
  wasReady: boolean;
};

type Presence = {
  client: Client;
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  visible: boolean;
  focused: boolean;
  /** Null: no input since the page loaded. */
  inputAgeMs: number | null;
  /** Null from pages older than causes. */
  cause: ReportedCause | "repeat" | null;
};

type PresenceState = {
  client: Client;
  connectionId: string | null;
  /** Whether the UI was last reported in front of the user. */
  attentive: boolean | null;
  idle: boolean;
  lastPresenceAt: number;
  span: Span | null;
  timeout: ReturnType<typeof setTimeout> | null;
  /**
   * Only input after this counts: the page's first report on this socket,
   * or its view moving without input.
   */
  armedAfter: number;
  /** Why it is not armed: what the page's state comes from. */
  unarmedCause: EventCause;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ID_RE.test(value))
    throw new Error(`invalid ${field}`);
  return value;
}

export function parsePresence(params: unknown): Presence {
  const input = record(params);
  if (!input) throw new Error("invalid presence");
  const clientId = input.client_id;
  if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId))
    throw new Error("invalid client_id");
  const kind = input.client_kind;
  if (kind !== "desktop" && kind !== "phone")
    throw new Error("invalid client_kind");
  if (typeof input.visible !== "boolean" || typeof input.focused !== "boolean")
    throw new Error("invalid visibility");
  const age = input.input_age_ms;
  if (
    age !== null &&
    (typeof age !== "number" || !Number.isFinite(age) || age < 0)
  )
    throw new Error("invalid input_age_ms");
  const cause = input.cause ?? null;
  if (cause !== null && !REPORTED_CAUSES.has(cause as string))
    throw new Error("invalid cause");
  return {
    client: { id: clientId, kind },
    workspaceId: optionalId(input.workspace_id, "workspace_id"),
    tabId: optionalId(input.tab_id, "tab_id"),
    paneId: optionalId(input.pane_id, "pane_id"),
    visible: input.visible,
    focused: input.focused,
    inputAgeMs: age === null ? null : Math.min(age, MAX_INPUT_AGE_MS),
    cause: cause as Presence["cause"],
  };
}

/** Connection plus checkout path (or name when Herdr gives no path). */
export function stableWorkspaceId(connectionId: string, key: string): string {
  return `ws_${createHash("sha256")
    .update(`${connectionId}\0${key}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/** A session file path identifies its session by name; ids are themselves. */
function sessionId(value: unknown): string | null {
  const session = record(value);
  const raw = text(session?.value);
  if (!raw) return null;
  return session?.kind === "path"
    ? (raw
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? null)
    : raw;
}

function paneInfoFrom(value: unknown): [string, PaneInfo] | null {
  const pane = record(value);
  const paneId = text(pane?.pane_id);
  const workspaceId = text(pane?.workspace_id);
  if (!pane || !paneId || !workspaceId) return null;
  return [
    paneId,
    {
      workspaceId,
      tabId: text(pane.tab_id),
      agent: text(pane.agent),
      sessionId: sessionId(pane.agent_session),
      title: text(pane.title),
      focused: pane.focused === true,
    },
  ];
}

function listedPanes(result: unknown): Array<[string, PaneInfo, unknown]> {
  const panes = record(result)?.panes;
  if (!Array.isArray(panes)) return [];
  const listed: Array<[string, PaneInfo, unknown]> = [];
  for (const pane of panes) {
    const info = paneInfoFrom(pane);
    if (info) listed.push([info[0], info[1], record(pane)?.agent_status]);
  }
  return listed;
}

export function createActivityRecorder(options: {
  settings: () => Promise<GuiActivitySettings>;
  directory: () => string;
  herdrCall: HerdrCall;
  /** The agents Roamgate runs itself on a connection, with their state. */
  ownedAgents?: (connectionId: string) => readonly OwnedAgent[];
  /** Runs git on a connection's host for branches and remotes. */
  runHostScript?: RunHostScript;
  now?: () => number;
  logger?: Logger;
}): ActivityRecorder {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? silentLogger;
  let settings: GuiActivitySettings | null = null;
  let store: ActivityStore | null = null;
  let session = 0;
  let stopped = false;
  let finished = false;
  let aliveTimer: ReturnType<typeof setInterval> | null = null;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  const connections = new Map<string, Connection>();
  const clients = new Map<object, PresenceState>();
  /** When each stable workspace's repository was last read. */
  const repoReadAt = new Map<string, number>();
  const repoReading = new Set<string>();
  const repoTasks = new Set<Promise<void>>();

  function ownedAgents(connectionId: string): Map<string, OwnedAgent> {
    let owned: readonly OwnedAgent[] = [];
    try {
      owned = options.ownedAgents?.(connectionId) ?? [];
    } catch (error) {
      logger.debug("activity owned agents unavailable", { error });
    }
    return new Map(owned.map((agent) => [agent.pane_id, agent]));
  }

  function unref(timer: unknown) {
    (timer as { unref?: () => void } | null)?.unref?.();
  }

  function connection(id: string): Connection {
    let entry = connections.get(id);
    if (!entry) {
      entry = {
        id,
        ready: false,
        gap: null,
        workspaces: new Map(),
        stale: true,
        refreshedAt: Number.NEGATIVE_INFINITY,
        panes: new Map(),
        agents: new Map(),
        herdrFocus: null,
        wasReady: false,
      };
      connections.set(id, entry);
    }
    return entry;
  }

  function append(event: Omit<NewEvent, "session">): number {
    return store!.append({ ...event, session });
  }

  function openSpan(
    ts: number,
    fields: Omit<Span, "seq" | "start">,
    cause: EventCause,
    inputAgeMs: number | null = null,
  ): Span | null {
    const seq = append({
      ts,
      kind: "workspace.focus",
      connectionId: fields.connectionId,
      workspaceId: fields.workspaceId,
      tabId: fields.tabId,
      paneId: fields.paneId,
      client: fields.client,
      source: fields.source,
      cause,
      inputAgeMs,
    });
    return { ...fields, seq, start: ts };
  }

  /** `cause` only for a switch or hidden blur: what made the change. */
  function closeSpan(
    span: Span,
    ts: number,
    reason: BlurReason,
    cause: EventCause | null = null,
    inputAgeMs: number | null = null,
  ) {
    append({
      cause,
      inputAgeMs,
      ts: Math.max(ts, span.start),
      kind: "workspace.blur",
      connectionId: span.connectionId,
      workspaceId: span.workspaceId,
      tabId: span.tabId,
      paneId: span.paneId,
      client: span.client,
      source: span.source,
      reason,
      span: span.seq,
    });
  }

  function retention() {
    if (!store || !settings) return;
    try {
      store.purge(now() - settings.retention_days * 24 * 60 * 60 * 1000);
      store.vacuum();
    } catch (error) {
      logger.warn("activity retention failed", { error });
    }
  }

  /** Ends what a previous recorder left open, at its last sign of life. */
  function recover(ts: number) {
    const s = store!;
    const ends = new Map<number, number>();
    for (const old of s.unfinishedSessions()) {
      s.stopSession(old.id, old.last_alive, false);
      ends.set(old.id, old.last_alive);
    }
    session = s.startSession(ts);
    const previous = s.previousSession(session);
    const previousEnd = previous
      ? (previous.stopped_at ?? previous.last_alive)
      : ts;
    const endOf = (id: number) => ends.get(id) ?? previousEnd;
    for (const span of s.openSpans())
      closeSpan(
        {
          seq: span.seq,
          start: span.ts,
          connectionId: span.connection_id,
          workspaceId: span.workspace_id ?? "",
          herdrWorkspaceId: null,
          tabId: span.tab_id,
          paneId: span.pane_id,
          client:
            span.client_id && span.client_kind
              ? { id: span.client_id, kind: span.client_kind as ClientKind }
              : null,
          source: span.source as EventSource,
        },
        endOf(span.session),
        "recorder_stop",
      );
    for (const client of s.visibleClients())
      append({
        ts: endOf(client.session),
        kind: "ui.visibility",
        connectionId: client.connection_id,
        client: {
          id: client.client_id,
          kind: client.client_kind as ClientKind,
        },
        visible: false,
      });
    for (const gap of s.openGaps()) s.closeGap(gap.id, previousEnd);
    if (previous) s.addGap(null, previousEnd, ts, "recorder");
  }

  const init: Promise<boolean> = (async () => {
    settings = await options.settings();
    if (!settings.enabled || stopped) return false;
    store = openActivityStore(options.directory());
    recover(now());
    aliveTimer = setInterval(() => {
      try {
        if (store && !finished) store.alive(session, now());
      } catch (error) {
        logger.warn("activity alive stamp failed", { error });
      }
    }, ALIVE_INTERVAL_MS);
    unref(aliveTimer);
    retention();
    retentionTimer = setInterval(retention, RETENTION_INTERVAL_MS);
    unref(retentionTimer);
    logger.info("recording activity", {
      retention_days: settings.retention_days,
    });
    return true;
  })().catch((error) => {
    logger.warn("activity log unavailable", { error });
    store?.close();
    store = null;
    return false;
  });

  let chain: Promise<void> = Promise.resolve();
  /** Resolves once the task ran (or was dropped). */
  function enqueue(task: () => void | Promise<void>): Promise<void> {
    chain = chain.then(async () => {
      if (!(await init) || finished) return;
      try {
        await task();
      } catch (error) {
        logger.warn("activity signal dropped", { error });
      }
    });
    return chain;
  }

  // --- Workspaces --------------------------------------------------------

  /** Lists the connection's workspaces and panes; returns Herdr's focus. */
  async function refresh(
    conn: Connection,
  ): Promise<{ workspaceId: string; paneId: string | null } | null> {
    conn.refreshedAt = now();
    const [workspaces, panes] = await Promise.all([
      options.herdrCall(conn.id, "workspace.list", {}),
      options.herdrCall(conn.id, "pane.list", {}),
    ]);
    if (finished || !conn.ready) return null;
    const listed = listedPanes(panes);
    const firstCwd = new Map<string, string>();
    const paneRecords = record(panes)?.panes;
    if (Array.isArray(paneRecords))
      for (const pane of paneRecords) {
        const info = record(pane);
        const workspaceId = text(info?.workspace_id);
        const cwd = text(info?.cwd);
        if (workspaceId && cwd && !firstCwd.has(workspaceId))
          firstCwd.set(workspaceId, cwd);
      }
    for (const [paneId, info] of listed) conn.panes.set(paneId, info);
    const list = record(workspaces)?.workspaces;
    if (!Array.isArray(list)) return null;
    const seen = new Set<string>();
    let focused: string | null = null;
    const at = now();
    for (const value of list) {
      const workspace = record(value);
      const herdrId = text(workspace?.workspace_id);
      if (!workspace || !herdrId) continue;
      seen.add(herdrId);
      const worktree = record(workspace.worktree);
      const previous = conn.workspaces.get(herdrId);
      const name = text(workspace.label) ?? herdrId;
      const checkout = text(worktree?.checkout_path) ?? text(workspace.cwd);
      // A pane's directory follows `cd`: once known, a path sticks.
      const path = checkout ?? previous?.path ?? firstCwd.get(herdrId) ?? null;
      const stableId = stableWorkspaceId(conn.id, path ?? `name:${name}`);
      conn.workspaces.set(herdrId, { stableId, name, path });
      store!.upsertWorkspace({
        id: stableId,
        connectionId: conn.id,
        name,
        path,
        herdrWorkspaceId: herdrId,
        repoRoot: text(worktree?.repo_root),
        repoIsWorktree:
          typeof worktree?.is_linked_worktree === "boolean"
            ? worktree.is_linked_worktree
            : null,
        seenAt: at,
      });
      if (workspace.focused === true) focused = herdrId;
    }
    for (const herdrId of conn.workspaces.keys())
      if (!seen.has(herdrId)) conn.workspaces.delete(herdrId);
    conn.stale = false;
    readRepos(conn);
    if (!focused) return null;
    const pane = listed.find(
      ([, info]) => info.workspaceId === focused && info.focused,
    );
    return { workspaceId: focused, paneId: pane?.[0] ?? null };
  }

  /**
   * Reads the branch and remote of the connection's workspaces now and then,
   * off the signal queue: a slow host never holds up the log.
   */
  function readRepos(conn: Connection) {
    const run = options.runHostScript;
    if (!run || repoReading.has(conn.id)) return;
    const at = now();
    const due = new Map<string, string>();
    for (const workspace of conn.workspaces.values())
      if (
        workspace.path &&
        at - (repoReadAt.get(workspace.stableId) ?? Number.NEGATIVE_INFINITY) >=
          REPO_INFO_INTERVAL_MS
      )
        due.set(workspace.stableId, workspace.path);
    if (due.size === 0) return;
    const entries = [...due].slice(0, REPO_INFO_BATCH);
    for (const [id] of entries) repoReadAt.set(id, at);
    repoReading.add(conn.id);
    const task = (async () => {
      try {
        const paths = [...new Set(entries.map(([, path]) => path))];
        const repos = await readRepoInfo(run, conn.id, paths);
        if (finished || !store) return;
        for (const [id, path] of entries) {
          const repo = repos.get(path);
          if (repo) store.setRepo(id, repo);
        }
      } catch (error) {
        logger.debug("activity repository read failed", {
          connection: conn.id,
          error,
        });
      } finally {
        repoReading.delete(conn.id);
      }
    })();
    repoTasks.add(task);
    void task.finally(() => repoTasks.delete(task));
  }

  /** Lists, and records Herdr's focus as found when `cause` is given. */
  async function refreshAndFollowHerdr(
    conn: Connection,
    ts: number,
    cause: EventCause | null,
  ) {
    const focus = await refresh(conn);
    if (focus && cause)
      herdrFocus(conn, ts, focus.workspaceId, focus.paneId, null, cause);
  }

  /**
   * A Herdr workspace's stable id, listing first when needed. A listing
   * that finds Herdr's focus moved records it as `herdr_listing`, unless
   * the caller records that focus itself (`follow` false).
   */
  async function resolve(
    conn: Connection,
    herdrId: string | null,
    ts: number,
    follow = true,
  ): Promise<Resolved | null> {
    if (!herdrId || !conn.ready) return null;
    const known = conn.workspaces.get(herdrId);
    if (conn.stale || (!known && now() - conn.refreshedAt >= MISS_REFRESH_MS)) {
      try {
        await refreshAndFollowHerdr(conn, ts, follow ? "herdr_listing" : null);
      } catch (error) {
        logger.debug("activity workspace listing failed", {
          connection: conn.id,
          error,
        });
      }
    }
    return conn.workspaces.get(herdrId) ?? null;
  }

  // --- Herdr's own focus -------------------------------------------------

  function herdrFocus(
    conn: Connection,
    ts: number,
    herdrId: string,
    paneId: string | null,
    tabId: string | null,
    cause: EventCause,
  ) {
    const current = conn.herdrFocus;
    if (current?.herdrWorkspaceId === herdrId) return;
    const resolved = conn.workspaces.get(herdrId);
    if (current) closeSpan(current, ts, "switch", cause);
    conn.herdrFocus = resolved
      ? openSpan(
          ts,
          {
            connectionId: conn.id,
            workspaceId: resolved.stableId,
            herdrWorkspaceId: herdrId,
            tabId: tabId ?? conn.panes.get(paneId ?? "")?.tabId ?? null,
            paneId,
            client: null,
            source: "herdr",
          },
          cause,
        )
      : null;
  }

  // --- Agents -----------------------------------------------------------

  async function agentChanged(
    conn: Connection,
    ts: number,
    paneId: string,
    fields: {
      workspaceId: string;
      tabId: string | null;
      name: string;
      status: unknown;
      sessionId: string | null;
      title: string | null;
    },
  ) {
    const state = agentState(fields.status);
    const previous = conn.agents.get(paneId);
    if (
      previous &&
      ((previous.name === fields.name &&
        previous.state === state &&
        previous.sessionId === fields.sessionId) ||
        (previous.state === "unknown" && state === "unknown"))
    ) {
      previous.at = ts;
      return;
    }
    // An agent first seen in no known state says nothing yet.
    if (!previous && state === "unknown") return;
    const entry: AgentRecord = {
      name: fields.name,
      state,
      sessionId: fields.sessionId,
      workspaceId: fields.workspaceId,
      stableId: null,
      tabId: fields.tabId,
      at: ts,
    };
    conn.agents.set(paneId, entry);
    const workspace = await resolve(conn, fields.workspaceId, ts);
    entry.stableId = workspace?.stableId ?? null;
    append({
      ts,
      kind: "agent.state",
      connectionId: conn.id,
      workspaceId: workspace?.stableId ?? null,
      tabId: fields.tabId,
      paneId,
      agent: {
        name: fields.name,
        state,
        task: settings!.record_agent_titles ? fields.title : null,
        sessionId: fields.sessionId,
      },
    });
  }

  async function agentGone(conn: Connection, ts: number, paneId: string) {
    const previous = conn.agents.get(paneId);
    conn.agents.delete(paneId);
    if (!previous || previous.state === "unknown") return;
    const workspace =
      conn.workspaces.get(previous.workspaceId)?.stableId ?? previous.stableId;
    append({
      ts,
      kind: "agent.state",
      connectionId: conn.id,
      workspaceId: workspace,
      tabId: previous.tabId,
      paneId,
      agent: {
        name: previous.name,
        state: "unknown",
        task: null,
        sessionId: previous.sessionId,
      },
    });
  }

  async function handleHerdrEvent(
    conn: Connection,
    ts: number,
    event: unknown,
  ) {
    if (!conn.ready) return;
    const name = herdrEventName(event)?.replaceAll("_", ".");
    const data = record(record(event)?.data);
    if (!name || !data) return;
    const paneId = text(data.pane_id);
    const workspaceId = text(data.workspace_id);
    // Herdr's view of an agent Roamgate runs itself does not follow it.
    if (
      paneId &&
      (name === "pane.agent.status.changed" ||
        name === "pane.agent.detected") &&
      ownedAgents(conn.id).has(paneId)
    )
      return;
    switch (name) {
      case "pane.agent.status.changed": {
        if (!paneId || !workspaceId) return;
        const pane = conn.panes.get(paneId);
        const agent =
          text(data.agent) ?? pane?.agent ?? conn.agents.get(paneId)?.name;
        if (!agent) return;
        await agentChanged(conn, ts, paneId, {
          workspaceId,
          tabId: text(data.tab_id) ?? pane?.tabId ?? null,
          name: agent,
          status: data.agent_status,
          sessionId: pane?.sessionId ?? null,
          title: text(data.title) ?? pane?.title ?? null,
        });
        return;
      }
      case "pane.agent.detected":
        if (paneId && (!text(data.agent) || data.released === true))
          await agentGone(conn, ts, paneId);
        return;
      case "pane.closed":
      case "pane.exited":
        if (!paneId) return;
        conn.panes.delete(paneId);
        await agentGone(conn, ts, paneId);
        return;
      case "pane.moved": {
        const previousId = text(data.previous_pane_id);
        const moved = paneInfoFrom(data.pane);
        if (previousId && moved) {
          const agent = conn.agents.get(previousId);
          conn.agents.delete(previousId);
          conn.panes.delete(previousId);
          conn.panes.set(moved[0], moved[1]);
          if (agent)
            conn.agents.set(moved[0], {
              ...agent,
              workspaceId: moved[1].workspaceId,
              stableId:
                conn.workspaces.get(moved[1].workspaceId)?.stableId ??
                agent.stableId,
              tabId: moved[1].tabId,
            });
        }
        conn.stale = true;
        return;
      }
      case "workspace.focused":
      case "pane.focused":
        if (!workspaceId) return;
        await resolve(conn, workspaceId, ts, false);
        herdrFocus(conn, ts, workspaceId, paneId, null, "herdr_event");
        return;
      case "workspace.closed":
        if (workspaceId) conn.workspaces.delete(workspaceId);
        conn.stale = true;
        return;
      default:
        if (name.startsWith("workspace.") || name.startsWith("worktree."))
          conn.stale = true;
    }
  }

  async function handlePaneList(
    conn: Connection,
    ts: number,
    result: unknown,
    startedAt: number,
  ) {
    if (!conn.ready) return;
    const listed = listedPanes(result);
    if (!Array.isArray(record(result)?.panes)) return;
    const owned = ownedAgents(conn.id);
    const live = new Set<string>();
    for (const [paneId, listedInfo, listedStatus] of listed) {
      const mine = owned.get(paneId);
      // Herdr sees only the holder in a pane Roamgate runs claude in.
      const info: PaneInfo = mine
        ? { ...listedInfo, agent: "claude", sessionId: mine.session_id }
        : listedInfo;
      const status = mine ? mine.agent_status : listedStatus;
      conn.panes.set(paneId, info);
      live.add(paneId);
      const previous = conn.agents.get(paneId);
      // A status event newer than this listing wins over it.
      if (previous && previous.at > startedAt) continue;
      if (!info.agent) {
        if (previous) await agentGone(conn, ts, paneId);
        continue;
      }
      await agentChanged(conn, ts, paneId, {
        workspaceId: info.workspaceId,
        tabId: info.tabId,
        name: info.agent,
        status,
        sessionId: info.sessionId,
        title: info.title,
      });
    }
    for (const paneId of [...conn.agents.keys()])
      if (!live.has(paneId) && conn.agents.get(paneId)!.at <= startedAt)
        await agentGone(conn, ts, paneId);
    for (const paneId of [...conn.panes.keys()])
      if (!live.has(paneId)) conn.panes.delete(paneId);
    // Branches change without a workspace event.
    readRepos(conn);
  }

  /** An agent Roamgate runs itself, as Roamgate knows it now. */
  async function handleOwnedAgent(
    conn: Connection,
    ts: number,
    paneId: string,
  ) {
    if (!conn.ready) return;
    const mine = ownedAgents(conn.id).get(paneId);
    const pane = conn.panes.get(paneId);
    const workspaceId =
      pane?.workspaceId ?? conn.agents.get(paneId)?.workspaceId;
    // Not known yet: the next listing records it.
    if (!mine || !workspaceId) return;
    await agentChanged(conn, ts, paneId, {
      workspaceId,
      tabId: pane?.tabId ?? conn.agents.get(paneId)?.tabId ?? null,
      name: "claude",
      status: mine.agent_status,
      sessionId: mine.session_id,
      title: pane?.title ?? null,
    });
  }

  // --- Connections ------------------------------------------------------

  async function handleStatus(conn: Connection, ts: number, state: string) {
    if (state === "ready") {
      if (conn.gap !== null) store!.closeGap(conn.gap, ts);
      conn.gap = null;
      if (conn.ready) return;
      conn.ready = true;
      conn.stale = true;
      const cause = conn.wasReady ? "connection_ready" : "recorder_start";
      conn.wasReady = true;
      try {
        await refreshAndFollowHerdr(conn, ts, cause);
      } catch (error) {
        logger.debug("activity workspace listing failed", {
          connection: conn.id,
          error,
        });
      }
      return;
    }
    if (conn.ready) {
      conn.ready = false;
      for (const presence of clients.values())
        if (presence.span?.connectionId === conn.id) {
          closeSpan(presence.span, ts, "disconnect");
          presence.span = null;
        }
      if (conn.herdrFocus) closeSpan(conn.herdrFocus, ts, "disconnect");
      conn.herdrFocus = null;
      // Herdr may come back as another server: start from what it says then.
      conn.workspaces.clear();
      conn.panes.clear();
      conn.agents.clear();
      conn.stale = true;
    }
    if (conn.gap === null) conn.gap = store!.openGap(conn.id, ts, state);
  }

  // --- Presence ---------------------------------------------------------

  /** `cause` and `inputAgeMs` only when a page's report says so. */
  function visibility(
    state: PresenceState,
    ts: number,
    visible: boolean,
    cause: EventCause | null = null,
    inputAgeMs: number | null = null,
  ) {
    if (state.attentive === visible || !state.connectionId) return;
    state.attentive = visible;
    append({
      ts,
      kind: "ui.visibility",
      connectionId: state.connectionId,
      client: state.client,
      visible,
      cause,
      inputAgeMs,
    });
  }

  function endPresenceSpan(
    state: PresenceState,
    ts: number,
    reason: BlurReason,
    cause: EventCause | null = null,
    inputAgeMs: number | null = null,
  ) {
    if (!state.span) return;
    closeSpan(state.span, ts, reason, cause, inputAgeMs);
    state.span = null;
  }

  function armTimeout(socket: object, state: PresenceState) {
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = null;
    if (!state.span) return;
    state.timeout = setTimeout(() => {
      state.timeout = null;
      enqueue(() => {
        if (clients.get(socket) !== state) return;
        // Last seen at its last report; nothing is known after it.
        endPresenceSpan(state, state.lastPresenceAt, "timeout");
        visibility(state, state.lastPresenceAt, false);
      });
    }, PRESENCE_TIMEOUT_MS);
    unref(state.timeout);
  }

  /**
   * What a report's change comes from. Input since the page's socket
   * reported first, and since its view last moved on its own, is a person;
   * before that the page is loading, reconnecting or following.
   */
  function reportCause(
    state: PresenceState,
    ts: number,
    presence: Presence,
  ): { cause: EventCause; armed: boolean } {
    if (presence.cause === "follow_herdr" || presence.cause === "app") {
      state.armedAfter = ts;
      state.unarmedCause = presence.cause;
      return { cause: presence.cause, armed: false };
    }
    if (presence.inputAgeMs === null) {
      state.unarmedCause = "page_load";
      return { cause: "page_load", armed: false };
    }
    // Input at the report that opened the socket counts (the page sent it
    // for that input), except from pages older than causes, which say
    // "just now" on load.
    const lastInput = ts - presence.inputAgeMs;
    if (
      lastInput < state.armedAfter ||
      (presence.cause === null && lastInput === state.armedAfter)
    )
      return { cause: state.unarmedCause, armed: false };
    return {
      cause: presence.cause === "user_focus" ? "user_focus" : "user_input",
      armed: true,
    };
  }

  async function handlePresence(
    socket: object,
    connectionId: string,
    ts: number,
    presence: Presence,
  ) {
    let state = clients.get(socket);
    if (state && state.client.id !== presence.client.id) {
      endPresenceSpan(state, ts, "switch");
      visibility(state, ts, false);
      state = undefined;
    }
    if (!state) {
      state = {
        client: presence.client,
        connectionId: null,
        attentive: null,
        idle: false,
        lastPresenceAt: ts,
        span: null,
        timeout: null,
        // A page's first report on a socket is a load or a reconnect:
        // what it did before says nothing of now.
        armedAfter: ts,
        unarmedCause: "reconnect",
      };
      clients.set(socket, state);
    }
    if (state.connectionId !== connectionId) {
      endPresenceSpan(state, ts, "switch");
      // The UI's state moves with the browser to the other connection.
      if (state.attentive && state.connectionId) {
        visibility(state, ts, false);
      }
      state.attentive = null;
      state.connectionId = connectionId;
    }
    state.lastPresenceAt = ts;
    const { cause, armed } = reportCause(state, ts, presence);
    const age = presence.inputAgeMs;
    const attentive = presence.visible && presence.focused;
    visibility(state, ts, attentive, cause, age);
    if (!attentive) {
      endPresenceSpan(state, ts, "hidden", cause, age);
    } else if (age !== null) {
      const idleMs = settings!.idle_seconds * 1000;
      const lastInput = ts - age;
      const idle = age >= idleMs;
      if (idle && !state.idle) {
        // Reading counted as attention until the threshold, not after it.
        const idleAt = Math.min(ts, lastInput + idleMs);
        state.idle = true;
        endPresenceSpan(state, idleAt, "idle");
        append({
          ts: idleAt,
          kind: "session.idle",
          connectionId,
          client: state.client,
          idleAfterSeconds: settings!.idle_seconds,
        });
      } else if (!idle && state.idle && armed) {
        state.idle = false;
        append({
          ts,
          kind: "session.active",
          connectionId,
          client: state.client,
          cause: "user_input",
          inputAgeMs: age,
        });
      }
      if (!state.idle) {
        const conn = connection(connectionId);
        const workspace = await resolve(conn, presence.workspaceId, ts);
        const span = state.span;
        if (
          span &&
          (!workspace ||
            span.workspaceId !== workspace.stableId ||
            span.paneId !== presence.paneId)
        )
          endPresenceSpan(state, ts, "switch", cause, age);
        if (workspace && !state.span && armed)
          state.span = openSpan(
            ts,
            {
              connectionId,
              workspaceId: workspace.stableId,
              herdrWorkspaceId: presence.workspaceId,
              tabId: presence.tabId,
              paneId: presence.paneId,
              client: state.client,
              source: "browser",
            },
            cause,
            age,
          );
        else if (state.span) state.span.tabId = presence.tabId;
      }
    }
    armTimeout(socket, state);
  }

  function handleSocketClosed(socket: object, ts: number) {
    const state = clients.get(socket);
    if (!state) return;
    clients.delete(socket);
    if (state.timeout) clearTimeout(state.timeout);
    endPresenceSpan(state, ts, "disconnect");
    visibility(state, ts, false);
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (aliveTimer) clearInterval(aliveTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    for (const state of clients.values())
      if (state.timeout) clearTimeout(state.timeout);
    if (!store) return;
    const ts = now();
    try {
      for (const state of clients.values()) {
        endPresenceSpan(state, ts, "recorder_stop");
        visibility(state, ts, false);
      }
      for (const conn of connections.values()) {
        if (conn.herdrFocus) closeSpan(conn.herdrFocus, ts, "recorder_stop");
        conn.herdrFocus = null;
        if (conn.gap !== null) store.closeGap(conn.gap, ts);
        conn.gap = null;
      }
      store.stopSession(session, ts, true);
    } catch (error) {
      logger.warn("activity log could not be closed cleanly", { error });
    } finally {
      clients.clear();
      store.close();
    }
  }

  return {
    ready: () => init,
    connectionStatus(connectionId, state, at) {
      if (stopped) return;
      const ts = at ?? now();
      enqueue(() => handleStatus(connection(connectionId), ts, state));
    },
    herdrEvent(connectionId, event, at) {
      if (stopped) return;
      const ts = at ?? now();
      enqueue(() => handleHerdrEvent(connection(connectionId), ts, event));
    },
    paneList(connectionId, result, startedAt, at) {
      if (stopped) return;
      const ts = at ?? now();
      enqueue(() =>
        handlePaneList(connection(connectionId), ts, result, startedAt),
      );
    },
    ownedAgentChanged(connectionId, paneId, at) {
      if (stopped) return;
      const ts = at ?? now();
      enqueue(() => handleOwnedAgent(connection(connectionId), ts, paneId));
    },
    async presence(socket, connectionId, params) {
      const presence = parsePresence(params);
      const recording = (await init) && !stopped;
      const idleSeconds = settings?.idle_seconds ?? 300;
      if (!recording)
        return { recording, idle_seconds: idleSeconds, attention: false };
      const ts = now();
      await enqueue(() => handlePresence(socket, connectionId, ts, presence));
      return {
        recording,
        idle_seconds: idleSeconds,
        attention: !!clients.get(socket)?.span,
      };
    },
    socketClosed(socket, at) {
      if (stopped) return;
      const ts = at ?? now();
      enqueue(() => handleSocketClosed(socket, ts));
    },
    async flush() {
      await init;
      // Tasks may enqueue more (a timeout firing): wait until it settles.
      for (;;) {
        const current = chain;
        await current;
        if (current === chain) break;
      }
      await Promise.all(repoTasks);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        chain,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_DRAIN_MS);
          unref(timer);
        }),
      ]);
      if (timer) clearTimeout(timer);
      finish();
    },
    stopNow() {
      stopped = true;
      finish();
    },
    store: () => (finished ? null : store),
  };
}
