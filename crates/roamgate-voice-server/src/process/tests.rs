//! voice-helper.test.ts, helper launch: the two cases that spawn a
//! process, the helper a `cat` that gives each frame back. Unix only, as
//! Bun skips them on Windows.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use roamgate_protocol::frames;
use serde_json::{Value, json};

use super::*;
use crate::config::YIELD_CPU_NICE;
use crate::config::tests::config;

fn ping() -> Vec<u8> {
    frames::encode(frames::JSON, br#"{"op":"ping","id":1}"#)
}

fn spawn(extra: Value, data_root: &Path) -> Spawned {
    spawn_voice_helper(&config(extra), data_root, Arc::new(|_| {})).unwrap()
}

#[tokio::test]
async fn a_helper_yielding_the_cpu_without_systemd_run_is_reniced() {
    use rustix::process::getpriority_process;
    // The wrapper waits to be reniced, then says its niceness; one already
    // nicer (a test run under nice) is left as it is.
    let expected = YIELD_CPU_NICE.max(getpriority_process(None).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let said = dir.path().join("nice");
    // `ps -o nice=` (macOS's `nice` prints nothing without a command).
    let script = format!(
        r#"n() {{ ps -o nice= -p $$ | tr -d ' '; }}; while [ "$(n)" -lt {expected} ]; do sleep 0.01; done; n > "$0"; exec cat"#
    );
    let mut child = spawn(
        json!({
            "helper": "/bin/cat",
            "helper_wrapper": ["/bin/sh", "-c", script, said.to_str().unwrap()],
            "yield_cpu": {"threads": 2},
        }),
        dir.path(),
    );
    // Its frame comes back once cat runs: the niceness was written before.
    child.process.write(ping());
    let (kind, payload) = child.frames.recv().await.unwrap().unwrap();
    assert_eq!(kind, frames::JSON);
    assert_eq!(payload, br#"{"op":"ping","id":1}"#);
    assert_eq!(
        std::fs::read_to_string(&said).unwrap().trim(),
        expected.to_string()
    );
    child.process.kill();
    let _ = child.exited.wait_for(|done| *done).await;
}

#[tokio::test]
async fn frames_go_through_a_wrapper_which_ends_with_the_helpers_input() {
    // The wrapper leaves out the helper's arguments and ignores the signals
    // it is sent: cat gives each frame back, and ends only at the end of
    // its input.
    let dir = tempfile::tempdir().unwrap();
    let mut child = spawn(
        json!({
            "helper": "/bin/cat",
            "helper_wrapper": ["/bin/sh", "-c", "trap '' TERM; exec cat", "wrap"],
        }),
        dir.path(),
    );
    assert_eq!(child.process.pid(), None);
    child.process.write(ping());
    child
        .process
        .write(frames::encode(frames::AUDIO, &[1, 2, 3, 4]));
    let (kind, payload) = child.frames.recv().await.unwrap().unwrap();
    assert_eq!(kind, frames::JSON);
    assert_eq!(
        serde_json::from_slice::<Value>(&payload).unwrap(),
        json!({"op": "ping", "id": 1})
    );
    let (kind, payload) = child.frames.recv().await.unwrap().unwrap();
    assert_eq!(kind, frames::AUDIO);
    assert_eq!(payload, [1, 2, 3, 4]);
    child.process.kill();
    // Ended by its input closing, well before the wrapper would be
    // signalled.
    let ended = tokio::time::timeout(
        Duration::from_millis(WRAPPED_EXIT_MS),
        child.exited.wait_for(|done| *done),
    )
    .await;
    assert!(ended.is_ok());
}
