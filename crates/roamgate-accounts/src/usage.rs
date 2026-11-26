//! Each signed-in account's usage, polled by one scheduler and kept in
//! `<data>/accounts/usage.json`, so that a restart shows the last reading.
//!
//! Adapted from clauth (https://github.com/uwuclxdy/clauth, MIT licence,
//! Copyright (c) 2026 cloudy): src/usage/fetch.rs (the Anthropic `/usage`
//! and `/profile` reads, their headers, the windows derived from `limits[]`
//! with the legacy `five_hour` / `seven_day` fallback, the per-model weekly
//! windows), src/usage/codex.rs and src/usage/codex_headers.rs (ChatGPT's
//! `wham/usage`, its windows placed by duration, `limit_reached`), and the
//! statuses of its status.json (fresh, cached, failed, rate limited, auth
//! expired); its 90 s poll interval.
//!
//! `agy` is never polled against Google: Roamgate asks `agy` itself
//! (`agy -p /usage`, which prints one tab-separated record per line) in
//! the account's environment, every [`AGY_INTERVAL_MS`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rand::Rng as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::files::{read_object, write_private};
use crate::oauth::{Endpoints, Http};
use crate::{AccountAgent, AuthState, claude_auth, codex_auth, launch_env};

/// How often a signed-in Claude or Codex account is read (ms).
pub const INTERVAL_MS: i64 = 90_000;
/// How often an `agy` account is asked (ms): each ask runs `agy`.
pub const AGY_INTERVAL_MS: i64 = 5 * 60_000;
/// The longest wait after failures (ms).
const MAX_BACKOFF_MS: i64 = 15 * 60_000;
/// How often the Claude profile (plan, email) is read again (ms).
const PROFILE_TTL_MS: i64 = 60 * 60_000;

/// A usage window: `5h`, `7d`, or a per-model week (`7d opus`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageWindow {
    pub label: String,
    /// Percent used, 0 to 100.
    pub utilization: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// One window's reading at one time, for the burn-aware projection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageSample {
    pub at: i64,
    pub label: String,
    pub utilization: f64,
}

/// How long readings are kept for the projection (ms), and how many.
const HISTORY_MS: i64 = 6 * 60 * 60_000;
const HISTORY_MAX: usize = 64;

/// What an account's last reading said.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub windows: Vec<UsageWindow>,
    /// Claude's pay-as-you-go credits, as the server gives them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Codex: the limit the account is blocked on now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_reached: Option<String>,
    /// `agy`: its own records, as it printed them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub records: Vec<Vec<String>>,
}

/// How the last poll went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus {
    /// Read just now.
    Fresh,
    /// The last reading, from an earlier run.
    Cached,
    Failed,
    RateLimited,
    /// The sign-in was refused; it needs a refresh or a new sign-in.
    AuthExpired,
    /// No number to read (an `agy` that gives none).
    Unknown,
}

/// One account's usage, as clients see it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountUsage {
    pub agent: String,
    pub id: String,
    pub status: UsageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// When `usage` was read (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AccountUsage {
    pub fn key(&self) -> String {
        format!("{}/{}", self.agent, self.id)
    }
}

/// An account the scheduler reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolledAccount {
    pub agent: AccountAgent,
    pub id: String,
    pub dir: PathBuf,
}

/// Why a read failed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReadError {
    Auth,
    RateLimited(Option<u64>),
    Failed(String),
}

// ------------------------------------------------------------ Claude

/// The windows of an Anthropic `/usage` body: `limits[]` first
/// (`session` 5h, `weekly_all` 7d, each `weekly_scoped` a `7d <model>`),
/// the legacy `five_hour` / `seven_day` when it lacks one.
pub(crate) fn claude_windows(body: &Value) -> Vec<UsageWindow> {
    let window = |label: String, utilization: Option<f64>, resets: Option<&Value>| UsageWindow {
        label,
        utilization: utilization.unwrap_or(0.0),
        resets_at: resets.and_then(Value::as_str).map(str::to_owned),
    };
    let (mut five, mut seven, mut scoped) = (None, None, Vec::new());
    for limit in body
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let made = |label: String| {
            window(
                label,
                limit.get("percent").and_then(Value::as_f64),
                limit.get("resets_at"),
            )
        };
        match limit.get("kind").and_then(Value::as_str) {
            Some("session") => five = Some(made("5h".into())),
            Some("weekly_all") => seven = Some(made("7d".into())),
            Some("weekly_scoped") => {
                let scope = limit.get("scope");
                let name = scope
                    .and_then(|scope| scope.get("model")?.get("display_name")?.as_str())
                    .or_else(|| {
                        let surface = scope?.get("surface")?;
                        surface.as_str().or_else(|| {
                            surface
                                .get("display_name")
                                .or_else(|| surface.get("id"))?
                                .as_str()
                        })
                    });
                if let Some(name) = name {
                    scoped.push(made(format!("7d {}", name.to_lowercase())));
                }
            }
            _ => {}
        }
    }
    let legacy = |key: &str, label: &str| {
        let raw = body.get(key).filter(|raw| raw.is_object())?;
        Some(window(
            label.into(),
            raw.get("utilization").and_then(Value::as_f64),
            raw.get("resets_at"),
        ))
    };
    let mut windows = Vec::new();
    windows.extend(five.or_else(|| legacy("five_hour", "5h")));
    windows.extend(seven.or_else(|| legacy("seven_day", "7d")));
    windows.extend(scoped);
    windows
}

/// The plan and email of an Anthropic `/profile` body.
pub(crate) fn claude_profile(body: &Value) -> (Option<String>, Option<String>) {
    let account = body.get("account");
    let email = account
        .and_then(|account| account.get("email")?.as_str())
        .map(str::to_owned);
    let plan = body
        .get("organization")
        .and_then(|org| org.get("plan_display_name")?.as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let flag = |key: &str| {
                account
                    .and_then(|account| account.get(key)?.as_bool())
                    .unwrap_or(false)
            };
            if flag("has_claude_max") {
                Some("Max".into())
            } else if flag("has_claude_pro") {
                Some("Pro".into())
            } else {
                None
            }
        });
    (plan, email)
}

fn claude_headers(token: &str, usage: bool) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("Authorization", format!("Bearer {token}")),
        ("Accept", "application/json, text/plain, */*".into()),
        ("Content-Type", "application/json".into()),
    ];
    if usage {
        headers.push(("anthropic-beta", "oauth-2025-04-20".into()));
        headers.push(("User-Agent", "claude-cli (external, cli)".into()));
    } else {
        headers.push(("User-Agent", "axios/1.15.2".into()));
        headers.push(("Cache-Control", "no-cache".into()));
    }
    headers
}

fn read_error(status: u16, retry_after: Option<u64>) -> ReadError {
    match status {
        401 | 403 => ReadError::Auth,
        429 => ReadError::RateLimited(retry_after),
        _ => ReadError::Failed(format!("The usage server answered HTTP {status}")),
    }
}

async fn read_claude(
    http: &Http,
    endpoints: &Endpoints,
    dir: &Path,
    profile: Option<(Option<String>, Option<String>)>,
) -> Result<(Usage, Option<(Option<String>, Option<String>)>), ReadError> {
    let token = claude_auth::access_token(dir).ok_or(ReadError::Auth)?;
    let got = http
        .get(&endpoints.claude_usage, &claude_headers(&token, true))
        .await
        .map_err(ReadError::Failed)?;
    if got.status != 200 {
        return Err(read_error(got.status, got.retry_after));
    }
    let body: Value = serde_json::from_str(&got.text)
        .map_err(|_| ReadError::Failed("The usage answer did not parse".into()))?;
    let profile = match profile {
        Some(profile) => Some(profile),
        // Best effort: a failed profile read leaves plan and email out.
        None => match http
            .get(&endpoints.claude_profile, &claude_headers(&token, false))
            .await
        {
            Ok(got) if got.status == 200 => serde_json::from_str::<Value>(&got.text)
                .ok()
                .map(|body| claude_profile(&body)),
            _ => None,
        },
    };
    let (plan, email) = profile.clone().unwrap_or_default();
    Ok((
        Usage {
            windows: claude_windows(&body),
            extra_usage: body
                .get("extra_usage")
                .filter(|extra| !extra.is_null())
                .cloned(),
            plan,
            email,
            ..Usage::default()
        },
        profile,
    ))
}

// ------------------------------------------------------------- Codex

/// The windows of a `wham/usage` body, placed by their duration (over a
/// day is the week), else by position (primary 5h, secondary 7d); a
/// reached limit reads at least 100 %.
pub(crate) fn codex_usage(body: &Value, now_ms: i64) -> Usage {
    let rate = body.get("rate_limit");
    let mut five: Option<UsageWindow> = None;
    let mut seven: Option<UsageWindow> = None;
    for (key, positional_week) in [("primary_window", false), ("secondary_window", true)] {
        let Some(raw) = rate
            .and_then(|rate| rate.get(key))
            .filter(|raw| raw.is_object())
        else {
            continue;
        };
        let number = |name: &str| raw.get(name).and_then(Value::as_i64).unwrap_or(0);
        let seconds = number("limit_window_seconds");
        let week = if seconds > 0 {
            seconds > 24 * 3600
        } else {
            positional_week
        };
        let resets = if number("reset_at") > 0 {
            Some(number("reset_at") * 1000)
        } else if number("reset_after_seconds") > 0 {
            Some(now_ms + number("reset_after_seconds") * 1000)
        } else {
            None
        };
        let window = UsageWindow {
            label: String::new(),
            utilization: raw
                .get("used_percent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            resets_at: resets.map(roamgate_base::log::iso_millis),
        };
        let (first, second) = if week {
            (&mut seven, &mut five)
        } else {
            (&mut five, &mut seven)
        };
        if first.is_none() {
            *first = Some(window);
        } else if second.is_none() {
            *second = Some(window);
        }
    }
    if rate
        .and_then(|rate| rate.get("limit_reached")?.as_bool())
        .unwrap_or(false)
    {
        let blocking = match (&five, &seven) {
            (Some(f), Some(s)) if s.utilization > f.utilization => seven.as_mut(),
            (None, Some(_)) => seven.as_mut(),
            _ => five.as_mut(),
        };
        if let Some(window) = blocking {
            window.utilization = window.utilization.max(100.0);
        }
    }
    let mut windows = Vec::new();
    for (label, window) in [("5h", five), ("7d", seven)] {
        if let Some(mut window) = window {
            window.label = label.into();
            windows.push(window);
        }
    }
    Usage {
        windows,
        plan: body
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        limit_reached: body
            .get("rate_limit_reached_type")
            .and_then(|reached| reached.get("type")?.as_str())
            .filter(|kind| !kind.is_empty())
            .map(str::to_owned),
        ..Usage::default()
    }
}

async fn read_codex(
    http: &Http,
    endpoints: &Endpoints,
    dir: &Path,
    now_ms: i64,
) -> Result<Usage, ReadError> {
    let (token, account) = codex_auth::access_token(dir).ok_or(ReadError::Auth)?;
    let mut headers = vec![
        ("User-Agent", "codex_cli_rs".to_owned()),
        ("Authorization", format!("Bearer {token}")),
    ];
    if let Some(account) = account {
        headers.push(("ChatGPT-Account-ID", account));
    }
    let got = http
        .get(&endpoints.codex_usage, &headers)
        .await
        .map_err(ReadError::Failed)?;
    if got.status != 200 {
        return Err(read_error(got.status, got.retry_after));
    }
    let body: Value = serde_json::from_str(&got.text)
        .map_err(|_| ReadError::Failed("The usage answer did not parse".into()))?;
    Ok(codex_usage(&body, now_ms))
}

// --------------------------------------------------------------- agy

/// The window an `agy` window name is: `5h`, `7d`, else its own words.
fn agy_window(name: &str) -> String {
    let lower = name.to_lowercase();
    let lower = lower
        .trim_end_matches(" remaining")
        .trim_end_matches(" limit");
    match lower {
        "five hour" => "5h".into(),
        "weekly" | "seven day" => "7d".into(),
        other => other.to_owned(),
    }
}

/// `agy`'s usage records (`agy -p /usage`: model group, window name,
/// percent remaining, reset time; one tab-separated record per line), as
/// windows per model group (`5h gemini models`, `7d claude and gpt
/// models`), the used part being 100 less the remaining. A reset at the
/// epoch is a window not used yet, with no reset pending.
pub(crate) fn agy_usage(output: &str) -> Usage {
    let records: Vec<Vec<String>> = output
        .lines()
        .map(str::trim_end)
        .filter(|line| line.contains('\t'))
        .map(|line| {
            line.split('\t')
                .map(|field| field.trim().to_owned())
                .collect()
        })
        .collect();
    let mut windows: Vec<UsageWindow> = records
        .iter()
        .filter_map(|record| {
            let [group, name, remaining, rest @ ..] = record.as_slice() else {
                return None;
            };
            let remaining = remaining.strip_suffix('%')?.trim().parse::<f64>().ok()?;
            let resets_at = rest
                .first()
                .filter(|at| roamgate_base::log::parse_iso_millis(at).is_some_and(|at| at > 0))
                .cloned();
            Some(UsageWindow {
                label: format!("{} {}", agy_window(name), group.to_lowercase()),
                utilization: (100.0 - remaining).clamp(0.0, 100.0),
                resets_at,
            })
        })
        .collect();
    // 5h before 7d, as the other agents' windows.
    windows.sort_by_key(|window| !window.label.starts_with("5h "));
    Usage {
        windows,
        records,
        ..Usage::default()
    }
}

async fn read_agy(program: &str, dir: &Path) -> Result<Usage, ReadError> {
    let env = launch_env(AccountAgent::Agy, dir);
    let mut command = tokio::process::Command::new(program);
    command
        .args(["-p", "/usage"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    for name in &env.unset {
        command.env_remove(name);
    }
    for (name, value) in &env.set {
        command.env(name, value);
    }
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| ReadError::Failed("agy did not answer".into()))?
        .map_err(|_| ReadError::Failed("agy could not be started".into()))?;
    if !output.status.success() {
        return Err(ReadError::Failed("agy refused /usage".into()));
    }
    Ok(agy_usage(&String::from_utf8_lossy(&output.stdout)))
}

// --------------------------------------------------------- scheduler

#[derive(Clone, Default)]
struct Timer {
    next_at: i64,
    failures: u32,
    profile: Option<(Option<String>, Option<String>)>,
    profile_at: i64,
}

/// The scheduler: one timer per account, the board every client reads.
pub struct UsagePoller {
    file: PathBuf,
    endpoints: Endpoints,
    http: Http,
    agy_program: String,
    board: Mutex<BTreeMap<String, AccountUsage>>,
    timers: Mutex<BTreeMap<String, Timer>>,
    history: Mutex<BTreeMap<String, Vec<UsageSample>>>,
}

/// What a poll changed: the accounts read anew, and those gone.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageDelta {
    pub accounts: Vec<AccountUsage>,
    pub removed: Vec<String>,
}

impl UsageDelta {
    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty() && self.removed.is_empty()
    }
}

fn jittered(interval: i64) -> i64 {
    let spread = interval / 10;
    interval + rand::rng().random_range(-spread..=spread)
}

impl UsagePoller {
    /// The scheduler of `<data>/accounts/usage.json`, its last readings
    /// loaded as cached.
    pub fn new(data_root: &Path, endpoints: Endpoints, agy_program: &str) -> Self {
        let file = crate::accounts_root(data_root).join("usage.json");
        let mut board = BTreeMap::new();
        let saved = read_object(&file);
        let history = saved
            .as_ref()
            .and_then(|saved| saved.get("history").cloned())
            .and_then(|history| serde_json::from_value(history).ok())
            .unwrap_or_default();
        if let Some(saved) = &saved
            && let Some(Value::Object(accounts)) = saved.get("accounts")
        {
            for (key, value) in accounts {
                if let Ok(mut usage) = serde_json::from_value::<AccountUsage>(value.clone()) {
                    if usage.status == UsageStatus::Fresh {
                        usage.status = UsageStatus::Cached;
                    }
                    board.insert(key.clone(), usage);
                }
            }
        }
        Self {
            file,
            endpoints,
            http: Http::default(),
            agy_program: agy_program.to_owned(),
            board: Mutex::new(board),
            timers: Mutex::new(BTreeMap::new()),
            history: Mutex::new(history),
        }
    }

    /// Every account's last reading.
    pub fn snapshot(&self) -> Vec<AccountUsage> {
        self.board
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    /// An account's recent readings (`agent/id`), oldest first.
    pub fn history(&self, key: &str) -> Vec<UsageSample> {
        self.history
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
            .unwrap_or_default()
    }

    fn remember(&self, key: &str, usage: &Usage, now_ms: i64) {
        let mut history = self.history.lock().unwrap_or_else(|e| e.into_inner());
        let samples = history.entry(key.to_owned()).or_default();
        samples.extend(usage.windows.iter().map(|window| UsageSample {
            at: now_ms,
            label: window.label.clone(),
            utilization: window.utilization,
        }));
        samples.retain(|sample| now_ms - sample.at <= HISTORY_MS);
        let excess = samples.len().saturating_sub(HISTORY_MAX);
        samples.drain(..excess);
    }

    fn save(&self) {
        let accounts: serde_json::Map<String, Value> = self
            .board
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|(key, usage)| Some((key.clone(), serde_json::to_value(usage).ok()?)))
            .collect();
        let mut doc = serde_json::Map::new();
        doc.insert("version".into(), Value::from(1));
        doc.insert("accounts".into(), Value::Object(accounts));
        if let Ok(history) =
            serde_json::to_value(&*self.history.lock().unwrap_or_else(|e| e.into_inner()))
        {
            doc.insert("history".into(), history);
        }
        if let Some(parent) = self.file.parent()
            && roamgate_base::private::create_private_dir(parent).is_ok()
        {
            let _ = write_private(&self.file, &doc);
        }
    }

    /// Reads every signed-in account whose time has come; forgets those no
    /// longer given. Returns what changed.
    pub async fn poll(&self, accounts: &[PolledAccount], now_ms: i64) -> UsageDelta {
        let mut delta = UsageDelta::default();
        let keys: Vec<String> = accounts
            .iter()
            .map(|account| format!("{}/{}", account.agent.id(), account.id))
            .collect();
        {
            let mut board = self.board.lock().unwrap_or_else(|e| e.into_inner());
            let gone: Vec<String> = board
                .keys()
                .filter(|key| !keys.contains(key))
                .cloned()
                .collect();
            for key in gone {
                board.remove(&key);
                self.history
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&key);
                delta.removed.push(key);
            }
            self.timers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|key, _| keys.contains(key));
        }
        for (account, key) in accounts.iter().zip(&keys) {
            let mut timer = self
                .timers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(key)
                .cloned()
                .unwrap_or_default();
            if timer.next_at > now_ms {
                continue;
            }
            let signed_in = crate::auth_state(account.agent, &account.dir) == AuthState::SignedIn;
            let interval = match account.agent {
                AccountAgent::Agy => AGY_INTERVAL_MS,
                _ => INTERVAL_MS,
            };
            let previous = self
                .board
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(key)
                .cloned();
            let mut next = previous.clone().unwrap_or(AccountUsage {
                agent: account.agent.id().into(),
                id: account.id.clone(),
                status: UsageStatus::Unknown,
                usage: None,
                read_at: None,
                error: None,
            });
            let result = if !signed_in {
                Err(ReadError::Auth)
            } else {
                match account.agent {
                    AccountAgent::Claude => {
                        let cached = timer
                            .profile
                            .clone()
                            .filter(|_| now_ms - timer.profile_at < PROFILE_TTL_MS);
                        let fresh_profile = cached.is_none();
                        read_claude(&self.http, &self.endpoints, &account.dir, cached)
                            .await
                            .map(|(usage, profile)| {
                                if fresh_profile && profile.is_some() {
                                    timer.profile = profile;
                                    timer.profile_at = now_ms;
                                }
                                usage
                            })
                    }
                    AccountAgent::Codex => {
                        read_codex(&self.http, &self.endpoints, &account.dir, now_ms).await
                    }
                    AccountAgent::Agy => read_agy(&self.agy_program, &account.dir).await,
                }
            };
            let wait = match result {
                Ok(usage) => {
                    timer.failures = 0;
                    self.remember(key, &usage, now_ms);
                    next.status = if usage.windows.is_empty() && account.agent == AccountAgent::Agy
                    {
                        UsageStatus::Unknown
                    } else {
                        UsageStatus::Fresh
                    };
                    next.usage = Some(usage);
                    next.read_at = Some(now_ms);
                    next.error = None;
                    jittered(interval)
                }
                Err(error) => {
                    timer.failures += 1;
                    let backoff = (interval << timer.failures.min(4)).min(MAX_BACKOFF_MS);
                    let (status, message, wait) = match error {
                        ReadError::Auth if !signed_in => (
                            if account.agent == AccountAgent::Agy {
                                UsageStatus::Unknown
                            } else {
                                UsageStatus::AuthExpired
                            },
                            None,
                            interval,
                        ),
                        ReadError::Auth => (UsageStatus::AuthExpired, None, interval),
                        ReadError::RateLimited(after) => (
                            UsageStatus::RateLimited,
                            None,
                            after.map_or(backoff, |seconds| {
                                (seconds as i64 * 1000).clamp(interval, MAX_BACKOFF_MS * 4)
                            }),
                        ),
                        ReadError::Failed(message) => (UsageStatus::Failed, Some(message), backoff),
                    };
                    next.status = status;
                    next.error = message;
                    jittered(wait)
                }
            };
            timer.next_at = now_ms + wait;
            self.timers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key.clone(), timer);
            if previous.as_ref() != Some(&next) {
                self.board
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key.clone(), next.clone());
                delta.accounts.push(next);
            }
        }
        if !delta.is_empty() {
            self.save();
        }
        delta
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::FakeServer;
    use serde_json::json;

    #[test]
    fn claude_windows_come_from_limits_then_the_legacy_fields() {
        let body = json!({
            "five_hour": {"utilization": 9.0, "resets_at": "old"},
            "seven_day": {"utilization": 30.0, "resets_at": "2026-12-01T00:00:00Z"},
            "limits": [
                {"kind": "session", "percent": 12.5, "resets_at": "2026-11-27T05:00:00Z"},
                {"kind": "weekly_scoped", "percent": 40.0, "scope": {"model": {"display_name": "Opus"}}},
                {"kind": "weekly_scoped", "percent": 1.0, "scope": {"surface": {"id": "code"}}},
            ],
            "extra_usage": {"is_enabled": false},
        });
        let windows = claude_windows(&body);
        let labels: Vec<_> = windows
            .iter()
            .map(|w| (w.label.as_str(), w.utilization))
            .collect();
        assert_eq!(
            labels,
            [
                ("5h", 12.5),
                ("7d", 30.0),
                ("7d opus", 40.0),
                ("7d code", 1.0)
            ]
        );
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("2026-11-27T05:00:00Z")
        );
        assert_eq!(
            claude_profile(&json!({"account": {"email": "me@x", "has_claude_max": true}})),
            (Some("Max".into()), Some("me@x".into()))
        );
    }

    #[test]
    fn codex_windows_are_placed_by_duration() {
        let body = json!({
            "plan_type": "pro",
            "rate_limit": {
                "limit_reached": true,
                "primary_window": {"used_percent": 80, "limit_window_seconds": 604800, "reset_at": 2000},
                "secondary_window": {"used_percent": 20, "limit_window_seconds": 18000, "reset_after_seconds": 60},
            },
            "rate_limit_reached_type": {"type": "primary"},
        });
        let usage = codex_usage(&body, 1_000);
        assert_eq!(usage.plan.as_deref(), Some("pro"));
        assert_eq!(usage.limit_reached.as_deref(), Some("primary"));
        assert_eq!(usage.windows[0].label, "5h");
        assert_eq!(usage.windows[0].utilization, 20.0);
        assert_eq!(
            usage.windows[0].resets_at.as_deref(),
            Some("1970-01-01T00:01:01.000Z")
        );
        assert_eq!(usage.windows[1].label, "7d");
        assert_eq!(usage.windows[1].utilization, 100.0);
    }

    #[test]
    fn agy_usage_reads_its_own_records() {
        // `agy -p "/usage"` as the official client printed it (2026-11-26).
        let usage = agy_usage(include_str!("../tests/fixtures/agy-usage.txt"));
        assert_eq!(usage.records.len(), 4);
        let windows: Vec<_> = usage
            .windows
            .iter()
            .map(|w| (w.label.as_str(), w.utilization, w.resets_at.as_deref()))
            .collect();
        assert_eq!(
            windows,
            [
                ("5h gemini models", 21.0, Some("2026-11-26T23:22:34Z")),
                ("5h claude and gpt models", 0.0, None),
                ("7d gemini models", 23.0, Some("2026-12-03T13:22:34Z")),
                ("7d claude and gpt models", 0.0, None),
            ]
        );
        assert!(agy_usage("plain line\nnote\tnothing\n").windows.is_empty());
    }

    fn claude_account(data: &Path) -> PolledAccount {
        let dir = crate::account_dir(data, AccountAgent::Claude, "work");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".credentials.json"),
            json!({"claudeAiOauth": {"accessToken": "tok", "refreshToken": "r", "expiresAt": i64::MAX}})
                .to_string(),
        )
        .unwrap();
        PolledAccount {
            agent: AccountAgent::Claude,
            id: "work".into(),
            dir,
        }
    }

    #[tokio::test]
    async fn one_poll_per_interval_its_reading_kept_across_restarts() {
        let server = FakeServer::start(vec![
            (200, json!({"limits": [{"kind": "session", "percent": 10.0}]}).to_string()),
            (200, json!({"account": {"email": "me@work"}, "organization": {"plan_display_name": "Max 20x"}}).to_string()),
            (429, "600".into()),
        ])
        .await;
        let endpoints = Endpoints {
            claude_usage: server.url("/api/oauth/usage"),
            claude_profile: server.url("/api/oauth/profile"),
            ..Endpoints::default()
        };
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let accounts = [claude_account(data)];
        let poller = UsagePoller::new(data, endpoints.clone(), "agy");
        if cfg!(target_os = "macos") {
            return;
        }
        let delta = poller.poll(&accounts, 1_000).await;
        assert_eq!(delta.accounts.len(), 1);
        let read = &delta.accounts[0];
        assert_eq!(read.status, UsageStatus::Fresh);
        let usage = read.usage.as_ref().unwrap();
        assert_eq!(usage.windows[0].utilization, 10.0);
        assert_eq!(usage.plan.as_deref(), Some("Max 20x"));
        assert_eq!(usage.email.as_deref(), Some("me@work"));
        let requests = server.requests().await;
        assert_eq!(requests[0].authorization, "Bearer tok");
        assert_eq!(requests[1].path, "/api/oauth/profile");
        // Not again before its time.
        assert!(poller.poll(&accounts, 2_000).await.is_empty());
        assert_eq!(server.requests().await.len(), 2);
        // Rate limited: the reading stays, the server's wait is kept.
        let delta = poller.poll(&accounts, 1_000 + INTERVAL_MS * 2).await;
        assert_eq!(delta.accounts[0].status, UsageStatus::RateLimited);
        assert!(delta.accounts[0].usage.is_some());
        assert!(
            poller
                .poll(&accounts, 1_000 + INTERVAL_MS * 2 + 400_000)
                .await
                .is_empty()
        );
        // A restart shows the last reading, as cached.
        let restarted = UsagePoller::new(data, endpoints, "agy");
        assert_eq!(restarted.history("claude/work")[0].utilization, 10.0);
        let snapshot = restarted.snapshot();
        assert_eq!(snapshot[0].status, UsageStatus::RateLimited);
        assert_eq!(
            snapshot[0].usage.as_ref().unwrap().windows[0].utilization,
            10.0
        );
        // An account no longer given goes.
        let delta = restarted.poll(&[], 0).await;
        assert_eq!(delta.removed, vec!["claude/work".to_owned()]);
    }

    #[tokio::test]
    async fn a_refused_sign_in_reads_as_expired() {
        let server = FakeServer::start(vec![(401, "{}".into())]).await;
        let endpoints = Endpoints {
            claude_usage: server.url("/u"),
            claude_profile: server.url("/p"),
            ..Endpoints::default()
        };
        let temp = tempfile::tempdir().unwrap();
        let accounts = [claude_account(temp.path())];
        let poller = UsagePoller::new(temp.path(), endpoints, "agy");
        let delta = poller.poll(&accounts, 0).await;
        assert_eq!(delta.accounts[0].status, UsageStatus::AuthExpired);
        if !cfg!(target_os = "macos") {
            assert_eq!(server.requests().await.len(), 1);
        }
    }

    #[tokio::test]
    async fn codex_usage_is_read_with_its_account() {
        let server = FakeServer::start(vec![(
            200,
            json!({"rate_limit": {"primary_window": {"used_percent": 5}}}).to_string(),
        )])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let dir = crate::account_dir(temp.path(), AccountAgent::Codex, "c");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("auth.json"),
            json!({"tokens": {"access_token": "at", "refresh_token": "r", "account_id": "acc"}})
                .to_string(),
        )
        .unwrap();
        let poller = UsagePoller::new(
            temp.path(),
            Endpoints {
                codex_usage: server.url("/wham/usage"),
                ..Endpoints::default()
            },
            "agy",
        );
        let accounts = [PolledAccount {
            agent: AccountAgent::Codex,
            id: "c".into(),
            dir,
        }];
        let delta = poller.poll(&accounts, 0).await;
        assert_eq!(delta.accounts[0].status, UsageStatus::Fresh);
        assert_eq!(server.requests().await[0].authorization, "Bearer at");
    }
}
