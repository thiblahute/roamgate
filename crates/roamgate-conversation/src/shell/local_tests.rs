//! A local `!` line in this machine's own shell: `/bin/sh` and the login
//! shell here, Git for Windows' bash on Windows.

use std::sync::{Arc, Mutex};

use super::*;

#[tokio::test]
async fn a_local_line_runs_in_this_machine_s_shell() {
    let directory = tempfile::tempdir().unwrap();
    let seen = Arc::new(Mutex::new(ShellOutput::default()));
    let sink = seen.clone();
    let run = ProcessShellRunner::local().run(
        directory.path().to_str().unwrap(),
        "echo hi; exit 4",
        Arc::new(move |output| *sink.lock().unwrap() = output),
    );
    assert_eq!(
        run.done.await.unwrap(),
        ShellDone {
            code: Some(4),
            stopped: false
        }
    );
    assert!(seen.lock().unwrap().stdout.contains("hi"));
}
