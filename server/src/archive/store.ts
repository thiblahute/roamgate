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
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { assertSafeDataPath } from "../config/data-paths";

/** Bump when the index layout changes: an unknown version is rebuilt. */
export const INDEX_VERSION = 1;

const SCHEMA = `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) STRICT;
  CREATE TABLE files(
    id INTEGER PRIMARY KEY,
    host TEXT NOT NULL, agent TEXT NOT NULL, relpath TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'transcript',
    project TEXT, session TEXT, subagent INTEGER NOT NULL DEFAULT 0,
    title TEXT, cost_usd REAL, cwd TEXT,
    src_size INTEGER, src_mtime REAL,
    archived_size INTEGER NOT NULL DEFAULT 0,
    zst_size INTEGER NOT NULL DEFAULT 0,
    indexed_bytes INTEGER NOT NULL DEFAULT 0,
    index_level TEXT NOT NULL DEFAULT 'full',
    first_ts TEXT, last_ts TEXT,
    UNIQUE(host, agent, relpath)
  ) STRICT;
  CREATE INDEX files_session ON files(agent, session);
  CREATE TABLE docs(
    id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL,
    ts TEXT, role TEXT, kind TEXT, tool TEXT
  ) STRICT;
  CREATE INDEX docs_file ON docs(file_id);
  CREATE TABLE history(
    id INTEGER PRIMARY KEY, host TEXT NOT NULL, agent TEXT NOT NULL,
    ts TEXT, project TEXT, text TEXT NOT NULL,
    UNIQUE(host, agent, ts, project, text)
  ) STRICT;
  CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='trigram');
  CREATE VIRTUAL TABLE fts_words USING fts5(text, tokenize='unicode61');
  CREATE VIRTUAL TABLE hist_fts USING fts5(text, tokenize='trigram');
`;

export type ArchiveDb = Database;

export function indexPath(archiveDir: string): string {
  return join(archiveDir, "index.sqlite");
}

function privateFile(path: string, create: boolean): void {
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
      throw new Error("Invalid archive index file");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function protectSidecars(path: string): void {
  for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    assertSafeDataPath(sidecar);
    if (!existsSync(sidecar)) continue;
    const stat = lstatSync(sidecar);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Invalid archive index file");
    chmodSync(sidecar, 0o600);
  }
}

export function removeIndex(archiveDir: string): void {
  const path = indexPath(archiveDir);
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`])
    rmSync(file, { force: true });
}

/** Meta kept across a rebuild: when each host last synced and what failed. */
export function readKeptMeta(db: ArchiveDb): Array<[string, string]> {
  return db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM meta WHERE key LIKE 'last_%' OR key LIKE 'home:%' OR key LIKE 'unknown:%'",
    )
    .all()
    .map((row) => [row.key, row.value]);
}

export type OpenResult = {
  db: ArchiveDb;
  /** The index existed with a version this code does not know. */
  needsRebuild: boolean;
};

/**
 * Opens the derived index in `archiveDir`, creating it when absent. WAL is
 * required. An index of another version is left alone and reported: the
 * caller rebuilds it from the raw files.
 */
export function openArchiveDb(
  archiveDir: string,
  options: { readonly?: boolean } = {},
): OpenResult {
  const path = indexPath(archiveDir);
  assertSafeDataPath(path);
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  chmodSync(archiveDir, 0o700);
  const existing = existsSync(path);
  if (options.readonly && !existing) throw new Error("no archive index yet");
  privateFile(path, !existing);
  protectSidecars(path);
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    const mode = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
      .get();
    if (mode?.journal_mode.toLowerCase() !== "wal")
      throw new Error("the archive index needs a file system with WAL support");
    db.exec("PRAGMA synchronous = NORMAL");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (version === 0) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${INDEX_VERSION}`);
      })();
    } else if (version !== INDEX_VERSION) {
      return { db, needsRebuild: true };
    }
    protectSidecars(path);
    return { db, needsRebuild: false };
  } catch (error) {
    db.close(false);
    throw error;
  }
}

export function setMeta(db: ArchiveDb, key: string, value: string): void {
  db.query(
    "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getMeta(db: ArchiveDb, key: string): string | null {
  return (
    db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?1",
      )
      .get(key)?.value ?? null
  );
}
