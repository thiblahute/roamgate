//! The archive's bookkeeping (archive/store.ts): what each raw/ file holds
//! (sizes, offsets, frame boundaries, the session it belongs to) and when
//! each host last synced, in `archive.sqlite`. Search is the text repo's;
//! the FTS index that lived in `index.sqlite` before is gone, and an old
//! `index.sqlite` is migrated: its files and meta copied here, then it is
//! deleted.

use std::path::{Path, PathBuf};

use roamgate_base::paths::DataContext;
use roamgate_base::private::{create_dir_all_mode, private_file, protect_sidecars, set_mode};
use roamgate_base::sqlite::sidecars;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

/// Bump when the layout changes: an unknown version is rebuilt from raw/.
pub const DB_VERSION: i64 = 2;
pub const DB_FILE: &str = "archive.sqlite";
/// The file before version 2, with the FTS tables.
pub const LEGACY_INDEX_FILE: &str = "index.sqlite";

const SCHEMA: &str = "
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
";

/// The columns of `files`, the same in version 1 (migrated from) and 2.
const FILE_COLUMNS: &str = "id, host, agent, relpath, kind, project, session, subagent, title, cost_usd, cwd, src_size, src_mtime, archived_size, zst_size, indexed_bytes, index_level, first_ts, last_ts";

const INVALID: &str = "Invalid archive database file";

/// An error of the archive, with the message the Bun server gives.
pub type Result<T> = std::result::Result<T, crate::Error>;

pub fn archive_db_path(archive_dir: &Path) -> PathBuf {
    archive_dir.join(DB_FILE)
}

pub fn legacy_index_path(archive_dir: &Path) -> PathBuf {
    archive_dir.join(LEGACY_INDEX_FILE)
}

/// The bookkeeping database to read: the current one, else an unmigrated
/// index.
pub fn existing_archive_db(archive_dir: &Path) -> Option<PathBuf> {
    [archive_db_path(archive_dir), legacy_index_path(archive_dir)]
        .into_iter()
        .find(|path| path.exists())
}

fn invalid(error: std::io::Error) -> crate::Error {
    if error.kind() == std::io::ErrorKind::InvalidData {
        crate::Error::msg(INVALID)
    } else {
        error.into()
    }
}

fn protect(context: &DataContext, path: &Path) -> Result<()> {
    for sidecar in sidecars(path) {
        context.assert_safe_data_path(&sidecar)?;
    }
    protect_sidecars(&sidecars(path), INVALID).map_err(invalid)
}

fn remove_sqlite(path: &Path) {
    let _ = std::fs::remove_file(path);
    for sidecar in sidecars(path) {
        let _ = std::fs::remove_file(sidecar);
    }
}

pub fn remove_archive_db(archive_dir: &Path) {
    remove_sqlite(&archive_db_path(archive_dir));
}

/// Meta kept across a rebuild: when each host last synced and what failed.
pub fn read_kept_meta(db: &Connection) -> Result<Vec<(String, String)>> {
    let mut statement = db.prepare(
        "SELECT key, value FROM meta WHERE key LIKE 'last_%' OR key LIKE 'home:%' OR key LIKE 'unknown:%'",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// An opened database.
pub struct ArchiveDb {
    pub conn: Connection,
    /// It existed with a version this code does not know: rebuild it.
    pub needs_rebuild: bool,
}

/// Copies an old index's files and meta into the new database, then
/// deletes the old index (its FTS tables were most of its size).
fn migrate_legacy_index(context: &DataContext, db: &Connection, archive_dir: &Path) -> Result<()> {
    let legacy = legacy_index_path(archive_dir);
    if !legacy.exists() {
        return Ok(());
    }
    context.assert_safe_data_path(&legacy)?;
    {
        let old = Connection::open_with_flags(&legacy, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        old.busy_timeout(std::time::Duration::from_millis(30_000))?;
        let version: i64 = old.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != 1 {
            return Ok(());
        }
    }
    db.execute(
        "ATTACH DATABASE ?1 AS legacy",
        params![legacy.to_string_lossy()],
    )?;
    let copied = db
        .execute_batch(&format!(
            "BEGIN; INSERT INTO files({FILE_COLUMNS}) SELECT {FILE_COLUMNS} FROM legacy.files; \
             INSERT INTO meta(key, value) SELECT key, value FROM legacy.meta; COMMIT;"
        ))
        .inspect_err(|_| {
            let _ = db.execute_batch("ROLLBACK");
        });
    db.execute_batch("DETACH DATABASE legacy")?;
    copied?;
    remove_sqlite(&legacy);
    Ok(())
}

/// Opens the archive's database in `archive_dir`, creating it when absent
/// (from an old index.sqlite when there is one). WAL is required. A
/// database of another version is left alone and reported. Read-only, an
/// unmigrated index.sqlite is read as is.
pub fn open_archive_db(
    context: &DataContext,
    archive_dir: &Path,
    readonly: bool,
) -> Result<ArchiveDb> {
    let mut path = archive_db_path(archive_dir);
    if readonly && !path.exists() {
        let legacy = legacy_index_path(archive_dir);
        if legacy.exists() {
            path = legacy;
        }
    }
    let legacy_read = path != archive_db_path(archive_dir);
    context.assert_safe_data_path(&path)?;
    create_dir_all_mode(archive_dir)?;
    set_mode(archive_dir, 0o700)?;
    let existing = path.exists();
    if readonly && !existing {
        return Err(crate::Error::msg("no archive yet"));
    }
    private_file(&path, !existing, INVALID).map_err(invalid)?;
    protect(context, &path)?;
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(30_000))?;
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(crate::Error::msg(
            "the archive index needs a file system with WAL support",
        ));
    }
    conn.execute_batch("PRAGMA synchronous = NORMAL")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if legacy_read {
        if version != 1 {
            return Ok(ArchiveDb {
                conn,
                needs_rebuild: true,
            });
        }
    } else if version == 0 {
        conn.execute_batch(&format!(
            "BEGIN IMMEDIATE; {SCHEMA}; PRAGMA user_version = {DB_VERSION}; COMMIT;"
        ))
        .inspect_err(|_| {
            let _ = conn.execute_batch("ROLLBACK");
        })?;
        migrate_legacy_index(context, &conn, archive_dir)?;
    } else if version != DB_VERSION {
        return Ok(ArchiveDb {
            conn,
            needs_rebuild: true,
        });
    }
    protect(context, &path)?;
    Ok(ArchiveDb {
        conn,
        needs_rebuild: false,
    })
}

pub fn set_meta(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_meta(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_base::paths::Platform;

    fn context(dir: &Path) -> DataContext {
        DataContext::new(dir, Platform::current(), None)
    }

    #[test]
    fn a_fresh_archive_gets_a_database_of_the_current_version() {
        let home = tempfile::tempdir().unwrap();
        let archive = home.path().join("archive");
        let db = open_archive_db(&context(home.path()), &archive, false).unwrap();
        assert!(!db.needs_rebuild);
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, DB_VERSION);
        assert!(archive.join(DB_FILE).exists());
        assert!(!archive.join(LEGACY_INDEX_FILE).exists());
        set_meta(&db.conn, "last_sync:h", "x").unwrap();
        assert_eq!(
            get_meta(&db.conn, "last_sync:h").unwrap().as_deref(),
            Some("x")
        );
        assert_eq!(get_meta(&db.conn, "none").unwrap(), None);
    }

    #[test]
    fn an_old_index_sqlite_is_read_as_is_then_migrated_by_a_writer_and_deleted() {
        let home = tempfile::tempdir().unwrap();
        let archive = home.path().join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        {
            let old = Connection::open(archive.join(LEGACY_INDEX_FILE)).unwrap();
            old.execute_batch(&format!(
                "PRAGMA journal_mode = WAL; {SCHEMA}; CREATE TABLE docs(id INTEGER PRIMARY KEY) STRICT; \
                 INSERT INTO files(host, agent, relpath, session, archived_size) VALUES('h', 'claude', 'p/s.jsonl', 's', 10); \
                 INSERT INTO meta VALUES('last_sync:h', 't'); PRAGMA user_version = 1;"
            ))
            .unwrap();
        }
        let context = context(home.path());
        let read = open_archive_db(&context, &archive, true).unwrap();
        assert!(!read.needs_rebuild);
        let count: i64 = read
            .conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        drop(read);
        assert!(archive.join(LEGACY_INDEX_FILE).exists());
        assert!(!archive.join(DB_FILE).exists());
        let written = open_archive_db(&context, &archive, false).unwrap();
        let count: i64 = written
            .conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            get_meta(&written.conn, "last_sync:h").unwrap().as_deref(),
            Some("t")
        );
        assert!(!archive.join(LEGACY_INDEX_FILE).exists());
        assert_eq!(existing_archive_db(&archive), Some(archive.join(DB_FILE)));
    }

    #[test]
    fn another_version_asks_for_a_rebuild() {
        let home = tempfile::tempdir().unwrap();
        let archive = home.path().join("archive");
        let context = context(home.path());
        drop(open_archive_db(&context, &archive, false).unwrap());
        Connection::open(archive.join(DB_FILE))
            .unwrap()
            .execute_batch("PRAGMA user_version = 9")
            .unwrap();
        assert!(
            open_archive_db(&context, &archive, false)
                .unwrap()
                .needs_rebuild
        );
    }
}
