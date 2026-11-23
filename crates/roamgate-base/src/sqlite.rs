//! `SqliteDb::open` (the plan's section 6.6), the one open path of the
//! server's SQLite databases, as review/storage.ts, activity/store.ts,
//! archive/store.ts and assistant/task-storage.ts each did it:
//!
//! 1. the data path is checked for symlinks, the directory made 0700;
//! 2. the database file is opened without following links (created 0600
//!    when new), refused unless a regular file with one link, and set to
//!    0600; so are its `-wal`, `-shm` and `-journal` files when present;
//! 3. busy timeout, foreign keys, WAL (refused without it), synchronous;
//!    `auto_vacuum = INCREMENTAL` on a new database when asked;
//! 4. a new database gets the schema and its `user_version` in one
//!    transaction; another version is refused, accepted, or reported for a
//!    rebuild, as the database's rule says;
//! 5. the side files are checked again.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::paths::DataContext;
use crate::private::{create_private_dir, private_file, protect_sidecars};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Synchronous {
    Normal,
    Full,
}

/// What a `user_version` other than the schema's means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionRule<'a> {
    /// Refused: `"Unsupported <name> database"`.
    Exact,
    /// Also accepted: older versions the caller migrates itself.
    Accept(&'a [i64]),
    /// Opened, with [`SqliteDb::needs_rebuild`] set (the archive index).
    Rebuild,
}

/// How a database is opened.
#[derive(Debug, Clone, Copy)]
pub struct SqliteSpec<'a> {
    /// The database's name in messages: "review" gives "Invalid review
    /// storage file", "Review database requires WAL", "Unsupported review
    /// database".
    pub name: &'a str,
    pub busy_timeout_ms: u32,
    pub foreign_keys: bool,
    pub synchronous: Synchronous,
    /// `auto_vacuum = INCREMENTAL` before the first table (activity).
    pub incremental_vacuum: bool,
    /// The SQL of a new database.
    pub schema: &'a str,
    pub user_version: i64,
    pub versions: VersionRule<'a>,
}

#[derive(Debug, thiserror::Error)]
pub enum SqliteError {
    #[error("Invalid {0} storage file")]
    InvalidFile(String),
    #[error("{0} database requires WAL")]
    NoWal(String),
    #[error("Unsupported {0} database")]
    Unsupported(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// An open database.
#[derive(Debug)]
pub struct SqliteDb {
    pub conn: Connection,
    path: PathBuf,
    /// The `user_version` found when it was opened (0: new).
    pub found_version: i64,
    /// Another version under [`VersionRule::Rebuild`].
    pub needs_rebuild: bool,
    invalid: String,
}

fn capitalized(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `<path>-wal`, `<path>-shm`, `<path>-journal`.
pub fn sidecars(path: &Path) -> Vec<PathBuf> {
    ["-wal", "-shm", "-journal"]
        .iter()
        .map(|suffix| {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            PathBuf::from(name)
        })
        .collect()
}

impl SqliteDb {
    /// Opens or creates the database at `path` (see the module).
    pub fn open(
        context: &DataContext,
        path: &Path,
        spec: SqliteSpec<'_>,
    ) -> Result<Self, SqliteError> {
        let invalid = format!("Invalid {} storage file", spec.name);
        context.assert_safe_data_path(path)?;
        let directory = crate::paths::dirname(path);
        create_private_dir(&directory)?;
        let existing = std::fs::symlink_metadata(path).is_ok();
        private_file(path, !existing, &invalid).map_err(|error| match error.kind() {
            std::io::ErrorKind::InvalidData => SqliteError::InvalidFile(spec.name.to_owned()),
            _ => error.into(),
        })?;
        let protect = || -> Result<(), SqliteError> {
            for sidecar in sidecars(path) {
                context.assert_safe_data_path(&sidecar)?;
            }
            protect_sidecars(&sidecars(path), &invalid).map_err(|error| match error.kind() {
                std::io::ErrorKind::InvalidData => SqliteError::InvalidFile(spec.name.to_owned()),
                _ => error.into(),
            })
        };
        protect()?;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_millis(
            spec.busy_timeout_ms.into(),
        ))?;
        if spec.foreign_keys {
            conn.execute_batch("PRAGMA foreign_keys = ON")?;
        }
        let found: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if spec.incremental_vacuum && found == 0 {
            conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL")?;
        }
        let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(SqliteError::NoWal(capitalized(spec.name)));
        }
        conn.execute_batch(match spec.synchronous {
            Synchronous::Normal => "PRAGMA synchronous = NORMAL",
            Synchronous::Full => "PRAGMA synchronous = FULL",
        })?;
        let mut needs_rebuild = false;
        if found == 0 {
            conn.execute_batch(&format!(
                "BEGIN IMMEDIATE; {}; PRAGMA user_version = {}; COMMIT;",
                spec.schema, spec.user_version
            ))
            .inspect_err(|_| {
                let _ = conn.execute_batch("ROLLBACK");
            })?;
        } else if found != spec.user_version {
            match spec.versions {
                VersionRule::Exact => return Err(SqliteError::Unsupported(spec.name.to_owned())),
                VersionRule::Accept(versions) if !versions.contains(&found) => {
                    return Err(SqliteError::Unsupported(spec.name.to_owned()));
                }
                VersionRule::Accept(_) => {}
                VersionRule::Rebuild => needs_rebuild = true,
            }
        }
        protect()?;
        Ok(Self {
            conn,
            path: path.to_path_buf(),
            found_version: found,
            needs_rebuild,
            invalid,
        })
    }

    /// An existing database opened read-only (the readers of a database
    /// another process writes); `query_only` keeps it so.
    pub fn open_readonly(
        context: &DataContext,
        path: &Path,
        busy_timeout_ms: u32,
    ) -> Result<Self, SqliteError> {
        context.assert_safe_data_path(path)?;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_millis(busy_timeout_ms.into()))?;
        conn.execute_batch("PRAGMA query_only = ON")?;
        let found: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(Self {
            conn,
            path: path.to_path_buf(),
            found_version: found,
            needs_rebuild: false,
            invalid: String::new(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Checks the side files again (after a checkpoint made them).
    pub fn protect(&self) -> Result<(), SqliteError> {
        protect_sidecars(&sidecars(&self.path), &self.invalid)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Platform;

    const SCHEMA: &str = "CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT";

    fn spec(versions: VersionRule<'static>) -> SqliteSpec<'static> {
        SqliteSpec {
            name: "review",
            busy_timeout_ms: 5_000,
            foreign_keys: true,
            synchronous: Synchronous::Full,
            incremental_vacuum: false,
            schema: SCHEMA,
            user_version: 2,
            versions,
        }
    }

    #[test]
    fn a_new_database_gets_its_schema_wal_and_private_files() {
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::Unix, None);
        let path = dir.path().join("review/reviews.sqlite");
        let db = SqliteDb::open(&context, &path, spec(VersionRule::Exact)).unwrap();
        assert_eq!(db.found_version, 0);
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        let mode: String = db
            .conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let keys: i64 = db
            .conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(keys, 1);
        let sync: i64 = db
            .conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sync, 2);
        db.conn
            .execute("INSERT INTO sessions VALUES ('a', '{}')", [])
            .unwrap();
        db.protect().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(&dir.path().join("review")), 0o700);
            assert_eq!(mode(&sidecars(&path)[0]), 0o600);
        }
        drop(db);
        let again = SqliteDb::open(&context, &path, spec(VersionRule::Exact)).unwrap();
        assert_eq!(again.found_version, 2);
        let reader = SqliteDb::open_readonly(&context, &path, 5_000).unwrap();
        let count: i64 = reader
            .conn
            .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert!(reader.conn.execute("DELETE FROM sessions", []).is_err());
    }

    #[test]
    fn other_versions_follow_the_rule() {
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::Unix, None);
        let path = dir.path().join("db/x.sqlite");
        drop(SqliteDb::open(&context, &path, spec(VersionRule::Exact)).unwrap());
        Connection::open(&path)
            .unwrap()
            .execute_batch("PRAGMA user_version = 1")
            .unwrap();
        let error = SqliteDb::open(&context, &path, spec(VersionRule::Exact)).unwrap_err();
        assert_eq!(error.to_string(), "Unsupported review database");
        let accepted = SqliteDb::open(&context, &path, spec(VersionRule::Accept(&[1]))).unwrap();
        assert_eq!(accepted.found_version, 1);
        drop(accepted);
        assert!(SqliteDb::open(&context, &path, spec(VersionRule::Accept(&[3]))).is_err());
        let rebuild = SqliteDb::open(&context, &path, spec(VersionRule::Rebuild)).unwrap();
        assert!(rebuild.needs_rebuild);
    }

    #[cfg(unix)]
    #[test]
    fn linked_database_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::Unix, None);
        let path = dir.path().join("db/x.sqlite");
        drop(SqliteDb::open(&context, &path, spec(VersionRule::Exact)).unwrap());
        std::fs::hard_link(&path, dir.path().join("copy")).unwrap();
        let error = SqliteDb::open(&context, &path, spec(VersionRule::Exact)).unwrap_err();
        assert_eq!(error.to_string(), "Invalid review storage file");
        std::fs::remove_file(dir.path().join("copy")).unwrap();
        let wal = &sidecars(&path)[0];
        let _ = std::fs::remove_file(wal);
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), wal).unwrap();
        assert!(SqliteDb::open(&context, &path, spec(VersionRule::Exact)).is_err());
        std::fs::remove_file(wal).unwrap();
        let link = dir.path().join("db/link.sqlite");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let error = SqliteDb::open(&context, &link, spec(VersionRule::Exact)).unwrap_err();
        assert!(error.to_string().contains("symlink"), "{error}");
    }

    #[test]
    fn incremental_vacuum_is_set_on_a_new_database() {
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::Unix, None);
        let path = dir.path().join("activity/activity.sqlite");
        let db = SqliteDb::open(
            &context,
            &path,
            SqliteSpec {
                name: "activity",
                synchronous: Synchronous::Normal,
                incremental_vacuum: true,
                ..spec(VersionRule::Exact)
            },
        )
        .unwrap();
        let vacuum: i64 = db
            .conn
            .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
            .unwrap();
        assert_eq!(vacuum, 2);
    }
}
