use super::*;
use crate::conversation::memory::ClaudeMemoryDriver;
use roamgate_conversation::driver::CompanionMemoryDriver;

#[test]
fn drops_the_herdr_pane_and_claude_code_variables_keeps_the_rest() {
    let env = [
        ("HOME", "/home/me"),
        ("PATH", "/bin"),
        ("HERDR_ENV", "1"),
        ("HERDR_PANE_ID", "p1"),
        ("HERDR_SOCKET_PATH", "/tmp/herdr.sock"),
        ("HERDR_WORKSPACE_ID", "w1"),
        ("CLAUDECODE", "1"),
    ]
    .map(|(k, v)| (k.to_owned(), v.to_owned()));
    assert_eq!(
        background_claude_env(env),
        vec![
            ("HOME".to_owned(), "/home/me".to_owned()),
            ("PATH".to_owned(), "/bin".to_owned())
        ]
    );
}

/// The spawn test of voice-cleaner.spawn.test.ts ran a fake `claude`
/// echoing its `--effort`: the argv says it, without a process.
#[test]
fn the_background_sessions_answer_at_low_effort_not_thinking_for_seconds() {
    let args = background_args("opus", "system", &BackgroundOptions::default());
    let effort = args.iter().position(|a| a == "--effort").unwrap();
    assert_eq!(args[effort + 1], "low");
    assert_eq!(
        args,
        [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            "opus",
            "--effort",
            "low",
            "--tools",
            "",
            "--safe-mode",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--system-prompt",
            "system",
        ]
    );
    let partial = background_args(
        "haiku",
        "s",
        &BackgroundOptions {
            partial: true,
            launch: ClaudeMemoryDriver.reader("/x/memories"),
        },
    );
    assert_eq!(partial[6], "--include-partial-messages");
    assert!(!partial.contains(&"--safe-mode".to_owned()));
    assert!(
        partial.contains(
            &r#"{"autoMemoryDirectory":"/x/memories","disableAllHooks":true}"#.to_owned()
        )
    );
}
