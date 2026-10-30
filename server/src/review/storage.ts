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
import { assertSafeDataPath, dataRoot } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import type { ReviewSession, ReviewThread } from "../../../shared/review";

/**
 * Review sessions and their threads, one row each with the record as JSON.
 * Every change is written through, so a review survives a bridge restart and
 * reaches every browser from the same source.
 */
export type ReviewStorage = {
  loadSessions(): ReviewSession[];
  loadThreads(sessionId: string): ReviewThread[];
  saveSession(session: ReviewSession): void;
  saveThread(thread: ReviewThread): void;
  deleteThread(id: string): void;
  deleteSession(id: string): void;
  close(): void;
};

const SCHEMA_VERSION = 1;
const schema = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, data TEXT NOT NULL
  ) STRICT;
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, data TEXT NOT NULL
  ) STRICT;
  CREATE INDEX threads_session ON threads(session_id, created_at);
`;

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
      throw new Error("Invalid review storage file");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export function openReviewStorage(directory: string): ReviewStorage {
  const path = join(directory, "reviews.sqlite");
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
      const stat = lstatSync(sidecar);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Invalid review storage file");
      chmodSync(sidecar, 0o600);
    }
  }
  protect();
  const db = new Database(path, { readwrite: true, strict: true });
  let closed = false;
  const close = () => {
    if (!closed) {
      db.close(true);
      closed = true;
    }
  };
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (
      db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
        ?.journal_mode !== "wal"
    )
      throw new Error("Review database requires WAL");
    db.exec("PRAGMA synchronous = FULL");
    if (version === 0) {
      db.transaction(() => {
        db.exec(schema);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      })();
    } else if (version !== SCHEMA_VERSION) {
      throw new Error("Unsupported review database");
    }
    protect();
  } catch (error) {
    close();
    throw error;
  }

  const upsertSession = db.query(
    `INSERT INTO sessions (id, connection_id, updated_at, data)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id,
       updated_at = excluded.updated_at, data = excluded.data`,
  );
  const upsertThread = db.query(
    `INSERT INTO threads (id, session_id, created_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
  );
  const selectSessions = db.query<{ data: string }, []>(
    "SELECT data FROM sessions ORDER BY updated_at",
  );
  const selectThreads = db.query<{ data: string }, [string]>(
    "SELECT data FROM threads WHERE session_id = ? ORDER BY created_at, id",
  );
  const removeThread = db.query("DELETE FROM threads WHERE id = ?");
  const removeSession = db.query("DELETE FROM sessions WHERE id = ?");

  function parseRows<T>(rows: { data: string }[]): T[] {
    const records: T[] = [];
    for (const row of rows) {
      try {
        records.push(JSON.parse(row.data) as T);
      } catch {
        // A row this version cannot read is skipped rather than failing every
        // other review.
      }
    }
    return records;
  }

  return {
    loadSessions: () => parseRows<ReviewSession>(selectSessions.all()),
    loadThreads: (sessionId) =>
      parseRows<ReviewThread>(selectThreads.all(sessionId)),
    saveSession(session) {
      upsertSession.run(
        session.id,
        session.connectionId,
        session.updatedAt,
        JSON.stringify(session),
      );
    },
    saveThread(thread) {
      upsertThread.run(
        thread.id,
        thread.sessionId,
        thread.createdAt,
        JSON.stringify(thread),
      );
    },
    deleteThread: (id) => {
      removeThread.run(id);
    },
    deleteSession: (id) => {
      removeSession.run(id);
    },
    close,
  };
}

export function reviewDirectory(): string {
  return roamgateEnv("REVIEW_DIR") ?? join(dataRoot(), "reviews");
}
