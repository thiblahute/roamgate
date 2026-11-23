//! The front's SSH commands through one set of slots.

use std::os::unix::fs::PermissionsExt;

use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_exec::ssh::sessions::SSH_SESSION_LIMIT;

use super::*;

/// A fake ssh printing its last argument and its input, exiting 3.
fn fake_ssh(dir: &std::path::Path) -> String {
    let path = dir.join("ssh");
    std::fs::write(
        &path,
        "#!/bin/sh\nfor last; do :; done\nprintf 'ran %s\\n' \"$last\"\ncat\necho 'warn' >&2\nexit 3\n",
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_str().unwrap().to_owned()
}

fn ops(program: String) -> HostOps {
    let clock: SharedClock = Arc::new(SystemClock);
    let mut ops = HostOps::new(SshSessions::new(clock.clone()), ProcessRunner::new(clock));
    ops.program = Some(program);
    ops
}

fn command(text: &str) -> HostCommand {
    HostCommand {
        destination: "devbox".into(),
        command: text.into(),
        tag: Some("test".into()),
        ..HostCommand::default()
    }
}

#[tokio::test]
async fn a_command_runs_on_the_host_with_its_input_and_output() {
    let dir = tempfile::tempdir().unwrap();
    let ops = ops(fake_ssh(dir.path()));
    let output = ops
        .run(
            &command("git status"),
            Some(b"input\n".to_vec()),
            &HostWait {
                timeout_ms: Some(10_000),
                ..HostWait::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(output.code, 3);
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with("ran "), "{stdout}");
    assert!(stdout.contains("git status"), "{stdout}");
    assert!(stdout.ends_with("input\n"), "{stdout}");
    assert_eq!(output.stderr, "warn\n");
}

#[tokio::test]
async fn an_invalid_destination_is_refused_before_anything_runs() {
    let dir = tempfile::tempdir().unwrap();
    let ops = ops(fake_ssh(dir.path()));
    let mut bad = command("true");
    bad.destination = "-oProxyCommand=evil".into();
    let error = ops.run(&bad, None, &HostWait::default()).await.unwrap_err();
    assert_eq!(error.code, Some("invalid"));
}

#[tokio::test]
async fn held_slots_count_against_the_host_until_released() {
    let dir = tempfile::tempdir().unwrap();
    let ops = ops(fake_ssh(dir.path()));
    let registry = HoldRegistry::default();
    let wait = HostWait {
        timeout_ms: Some(200),
        ..HostWait::default()
    };
    let mut leases = Vec::new();
    for _ in 0..SSH_SESSION_LIMIT {
        let held = registry
            .hold(&ops, &command("cat file"), &wait, false)
            .await
            .unwrap();
        // No master: the command logs in on its own.
        assert!(!held.argv.contains(&"-S".to_owned()));
        assert_eq!(ops.spawn_argv(&held)[0], ops.program.clone().unwrap());
        leases.push(held.lease);
    }
    assert_eq!(registry.len(), SSH_SESSION_LIMIT);
    // The host is full: one more waits out its budget.
    let error = registry
        .hold(&ops, &command("cat file"), &wait, false)
        .await
        .unwrap_err();
    assert!(
        error.message.contains("waiting for a session to devbox"),
        "{}",
        error.message
    );
    assert!(registry.release(leases[0]));
    assert!(!registry.release(leases[0]));
    let held = registry
        .hold(&ops, &command("cat file"), &wait, false)
        .await
        .unwrap();
    registry.release_all();
    assert!(registry.is_empty());
    assert!(!registry.release(held.lease));
}
