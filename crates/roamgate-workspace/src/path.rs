//! A directory typed for a new workspace (workspace/path.ts): checked on
//! the connection's host, `~` expanded there, and the directories that
//! complete it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use roamgate_base::assets::{LIST_DIRECTORY_PS1, LIST_DIRECTORY_SH, fill_template};
use roamgate_exec::ssh::windows::powershell_command;
use roamgate_git::compare::locale_compare;
use roamgate_git::{GitContext, Invocation, shell_quote};
use serde::Serialize;

use crate::connection::WorkspaceError;
use crate::file_types::{path_text, realpath, resolve};
use crate::remote_files::node_base64;

const DIRECTORY_LIMIT: usize = 50;
const PATH_TIMEOUT: Duration = Duration::from_millis(8000);

/// shared/workspacePath.ts `WorkspacePathInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspacePathInfo {
    pub path: String,
    pub error: Option<String>,
    pub directories: Vec<String>,
}

/// Node's `os.homedir()`: `$HOME`, else the account's.
pub fn local_home() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|home| !home.is_empty())
        .or_else(|| std::env::home_dir().map(|home| path_text(&home)))
        .unwrap_or_default()
}

fn is_control(c: char) -> bool {
    c <= '\x1f' || c == '\x7f'
}

/// Bun's realpath drops a Windows drive root's separator, and keeps a
/// trailing Unix backslash's spelling only when not resolved.
fn real_directory_path(path: &str) -> std::io::Result<String> {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && path[2..].chars().all(|c| c == '/' || c == '\\')
        {
            return Ok(path.to_owned());
        }
    } else if path.ends_with('\\') {
        return Ok(path.to_owned());
    }
    realpath(Path::new(path)).map(|real| path_text(&real))
}

/// `inspectWorkspacePath`: where `value` leads on the connection's host
/// (`host`: SSH, with `windows` its platform), the error it has as a
/// directory, and with `suggestions` the directories completing it.
pub async fn inspect_workspace_path(
    value: Option<&serde_json::Value>,
    cx: &GitContext,
    windows_host: bool,
    suggestions: bool,
) -> Result<WorkspacePathInfo, WorkspaceError> {
    let text = value.and_then(serde_json::Value::as_str);
    let Some(text) = text.filter(|text| {
        !text.trim().is_empty()
            && text.encode_utf16().count() <= 4096
            && !text.chars().any(is_control)
    }) else {
        return Err(WorkspaceError::new("Enter a valid directory path."));
    };
    let input = text.trim();
    let windows = match cx.host() {
        Some(_) => windows_host,
        None => cfg!(windows),
    };
    let home_path =
        input == "~" || input.starts_with("~/") || (windows && input.starts_with("~\\"));
    let absolute = if windows {
        let bytes = input.as_bytes();
        (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\'))
            || input.starts_with("//")
            || input.starts_with("\\\\")
            || input.starts_with("/\\")
            || input.starts_with("\\/")
    } else {
        crate::file_paths::is_absolute(input)
    };
    if !absolute && !home_path {
        return Err(WorkspaceError::new(
            "Use an absolute path or a path starting with ~/.",
        ));
    }

    if let Some(host) = cx.host() {
        let command = if windows {
            powershell_command(
                &fill_template(
                    LIST_DIRECTORY_PS1,
                    &[
                        ("path", input.replace('\'', "''").into()),
                        (
                            "suggestions",
                            if suggestions { "$true" } else { "$false" }.into(),
                        ),
                        ("limit", (DIRECTORY_LIMIT as i64).into()),
                    ],
                )
                .expect("list-directory.ps1"),
            )
        } else {
            format!(
                "bash -c {}",
                shell_quote(
                    &fill_template(
                        LIST_DIRECTORY_SH,
                        &[
                            ("path", shell_quote(input).into()),
                            ("suggestions", if suggestions { "1" } else { "0" }.into()),
                            ("limit", (DIRECTORY_LIMIT as i64).into()),
                        ],
                    )
                    .expect("list-directory.sh")
                )
            )
        };
        let ran = cx
            .run(
                Invocation::ssh_read(host, &command, Some("workspace.path")),
                PATH_TIMEOUT,
            )
            .await;
        let Ok(ran) = ran
            .map_err(|_| ())
            .and_then(|ran| if ran.code == 0 { Ok(ran) } else { Err(()) })
        else {
            return Err(WorkspaceError::new(
                "Could not check the directory on the connected host.",
            ));
        };
        let mut info = WorkspacePathInfo {
            path: String::new(),
            error: None,
            directories: Vec::new(),
        };
        for line in ran.stdout.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let (kind, encoded) = line.split_once('\t').unwrap_or((line, ""));
            let encoded = encoded.split('\t').next().unwrap_or("");
            let text = String::from_utf8_lossy(&node_base64(encoded)).into_owned();
            match kind {
                "PATH" => info.path = text,
                "ERROR" => info.error = (!text.is_empty()).then_some(text),
                "DIRECTORY" => info.directories.push(text),
                _ => {}
            }
        }
        if info.path.is_empty() {
            return Err(WorkspaceError::new(
                "Invalid directory response from the connected host.",
            ));
        }
        return Ok(info);
    }

    let input = input.to_owned();
    tokio::task::spawn_blocking(move || inspect_local(&input, home_path, windows, suggestions))
        .await
        .map_err(|error| WorkspaceError::new(error.to_string()))
}

fn inspect_local(
    input: &str,
    home_path: bool,
    windows: bool,
    suggestions: bool,
) -> WorkspacePathInfo {
    let wanted = if home_path {
        resolve(Path::new(&local_home()), input.get(2..).unwrap_or(""))
    } else {
        resolve(Path::new("/"), input)
    };
    let mut info = WorkspacePathInfo {
        path: path_text(&wanted),
        error: None,
        directories: Vec::new(),
    };
    // Node's resolve keeps no trailing separator but the root's.
    match std::fs::metadata(&info.path) {
        Ok(meta) if !meta.is_dir() => info.error = Some("Path is not a directory.".into()),
        Ok(_) => match executable(&info.path).and_then(|()| real_directory_path(&info.path)) {
            Ok(real) => info.path = real,
            Err(error) => info.error = Some(access_error(&error)),
        },
        Err(error) => info.error = Some(access_error(&error)),
    }
    if !suggestions {
        return info;
    }
    let base = if info.error.is_some() {
        Path::new(&info.path)
            .parent()
            .map(path_text)
            .unwrap_or_else(|| info.path.clone())
    } else {
        info.path.clone()
    };
    let Ok(directory) = real_directory_path(&base) else {
        return info;
    };
    let prefix = if info.error.is_some() {
        Path::new(&info.path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut entries: Vec<(String, bool, bool)> = std::fs::read_dir(&directory)
        .map(|read| {
            read.flatten()
                .map(|entry| {
                    let kind = entry.file_type().ok();
                    (
                        entry.file_name().to_string_lossy().into_owned(),
                        kind.is_some_and(|k| k.is_dir()),
                        kind.is_some_and(|k| k.is_symlink()),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    entries.retain(|(name, _, _)| {
        let matches = if windows {
            name.to_lowercase().starts_with(&prefix.to_lowercase())
        } else {
            name.starts_with(&prefix)
        };
        matches
            && (prefix.starts_with('.') || !name.starts_with('.'))
            && !name.chars().any(is_control)
    });
    entries.sort_by(|a, b| locale_compare(&a.0, &b.0));
    for (name, is_dir, is_link) in entries {
        let path: PathBuf = Path::new(&directory).join(&name);
        if is_dir || (is_link && std::fs::metadata(&path).is_ok_and(|m| m.is_dir())) {
            info.directories.push(path_text(&path));
        }
        if info.directories.len() == DIRECTORY_LIMIT {
            break;
        }
    }
    info
}

fn executable(path: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        rustix::fs::access(path, rustix::fs::Access::EXEC_OK).map_err(std::io::Error::from)
    }
    #[cfg(not(unix))]
    {
        std::fs::read_dir(path).map(|_| ())
    }
}

fn access_error(error: &std::io::Error) -> String {
    if crate::file_paths::is_missing(error) {
        "Directory does not exist.".into()
    } else {
        "Directory is not accessible.".into()
    }
}

#[cfg(test)]
mod tests;
