//! One run of the time-report provider (docs/time-report.md,
//! server/src/time-report/provider.ts): the configured command with the
//! operation appended, a JSON body on stdin, one JSON document on stdout.
//! One process per operation, from an empty directory, killed with its
//! process group at `timeout_seconds`. Never retried here: a timed out
//! `submit` is previewed again by the user.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use roamgate_base::log::slice_utf16;
use roamgate_base::settings::js_trim;
use roamgate_exec::process::{Command, ExecError, KillSignal, Overflow, ProcessRunner};
use serde_json::Value;

use crate::js::parse_json;

/// The most stdout (and stderr) a provider may print.
pub const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;

/// The configured provider (`time_report` in settings.json, normalised).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSettings {
    pub command: Vec<String>,
    pub timeout_seconds: u64,
}

impl ProviderSettings {
    /// From the normalised `time_report` setting; None when absent.
    pub fn from_setting(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        let command = value
            .get("command")?
            .as_array()?
            .iter()
            .map(|part| part.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            command,
            timeout_seconds: value.get("timeout_seconds")?.as_u64()?,
        })
    }
}

/// A failed run: the provider's `{error, code}`, or what went wrong.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderError {
    pub message: String,
    /// The provider's code as it printed it, else ours (a string).
    pub code: Value,
    pub exit_code: Option<i32>,
    /// stdout of a failed run, for `submit`'s partial SubmitResult.
    pub partial: Value,
}

impl ProviderError {
    fn new(message: impl Into<String>, code: &str, exit_code: Option<i32>) -> Self {
        Self {
            message: message.into(),
            code: Value::String(code.into()),
            exit_code,
            partial: Value::Null,
        }
    }
}

/// What a run gave.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spawned {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Why a run did not happen or did not end well.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnFailure {
    /// No such program.
    NotFound,
    /// It printed more than [`OUTPUT_LIMIT`].
    TooMuch,
    Other(String),
}

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// Runs the provider's process (tests put a fake in).
pub trait Spawn: Send + Sync + 'static {
    fn spawn(
        &self,
        argv: Vec<String>,
        cwd: PathBuf,
        stdin: String,
        timeout: Duration,
    ) -> BoxFuture<Result<Spawned, SpawnFailure>>;
}

/// The real one: its own process group, killed with SIGKILL at the
/// deadline (on the runner's clock), output capped.
impl Spawn for ProcessRunner {
    fn spawn(
        &self,
        argv: Vec<String>,
        cwd: PathBuf,
        stdin: String,
        timeout: Duration,
    ) -> BoxFuture<Result<Spawned, SpawnFailure>> {
        let runner = self.clone();
        Box::pin(async move {
            let command = Command::new(argv)
                .cwd(cwd)
                .stdin(stdin)
                .timeout(timeout)
                .output_cap(OUTPUT_LIMIT, Overflow::Fail)
                .kill_signal(KillSignal::Kill)
                .missing_is_error();
            match runner.run(&command).await {
                Ok(output) => Ok(Spawned {
                    code: Some(output.code),
                    stdout: output.stdout_text(),
                    stderr: output.stderr_text(),
                    timed_out: false,
                }),
                Err(ExecError::TimedOut { .. }) => Ok(Spawned {
                    timed_out: true,
                    ..Spawned::default()
                }),
                Err(ExecError::TooMuchOutput { .. }) => Err(SpawnFailure::TooMuch),
                Err(ExecError::Spawn { source, .. })
                    if source.kind() == std::io::ErrorKind::NotFound =>
                {
                    Err(SpawnFailure::NotFound)
                }
                Err(error) => Err(SpawnFailure::Other(error.to_string())),
            }
        })
    }
}

/// The meaning of the provider's exit codes.
fn exit_code_name(code: i32) -> &'static str {
    match code {
        2 => "invalid",
        3 => "not_found",
        4 => "conflict",
        5 => "forbidden",
        6 => "upstream",
        _ => "error",
    }
}

/// The provider's error from stderr, when it printed one: the last line
/// that is a JSON object with a string `error`.
fn provider_error(stderr: &str) -> Option<(String, Option<Value>)> {
    js_trim(stderr).split('\n').rev().find_map(|line| {
        let value = parse_json(line)?;
        let error = value.get("error")?.as_str()?.to_owned();
        let code = value.get("code").filter(|code| !code.is_null()).cloned();
        Some((error, code))
    })
}

/// Runs `settings.command` with `args`, `stdin` (as JSON) on its standard
/// input: the JSON it printed, or why not.
pub async fn run_provider(
    settings: &ProviderSettings,
    args: &[String],
    stdin: Option<&Value>,
    spawn: &dyn Spawn,
) -> Result<Value, Box<ProviderError>> {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-time-report-")
        .tempdir()
        .map_err(|error| {
            Box::new(ProviderError::new(
                format!("The provider could not run: {error}"),
                "error",
                None,
            ))
        })?;
    let mut argv = settings.command.clone();
    argv.extend(args.iter().cloned());
    let input = stdin.map(Value::to_string).unwrap_or_default();
    let result = spawn
        .spawn(
            argv,
            dir.path().to_path_buf(),
            input,
            Duration::from_secs(settings.timeout_seconds),
        )
        .await;
    drop(dir);
    let result = match result {
        Ok(result) => result,
        Err(SpawnFailure::NotFound) => {
            return Err(Box::new(ProviderError::new(
                format!(
                    "The provider command was not found: {}",
                    settings.command.first().map(String::as_str).unwrap_or("")
                ),
                "error",
                None,
            )));
        }
        Err(SpawnFailure::TooMuch) => {
            return Err(Box::new(ProviderError::new(
                "The provider printed too much.",
                "error",
                None,
            )));
        }
        Err(SpawnFailure::Other(message)) => {
            return Err(Box::new(ProviderError::new(
                format!("The provider could not run: {message}"),
                "error",
                None,
            )));
        }
    };
    if result.timed_out {
        return Err(Box::new(ProviderError::new(
            format!(
                "The provider did not answer within {} seconds.",
                settings.timeout_seconds
            ),
            "timeout",
            None,
        )));
    }
    if result.code != Some(0) {
        let printed = provider_error(&result.stderr);
        let code = printed
            .as_ref()
            .and_then(|(_, code)| code.clone())
            .unwrap_or_else(|| Value::String(result.code.map_or("error", exit_code_name).into()));
        let message = match printed {
            Some((message, _)) => message,
            None => {
                let last = js_trim(&result.stderr)
                    .split('\n')
                    .next_back()
                    .unwrap_or("");
                let last = slice_utf16(last, 500);
                if last.is_empty() {
                    format!(
                        "The provider exited with {}.",
                        result
                            .code
                            .map_or_else(|| "null".to_owned(), |code| code.to_string())
                    )
                } else {
                    last.to_owned()
                }
            }
        };
        return Err(Box::new(ProviderError {
            message,
            code,
            exit_code: result.code,
            partial: parse_json(&result.stdout).unwrap_or(Value::Null),
        }));
    }
    parse_json(&result.stdout).ok_or_else(|| {
        Box::new(ProviderError::new(
            "The provider printed no JSON.",
            "error",
            result.code,
        ))
    })
}

/// A shared spawner.
pub type SharedSpawn = Arc<dyn Spawn>;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use roamgate_base::clock::SystemClock;
    use serde_json::json;

    /// A provider that does what its second argument says, and logs its
    /// call (server/src/time-report/provider.test.ts's fake).
    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let log = dir.path().join("calls.log");
            let script = format!(
                r#"#!/bin/sh
input=$(cat)
printf '%s|%s|%s|%s\n' "$*" "$input" "$PWD" "$(ls -A | wc -l | tr -d ' ')" >> '{}'
case "$2" in
  health) printf '{{"ok":true,"provider":"Fake"}}\n' ;;
  slow) sleep 5 ;;
  invalid) printf '{{"error":"end before start","code":"invalid"}}\n' >&2; exit 2 ;;
  upstream) printf '{{"results":[{{"block_id":"b1","ok":true}}]}}\n'; printf '{{"error":"Olmo is down","code":"upstream"}}\n' >&2; exit 6 ;;
  bare) echo "boom" >&2; exit 3 ;;
  silent) ;;
  echo) printf '%s\n' "$input" ;;
esac
"#,
                log.display()
            );
            std::fs::write(dir.path().join("provider.sh"), script).unwrap();
            Self { dir }
        }

        fn settings(&self, timeout_seconds: u64) -> ProviderSettings {
            ProviderSettings {
                command: vec![
                    "/bin/sh".into(),
                    self.dir.path().join("provider.sh").display().to_string(),
                    "provider".into(),
                ],
                timeout_seconds,
            }
        }

        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("calls.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    fn runner() -> ProcessRunner {
        ProcessRunner::new(Arc::new(SystemClock))
    }

    #[tokio::test]
    async fn the_operation_follows_the_command_the_body_goes_on_stdin_an_empty_directory() {
        let fixture = Fixture::new();
        let settings = fixture.settings(60);
        assert_eq!(
            run_provider(&settings, &args(&["health"]), None, &runner())
                .await
                .unwrap(),
            json!({"ok": true, "provider": "Fake"})
        );
        assert_eq!(
            run_provider(
                &settings,
                &args(&["echo", "2026-11-03"]),
                Some(&json!({"date": "x"})),
                &runner()
            )
            .await
            .unwrap(),
            json!({"date": "x"})
        );
        let calls = fixture.calls();
        let first: Vec<&str> = calls[0].split('|').collect();
        assert_eq!(first[0], "provider health");
        assert_eq!(first[1], "");
        assert_eq!(first[3], "0");
        assert!(!std::path::Path::new(first[2]).exists());
        let second: Vec<&str> = calls[1].split('|').collect();
        assert_eq!(
            &second[..2],
            &["provider echo 2026-11-03", "{\"date\":\"x\"}"]
        );
    }

    #[tokio::test]
    async fn a_hung_provider_is_killed_at_the_timeout() {
        let fixture = Fixture::new();
        let started = std::time::Instant::now();
        let settings = ProviderSettings {
            timeout_seconds: 1,
            ..fixture.settings(1)
        };
        let error = run_provider(&settings, &args(&["slow"]), None, &runner())
            .await
            .unwrap_err();
        assert_eq!(error.code, json!("timeout"));
        assert_eq!(
            error.message,
            "The provider did not answer within 1 seconds."
        );
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[tokio::test]
    async fn errors_carry_the_provider_s_message_and_code_and_submit_s_partial_result() {
        let fixture = Fixture::new();
        let settings = fixture.settings(60);
        let run = |op: &'static str| {
            let settings = settings.clone();
            async move {
                run_provider(&settings, &args(&[op]), Some(&json!({})), &runner())
                    .await
                    .unwrap_err()
            }
        };
        let invalid = run("invalid").await;
        assert_eq!(
            (invalid.message.as_str(), &invalid.code, invalid.exit_code),
            ("end before start", &json!("invalid"), Some(2))
        );
        let upstream = run("upstream").await;
        assert_eq!(upstream.code, json!("upstream"));
        assert_eq!(
            upstream.partial,
            json!({"results": [{"block_id": "b1", "ok": true}]})
        );
        let bare = run("bare").await;
        assert_eq!(
            (bare.message.as_str(), &bare.code),
            ("boom", &json!("not_found"))
        );
        let silent = run("silent").await;
        assert_eq!(silent.message, "The provider printed no JSON.");
    }

    #[tokio::test]
    async fn a_missing_command_says_so() {
        let fixture = Fixture::new();
        let settings = ProviderSettings {
            command: vec![fixture.dir.path().join("nope").display().to_string()],
            timeout_seconds: 5,
        };
        let error = run_provider(&settings, &args(&["health"]), None, &runner())
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            format!(
                "The provider command was not found: {}",
                settings.command[0]
            )
        );
        assert_eq!(error.code, json!("error"));
    }

    #[test]
    fn only_a_runnable_command_is_a_provider_setting() {
        use roamgate_base::settings::normalize_time_report_settings as normalize;
        let read = |raw: Value| ProviderSettings::from_setting(normalize(Some(&raw)).as_ref());
        assert_eq!(
            ProviderSettings::from_setting(normalize(None).as_ref()),
            None
        );
        assert_eq!(read(json!({"command": []})), None);
        assert_eq!(read(json!({"command": "olmo"})), None);
        assert_eq!(read(json!({"command": ["a", 3]})), None);
        assert_eq!(
            read(json!({"command": ["olmo", "provider"]})),
            Some(ProviderSettings {
                command: vec!["olmo".into(), "provider".into()],
                timeout_seconds: 60
            })
        );
        assert_eq!(
            read(json!({"command": ["o"], "timeout_seconds": 1}))
                .unwrap()
                .timeout_seconds,
            60
        );
    }
}
