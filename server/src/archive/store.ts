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

/**
 * The archive's bookkeeping: what each raw/ file holds (sizes, offsets,
 * frame boundaries, the session it belongs to) and when each host last
 * synced. Search is the text repo's (text-repo.ts); the FTS index that
 * lived in `index.sqlite` before is gone, and an old `index.sqlite` is
 * migrated: its files and meta are copied here, then it is deleted.
 */

/** Bump when the layout changes: an unknown version is rebuilt from raw/. */
export const DB_VERSION = 2;
export const DB_FILE = "archive.sqlite";
/** The file before version 2, with the FTS tables. */
export const LEGACY_INDEX_FILE = "index.sqlite";

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
`;

/** The columns of `files`, the same in version 1 (migrated from) and 2. */
const FILE_COLUMNS =
  "id, host, agent, relpath, kind, project, session, subagent, title, cost_usd, cwd, src_size, src_mtime, archived_size, zst_size, indexed_bytes, index_level, first_ts, last_ts";

export type ArchiveDb = Database;

export function archiveDbPath(archiveDir: string): string {
  return join(archiveDir, DB_FILE);
}

export function legacyIndexPath(archiveDir: string): string {
  return join(archiveDir, LEGACY_INDEX_FILE);
}

/** The bookkeeping database to read: the current one, else an unmigrated index. */
export function existingArchiveDb(archiveDir: string): string | null {
  for (const path of [archiveDbPath(archiveDir), legacyIndexPath(archiveDir)])
    if (existsSync(path)) return path;
  return null;
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
      throw new Error("Invalid archive database file");
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
      throw new Error("Invalid archive database file");
    chmodSync(sidecar, 0o600);
  }
}

function removeSqlite(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`])
    rmSync(file, { force: true });
}

export function removeArchiveDb(archiveDir: string): void {
  removeSqlite(archiveDbPath(archiveDir));
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
 * Copies an old index's files and meta into the new database, then deletes
 * the old index (its FTS tables were most of its size).
 */
function migrateLegacyIndex(db: ArchiveDb, archiveDir: string): void {
  const legacy = legacyIndexPath(archiveDir);
  if (!existsSync(legacy)) return;
  assertSafeDataPath(legacy);
  const old = new Database(legacy, { readonly: true });
  try {
    old.exec("PRAGMA busy_timeout = 30000");
    const version = old
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    if (version !== 1) return;
  } finally {
    old.close(false);
  }
  db.exec(`ATTACH DATABASE '${legacy.replace(/'/g, "''")}' AS legacy`);
  try {
    db.transaction(() => {
      db.exec(
        `INSERT INTO files(${FILE_COLUMNS}) SELECT ${FILE_COLUMNS} FROM legacy.files`,
      );
      db.exec(
        "INSERT INTO meta(key, value) SELECT key, value FROM legacy.meta",
      );
    })();
  } finally {
    db.exec("DETACH DATABASE legacy");
  }
  removeSqlite(legacy);
}

/**
 * Opens the archive's database in `archiveDir`, creating it when absent
 * (from an old index.sqlite when there is one). WAL is required. A database
 * of another version is left alone and reported: the caller rebuilds it
 * from the raw files. Read-only, an unmigrated index.sqlite is read as is.
 */
export function openArchiveDb(
  archiveDir: string,
  options: { readonly?: boolean } = {},
): OpenResult {
  let path = archiveDbPath(archiveDir);
  if (options.readonly && !existsSync(path)) {
    const legacy = legacyIndexPath(archiveDir);
    if (existsSync(legacy)) path = legacy;
  }
  const legacyRead = path !== archiveDbPath(archiveDir);
  assertSafeDataPath(path);
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  chmodSync(archiveDir, 0o700);
  const existing = existsSync(path);
  if (options.readonly && !existing) throw new Error("no archive yet");
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
    if (legacyRead) {
      if (version !== 1) return { db, needsRebuild: true };
    } else if (version === 0) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${DB_VERSION}`);
      })();
      migrateLegacyIndex(db, archiveDir);
    } else if (version !== DB_VERSION) {
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
