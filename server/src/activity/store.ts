import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { assertSafeDataPath } from "../config/data-paths";
import {
  type ActivityEvent,
  type ActivityGap,
  type ActivityWorkspace,
  type AgentState,
  type BlurReason,
  type ClientKind,
  type EventKind,
  type EventSource,
  eventId,
  isoTime,
} from "./protocol";
import type { RepoInfo } from "./repo-info";

/**
 * The activity log: coarse, timestamped attention and agent-state events per
 * connection, the workspaces they refer to, recorder sessions and the periods
 * nothing was recorded. Times are epoch milliseconds; `seq` orders the log.
 * No terminal contents are stored.
 */
export type ActivityStore = {
  append(event: NewEvent): number;
  upsertWorkspace(workspace: WorkspaceRow): void;
  /** What git says of a workspace's repository (repo-info.ts). */
  setRepo(id: string, repo: RepoInfo | null): void;
  startSession(now: number): number;
  alive(session: number, now: number): void;
  stopSession(session: number, at: number, clean: boolean): void;
  /** Sessions never stopped: the recorder died. */
  unfinishedSessions(): SessionRow[];
  /** The last session before `session`, if any. */
  previousSession(session: number): SessionRow | null;
  /** Focus events with no blur yet. */
  openSpans(): SpanRow[];
  /** Clients whose last visibility event says visible. */
  visibleClients(): VisibleClientRow[];
  openGap(connectionId: string | null, start: number, reason: string): number;
  closeGap(id: number, end: number): void;
  addGap(
    connectionId: string | null,
    start: number,
    end: number,
    reason: string,
  ): void;
  openGaps(): GapRow[];
  /** Deletes what ended before `cutoff`; returns the events deleted. */
  purge(cutoff: number): number;
  /** Returns freed pages to the file system, a bounded amount at a time. */
  vacuum(): void;
  /** Read side, for tests and the readers to come. */
  readEvents(range?: { from?: number; to?: number }): ActivityEvent[];
  readWorkspaces(): ActivityWorkspace[];
  readGaps(): ActivityGap[];
  close(): void;
};

export type NewEvent = {
  ts: number;
  kind: EventKind;
  connectionId: string;
  session: number;
  workspaceId?: string | null;
  tabId?: string | null;
  paneId?: string | null;
  agent?: {
    name: string;
    state: AgentState;
    task: string | null;
    sessionId: string | null;
  } | null;
  visible?: boolean | null;
  idleAfterSeconds?: number | null;
  reason?: BlurReason | null;
  client?: { id: string; kind: ClientKind } | null;
  source?: EventSource | null;
  /** On a blur: the seq of the focus it ends. */
  span?: number | null;
};

export type WorkspaceRow = {
  id: string;
  connectionId: string;
  name: string;
  path: string | null;
  herdrWorkspaceId: string | null;
  repoRoot: string | null;
  repoIsWorktree: boolean | null;
  seenAt: number;
};

export type SessionRow = {
  id: number;
  started_at: number;
  last_alive: number;
  stopped_at: number | null;
};

export type SpanRow = {
  seq: number;
  ts: number;
  connection_id: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  client_id: string | null;
  client_kind: string | null;
  source: string;
  session: number;
};

export type VisibleClientRow = {
  connection_id: string;
  client_id: string;
  client_kind: string;
  session: number;
};

export type GapRow = {
  id: number;
  connection_id: string | null;
  start_ts: number;
  reason: string;
};

export type EventRow = {
  seq: number;
  ts: number;
  kind: EventKind;
  connection_id: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  agent_name: string | null;
  agent_state: AgentState | null;
  agent_task: string | null;
  agent_session_id: string | null;
  visible: number | null;
  idle_after_seconds: number | null;
  reason: BlurReason | null;
  client_id: string | null;
  client_kind: ClientKind | null;
  source: EventSource | null;
  span: number | null;
  open: number;
};

export type WorkspaceDbRow = {
  id: string;
  connection_id: string;
  name: string;
  path: string | null;
  herdr_workspace_id: string | null;
  repo_root: string | null;
  repo_is_worktree: number | null;
  repo_branch?: string | null;
  repo_remote_url?: string | null;
};

/** The workspaces columns readers select; older logs lack the git ones. */
export const WORKSPACE_COLUMNS =
  "id, connection_id, name, path, herdr_workspace_id, repo_root, repo_is_worktree, repo_branch, repo_remote_url";

/**
 * Columns added after version 1 shipped: created on open, so a reader of an
 * older log (opened read-only) has to check for them.
 */
const ADDED_COLUMNS = [
  ["workspaces", "repo_branch", "TEXT"],
  ["workspaces", "repo_remote_url", "TEXT"],
] as const;

export function hasAddedColumns(db: Database): boolean {
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(workspaces)")
      .all()
      .map((row) => row.name),
  );
  return ADDED_COLUMNS.every(([, column]) => columns.has(column));
}

const SCHEMA_VERSION = 1;
const KINDS =
  "'workspace.focus', 'workspace.blur', 'agent.state', 'session.idle', 'session.active', 'ui.visibility'";
const schema = `
  CREATE TABLE recorder_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL, last_alive INTEGER NOT NULL,
    stopped_at INTEGER, clean_stop INTEGER
  ) STRICT;
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, name TEXT NOT NULL,
    path TEXT, herdr_workspace_id TEXT,
    repo_root TEXT, repo_is_worktree INTEGER,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${KINDS})),
    connection_id TEXT NOT NULL,
    workspace_id TEXT, tab_id TEXT, pane_id TEXT,
    agent_name TEXT, agent_state TEXT, agent_task TEXT, agent_session_id TEXT,
    visible INTEGER, idle_after_seconds INTEGER, reason TEXT,
    client_id TEXT, client_kind TEXT, source TEXT,
    span INTEGER,
    session INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX events_ts ON events(ts, seq);
  CREATE INDEX events_span ON events(span) WHERE span IS NOT NULL;
  CREATE TABLE connection_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT,
    start_ts INTEGER NOT NULL, end_ts INTEGER,
    reason TEXT NOT NULL,
    excluded INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX connection_gaps_start ON connection_gaps(start_ts);
`;

/** An events row as the protocol's Event (`open` computed by the query). */
export function eventFromRow(row: EventRow): ActivityEvent {
  const event: ActivityEvent = {
    id: eventId(row.seq),
    ts: isoTime(row.ts),
    kind: row.kind,
    connection_id: row.connection_id,
    workspace_id: row.workspace_id,
    tab_id: row.tab_id,
    pane_id: row.pane_id,
  };
  if (row.kind === "agent.state" && row.agent_name && row.agent_state)
    event.agent = {
      name: row.agent_name,
      state: row.agent_state,
      task: row.agent_task,
      session_id: row.agent_session_id,
    };
  if (row.kind === "ui.visibility") event.visible = row.visible === 1;
  if (row.kind === "session.idle")
    event.idle_after_seconds = row.idle_after_seconds;
  if (row.kind === "workspace.blur") event.reason = row.reason;
  if (row.kind === "workspace.focus") event.open = row.open === 1;
  if (row.client_id && row.client_kind)
    event.client = { id: row.client_id, kind: row.client_kind };
  else if (row.kind !== "agent.state") event.client = null;
  // Only attention spans carry a source.
  if (
    row.source &&
    (row.kind === "workspace.focus" || row.kind === "workspace.blur")
  )
    event.source = row.source;
  return event;
}

export function workspaceFromRow(row: WorkspaceDbRow): ActivityWorkspace {
  return {
    id: row.id,
    connection_id: row.connection_id,
    name: row.name,
    path: row.path,
    subject: null,
    repo: row.repo_root
      ? {
          root: row.repo_root,
          remote_url: row.repo_remote_url ?? null,
          branch: row.repo_branch ?? null,
          is_worktree: row.repo_is_worktree === 1,
        }
      : null,
    herdr_workspace_id: row.herdr_workspace_id,
  };
}

/** At most this many free pages are returned per vacuum. */
const VACUUM_PAGES = 4096;
/** Below this many free pages a vacuum is not worth it. */
const VACUUM_MIN_FREE_PAGES = 256;

function privateFile(path: string, create = false) {
  assertSafeDataPath(path);
  const fd = openSync(
    path,
    constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0) |
      (create ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Invalid activity storage file");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export function activityStoragePath(directory: string): string {
  return join(directory, "activity.sqlite");
}

export function openActivityStore(directory: string): ActivityStore {
  const path = activityStoragePath(directory);
  const sidecars = [`${path}-wal`, `${path}-shm`, `${path}-journal`];
  assertSafeDataPath(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const existing = existsSync(path);
  privateFile(path, !existing);
  function protect() {
    for (const sidecar of sidecars) {
      assertSafeDataPath(sidecar);
      if (!existsSync(sidecar)) continue;
      // Closing another fd on a live SQLite file can release its POSIX locks.
      const stat = lstatSync(sidecar);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Invalid activity storage file");
      chmodSync(sidecar, 0o600);
    }
  }
  protect();
  const db = new Database(path, { readwrite: true, strict: true });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      db.close(false);
    }
  };
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    // Only takes effect before the first table exists.
    if (version === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    if (
      db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
        ?.journal_mode !== "wal"
    )
      throw new Error("Activity database requires WAL");
    // A crash may lose the last events, never corrupt the log.
    db.exec("PRAGMA synchronous = NORMAL");
    if (version === 0) {
      db.transaction(() => {
        db.exec(schema);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }).immediate();
    } else if (version !== SCHEMA_VERSION) {
      throw new Error("Unsupported activity database");
    }
    // For the readers (reader.ts): states and presence by kind. Added after
    // version 1 shipped, so created on open rather than with the schema.
    db.exec("CREATE INDEX IF NOT EXISTS events_kind ON events(kind, ts)");
    if (!hasAddedColumns(db))
      db.transaction(() => {
        for (const [table, column, type] of ADDED_COLUMNS) {
          const present = db
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
            .some((row) => row.name === column);
          if (!present)
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
      }).immediate();
    protect();
  } catch (error) {
    close();
    throw error;
  }

  const insertEvent = db.query(
    `INSERT INTO events (
      ts, kind, connection_id, workspace_id, tab_id, pane_id,
      agent_name, agent_state, agent_task, agent_session_id,
      visible, idle_after_seconds, reason, client_id, client_kind, source,
      span, session
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertWorkspaceQuery = db.query(
    `INSERT INTO workspaces (
      id, connection_id, name, path, herdr_workspace_id,
      repo_root, repo_is_worktree, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path,
      herdr_workspace_id = excluded.herdr_workspace_id,
      repo_root = COALESCE(excluded.repo_root, repo_root),
      repo_is_worktree = COALESCE(excluded.repo_is_worktree, repo_is_worktree),
      last_seen = MAX(last_seen, excluded.last_seen)`,
  );
  const updateRepo = db.query(
    `UPDATE workspaces SET repo_root = COALESCE(?, repo_root), repo_is_worktree = ?,
       repo_branch = ?, repo_remote_url = ? WHERE id = ?`,
  );
  const insertSession = db.query<{ id: number }, [number, number]>(
    "INSERT INTO recorder_sessions (started_at, last_alive) VALUES (?, ?) RETURNING id",
  );
  const updateAlive = db.query(
    "UPDATE recorder_sessions SET last_alive = ? WHERE id = ? AND stopped_at IS NULL",
  );
  const updateStopped = db.query(
    "UPDATE recorder_sessions SET stopped_at = ?, last_alive = MAX(last_alive, ?), clean_stop = ? WHERE id = ?",
  );
  const selectUnfinished = db.query<SessionRow, []>(
    "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions WHERE stopped_at IS NULL ORDER BY id",
  );
  const selectPrevious = db.query<SessionRow, [number]>(
    "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions WHERE id < ? ORDER BY id DESC LIMIT 1",
  );
  const selectOpenSpans = db.query<SpanRow, []>(
    `SELECT f.seq, f.ts, f.connection_id, f.workspace_id, f.tab_id, f.pane_id,
       f.client_id, f.client_kind, f.source, f.session
     FROM events f
     WHERE f.kind = 'workspace.focus'
       AND NOT EXISTS (SELECT 1 FROM events b WHERE b.span = f.seq)
     ORDER BY f.seq`,
  );
  const selectVisibleClients = db.query<VisibleClientRow, []>(
    `SELECT e.connection_id, e.client_id, e.client_kind, e.session
     FROM events e
     WHERE e.seq IN (
       SELECT MAX(seq) FROM events
       WHERE kind = 'ui.visibility' AND client_id IS NOT NULL
       GROUP BY client_id
     ) AND e.visible = 1
     ORDER BY e.seq`,
  );
  const insertGap = db.query<
    { id: number },
    [string | null, number, number | null, string]
  >(
    "INSERT INTO connection_gaps (connection_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?) RETURNING id",
  );
  const updateGapEnd = db.query(
    "UPDATE connection_gaps SET end_ts = MAX(start_ts, ?) WHERE id = ? AND end_ts IS NULL",
  );
  const selectOpenGaps = db.query<GapRow, []>(
    "SELECT id, connection_id, start_ts, reason FROM connection_gaps WHERE end_ts IS NULL ORDER BY id",
  );
  const purgeEvents = db.query("DELETE FROM events WHERE ts < ?");
  const purgeGaps = db.query(
    "DELETE FROM connection_gaps WHERE end_ts IS NOT NULL AND end_ts < ?",
  );
  const purgeSessions = db.query(
    `DELETE FROM recorder_sessions WHERE stopped_at IS NOT NULL AND stopped_at < ?
       AND id < (SELECT MAX(id) FROM recorder_sessions)`,
  );
  const purgeWorkspaces = db.query(
    `DELETE FROM workspaces WHERE last_seen < ?
       AND NOT EXISTS (SELECT 1 FROM events WHERE events.workspace_id = workspaces.id)`,
  );
  const selectEvents = db.query<EventRow, [number, number]>(
    `SELECT e.*, (e.kind = 'workspace.focus'
         AND NOT EXISTS (SELECT 1 FROM events b WHERE b.span = e.seq)) AS open
     FROM events e WHERE e.ts >= ? AND e.ts < ? ORDER BY e.ts, e.seq`,
  );
  const selectWorkspaces = db.query<WorkspaceDbRow, []>(
    `SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY id`,
  );
  const selectGaps = db.query<
    {
      connection_id: string | null;
      start_ts: number;
      end_ts: number | null;
      reason: string;
      excluded: number;
    },
    []
  >(
    "SELECT connection_id, start_ts, end_ts, reason, excluded FROM connection_gaps ORDER BY start_ts, id",
  );

  return {
    append(event) {
      const result = insertEvent.run(
        event.ts,
        event.kind,
        event.connectionId,
        event.workspaceId ?? null,
        event.tabId ?? null,
        event.paneId ?? null,
        event.agent?.name ?? null,
        event.agent?.state ?? null,
        event.agent?.task ?? null,
        event.agent?.sessionId ?? null,
        event.visible === undefined || event.visible === null
          ? null
          : event.visible
            ? 1
            : 0,
        event.idleAfterSeconds ?? null,
        event.reason ?? null,
        event.client?.id ?? null,
        event.client?.kind ?? null,
        event.source ?? null,
        event.span ?? null,
        event.session,
      );
      return Number(result.lastInsertRowid);
    },
    upsertWorkspace(workspace) {
      upsertWorkspaceQuery.run(
        workspace.id,
        workspace.connectionId,
        workspace.name,
        workspace.path,
        workspace.herdrWorkspaceId,
        workspace.repoRoot,
        workspace.repoIsWorktree === null
          ? null
          : workspace.repoIsWorktree
            ? 1
            : 0,
        workspace.seenAt,
        workspace.seenAt,
      );
    },
    setRepo(id, repo) {
      updateRepo.run(
        repo?.root ?? null,
        repo ? (repo.isWorktree ? 1 : 0) : null,
        repo?.branch ?? null,
        repo?.remoteUrl ?? null,
        id,
      );
    },
    startSession(now) {
      return insertSession.get(now, now)!.id;
    },
    alive(session, now) {
      updateAlive.run(now, session);
    },
    stopSession(session, at, clean) {
      updateStopped.run(at, at, clean ? 1 : 0, session);
    },
    unfinishedSessions: () => selectUnfinished.all(),
    previousSession: (session) => selectPrevious.get(session) ?? null,
    openSpans: () => selectOpenSpans.all(),
    visibleClients: () => selectVisibleClients.all(),
    openGap(connectionId, start, reason) {
      return insertGap.get(connectionId, start, null, reason)!.id;
    },
    closeGap(id, end) {
      updateGapEnd.run(end, id);
    },
    addGap(connectionId, start, end, reason) {
      if (end > start) insertGap.get(connectionId, start, end, reason);
    },
    openGaps: () => selectOpenGaps.all(),
    purge(cutoff) {
      return db
        .transaction(() => {
          const events = purgeEvents.run(cutoff).changes;
          purgeGaps.run(cutoff);
          purgeSessions.run(cutoff);
          purgeWorkspaces.run(cutoff);
          return events;
        })
        .immediate();
    },
    vacuum() {
      const free = db
        .query<{ freelist_count: number }, []>("PRAGMA freelist_count")
        .get()!.freelist_count;
      if (free >= VACUUM_MIN_FREE_PAGES)
        db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
    },
    readEvents(range = {}) {
      return selectEvents
        .all(range.from ?? 0, range.to ?? Number.MAX_SAFE_INTEGER)
        .map(eventFromRow);
    },
    readWorkspaces() {
      return selectWorkspaces.all().map(workspaceFromRow);
    },
    readGaps() {
      return selectGaps.all().map((row) => ({
        connection_id: row.connection_id,
        start: isoTime(row.start_ts),
        end: row.end_ts === null ? null : isoTime(row.end_ts),
        reason: row.reason,
        excluded: row.excluded === 1,
      }));
    },
    close,
  };
}
