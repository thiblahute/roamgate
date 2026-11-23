//! host-spawn, which runs a command on the host from a toolbox: the one
//! that runs (utils/host-spawn.ts). PATH may hold a broken one before the
//! real one (an empty, root-owned 0700 ~/.local/bin/host-spawn was found
//! before /usr/bin's on the desktop), so the first file of that name is not
//! enough.

use std::path::{Path, PathBuf};

/// Where the toolbox packages install host-spawn: tried before PATH.
pub const HOST_SPAWN_PATHS: &[&str] = &["/usr/bin/host-spawn", "/usr/local/bin/host-spawn"];

/// Whether `path` is a non-empty file this process may execute.
pub fn runnable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The host-spawn to run: `override_path` when given (ROAMGATE_HOST_SPAWN;
/// empty means none, and a test server points it at its own fake so it
/// never reaches the real host), else the first runnable one of `known`,
/// then of `path`'s directories; None when none runs.
pub fn host_spawn_path(path: &str, known: &[&str], override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(own) = override_path {
        return (!own.is_empty() && runnable(Path::new(own))).then(|| PathBuf::from(own));
    }
    if let Some(found) = known
        .iter()
        .map(PathBuf::from)
        .find(|candidate| runnable(candidate))
    {
        return Some(found);
    }
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join("host-spawn"))
        .find(|candidate| runnable(candidate))
}

/// [`host_spawn_path`] from this process's PATH and environment.
pub fn find_host_spawn() -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    host_spawn_path(
        &path,
        HOST_SPAWN_PATHS,
        roamgate_base::env::roamgate_env(&roamgate_base::env::ProcessEnv, "HOST_SPAWN").as_deref(),
    )
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A host-spawn file in root/dir, with mode and content.
    pub(crate) fn put(root: &Path, dir: &str, mode: u32, content: &str) -> PathBuf {
        std::fs::create_dir_all(root.join(dir)).unwrap();
        let path = root.join(dir).join("host-spawn");
        std::fs::write(&path, content).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn joined(root: &Path, dirs: &[&str]) -> String {
        dirs.iter()
            .map(|dir| {
                if dir.is_empty() {
                    String::new()
                } else {
                    root.join(dir).display().to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(":")
    }

    #[test]
    fn skips_an_empty_non_executable_host_spawn_first_on_path() {
        let root = tempfile::tempdir().unwrap();
        let broken = put(root.path(), "local-bin", 0o600, "");
        let real = put(root.path(), "usr-bin", 0o755, "#!/bin/sh\n");
        assert!(!runnable(&broken));
        let path = joined(root.path(), &["local-bin", "usr-bin"]);
        assert_eq!(host_spawn_path(&path, &[], None), Some(real));
    }

    #[test]
    fn skips_an_empty_executable_one_and_a_non_executable_one() {
        let root = tempfile::tempdir().unwrap();
        put(root.path(), "empty", 0o755, "");
        put(root.path(), "noexec", 0o644, "#!/bin/sh\n");
        let real = put(root.path(), "real", 0o755, "#!/bin/sh\n");
        let path = joined(root.path(), &["empty", "noexec", "", "missing", "real"]);
        assert_eq!(host_spawn_path(&path, &[], None), Some(real));
    }

    #[test]
    fn prefers_the_known_paths_to_path() {
        let root = tempfile::tempdir().unwrap();
        let on_path = put(root.path(), "path", 0o755, "#!/bin/sh\n");
        let known = put(root.path(), "known", 0o755, "#!/bin/sh\n");
        let path = joined(root.path(), &["path"]);
        let known_text = known.display().to_string();
        assert_eq!(host_spawn_path(&path, &[&known_text], None), Some(known));
        // A known path that does not run falls back to PATH.
        let none = root.path().join("none/host-spawn").display().to_string();
        assert_eq!(host_spawn_path(&path, &[&none], None), Some(on_path));
    }

    #[test]
    fn none_when_none_runs() {
        let root = tempfile::tempdir().unwrap();
        put(root.path(), "broken", 0o600, "");
        let path = joined(root.path(), &["broken"]);
        assert_eq!(host_spawn_path(&path, &[], None), None);
        assert_eq!(host_spawn_path("", &[], None), None);
    }

    #[test]
    fn the_override_replaces_the_search_and_empty_means_none() {
        let root = tempfile::tempdir().unwrap();
        let known = put(root.path(), "known", 0o755, "#!/bin/sh\n");
        let own = put(root.path(), "own", 0o755, "#!/bin/sh\n");
        let known_text = known.display().to_string();
        let own_text = own.display().to_string();
        assert_eq!(
            host_spawn_path("", &[&known_text], Some(&own_text)),
            Some(own)
        );
        assert_eq!(host_spawn_path("", &[&known_text], Some("")), None);
        let broken = put(root.path(), "broken-own", 0o600, "")
            .display()
            .to_string();
        assert_eq!(host_spawn_path("", &[&known_text], Some(&broken)), None);
    }
}
