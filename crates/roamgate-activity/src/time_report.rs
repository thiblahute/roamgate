//! `bridge.time_report {op, ...}` (server/src/time-report/rpc.ts): the
//! Hours view's calls to the provider. Day operations run one at a time
//! per day (never two provider processes for one day). `submit` goes out
//! only with a token this bridge got from a `submit-preview` of the same
//! day, once, and with `confirmed: true`, which only the Hours view's
//! confirmation sends; nothing in Roamgate submits on its own.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_base::clock::SharedClock;
use serde_json::{Map, Value, json};

use crate::provider::{BoxFuture, ProviderSettings, SharedSpawn, run_provider};
use crate::timeline::is_date;

/// A preview's token is good for this long here, whatever the provider
/// says.
pub const PREVIEW_TTL_MS: i64 = 15 * 60_000;

pub const TIME_REPORT_OPS: &[&str] = &[
    "health",
    "days",
    "day",
    "refresh",
    "targets",
    "block-create",
    "block-update",
    "block-delete",
    "block-split",
    "block-answer",
    "block-accept",
    "block-explain",
    "submit-preview",
    "submit",
    "mappings",
    "mapping-set",
    "mapping-delete",
];

// Never an option: ids start with a letter or digit.
static ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$").unwrap());
static ISO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$").unwrap()
});

/// An answer the Hours view shows: `{ok: false, error, code, partial}`.
#[derive(Debug, Clone, PartialEq)]
pub struct TimeReportError {
    pub message: String,
    pub code: Value,
    pub partial: Value,
}

impl TimeReportError {
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self {
            message: message.into(),
            code: Value::String(code.into()),
            partial: Value::Null,
        }
    }

    /// The RPC's result for it.
    pub fn to_result(&self) -> Value {
        json!({"ok": false, "error": self.message, "code": self.code, "partial": self.partial})
    }
}

/// Why `handle` gave no result.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// An answer (`{ok: false, ...}`).
    Report(Box<TimeReportError>),
    /// The call failed (an RPC error).
    Other(String),
}

impl From<TimeReportError> for Failure {
    fn from(error: TimeReportError) -> Self {
        Self::Report(Box::new(error))
    }
}

/// What the bridge needs from the server.
pub trait TimeReportSource: Send + Sync + 'static {
    /// The provider setting in effect, None when none is configured.
    fn settings(&self) -> BoxFuture<Option<ProviderSettings>>;
    /// The activity log's `date` as the provider gets it (DayInput), or a
    /// `not_configured` report while recording is off or there is no log.
    fn day_input(&self, date: String) -> BoxFuture<Result<Value, Failure>>;
}

#[derive(Debug, Clone)]
struct Preview {
    date: String,
    expires: i64,
}

/// The bridge: one per server.
pub struct TimeReport {
    source: Arc<dyn TimeReportSource>,
    spawn: SharedSpawn,
    clock: SharedClock,
    day_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Tokens previews handed out: token to its day and expiry.
    previews: Mutex<HashMap<String, Preview>>,
}

fn invalid(message: impl Into<String>) -> Failure {
    TimeReportError::new(message, "invalid").into()
}

fn forbidden(message: impl Into<String>) -> Failure {
    TimeReportError::new(message, "forbidden").into()
}

fn date(value: Option<&Value>, field: &str) -> Result<String, Failure> {
    match value.and_then(Value::as_str) {
        Some(text) if is_date(text) => Ok(text.to_owned()),
        _ => Err(invalid(format!("{field} must be a date, YYYY-MM-DD"))),
    }
}

fn id(value: Option<&Value>, field: &str) -> Result<String, Failure> {
    match value.and_then(Value::as_str) {
        Some(text) if ID_RE.is_match(text) => Ok(text.to_owned()),
        _ => Err(invalid(format!("{field} must be an id"))),
    }
}

fn body(value: Option<&Value>) -> Result<Value, Failure> {
    match value {
        Some(value @ Value::Object(_)) => Ok(value.clone()),
        _ => Err(invalid("body must be an object")),
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

impl TimeReport {
    pub fn new(source: Arc<dyn TimeReportSource>, spawn: SharedSpawn, clock: SharedClock) -> Self {
        Self {
            source,
            spawn,
            clock,
            day_locks: Mutex::default(),
            previews: Mutex::default(),
        }
    }

    /// Runs `run` once every earlier run for `day` ended, in call order.
    async fn locked<T>(&self, day: &str, run: impl Future<Output = T>) -> T {
        let lock = self
            .day_locks
            .lock()
            .unwrap()
            .entry(day.to_owned())
            .or_default()
            .clone();
        let result = {
            let _turn = lock.lock().await;
            run.await
        };
        let mut locks = self.day_locks.lock().unwrap();
        // The map's and this one: nobody waits.
        if Arc::strong_count(&lock) == 2 {
            locks.remove(day);
        }
        result
    }

    async fn call(
        &self,
        settings: &ProviderSettings,
        args: Vec<String>,
        stdin: Option<&Value>,
    ) -> Result<Value, Failure> {
        run_provider(settings, &args, stdin, self.spawn.as_ref())
            .await
            .map_err(|error| {
                Failure::Report(Box::new(TimeReportError {
                    message: error.message,
                    code: error.code,
                    partial: error.partial,
                }))
            })
    }

    /// One `bridge.time_report` call: the provider's answer, or why not.
    pub async fn handle(&self, params: &Value) -> Result<Value, Failure> {
        let empty = Map::new();
        let request = params.as_object().unwrap_or(&empty);
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .filter(|op| TIME_REPORT_OPS.contains(op))
            .ok_or_else(|| invalid("unknown time report operation"))?;
        let Some(settings) = self.source.settings().await else {
            return Err(TimeReportError::new(
                "No time report provider is configured (time_report.command).",
                "not_configured",
            )
            .into());
        };
        let settings = &settings;
        match op {
            "health" | "targets" | "mappings" => self.call(settings, args(&[op]), None).await,
            "days" => {
                let from = date(request.get("from"), "from")?;
                let to = date(request.get("to"), "to")?;
                if to < from {
                    return Err(invalid("to is before from"));
                }
                self.call(
                    settings,
                    args(&["days", "--from", &from, "--to", &to]),
                    None,
                )
                .await
            }
            "day" | "refresh" => {
                let day = date(request.get("date"), "date")?;
                self.locked(&day, async {
                    let input = self.source.day_input(day.clone()).await?;
                    self.call(settings, args(&[op, &day]), Some(&input)).await
                })
                .await
            }
            "block-create" => {
                let day = date(request.get("date"), "date")?;
                let payload = body(request.get("body"))?;
                self.locked(&day, self.call(settings, args(&[op, &day]), Some(&payload)))
                    .await
            }
            "block-update" | "block-answer" => {
                let day = date(request.get("date"), "date")?;
                let block = id(request.get("block"), "block")?;
                let payload = body(request.get("body"))?;
                self.locked(
                    &day,
                    self.call(settings, args(&[op, &day, &block]), Some(&payload)),
                )
                .await
            }
            "block-delete" | "block-accept" | "block-explain" => {
                let day = date(request.get("date"), "date")?;
                let block = id(request.get("block"), "block")?;
                self.locked(&day, self.call(settings, args(&[op, &day, &block]), None))
                    .await
            }
            "block-split" => {
                let day = date(request.get("date"), "date")?;
                let block = id(request.get("block"), "block")?;
                let at = request
                    .get("at")
                    .and_then(Value::as_str)
                    .filter(|at| ISO_RE.is_match(at))
                    .ok_or_else(|| invalid("at must be an ISO 8601 time"))?;
                self.locked(
                    &day,
                    self.call(settings, args(&[op, &day, &block, "--at", at]), None),
                )
                .await
            }
            "mapping-set" | "mapping-delete" => {
                let payload = body(request.get("body"))?;
                self.call(settings, args(&[op]), Some(&payload)).await
            }
            "submit-preview" => {
                let day = date(request.get("date"), "date")?;
                let blocks = match request.get("blocks") {
                    None => Vec::new(),
                    Some(Value::Array(blocks)) => blocks.clone(),
                    Some(_) => return Err(invalid("blocks must be a list")),
                };
                let mut command = args(&["submit-preview", &day]);
                for block in &blocks {
                    command.push("--block".into());
                    command.push(id(Some(block), "block")?);
                }
                self.locked(&day, async {
                    let preview = self.call(settings, command, None).await?;
                    if let Some(token) = preview.get("confirm_token").and_then(Value::as_str) {
                        self.previews.lock().unwrap().insert(
                            token.to_owned(),
                            Preview {
                                date: day.clone(),
                                expires: self.clock.now() + PREVIEW_TTL_MS,
                            },
                        );
                    }
                    // A preview that is no object answers as `{}` does.
                    Ok(if preview.is_object() {
                        preview
                    } else {
                        json!({})
                    })
                })
                .await
            }
            "submit" => {
                let day = date(request.get("date"), "date")?;
                // The Hours view sends this only from its confirmation step.
                if request.get("confirmed") != Some(&Value::Bool(true)) {
                    return Err(forbidden("Submitting needs an explicit confirmation."));
                }
                let token = match request.get("confirm_token").and_then(Value::as_str) {
                    Some(token) if !token.is_empty() => token.to_owned(),
                    _ => return Err(forbidden("confirm_token is missing")),
                };
                let now = self.clock.now();
                let preview = {
                    let mut previews = self.previews.lock().unwrap();
                    let preview = previews.get(&token).cloned();
                    previews.retain(|_, entry| entry.expires > now);
                    preview
                };
                match preview {
                    Some(preview) if preview.date == day && preview.expires > now => {}
                    _ => {
                        return Err(forbidden(
                            "This preview is unknown or expired: preview again.",
                        ));
                    }
                }
                // One use, whatever the outcome: a retry previews again.
                self.previews.lock().unwrap().remove(&token);
                self.locked(
                    &day,
                    self.call(
                        settings,
                        args(&["submit", &day]),
                        Some(&json!({"confirm_token": token})),
                    ),
                )
                .await
            }
            _ => Err(invalid("unknown time report operation")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use roamgate_base::clock::TestClock;

    use super::*;
    use crate::provider::{Spawn, SpawnFailure, Spawned};

    const DATE: &str = "2026-11-03";

    /// A provider that answers after a while and notes overlapping runs.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<(Vec<String>, String)>>,
        running: AtomicUsize,
        overlapped: AtomicUsize,
    }

    impl Spawn for Arc<Fake> {
        fn spawn(
            &self,
            argv: Vec<String>,
            _cwd: PathBuf,
            stdin: String,
            _timeout: Duration,
        ) -> BoxFuture<Result<Spawned, SpawnFailure>> {
            let fake = self.clone();
            Box::pin(async move {
                if fake.running.fetch_add(1, Ordering::SeqCst) > 0 {
                    fake.overlapped.fetch_add(1, Ordering::SeqCst);
                }
                let op = argv[1].clone();
                fake.calls.lock().unwrap().push((argv, stdin));
                tokio::time::sleep(Duration::from_millis(20)).await;
                fake.running.fetch_sub(1, Ordering::SeqCst);
                let stdout = if op == "submit-preview" {
                    format!(
                        "{{\"confirm_token\":\"tok-{}\"}}",
                        fake.calls.lock().unwrap().len()
                    )
                } else {
                    "{\"ok\":true}".to_owned()
                };
                Ok(Spawned {
                    code: Some(0),
                    stdout,
                    ..Spawned::default()
                })
            })
        }
    }

    struct Source;

    impl TimeReportSource for Source {
        fn settings(&self) -> BoxFuture<Option<ProviderSettings>> {
            Box::pin(async {
                Some(ProviderSettings {
                    command: vec!["olmo".into()],
                    timeout_seconds: 60,
                })
            })
        }

        fn day_input(&self, date: String) -> BoxFuture<Result<Value, Failure>> {
            Box::pin(async move { Ok(json!({"date": date})) })
        }
    }

    fn harness() -> (Arc<TimeReport>, Arc<Fake>, TestClock) {
        let fake = Arc::new(Fake::default());
        let clock = TestClock::new(1_000_000);
        let report = TimeReport::new(
            Arc::new(Source),
            Arc::new(fake.clone()),
            Arc::new(clock.clone()),
        );
        (Arc::new(report), fake, clock)
    }

    #[tokio::test]
    async fn one_provider_process_at_a_time_per_day() {
        let (report, fake, _) = harness();
        let (p1, p2, p3) = (
            json!({"op": "refresh", "date": DATE}),
            json!({"op": "block-accept", "date": DATE, "block": "b1"}),
            json!({"op": "day", "date": DATE}),
        );
        let (a, b, c) = tokio::join!(report.handle(&p1), report.handle(&p2), report.handle(&p3));
        for answer in [a, b, c] {
            assert_eq!(answer.unwrap(), json!({"ok": true}));
        }
        assert_eq!(fake.calls.lock().unwrap().len(), 3);
        assert_eq!(fake.overlapped.load(Ordering::SeqCst), 0);
        assert!(report.day_locks.lock().unwrap().is_empty());
        // Other days are not held up.
        let (p4, p5) = (
            json!({"op": "day", "date": DATE}),
            json!({"op": "day", "date": "2026-11-04"}),
        );
        let (x, y) = tokio::join!(report.handle(&p4), report.handle(&p5));
        assert!(x.is_ok() && y.is_ok());
        assert_eq!(fake.overlapped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn submit_needs_the_confirmation_and_this_bridge_s_fresh_preview_once() {
        let (report, fake, clock) = harness();
        let submits = || {
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(argv, _)| argv[1] == "submit")
                .count()
        };
        let forbidden = |answer: Result<Value, Failure>| match answer {
            Err(Failure::Report(error)) => assert_eq!(error.code, json!("forbidden")),
            other => panic!("{other:?}"),
        };
        forbidden(
            report
                .handle(&json!({"op": "submit", "date": DATE, "confirm_token": "made-up", "confirmed": true}))
                .await,
        );
        let preview = report
            .handle(&json!({"op": "submit-preview", "date": DATE}))
            .await
            .unwrap();
        let token = preview["confirm_token"].as_str().unwrap().to_owned();
        forbidden(
            report
                .handle(&json!({"op": "submit", "date": DATE, "confirm_token": token}))
                .await,
        );
        forbidden(
            report
                .handle(&json!({"op": "submit", "date": "2026-11-01", "confirm_token": token, "confirmed": true}))
                .await,
        );
        assert_eq!(submits(), 0);
        report
            .handle(
                &json!({"op": "submit", "date": DATE, "confirm_token": token, "confirmed": true}),
            )
            .await
            .unwrap();
        assert_eq!(submits(), 1);
        forbidden(
            report
                .handle(&json!({"op": "submit", "date": DATE, "confirm_token": token, "confirmed": true}))
                .await,
        );
        // A preview expires after 15 minutes of the bridge's clock.
        let preview = report
            .handle(&json!({"op": "submit-preview", "date": DATE}))
            .await
            .unwrap();
        clock.advance(PREVIEW_TTL_MS as u64).await;
        forbidden(
            report
                .handle(&json!({"op": "submit", "date": DATE, "confirm_token": preview["confirm_token"], "confirmed": true}))
                .await,
        );
        assert_eq!(submits(), 1);
    }

    #[tokio::test]
    async fn arguments_are_checked_before_anything_runs() {
        let (report, fake, _) = harness();
        for (params, message) in [
            (json!({"op": "rm -rf"}), "unknown time report operation"),
            (json!(null), "unknown time report operation"),
            (
                json!({"op": "day", "date": "today"}),
                "date must be a date, YYYY-MM-DD",
            ),
            (
                json!({"op": "days", "from": DATE, "to": "x"}),
                "to must be a date, YYYY-MM-DD",
            ),
            (
                json!({"op": "days", "from": DATE, "to": "2026-11-02"}),
                "to is before from",
            ),
            (
                json!({"op": "block-delete", "date": DATE, "block": "--all"}),
                "block must be an id",
            ),
            (
                json!({"op": "block-split", "date": DATE, "block": "b1", "at": "noon"}),
                "at must be an ISO 8601 time",
            ),
            (
                json!({"op": "block-update", "date": DATE, "block": "b1"}),
                "body must be an object",
            ),
            (
                json!({"op": "mapping-set", "body": []}),
                "body must be an object",
            ),
            (
                json!({"op": "submit-preview", "date": DATE, "blocks": "b1"}),
                "blocks must be a list",
            ),
            (
                json!({"op": "submit-preview", "date": DATE, "blocks": ["; rm"]}),
                "block must be an id",
            ),
        ] {
            let answer = report.handle(&params).await;
            assert_eq!(
                answer,
                Err(TimeReportError::new(message, "invalid").into()),
                "{params}"
            );
        }
        assert!(fake.calls.lock().unwrap().is_empty());
        report
            .handle(&json!({"op": "block-split", "date": DATE, "block": "b1", "at": "2026-11-03T10:00+01:00"}))
            .await
            .unwrap();
        assert_eq!(
            fake.calls.lock().unwrap()[0].0,
            args(&[
                "olmo",
                "block-split",
                DATE,
                "b1",
                "--at",
                "2026-11-03T10:00+01:00"
            ])
        );
    }
}
