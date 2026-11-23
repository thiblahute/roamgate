//! The mkdir lock against the Bun server's (the plan's section 5.7,
//! coexistence): proper-lockfile in a Bun process and roamgate_base::lock
//! in this one exclude each other on the same file, and the session secret
//! both write converges. Skipped, saying why, when bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use roamgate_base::lock::{LockError, lock_path, lock_waiting, try_lock};
use roamgate_base::paths::{DataContext, Platform};
use roamgate_base::session_secret::{SESSION_LOCK, load_or_create_session_secret};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the Bun side of the lock cannot run");
    }
    found
}

fn session_module() -> String {
    serde_json::to_string(&repo().join("server/src/config/session-secret.ts")).unwrap()
}

fn script(bun: &Path, home: &Path, source: &str, args: &[&str]) -> Command {
    let mut command = Command::new(bun);
    command
        .current_dir(repo().join("server"))
        .env("HOME", home)
        .env_remove("ROAMGATE_SETTINGS_PATH")
        .env_remove("HERDR_GUI_SETTINGS_PATH")
        .arg("-e")
        .arg(source)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn ok(output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    assert_eq!(stderr, "");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

const TRY_LOCK: &str = r#"
import { lockSync } from "proper-lockfile";
for (const stale of [Infinity, 10000]) {
  try {
    const release = lockSync(process.argv[1], { realpath: false, retries: 0, stale, update: 1000 });
    release();
    console.log("acquired");
  } catch (error) {
    console.log(error.code);
  }
}
"#;

const HOLD: &str = r#"
import { lockSync } from "proper-lockfile";
import { writeFileSync } from "node:fs";
const release = lockSync(process.argv[1], { realpath: false, stale: Infinity, update: 1000 });
writeFileSync(process.argv[2], "ready");
Bun.sleepSync(Number(process.argv[3]));
release();
"#;

#[test]
fn bun_is_refused_while_rust_holds_the_lock() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join("state.json");
    let held = try_lock(&file, SESSION_LOCK).unwrap();
    let file_arg = file.to_string_lossy().into_owned();
    // Refused whether Bun never steals (the session secret) or steals
    // after proper-lockfile's default 10 s: the Rust holder's mtime is fresh.
    let out = ok(script(&bun, home.path(), TRY_LOCK, &[&file_arg])
        .output()
        .unwrap());
    assert_eq!(out, "ELOCKED\nELOCKED");
    held.release().unwrap();
    let out = ok(script(&bun, home.path(), TRY_LOCK, &[&file_arg])
        .output()
        .unwrap());
    assert_eq!(out, "acquired\nacquired");
    assert!(!lock_path(&file).exists());
}

#[allow(clippy::disallowed_methods)]
#[test]
fn rust_waits_while_bun_holds_the_lock_and_sees_its_release() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join("state.json");
    let ready = home.path().join("ready");
    let mut holder = script(
        &bun,
        home.path(),
        HOLD,
        &[&file.to_string_lossy(), &ready.to_string_lossy(), "400"],
    )
    .spawn()
    .unwrap();
    let start = std::time::Instant::now();
    while !ready.exists() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the Bun holder did not start"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(matches!(
        try_lock(&file, SESSION_LOCK),
        Err(LockError::Locked(_))
    ));
    let guard = lock_waiting(
        &file,
        SESSION_LOCK,
        Duration::from_secs(10),
        Duration::from_millis(25),
    )
    .unwrap();
    assert!(holder.wait().unwrap().success());
    drop(guard);
    assert!(!lock_path(&file).exists());
}

#[test]
fn both_servers_converge_on_one_session_secret() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let context = DataContext::new(home.path(), Platform::current(), None);
    let path = home.path().join("data/session-secret.json");
    let path_arg = path.to_string_lossy().into_owned();
    let load = format!(
        "import {{ loadOrCreateSessionSecret }} from {}; console.log(loadOrCreateSessionSecret(JSON.parse(process.argv[2]), process.argv[1]));",
        session_module()
    );
    let bun_load = |credentials: &str| {
        ok(script(&bun, home.path(), &load, &[&path_arg, credentials])
            .output()
            .unwrap())
    };

    let rust = load_or_create_session_secret(&context, &["password", "123456"], &path).unwrap();
    assert_eq!(
        bun_load(r#"["123456","password"]"#),
        rust,
        "Bun reads the Rust secret"
    );
    let rotated = bun_load(r#"["password"]"#);
    assert_ne!(rotated, rust);
    assert_eq!(
        load_or_create_session_secret(&context, &["password"], &path).unwrap(),
        rotated,
        "Rust reads the Bun secret"
    );

    // Concurrent rotations from both sides converge on one secret.
    let children: Vec<_> = (0..4)
        .map(|_| {
            script(
                &bun,
                home.path(),
                &load,
                &[&path_arg, r#"["password","new"]"#],
            )
            .spawn()
            .unwrap()
        })
        .collect();
    let mine: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    load_or_create_session_secret(&context, &["new", "password"], &path).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    let theirs: Vec<String> = children
        .into_iter()
        .map(|child| ok(child.wait_with_output().unwrap()))
        .collect();
    let all: Vec<&String> = mine.iter().chain(theirs.iter()).collect();
    assert!(all.iter().all(|secret| *secret == all[0]), "{all:?}");
    assert_ne!(*all[0], rotated);
    assert!(!lock_path(&path).exists());
}
