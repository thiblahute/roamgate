//! Showing a file in the host's file manager (workspace/file-manager.ts):
//! only on this machine, only when the server allows it
//! (`ROAMGATE_ALLOW_FILE_REVEAL=1`) and the browser came over loopback.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use roamgate_base::env::{Env, roamgate_env};
use serde::Serialize;

use crate::connection::WorkspaceError;
use crate::file_paths::{
    assert_inside_root, is_missing, node_fs_error, sanitize_explorer_path, sanitize_filesystem_path,
};
use crate::file_types::{path_text, realpath, resolve};

/// `FileRevealResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileRevealResult {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// `isLoopbackAddress`.
pub fn is_loopback_address(address: &str) -> bool {
    address.starts_with("127.") || address == "::1" || address.starts_with("::ffff:127.")
}

/// `canRevealFiles`: loopback is a transport restriction, not proof of
/// the browser's machine.
pub fn can_reveal_files(address: &str, env: &dyn Env) -> bool {
    roamgate_env(env, "ALLOW_FILE_REVEAL").as_deref() == Some("1") && is_loopback_address(address)
}

/// `fileManagerCommand`: a file opens its folder (selected where the
/// platform's file manager can), a directory itself. `platform` is
/// Node's (`win32`, `darwin`, `linux`...).
pub fn file_manager_command(platform: &str, target: &str, directory: bool) -> Vec<String> {
    let words: Vec<String> = match platform {
        "win32" if directory => vec!["explorer.exe".into(), target.into()],
        "win32" => vec!["explorer.exe".into(), format!("/select,{target}")],
        "darwin" if directory => vec!["open".into(), target.into()],
        "darwin" => vec!["open".into(), "-R".into(), target.into()],
        _ => vec![
            "xdg-open".into(),
            if directory {
                target.to_owned()
            } else {
                Path::new(target)
                    .parent()
                    .map(path_text)
                    .unwrap_or_else(|| target.to_owned())
            },
        ],
    };
    words
}

/// This machine's platform as Node names it.
pub fn this_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_vendor = "apple") {
        "darwin"
    } else {
        "linux"
    }
}

/// Starts a program and lets it go.
pub type Spawn = Arc<dyn Fn(&[String]) -> Result<(), String> + Send + Sync>;

/// Starts the file manager detached: explorer.exe exits non-zero even
/// after opening a window, so only a failure to start is reported.
pub fn spawn_file_manager() -> Spawn {
    Arc::new(|argv: &[String]| {
        let (program, args) = argv.split_first().ok_or("nothing to start")?;
        // Found on PATH as everywhere: Windows' own search would look in
        // its system directories first.
        let program = roamgate_base::posix_shell::which_on_path(program.trim_end_matches(".exe"))
            .unwrap_or_else(|| program.clone());
        std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|mut child| {
                // Reaped in the background, never waited for here.
                std::thread::spawn(move || child.wait());
            })
            .map_err(|error| crate::file_paths::errno_name(&error).0.to_owned())
    })
}

/// `revealLocalPath`'s options.
#[derive(Clone)]
pub struct RevealOptions {
    pub platform: String,
    pub spawn: Spawn,
    /// `workspace` or `filesystem`.
    pub scope: String,
    /// Changes: a missing path shows its nearest existing ancestor.
    pub nearest_existing_ancestor: bool,
}

impl Default for RevealOptions {
    fn default() -> Self {
        Self {
            platform: this_platform().into(),
            spawn: spawn_file_manager(),
            scope: "workspace".into(),
            nearest_existing_ancestor: false,
        }
    }
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// `revealLocalPath`: opens the host's file manager. Only the filesystem
/// scope may leave the root; Changes may fall back to the nearest
/// existing ancestor inside it.
pub fn reveal_local_path(
    root_path: &str,
    requested_path: &str,
    options: &RevealOptions,
) -> Result<FileRevealResult, WorkspaceError> {
    if options.scope != "workspace" && options.scope != "filesystem" {
        return Err(WorkspaceError::new("invalid file.reveal scope"));
    }
    let filesystem = options.scope == "filesystem";
    if !filesystem && is_windows_absolute(requested_path) {
        return Err(WorkspaceError::new(
            "file.reveal workspace path must be relative",
        ));
    }
    let requested = serde_json::Value::from(requested_path);
    let path = if filesystem {
        sanitize_filesystem_path(Some(&requested))?
    } else {
        sanitize_explorer_path(Some(&requested))?
    };
    if path.is_empty() {
        return Err(WorkspaceError::new("file.reveal requires path"));
    }
    let root_real = realpath(Path::new(root_path))
        .map_err(|error| node_fs_error(&error, "realpath", Path::new(root_path)))?;
    let mut target: PathBuf = if filesystem {
        PathBuf::from(&path)
    } else {
        resolve(&root_real, &path)
    };
    if !filesystem {
        assert_inside_root(&root_real, &target)?;
    }
    if options.nearest_existing_ancestor {
        loop {
            match std::fs::symlink_metadata(&target) {
                Ok(_) => break,
                Err(error) => {
                    if !is_missing(&error) {
                        return Err(node_fs_error(&error, "lstat", &target));
                    }
                    let parent = target.parent().map(Path::to_path_buf);
                    let Some(parent) = parent.filter(|parent| *parent != target) else {
                        return Err(node_fs_error(&error, "lstat", &target));
                    };
                    if !filesystem {
                        assert_inside_root(&root_real, &parent)?;
                    }
                    target = parent;
                }
            }
        }
    }
    let target_real =
        realpath(&target).map_err(|error| node_fs_error(&error, "realpath", &target))?;
    if !filesystem {
        assert_inside_root(&root_real, &target_real)?;
    }
    let directory = std::fs::metadata(&target_real)
        .map_err(|error| node_fs_error(&error, "stat", &target_real))?
        .is_dir();
    let target_text = path_text(&target_real);
    let argv = file_manager_command(&options.platform, &target_text, directory);
    (options.spawn)(&argv).map_err(|error| {
        WorkspaceError::new(format!(
            "Unable to start the file manager ({}): {error}",
            argv[0]
        ))
    })?;
    Ok(FileRevealResult {
        path: target_text,
        kind: if directory { "directory" } else { "file" }.into(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::Mutex;

    use super::*;

    struct MapEnv(BTreeMap<String, String>);

    impl Env for MapEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    fn env(value: Option<&str>) -> MapEnv {
        MapEnv(
            value
                .map(|value| {
                    [("ROAMGATE_ALLOW_FILE_REVEAL".to_owned(), value.to_owned())]
                        .into_iter()
                        .collect()
                })
                .unwrap_or_default(),
        )
    }

    fn checkout() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("roamgate-file-manager-")
            .tempdir()
            .unwrap();
        let root = path_text(&realpath(dir.path()).unwrap());
        fs::create_dir(Path::new(&root).join("docs")).unwrap();
        fs::write(Path::new(&root).join("docs").join("guide.md"), "# Guide\n").unwrap();
        (dir, root)
    }

    fn recording(platform: &str) -> (RevealOptions, Arc<Mutex<Vec<Vec<String>>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let kept = calls.clone();
        (
            RevealOptions {
                platform: platform.into(),
                spawn: Arc::new(move |argv: &[String]| {
                    kept.lock().unwrap().push(argv.to_vec());
                    Ok(())
                }),
                ..RevealOptions::default()
            },
            calls,
        )
    }

    #[test]
    fn reveal_capability_requires_explicit_host_opt_in_and_a_loopback_peer() {
        for value in [None, Some(""), Some("0"), Some("true")] {
            assert!(!can_reveal_files("127.0.0.1", &env(value)));
        }
        let allowed = env(Some("1"));
        assert!(can_reveal_files("127.0.0.1", &allowed));
        assert!(can_reveal_files("::1", &allowed));
        assert!(can_reveal_files("::ffff:127.0.0.1", &allowed));
        assert!(!can_reveal_files("192.168.1.20", &allowed));
    }

    #[test]
    fn identifies_loopback_transport_addresses_without_inferring_browser_location() {
        for address in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback_address(address));
        }
        for address in ["192.168.1.20", "::ffff:10.0.0.2", "fe80::1", ""] {
            assert!(!is_loopback_address(address));
        }
    }

    #[test]
    fn each_platform_opens_a_file_s_folder_or_the_directory_itself() {
        for (platform, directory, expected) in [
            (
                "win32",
                false,
                vec!["explorer.exe", "/select,C:\\repo\\a.md"],
            ),
            ("win32", true, vec!["explorer.exe", "C:\\repo\\docs"]),
            ("darwin", false, vec!["open", "-R", "/repo/a.md"]),
            ("darwin", true, vec!["open", "/repo/docs"]),
            ("linux", false, vec!["xdg-open", "/repo"]),
            ("linux", true, vec!["xdg-open", "/repo/docs"]),
        ] {
            let target = match (platform, directory) {
                ("win32", true) => "C:\\repo\\docs",
                ("win32", false) => "C:\\repo\\a.md",
                (_, true) => "/repo/docs",
                _ => "/repo/a.md",
            };
            assert_eq!(file_manager_command(platform, target, directory), expected);
        }
    }

    #[test]
    fn relative_files_open_their_folder_with_the_file_selected() {
        let (_dir, root) = checkout();
        let (options, calls) = recording("win32");
        let result = reveal_local_path(&root, "docs/guide.md", &options).unwrap();
        let file = path_text(&Path::new(&root).join("docs").join("guide.md"));
        assert_eq!(
            result,
            FileRevealResult {
                path: file.clone(),
                kind: "file".into()
            }
        );
        assert_eq!(
            *calls.lock().unwrap(),
            [vec!["explorer.exe".to_owned(), format!("/select,{file}")]]
        );
    }

    #[test]
    fn directories_open_themselves() {
        let (_dir, root) = checkout();
        let (options, calls) = recording("darwin");
        let result = reveal_local_path(&root, "docs", &options).unwrap();
        let docs = path_text(&Path::new(&root).join("docs"));
        assert_eq!(
            result,
            FileRevealResult {
                path: docs.clone(),
                kind: "directory".into()
            }
        );
        assert_eq!(*calls.lock().unwrap(), [vec!["open".to_owned(), docs]]);
    }

    #[test]
    fn relative_paths_cannot_leave_the_checkout() {
        let (_dir, root) = checkout();
        let (options, calls) = recording("linux");
        assert!(reveal_local_path(&format!("{root}/docs"), "../docs/../..", &options).is_err());
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn missing_paths_fail_without_starting_a_file_manager() {
        let (_dir, root) = checkout();
        let (options, calls) = recording("linux");
        assert!(reveal_local_path(&root, "docs/missing.md", &options).is_err());
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn a_file_manager_that_cannot_start_is_reported() {
        let (_dir, root) = checkout();
        let options = RevealOptions {
            platform: "linux".into(),
            spawn: Arc::new(|_: &[String]| Err("ENOENT".into())),
            ..RevealOptions::default()
        };
        assert_eq!(
            reveal_local_path(&root, "docs", &options)
                .unwrap_err()
                .message,
            "Unable to start the file manager (xdg-open): ENOENT"
        );
    }
}
