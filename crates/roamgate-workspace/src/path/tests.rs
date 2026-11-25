//! path.test.ts.

// Their helpers serve tests that need Unix (sockets, modes, symlinks, sh).
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use std::fs;
use std::sync::Arc;

use base64::Engine as _;
use roamgate_git::exec::LocalRunner;
use roamgate_git::{Ran, Request};
use serde_json::{Value, json};

use super::*;
use crate::test_support::{Loopback, Scripted};

fn local() -> GitContext {
    GitContext::local(Arc::new(LocalRunner::system()))
}

fn remote() -> (GitContext, Arc<Loopback>) {
    let runner = Loopback::new();
    (
        GitContext::new(Some("remote-host".into()), runner.clone()),
        runner,
    )
}

async fn inspect(cx: &GitContext, path: &str, suggestions: bool) -> WorkspacePathInfo {
    inspect_workspace_path(Some(&json!(path)), cx, false, suggestions)
        .await
        .unwrap()
}

fn join(root: &str, parts: &[&str]) -> String {
    let mut path = PathBuf::from(root);
    for part in parts {
        path.push(part);
    }
    path_text(&path)
}

/// Node's `path.relative(from, to)` for absolute paths.
fn relative_path(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|p| !p.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|p| !p.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

#[cfg(unix)]
#[tokio::test]
async fn local_and_ssh_paths_expand_home_validate_directories_and_complete_prefixes_safely() {
    for is_remote in [false, true] {
        let (cx, runner) = if is_remote {
            let (cx, runner) = remote();
            (cx, Some(runner))
        } else {
            (local(), None)
        };
        let dir = tempfile::Builder::new()
            .prefix("workspace-path-")
            .tempdir()
            .unwrap();
        let root = path_text(&realpath(dir.path()).unwrap());
        let r = |parts: &[&str]| join(&root, parts);
        fs::create_dir(r(&["project"])).unwrap();
        fs::create_dir(r(&["project", "child"])).unwrap();
        fs::create_dir(r(&["ProjectCase"])).unwrap();
        fs::create_dir(r(&[".hidden"])).unwrap();
        fs::create_dir(r(&["literal\\"])).unwrap();
        fs::create_dir(r(&["literal"])).unwrap();
        fs::create_dir(r(&["literal\\", "child"])).unwrap();
        fs::create_dir(r(&["literal", "other"])).unwrap();
        assert_eq!(
            inspect(&cx, &r(&["literal\\"]), false).await.path,
            r(&["literal\\"])
        );
        assert_eq!(
            inspect(&cx, &r(&["literal\\"]), true).await.directories,
            [r(&["literal\\", "child"])]
        );
        assert_eq!(
            inspect(&cx, &r(&["literal\\", "ch"]), true)
                .await
                .directories,
            [r(&["literal\\", "child"])]
        );
        let quoted = "quote' $(touch SENTINEL)";
        fs::create_dir(r(&[quoted])).unwrap();
        fs::write(r(&["file"]), "text").unwrap();
        std::os::unix::fs::symlink(r(&["project"]), r(&["linked"])).unwrap();

        assert_eq!(
            inspect(&cx, "~", false).await,
            WorkspacePathInfo {
                path: path_text(&realpath(Path::new(&local_home())).unwrap()),
                error: None,
                directories: vec![],
            }
        );
        let home = path_text(&realpath(Path::new(&local_home())).unwrap());
        let relative = relative_path(&home, &root);
        assert_eq!(
            inspect(&cx, &format!("~/{relative}/project"), true).await,
            WorkspacePathInfo {
                path: r(&["project"]),
                error: None,
                directories: vec![r(&["project", "child"])],
            }
        );
        let list = inspect(&cx, &format!("{root}/"), true).await;
        assert_eq!(list.error, None);
        assert!(list.directories.contains(&r(&["project"])));
        assert!(list.directories.contains(&r(&["linked"])));
        assert!(!list.directories.contains(&r(&[".hidden"])));
        assert!(!list.directories.contains(&r(&["file"])));
        assert!(
            inspect(&cx, &r(&["projectc"]), true)
                .await
                .directories
                .is_empty()
        );
        assert_eq!(
            inspect(&cx, &r(&["pro"]), true).await,
            WorkspacePathInfo {
                path: r(&["pro"]),
                error: Some("Directory does not exist.".into()),
                directories: vec![r(&["project"])],
            }
        );
        assert_eq!(
            inspect(&cx, &r(&[".hid"]), true).await.directories,
            [r(&[".hidden"])]
        );
        assert_eq!(
            inspect(&cx, &r(&["file"]), true).await.error.as_deref(),
            Some("Path is not a directory.")
        );
        assert_eq!(
            inspect(&cx, &r(&["absent", "child"]), true)
                .await
                .error
                .as_deref(),
            Some("Directory does not exist.")
        );
        assert_eq!(inspect(&cx, &r(&[quoted]), true).await.error, None);
        assert_eq!(
            inspect(&cx, &r(&["SENTINEL"]), true).await.error.as_deref(),
            Some("Directory does not exist.")
        );
        assert_eq!(
            inspect(&cx, &r(&["linked"]), false).await.path,
            r(&["project"])
        );
        if let Some(runner) = runner {
            for call in runner.calls() {
                let Invocation::Ssh {
                    destination, tag, ..
                } = &call.invocation
                else {
                    panic!("not over SSH");
                };
                assert_eq!(destination, "remote-host");
                assert_eq!(tag.as_deref(), Some("workspace.path"));
            }
        }
    }
}

#[tokio::test]
async fn local_completion_filters_the_entire_directory_before_limiting_suggestions() {
    let dir = tempfile::Builder::new()
        .prefix("workspace-path-limit-")
        .tempdir()
        .unwrap();
    let root = path_text(&realpath(dir.path()).unwrap());
    for i in 0..1000 {
        fs::create_dir(join(&root, &[&format!("a-{i:04}")])).unwrap();
    }
    let matches: Vec<String> = (0..53)
        .map(|i| join(&root, &[&format!("z-project-{i:03}")]))
        .collect();
    for directory in &matches {
        fs::create_dir(directory).unwrap();
    }
    let info = inspect(&local(), &join(&root, &["z-project-"]), true).await;
    assert_eq!(info.error.as_deref(), Some("Directory does not exist."));
    assert_eq!(info.directories, matches[..50]);
}

#[tokio::test]
async fn invalid_paths_fail_before_any_host_command() {
    let runner = Scripted::new(|_: &Request| Ok(Ran::new(0, "", "")));
    let cx = GitContext::new(Some("remote-host".into()), runner.clone());
    for path in [
        Value::Null,
        json!({}),
        json!(""),
        json!("relative"),
        json!("~someone/project"),
        json!("/tmp/\0"),
        json!("/tmp/\n"),
        json!("x".repeat(4097)),
    ] {
        assert!(
            inspect_workspace_path(Some(&path), &cx, false, true)
                .await
                .is_err()
        );
    }
    assert!(runner.argvs().is_empty());
}

#[tokio::test]
async fn windows_ssh_paths_use_quoted_powershell_and_the_remote_user_s_home() {
    let runner = Scripted::new(|request: &Request| {
        let Invocation::Ssh { command, .. } = &request.invocation else {
            panic!("not over SSH");
        };
        assert!(command.starts_with("powershell.exe "));
        let encoded = command.rsplit(' ').next().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let script = String::from_utf16(&units).unwrap();
        assert!(script.contains("$env:USERPROFILE"));
        assert!(script.contains("$path = '~/quote'' $(throw)'"));
        assert!(script.contains("-LiteralPath"));
        let path =
            base64::engine::general_purpose::STANDARD.encode("C:\\Users\\remote\\quote' $(throw)");
        Ok(Ran::new(0, format!("PATH\t{path}\nERROR\t\n"), ""))
    });
    let cx = GitContext::new(Some("remote-host".into()), runner);
    assert_eq!(
        inspect_workspace_path(Some(&json!("~/quote' $(throw)")), &cx, true, false)
            .await
            .unwrap(),
        WorkspacePathInfo {
            path: "C:\\Users\\remote\\quote' $(throw)".into(),
            error: None,
            directories: vec![],
        }
    );
}
