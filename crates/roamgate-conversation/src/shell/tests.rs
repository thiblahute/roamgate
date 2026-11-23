//! shell.test.ts.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// An ssh that runs the remote command here, as the host would.
fn fake_ssh(directory: &Path) -> String {
    let path = directory.join("ssh");
    std::fs::write(
        &path,
        "#!/bin/sh\nfor last in \"$@\"; do :; done\nexec /bin/sh -c \"$last\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

fn runner(remote: bool, directory: &Path) -> ProcessShellRunner {
    let ssh = fake_ssh(directory);
    ProcessShellRunner {
        argv: Arc::new(move |cwd, command| {
            if remote {
                vec![
                    ssh.clone(),
                    "builder".into(),
                    remote_shell_command(cwd, command, &sh_quote),
                ]
            } else {
                local_shell_argv(cwd, command, "/bin/sh")
            }
        }),
        hold: None,
    }
}

fn seen() -> (
    Arc<Mutex<Vec<ShellOutput>>>,
    Arc<dyn Fn(ShellOutput) + Send + Sync>,
) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (
        seen,
        Arc::new(move |output| sink.lock().unwrap().push(output)),
    )
}

async fn runs_with_live_output_and_its_exit_code(remote: bool) {
    let directory = tempfile::tempdir().unwrap();
    let (seen, on_output) = seen();
    let run = runner(remote, directory.path()).run(
        directory.path().to_str().unwrap(),
        "FOO=bar; echo hi && pwd\necho \"$FOO\" >&2\nexit 3",
        on_output,
    );
    assert_eq!(
        run.done.await.unwrap(),
        ShellDone {
            code: Some(3),
            stopped: false
        }
    );
    let last = seen.lock().unwrap().last().cloned().unwrap();
    let text = format!("{}{}", last.stdout, last.stderr);
    assert!(text.contains("hi\n"));
    assert!(text.contains(&format!("{}\n", directory.path().display())));
    assert!(text.contains("bar\n"));
    // No job-control notice of the wrapper's.
    assert!(!text.contains("Done"));
}

async fn stop_ends_a_line_and_what_it_started(remote: bool) {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join(format!("stopped-{remote}"));
    let (_, on_output) = seen();
    let run = runner(remote, directory.path()).run(
        directory.path().to_str().unwrap(),
        &format!("sleep 5; touch {}", sh_quote(marker.to_str().unwrap())),
        on_output,
    );
    let done = tokio::spawn(run.done);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let started = Instant::now();
    (run.stop)();
    assert_eq!(
        done.await.unwrap().unwrap(),
        ShellDone {
            code: None,
            stopped: true
        }
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!marker.exists());
}

async fn a_long_output_is_kept_up_to_a_bound(remote: bool) {
    let directory = tempfile::tempdir().unwrap();
    let (seen, on_output) = seen();
    let run = runner(remote, directory.path()).run(
        directory.path().to_str().unwrap(),
        "yes | head -c 200000",
        on_output,
    );
    assert_eq!(
        run.done.await.unwrap(),
        ShellDone {
            code: Some(0),
            stopped: false
        }
    );
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert!(last.truncated);
    assert!(last.stdout.len() < 40_000);
    assert!(last.stdout.len() > 30_000);
}

#[tokio::test]
async fn a_line_runs_where_in_the_session_s_directory_a_real_shell_with_live_output_and_its_exit_code()
 {
    runs_with_live_output_and_its_exit_code(false).await;
    runs_with_live_output_and_its_exit_code(true).await;
}

#[tokio::test]
async fn stop_ends_a_line_where_and_what_it_started() {
    stop_ends_a_line_and_what_it_started(false).await;
    stop_ends_a_line_and_what_it_started(true).await;
}

#[tokio::test]
async fn a_long_output_where_is_kept_up_to_a_bound_and_says_so() {
    a_long_output_is_kept_up_to_a_bound(false).await;
    a_long_output_is_kept_up_to_a_bound(true).await;
}

#[tokio::test]
async fn a_directory_that_is_gone_fails_the_run_with_why() {
    let directory = tempfile::tempdir().unwrap();
    let (seen, on_output) = seen();
    let missing = directory.path().join("missing");
    let run =
        runner(false, directory.path()).run(missing.to_str().unwrap(), "echo never", on_output);
    assert_eq!(run.done.await.unwrap().code, Some(126));
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert!(last.stderr.contains("missing"));
    assert_eq!(last.stdout, "");
}

#[test]
fn over_ssh_the_wrapper_and_its_arguments_are_quoted_for_the_host_s_sh() {
    let remote = remote_shell_command("/home/me/it's here", "echo 'a b' && ls", &sh_quote);
    assert!(remote.starts_with("sh -c "));
    assert!(remote.contains(&sh_quote("/home/me/it's here")));
    assert!(remote.contains(&sh_quote("echo 'a b' && ls")));
}

#[test]
fn roamgate_s_own_variables_stay_out_of_the_user_s_commands() {
    let env = [
        ("PATH", "/bin"),
        ("ROAMGATE_PASSWORD", "secret"),
        ("HERDR_PANE_ID", "w1:p1"),
        ("HOME", "/home/me"),
    ]
    .map(|(key, value)| (key.to_owned(), value.to_owned()));
    assert_eq!(
        shell_env(env),
        [
            ("PATH".to_owned(), "/bin".to_owned()),
            ("HOME".to_owned(), "/home/me".to_owned())
        ]
    );
}
