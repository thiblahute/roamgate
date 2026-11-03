import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { assertSafeDataPath } from "../config/data-paths";
import {
  type ActivityPage,
  type ActivityStatus,
  type ActivityWorkspace,
  type EventKind,
  isoTime,
  type RecordingGap,
} from "./protocol";
import {
  activityStoragePath,
  type EventRow,
  eventFromRow,
  hasAddedColumns,
  WORKSPACE_COLUMNS,
  type WorkspaceDbRow,
  workspaceFromRow,
} from "./store";
import { type SubjectOf, withSubjects } from "./subjects";
import {
  type AgentRow,
  buildTimeline,
  type FocusRow,
  type GapInputRow,
  type PresenceRow,
  DEFAULT_IDLE_MS,
  RECORDER_STALE_MS,
  type SessionInputRow,
  type Timeline,
} from "./timeline";

/**
 * Read-only access to activity.sqlite, for the timeline RPC and
 * `roamgate activity`. Opens its own connection: the recorder may be writing
 * (WAL lets readers in), or not running at all.
 */
export type ActivityReader = {
  /**
   * `excludeConnections` leaves those connections out entirely;
   * `idleSeconds` is the setting (see TimelineInput.idleMs).
   */
  timeline(
    range: { from: number; to: number },
    dayStart: string,
    excludeConnections?: string[],
    idleSeconds?: number,
  ): Timeline;
  /** Events in id order after `after`, within `[from, to)` by `ts`. */
  page(query: PageQuery): ActivityPage;
  workspaces(query: {
    from?: number;
    to?: number;
    connection?: string;
  }): ActivityWorkspace[];
  status(query: {
    enabled: boolean;
    retentionDays: number;
    from: number;
    to: number;
  }): ActivityStatus;
  close(): void;
};

export type PageQuery = {
  after?: number;
  from?: number;
  to?: number;
  connection?: string;
  workspace?: string;
  kinds?: EventKind[];
  /** Connections left out (`exclude.connections`). */
  excludeConnections?: string[];
  limit: number;
};

export const PAGE_LIMIT_DEFAULT = 1000;
export const PAGE_LIMIT_MAX = 5000;

/** Parses an event id (`0000000000000042`) back into its seq. */
export function eventSeq(id: string): number | null {
  if (!/^\d{1,16}$/.test(id)) return null;
  const seq = Number(id);
  return Number.isSafeInteger(seq) ? seq : null;
}

function checkVersion(db: Database) {
  db.exec("PRAGMA busy_timeout = 5000");
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  if (version !== 1) throw new Error("Unsupported activity database");
}

/**
 * A read-only connection. With the recorder stopped, a WAL database has no
 * shared-memory file, which a read-only connection cannot create: then a
 * connection that may create it, refusing every write (`query_only`).
 */
function openReadOnly(path: string): Database {
  let db = new Database(path, { readonly: true, strict: true });
  try {
    checkVersion(db);
    return db;
  } catch (error) {
    db.close(false);
    if ((error as { code?: string }).code !== "SQLITE_CANTOPEN") throw error;
  }
  db = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    db.exec("PRAGMA query_only = ON");
    checkVersion(db);
    return db;
  } catch (error) {
    db.close(false);
    throw error;
  }
}

/** Null when there is no log yet. */
export function openActivityReader(
  directory: string,
  now: () => number = Date.now,
  options: { subjectOf?: SubjectOf } = {},
): ActivityReader | null {
  const path = activityStoragePath(directory);
  assertSafeDataPath(path);
  if (!existsSync(path)) return null;
  const db = openReadOnly(path);

  type FocusDbRow = Omit<FocusRow, "end" | "reason"> & {
    end: number | null;
    reason: FocusRow["reason"];
  };
  const selectFocus = db.query<FocusDbRow, [number, number]>(
    `SELECT f.seq, f.ts AS start, b.ts AS "end", b.reason, f.connection_id,
       f.workspace_id, f.tab_id, f.pane_id, COALESCE(f.source, 'browser') AS source,
       f.client_id, f.client_kind, f.session
     FROM events f LEFT JOIN events b
       ON b.span = f.seq AND b.kind = 'workspace.blur'
     WHERE f.kind = 'workspace.focus' AND f.ts < ?1
       AND (b.ts IS NULL OR b.ts >= ?2)
     ORDER BY f.seq`,
  );
  const presenceColumns = `seq, ts, kind, connection_id, client_id, client_kind,
       CASE WHEN visible IS NULL THEN NULL ELSE visible = 1 END AS visible, session`;
  const presenceKinds = `kind IN ('session.idle', 'session.active', 'ui.visibility')
       AND client_id IS NOT NULL`;
  const selectPresence = db.query<PresenceRow, [number, number]>(
    `SELECT ${presenceColumns} FROM events
     WHERE ${presenceKinds} AND ts >= ?1 AND ts < ?2
     UNION
     SELECT ${presenceColumns} FROM events
     WHERE seq IN (SELECT MAX(seq) FROM events
       WHERE ${presenceKinds} AND ts < ?1 GROUP BY client_id)
     ORDER BY seq`,
  );
  const agentColumns = `seq, ts, connection_id, workspace_id, pane_id,
       agent_name AS name, agent_state AS state, agent_task AS task, session`;
  const selectAgents = db.query<AgentRow, [number, number]>(
    `SELECT ${agentColumns} FROM events
     WHERE kind = 'agent.state' AND agent_name IS NOT NULL
       AND ts >= ?1 AND ts < ?2
     UNION
     SELECT ${agentColumns} FROM events
     WHERE seq IN (SELECT MAX(seq) FROM events
       WHERE kind = 'agent.state' AND agent_name IS NOT NULL AND ts < ?1
       GROUP BY connection_id, pane_id, agent_name)
       AND agent_state != 'unknown'
     ORDER BY seq`,
  );
  const selectGaps = db.query<
    GapInputRow & { end: number | null },
    [number, number]
  >(
    `SELECT connection_id, start_ts AS start, end_ts AS "end", reason
     FROM connection_gaps
     WHERE start_ts < ?1 AND (end_ts IS NULL OR end_ts > ?2)
     ORDER BY start_ts, id`,
  );
  // One per bridge run: few enough to read whole.
  const selectSessions = db.query<SessionInputRow, []>(
    "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions ORDER BY id",
  );
  const selectWorkspaces = db.query<WorkspaceDbRow, []>(
    hasAddedColumns(db)
      ? `SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY id`
      : "SELECT id, connection_id, name, path, herdr_workspace_id, repo_root, repo_is_worktree FROM workspaces ORDER BY id",
  );

  const allWorkspaces = () =>
    withSubjects(
      selectWorkspaces.all().map(workspaceFromRow),
      options.subjectOf,
    );

  function gapsBetween(from: number, to: number): RecordingGap[] {
    return selectGaps.all(to, from).map((gap) => ({
      connection_id: gap.connection_id,
      start: isoTime(gap.start),
      end: gap.end === null ? null : isoTime(gap.end),
      reason: gap.reason,
      excluded: false,
    }));
  }

  return {
    timeline(range, dayStart, excludeConnections = [], idleSeconds) {
      const at = now();
      const idleMs =
        idleSeconds === undefined ? DEFAULT_IDLE_MS : idleSeconds * 1000;
      const excluded = new Set(excludeConnections);
      const kept = <T extends { connection_id: string | null }>(rows: T[]) =>
        excluded.size === 0
          ? rows
          : rows.filter(
              (row) =>
                row.connection_id === null || !excluded.has(row.connection_id),
            );
      return db
        .transaction(() =>
          buildTimeline({
            from: range.from,
            to: range.to,
            now: at,
            dayStart,
            // Spans ended shortly before the range still show a person
            // was there at its start.
            focus: kept(selectFocus.all(range.to, range.from - idleMs)).map(
              (row) => ({
                ...row,
                reason: row.end === null ? null : row.reason,
              }),
            ),
            presence: kept(selectPresence.all(range.from, range.to)).map(
              (row) => ({
                ...row,
                visible: row.visible === null ? null : !!row.visible,
              }),
            ),
            agents: kept(selectAgents.all(range.from, range.to)),
            gaps: kept(selectGaps.all(range.to, range.from)),
            sessions: selectSessions.all(),
            workspaces: kept(allWorkspaces()),
            idleMs,
          }),
        )
        .deferred();
    },
    page(query) {
      const where = ["e.seq > ?"];
      const args: (string | number)[] = [query.after ?? 0];
      if (query.from !== undefined) {
        where.push("e.ts >= ?");
        args.push(query.from);
      }
      if (query.to !== undefined) {
        where.push("e.ts < ?");
        args.push(query.to);
      }
      if (query.connection !== undefined) {
        where.push("e.connection_id = ?");
        args.push(query.connection);
      }
      if (query.workspace !== undefined) {
        where.push("e.workspace_id = ?");
        args.push(query.workspace);
      }
      if (query.kinds?.length) {
        where.push(`e.kind IN (${query.kinds.map(() => "?").join(", ")})`);
        args.push(...query.kinds);
      }
      if (query.excludeConnections?.length) {
        where.push(
          `e.connection_id NOT IN (${query.excludeConnections.map(() => "?").join(", ")})`,
        );
        args.push(...query.excludeConnections);
      }
      const limit = Math.max(1, Math.min(query.limit, PAGE_LIMIT_MAX));
      args.push(limit + 1);
      const rows = db
        .query<EventRow, (string | number)[]>(
          `SELECT e.*, (e.kind = 'workspace.focus'
               AND NOT EXISTS (SELECT 1 FROM events b WHERE b.span = e.seq)) AS open
           FROM events e WHERE ${where.join(" AND ")}
           ORDER BY e.seq LIMIT ?`,
        )
        .all(...args);
      const more = rows.length > limit;
      const events = rows.slice(0, limit).map(eventFromRow);
      const ids = new Set(
        events.map((event) => event.workspace_id).filter(Boolean),
      );
      return {
        events,
        workspaces: allWorkspaces().filter((workspace) =>
          ids.has(workspace.id),
        ),
        next_cursor: more ? events[events.length - 1]!.id : null,
      };
    },
    workspaces(query) {
      const where = ["workspace_id IS NOT NULL"];
      const args: (string | number)[] = [];
      if (query.from !== undefined) {
        where.push("ts >= ?");
        args.push(query.from);
      }
      if (query.to !== undefined) {
        where.push("ts < ?");
        args.push(query.to);
      }
      if (query.connection !== undefined) {
        where.push("connection_id = ?");
        args.push(query.connection);
      }
      const ids = new Set(
        db
          .query<{ workspace_id: string }, (string | number)[]>(
            `SELECT DISTINCT workspace_id FROM events WHERE ${where.join(" AND ")}`,
          )
          .all(...args)
          .map((row) => row.workspace_id),
      );
      return allWorkspaces().filter((workspace) => ids.has(workspace.id));
    },
    status(query) {
      const at = now();
      const latest = db
        .query<SessionInputRow, []>(
          "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions ORDER BY id DESC LIMIT 1",
        )
        .get();
      const running =
        !!latest &&
        latest.stopped_at === null &&
        at - latest.last_alive <= RECORDER_STALE_MS;
      const connectionIds = db
        .query<{ id: string }, []>(
          `SELECT connection_id AS id FROM workspaces
           UNION SELECT connection_id FROM connection_gaps
             WHERE connection_id IS NOT NULL
           ORDER BY id`,
        )
        .all()
        .map((row) => row.id);
      const connections = connectionIds.map((id) => {
        const open = db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM connection_gaps WHERE connection_id = ? AND end_ts IS NULL",
          )
          .get(id)!.n;
        if (!running || open > 0)
          return {
            id,
            state: "disconnected" as const,
            recording_since: null,
          };
        const lastGap = db
          .query<{ end_ts: number | null }, [string]>(
            "SELECT MAX(end_ts) AS end_ts FROM connection_gaps WHERE connection_id = ?",
          )
          .get(id)!.end_ts;
        return {
          id,
          state: "ready" as const,
          recording_since: isoTime(Math.max(lastGap ?? 0, latest!.started_at)),
        };
      });
      const gaps = gapsBetween(query.from, query.to);
      if (latest && !running)
        gaps.push({
          connection_id: null,
          start: isoTime(latest.stopped_at ?? latest.last_alive),
          end: null,
          reason: "recorder",
          excluded: false,
        });
      return {
        recording: query.enabled && running,
        retention_days: query.retentionDays,
        last_alive: latest ? isoTime(latest.last_alive) : null,
        gaps,
        connections,
      };
    },
    close() {
      db.close(false);
    },
  };
}
