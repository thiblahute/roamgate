//! Data paths (config/data-paths.ts): the data root, the legacy herdr-gui
//! locations and their one-way migration, the symlink rules of Roamgate's
//! tree, and the writers that publish or replace a private file through a
//! synced temporary file.
//!
//! Everything is a method of a [`DataContext`] (home, platform, APPDATA),
//! which the TS code reads from the process: tests give their own.

use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use crate::env::Env;
use crate::private::{OpenMode, create_dir_all_mode, mode_of, open_nofollow, set_file_mode};

/// Checks legacy contents before they are migrated.
pub type Validate = dyn Fn(&[u8]) -> io::Result<()>;

/// Which family of paths: `win32` or anything else in the TS code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// The files `default_data_file` knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataFile {
    AuthToken,
    Settings,
    Connections,
}

impl DataFile {
    pub fn name(self) -> &'static str {
        match self {
            Self::AuthToken => "auth-token",
            Self::Settings => "settings.json",
            Self::Connections => "connections.json",
        }
    }
}

/// Where the user's data lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataContext {
    pub home: PathBuf,
    pub platform: Platform,
    /// APPDATA (Windows).
    pub app_data: Option<PathBuf>,
    /// A node's own data root (`ROAMGATE_DATA_ROOT`), instead of
    /// `<config>/roamgate`; nothing is migrated into it.
    pub root: Option<PathBuf>,
}

fn other(message: String) -> io::Error {
    io::Error::other(message)
}

/// `path.resolve`: absolute against the working directory, `.` and `..`
/// folded, without reading links.
pub fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path.dirname`: the parent, or the path itself at a root.
pub fn dirname(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        Some(_) => PathBuf::from("."),
        None => path.to_path_buf(),
    }
}

/// Node's `realpath`: the canonical path (without Windows' `\\?\` for a
/// drive path, which Git, shells and socket addresses do not take).
pub fn realpath(path: &Path) -> io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = real.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\")
            && !rest.starts_with("UNC\\")
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(real)
}

fn lstat_if_present(path: &Path, follow: bool) -> io::Result<Option<std::fs::Metadata>> {
    let found = if follow {
        std::fs::metadata(path)
    } else {
        std::fs::symlink_metadata(path)
    };
    match found {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// A random UUID v4, as `crypto.randomUUID`.
pub fn random_uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// Whether a name is one of the writers' temporary files.
fn is_data_temporary(name: &str) -> bool {
    let Some(middle) = name
        .strip_prefix(".roamgate-")
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return false;
    };
    middle.len() == 36
        && middle
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase() || byte == b'-')
}

impl DataContext {
    /// The process's: HOME (USERPROFILE on Windows), APPDATA.
    pub fn from_env(env: &dyn Env) -> Self {
        let platform = Platform::current();
        let home = match platform {
            Platform::Windows => env.var("USERPROFILE").or_else(|| env.var("HOME")),
            Platform::Unix => env.var("HOME"),
        }
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .unwrap_or_default();
        Self {
            home,
            platform,
            app_data: env.var("APPDATA").map(PathBuf::from),
            root: crate::node::data_root(env),
        }
    }

    /// The data root is `ROAMGATE_DATA_ROOT` of the process when set (a
    /// node's), else `<config>/roamgate` of `home`.
    pub fn new(home: impl Into<PathBuf>, platform: Platform, app_data: Option<PathBuf>) -> Self {
        Self {
            home: home.into(),
            platform,
            app_data,
            root: crate::node::data_root(&crate::env::ProcessEnv),
        }
    }

    /// `<config>/roamgate`: APPDATA (or ~/AppData/Roaming) on Windows,
    /// ~/.config elsewhere.
    pub fn data_root(&self) -> PathBuf {
        if let Some(root) = &self.root {
            return root.clone();
        }
        let base = match self.platform {
            Platform::Windows => self
                .app_data
                .clone()
                .unwrap_or_else(|| self.home.join("AppData").join("Roaming")),
            Platform::Unix => self.home.join(".config"),
        };
        base.join("roamgate")
    }

    /// The herdr-gui directory beside the data root.
    pub fn legacy_data_root(&self) -> PathBuf {
        dirname(&self.data_root()).join("herdr-gui")
    }

    /// The platform configuration directories belong to the user, not
    /// Roamgate: dotfile managers and folder redirection commonly make them
    /// symlinks or junctions, so they are followed; links inside Roamgate's
    /// tree never are.
    fn user_config_roots(&self) -> [PathBuf; 2] {
        [
            resolve(&dirname(&self.data_root())),
            resolve(&self.home.join(".config")),
        ]
    }

    /// Checks the configuration parent, the product directory and the
    /// file: none may be a symlink (dangling ones included), the
    /// directories must be directories and the file a file.
    pub fn assert_safe_data_path(&self, path: &Path) -> io::Result<()> {
        let roots = self.user_config_roots();
        let parent = dirname(path);
        for entry in [dirname(&parent), parent, path.to_path_buf()] {
            let follow = roots.contains(&resolve(&entry));
            let Some(stat) = lstat_if_present(&entry, follow)? else {
                continue;
            };
            if stat.file_type().is_symlink() {
                return Err(other(format!(
                    "data path contains a symlink: {}",
                    entry.display()
                )));
            }
            let expected = if entry == path {
                stat.is_file()
            } else {
                stat.is_dir()
            };
            if !expected {
                return Err(other(format!(
                    "data path has an unexpected file type: {}",
                    entry.display()
                )));
            }
        }
        Ok(())
    }

    /// Writes a complete private file through a synced temporary file.
    /// Publishing links it and keeps a concurrent winner; replacing
    /// renames over the target.
    fn write_data_file(
        &self,
        path: &Path,
        contents: &[u8],
        mode: u32,
        replace: bool,
    ) -> io::Result<()> {
        self.assert_safe_data_path(path)?;
        let directory = dirname(path);
        create_dir_all_mode(&directory)?;
        let temporary = directory.join(format!(".roamgate-{}.tmp", random_uuid()));
        let result = (|| {
            let mut file = open_nofollow(&temporary, OpenMode::CreateNew)?;
            file.write_all(contents)?;
            set_file_mode(&file, mode)?;
            file.sync_all()?;
            drop(file);
            self.assert_safe_data_path(path)?;
            if replace {
                std::fs::rename(&temporary, path)
            } else {
                match std::fs::hard_link(&temporary, path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        self.assert_safe_data_path(path)
                    }
                    Err(error) => Err(error),
                }
            }
        })();
        let _ = std::fs::remove_file(&temporary);
        result?;
        sync_directory(&directory);
        Ok(())
    }

    /// Publishes a complete private file without replacing a concurrent
    /// winner.
    pub fn publish_data_file(&self, path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
        self.write_data_file(path, contents, mode, false)
    }

    /// Atomically replaces a private file (publish never overwrites).
    pub fn replace_data_file(&self, path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
        self.write_data_file(path, contents, mode, true)
    }

    /// [`Self::replace_data_file`] off the async runtime's threads: a file
    /// rewritten often (a sync on a busy disk can take a second).
    pub async fn replace_data_file_async(
        &self,
        path: &Path,
        contents: Vec<u8>,
        mode: u32,
    ) -> io::Result<()> {
        let context = self.clone();
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || context.replace_data_file(&path, &contents, mode))
            .await
            .map_err(io::Error::other)?
    }

    /// Copies only a missing file: originals and concurrent or new values
    /// always win. `validate` refuses legacy contents before anything is
    /// published.
    pub fn migrate_data_file(
        &self,
        path: &Path,
        legacy: &Path,
        validate: Option<&Validate>,
    ) -> io::Result<PathBuf> {
        self.assert_safe_data_path(path)?;
        if lstat_if_present(path, false)?.is_some() {
            return Ok(path.to_path_buf());
        }
        self.assert_safe_data_path(legacy)?;
        if lstat_if_present(legacy, false)?.is_none() {
            return Ok(path.to_path_buf());
        }
        let mut file = open_nofollow(legacy, OpenMode::Read)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(other(format!(
                "legacy data is not a regular file: {}",
                legacy.display()
            )));
        }
        let mut contents = Vec::new();
        io::Read::read_to_end(&mut file, &mut contents)?;
        if let Some(validate) = validate {
            validate(&contents)?;
        }
        self.publish_data_file(path, &contents, mode_of(&metadata) & 0o600)?;
        Ok(path.to_path_buf())
    }

    /// The path of a data file, migrated from herdr-gui when only the
    /// legacy one exists. Settings and connections historically used
    /// ~/.config on Windows too; a cleared connection registry
    /// (`connections.json.legacy-cleared`) never comes back.
    pub fn default_data_file(&self, file: DataFile) -> io::Result<PathBuf> {
        if self.root.is_some() {
            let path = self.data_root().join(file.name());
            self.assert_safe_data_path(&path)?;
            return Ok(path);
        }
        let legacy_root = match file {
            DataFile::AuthToken => self.legacy_data_root(),
            _ => self.home.join(".config").join("herdr-gui"),
        };
        let path = self.data_root().join(file.name());
        if file == DataFile::Connections {
            let cleared = PathBuf::from(format!("{}.legacy-cleared", path.display()));
            self.assert_safe_data_path(&cleared)?;
            if lstat_if_present(&cleared, false)?.is_some() {
                return Ok(path);
            }
        }
        let validate_json = |contents: &[u8]| -> io::Result<()> {
            serde_json::from_slice::<serde_json::Value>(contents)
                .map(|_| ())
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        };
        let validate: Option<&Validate> = if file == DataFile::Settings {
            Some(&validate_json)
        } else {
            None
        };
        self.migrate_data_file(&path, &legacy_root.join(file.name()), validate)
    }
}

/// Persists a new directory entry; best effort (Windows cannot open
/// directories, some filesystems refuse to sync them).
fn sync_directory(directory: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(directory) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = directory;
}

/// Removes the temporary files a killed process left between writing and
/// renaming them: regular files named like the writers' own, anywhere
/// under `root`, last changed before `started_at_ms` (epoch ms). Symlinks
/// are never followed and no other file is touched. Returns how many.
pub fn remove_leftover_data_temporaries(root: &Path, started_at_ms: i64) -> usize {
    fn visit(directory: &Path, started_at_ms: i64, removed: &mut usize) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                visit(&path, started_at_ms, removed);
                continue;
            }
            let name = entry.file_name();
            if !kind.is_file() || !is_data_temporary(&name.to_string_lossy()) {
                continue;
            }
            let Ok(found) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            let modified = found
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as i64)
                .unwrap_or(i64::MAX);
            if !found.is_file() || modified >= started_at_ms {
                continue;
            }
            if std::fs::remove_file(&path).is_ok() {
                *removed += 1;
            }
        }
    }
    let mut removed = 0;
    visit(root, started_at_ms, &mut removed);
    removed
}

/// [`remove_leftover_data_temporaries`] off the async runtime's threads.
pub async fn remove_leftover_data_temporaries_async(root: PathBuf, started_at_ms: i64) -> usize {
    tokio::task::spawn_blocking(move || remove_leftover_data_temporaries(&root, started_at_ms))
        .await
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
