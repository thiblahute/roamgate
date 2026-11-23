//! The forge gate (workspace/forge-calls.ts): every glab and gh call goes
//! through it, per checkout host and forge host: at most
//! [`FORGE_CALLS_PER_MINUTE`] started in any minute and
//! [`FORGE_CONCURRENCY`] at once, the rest queued in order until their
//! deadline; a 429, a Retry-After or an exhausted RateLimit-Remaining
//! pauses the host; GETs asked `conditional` come back with If-None-Match
//! and a 304 answers with what was known; identical calls asked with
//! `reuse_ms` share one in flight and its answer for that long.
//!
//! Scopes are named by their owner (a process runner in Bun, which keys a
//! `WeakMap` by the runner function): one budget per owner, checkout host
//! and forge host, as in Bun.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_base::clock::{BoxFuture, SharedClock};
use tokio::sync::Notify;

pub const FORGE_CALLS_PER_MINUTE: usize = 60;
pub const FORGE_CONCURRENCY: usize = 4;
pub const FORGE_BACKOFF_MS: i64 = 60_000;
const MAX_BACKOFF_MS: i64 = 60 * 60_000;
const WINDOW_MS: i64 = 60_000;
const ETAGS_KEPT: usize = 300;
const ETAG_BODY_MAX: usize = 1_000_000;
const REUSE_KEPT: usize = 300;

/// A process's exit code and output.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProcessOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// What a forge call gives: the process's output, the HTTP status when the
/// gate asked for the headers, and whether a 304 answered from the ETag
/// cache.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ForgeOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub status: Option<u16>,
    pub not_modified: bool,
}

/// One forge call.
#[derive(Debug, Clone, Default)]
pub struct ForgeCall {
    /// The host the CLI runs on ("" or None: this machine).
    pub checkout: Option<String>,
    /// The forge host.
    pub host: String,
    pub feature: String,
    pub kind: String,
    /// Epoch ms after which a call still queued gives up.
    pub deadline: Option<i64>,
    /// Ask for the response headers (status, rate limits).
    pub include: bool,
    /// A GET that may come back 304.
    pub conditional: bool,
    /// Share the answer of an identical call this long.
    pub reuse_ms: Option<i64>,
}

/// The call could not start before its deadline.
pub const BUSY_MESSAGE: &str = "the forge is busy or rate limited; try later";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateError {
    /// Queued past its deadline.
    Busy,
    /// The process could not run.
    Spawn(String),
}

impl std::fmt::Display for GateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GateError::Busy => f.write_str(BUSY_MESSAGE),
            GateError::Spawn(message) => f.write_str(message),
        }
    }
}

/// The headers `--include` put in front of the body: the last response's
/// status and headers (lower-case names), and the body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Included {
    pub status: Option<u16>,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn status_line(text: &str) -> Option<u16> {
    let rest = text.strip_prefix("HTTP/")?;
    let version_end = rest.find(' ')?;
    if !rest[..version_end]
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.')
        || version_end == 0
    {
        return None;
    }
    let code = rest[version_end + 1..].get(..3)?;
    code.chars()
        .all(|c| c.is_ascii_digit())
        .then(|| code.parse().ok())
        .flatten()
}

/// Splits `--include` output (forge-calls.ts `splitIncluded`).
pub fn split_included(stdout: &str) -> Included {
    let mut headers = HashMap::new();
    let mut rest = stdout;
    let mut status = None;
    while let Some(code) = status_line(rest) {
        let end = [
            rest.find("\r\n\r\n"),
            rest.find("\n\n"),
            rest.find("\r\n\n"),
            rest.find("\n\r\n"),
        ]
        .into_iter()
        .flatten()
        .min();
        let (block, after) = match end {
            Some(at) => {
                let tail = &rest[at..];
                let sep = ["\r\n\r\n", "\r\n\n", "\n\r\n", "\n\n"]
                    .into_iter()
                    .find(|sep| tail.starts_with(sep))
                    .map(str::len)
                    .unwrap_or(2);
                (&rest[..at], &rest[at + sep..])
            }
            None => (rest, ""),
        };
        rest = after;
        status = Some(code);
        headers.clear();
        for line in block.split('\n').skip(1) {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(colon) = line.find(':')
                && colon > 0
            {
                headers.insert(
                    line[..colon].trim().to_ascii_lowercase(),
                    line[colon + 1..].trim().to_owned(),
                );
            }
        }
    }
    Included {
        status,
        headers,
        body: rest.to_owned(),
    }
}

fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// An HTTP date (IMF-fixdate, `Mon, 02 Nov 2026 19:00:10 GMT`) in epoch ms.
pub fn parse_http_date(text: &str) -> Option<i64> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    let [_, day, month, year, time, zone] = parts.as_slice() else {
        return None;
    };
    if *zone != "GMT" && *zone != "UTC" {
        return None;
    }
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| m.eq_ignore_ascii_case(month))? as i64
        + 1;
    let (day, year): (i64, i64) = (day.parse().ok()?, year.parse().ok()?);
    let hms: Vec<i64> = time
        .split(':')
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    let [h, m, s] = hms.as_slice() else {
        return None;
    };
    // days_from_civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + m) * 60_000 + s * 1000)
}

/// Until when (epoch ms) a response asks the host to be left alone, None
/// when it does not (forge-calls.ts `rateLimitPause`); at most an hour.
pub fn rate_limit_pause(
    status: Option<u16>,
    headers: &HashMap<String, String>,
    now: i64,
) -> Option<i64> {
    let reset_at = || {
        let reset = headers
            .get("ratelimit-reset")
            .or_else(|| headers.get("x-ratelimit-reset"))
            .and_then(|v| js_number(v))?;
        if reset <= 0.0 {
            return None;
        }
        Some(if reset > 1e9 {
            (reset * 1000.0) as i64
        } else {
            now + (reset * 1000.0) as i64
        })
    };
    let retry_after = || {
        let value = headers.get("retry-after")?;
        if let Some(seconds) = js_number(value) {
            return Some(now + (seconds.max(0.0) * 1000.0) as i64);
        }
        parse_http_date(value)
    };
    let until = if matches!(status, Some(429 | 503)) {
        Some(
            retry_after()
                .or_else(reset_at)
                .unwrap_or(now + FORGE_BACKOFF_MS),
        )
    } else {
        let remaining = headers
            .get("ratelimit-remaining")
            .or_else(|| headers.get("x-ratelimit-remaining"));
        if headers.contains_key("retry-after") && status.is_some_and(|s| s >= 400) {
            retry_after()
        } else if remaining.is_some_and(|r| js_number(r).is_some_and(|n| n <= 0.0)) {
            Some(reset_at().unwrap_or(now + FORGE_BACKOFF_MS))
        } else {
            None
        }
    };
    until
        .filter(|until| *until > now)
        .map(|until| until.min(now + MAX_BACKOFF_MS))
}

fn with_api_flags(argv: &[String], flags: &[String]) -> Vec<String> {
    match argv.iter().position(|a| a == "api") {
        Some(at) if !flags.is_empty() => argv[..=at]
            .iter()
            .chain(flags)
            .chain(&argv[at + 1..])
            .cloned()
            .collect(),
        _ => argv.to_vec(),
    }
}

/// The argv without the flags the gate added (for a caller that shows it).
pub fn without_gate_flags(argv: &[String]) -> Vec<String> {
    let mut plain = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "--include" {
            i += 1;
            continue;
        }
        if argv[i] == "--header"
            && argv
                .get(i + 1)
                .is_some_and(|h| h.starts_with("If-None-Match:"))
        {
            i += 2;
            continue;
        }
        plain.push(argv[i].clone());
        i += 1;
    }
    plain
}

#[derive(Default)]
struct HostState {
    starts: VecDeque<i64>,
    active: usize,
    blocked_until: i64,
    queue: VecDeque<u64>,
}

type Flight = Shared<BoxFuture<Result<ForgeOutput, GateError>>>;

#[derive(Default)]
struct Scope {
    hosts: HashMap<String, Arc<(Mutex<HostState>, Notify)>>,
    /// key -> (etag, body), oldest first.
    etags: VecDeque<(String, String, String)>,
    /// key -> (answered at, None while in flight; output)
    reused: VecDeque<(String, Option<i64>, Flight)>,
}

/// Runs a call's process.
pub type Spawn = Arc<dyn Fn(Vec<String>) -> BoxFuture<Result<ProcessOutput, String>> + Send + Sync>;

struct Inner {
    clock: SharedClock,
    per_minute: usize,
    concurrency: usize,
    scopes: Mutex<HashMap<String, Scope>>,
    next_waiter: Mutex<u64>,
}

/// The gate.
#[derive(Clone)]
pub struct ForgeGate {
    inner: Arc<Inner>,
}

impl ForgeGate {
    pub fn new(clock: SharedClock) -> Self {
        Self::with_limits(clock, FORGE_CALLS_PER_MINUTE, FORGE_CONCURRENCY)
    }

    pub fn with_limits(clock: SharedClock, per_minute: usize, concurrency: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                clock,
                per_minute,
                concurrency,
                scopes: Mutex::default(),
                next_waiter: Mutex::new(0),
            }),
        }
    }

    fn host(&self, owner: &str, key: &str) -> Arc<(Mutex<HostState>, Notify)> {
        let mut scopes = self.inner.scopes.lock().unwrap();
        scopes
            .entry(owner.to_owned())
            .or_default()
            .hosts
            .entry(key.to_owned())
            .or_default()
            .clone()
    }

    /// Until when (epoch ms) the forge host asked this owner's checkout
    /// host to be left alone; 0: it did not.
    pub fn paused_until(&self, owner: &str, checkout: &str, host: &str) -> i64 {
        let scopes = self.inner.scopes.lock().unwrap();
        scopes
            .get(owner)
            .and_then(|scope| scope.hosts.get(&format!("{checkout}\n{host}")))
            .map(|state| state.0.lock().unwrap().blocked_until)
            .unwrap_or(0)
    }

    async fn acquire(
        &self,
        state: &(Mutex<HostState>, Notify),
        deadline: Option<i64>,
    ) -> Result<(), GateError> {
        let id = {
            let mut next = self.inner.next_waiter.lock().unwrap();
            *next += 1;
            *next
        };
        state.0.lock().unwrap().queue.push_back(id);
        loop {
            let notified = state.1.notified();
            let at = self.inner.clock.now();
            let wait = {
                let mut host = state.0.lock().unwrap();
                if deadline.is_some_and(|deadline| deadline <= at) {
                    host.queue.retain(|w| *w != id);
                    drop(host);
                    state.1.notify_waiters();
                    return Err(GateError::Busy);
                }
                while host.starts.front().is_some_and(|s| *s <= at - WINDOW_MS) {
                    host.starts.pop_front();
                }
                if host.queue.front() != Some(&id) || host.active >= self.inner.concurrency {
                    None
                } else {
                    let wait = (host.blocked_until - at).max(
                        if host.starts.len() >= self.inner.per_minute {
                            host.starts[0] + WINDOW_MS - at
                        } else {
                            0
                        },
                    );
                    if wait <= 0 {
                        host.queue.pop_front();
                        host.starts.push_back(at);
                        host.active += 1;
                        drop(host);
                        state.1.notify_waiters();
                        return Ok(());
                    }
                    Some(wait)
                }
            };
            let until = match (wait, deadline) {
                (Some(wait), Some(deadline)) => Some((at + wait).min(deadline)),
                (Some(wait), None) => Some(at + wait),
                (None, deadline) => deadline,
            };
            match until {
                Some(until) => {
                    tokio::select! {
                        _ = notified => {}
                        _ = self.inner.clock.sleep_until(until.max(at + 1)) => {}
                    }
                }
                None => notified.await,
            }
        }
    }

    async fn perform(
        &self,
        owner: String,
        call: ForgeCall,
        argv: Vec<String>,
        spawn: Spawn,
        key: String,
    ) -> Result<ForgeOutput, GateError> {
        let checkout = call.checkout.clone().unwrap_or_default();
        let state = self.host(&owner, &format!("{checkout}\n{}", call.host));
        let queued_at = self.inner.clock.now();
        self.acquire(&state, call.deadline).await?;
        let started_at = self.inner.clock.now();
        let known = if call.conditional {
            let scopes = self.inner.scopes.lock().unwrap();
            scopes
                .get(&owner)
                .and_then(|s| s.etags.iter().find(|(k, _, _)| *k == key))
                .map(|(_, etag, body)| (etag.clone(), body.clone()))
        } else {
            None
        };
        let mut flags = Vec::new();
        if call.include || call.conditional {
            flags.push("--include".to_owned());
        }
        if let Some((etag, _)) = &known {
            flags.push("--header".to_owned());
            flags.push(format!("If-None-Match: {etag}"));
        }
        let result = spawn(with_api_flags(&argv, &flags)).await;
        {
            let mut host = state.0.lock().unwrap();
            host.active -= 1;
        }
        state.1.notify_waiters();
        let output = match result {
            Ok(output) => output,
            Err(error) => {
                tracing::debug!(scope = "forge", feature = %call.feature, kind = %call.kind, host = %call.host,
                    checkout = if checkout.is_empty() { "local" } else { checkout.as_str() }, code = "spawn-error",
                    waited_ms = started_at - queued_at, ms = self.inner.clock.now() - started_at, "forge call");
                return Err(GateError::Spawn(error));
            }
        };
        let mut out = ForgeOutput {
            code: output.code,
            stdout: output.stdout,
            stderr: output.stderr,
            status: None,
            not_modified: false,
        };
        if !flags.is_empty() {
            let split = split_included(&out.stdout);
            out.stdout = split.body.clone();
            out.status = split.status;
            if let Some(pause) =
                rate_limit_pause(split.status, &split.headers, self.inner.clock.now())
            {
                let mut host = state.0.lock().unwrap();
                host.blocked_until = host.blocked_until.max(pause);
            }
            let mut scopes = self.inner.scopes.lock().unwrap();
            let scope = scopes.entry(owner.clone()).or_default();
            if split.status == Some(304)
                && let Some((etag, body)) = known
            {
                scope.etags.retain(|(k, _, _)| *k != key);
                scope.etags.push_back((key.clone(), etag, body.clone()));
                out = ForgeOutput {
                    code: 0,
                    stdout: body,
                    stderr: String::new(),
                    status: Some(304),
                    not_modified: true,
                };
            } else if call.conditional
                && out.code == 0
                && split.status.is_some_and(|s| (200..300).contains(&s))
            {
                scope.etags.retain(|(k, _, _)| *k != key);
                if let Some(etag) = split.headers.get("etag")
                    && split.body.len() <= ETAG_BODY_MAX
                {
                    scope
                        .etags
                        .push_back((key.clone(), etag.clone(), split.body));
                    if scope.etags.len() > ETAGS_KEPT {
                        scope.etags.pop_front();
                    }
                }
            }
        } else if out.stderr.contains("HTTP 429") {
            let mut host = state.0.lock().unwrap();
            host.blocked_until = host
                .blocked_until
                .max(self.inner.clock.now() + FORGE_BACKOFF_MS);
            out.status = Some(429);
        }
        tracing::debug!(scope = "forge", feature = %call.feature, kind = %call.kind, host = %call.host,
            checkout = if checkout.is_empty() { "local" } else { checkout.as_str() }, code = out.code,
            status = out.status, not_modified = out.not_modified,
            waited_ms = started_at - queued_at, ms = self.inner.clock.now() - started_at, "forge call");
        Ok(out)
    }

    /// Runs a call through the gate.
    pub fn run(
        &self,
        owner: &str,
        call: ForgeCall,
        argv: Vec<String>,
        spawn: Spawn,
    ) -> BoxFuture<Result<ForgeOutput, GateError>> {
        let key = format!(
            "{}\n{}\n{}",
            call.checkout.clone().unwrap_or_default(),
            call.host,
            argv.join("\0")
        );
        let Some(reuse_ms) = call.reuse_ms else {
            let gate = self.clone();
            let owner = owner.to_owned();
            return Box::pin(async move { gate.perform(owner, call, argv, spawn, key).await });
        };
        let now = self.inner.clock.now();
        let mut scopes = self.inner.scopes.lock().unwrap();
        let scope = scopes.entry(owner.to_owned()).or_default();
        if let Some((_, at, flight)) = scope.reused.iter().find(|(k, _, _)| *k == key)
            && at.is_none_or(|at| now - at < reuse_ms)
        {
            let flight = flight.clone();
            return Box::pin(flight);
        }
        let gate = self.clone();
        let task: BoxFuture<Result<ForgeOutput, GateError>> = {
            let owner = owner.to_owned();
            let key = key.clone();
            Box::pin(async move { gate.perform(owner, call, argv, spawn, key).await })
        };
        let flight = task.shared();
        scope.reused.retain(|(k, _, _)| *k != key);
        scope.reused.push_back((key.clone(), None, flight.clone()));
        while scope.reused.len() > REUSE_KEPT {
            match scope.reused.iter().position(|(_, at, _)| at.is_some()) {
                Some(at) => {
                    scope.reused.remove(at);
                }
                None => break,
            }
        }
        drop(scopes);
        let gate = self.clone();
        let owner = owner.to_owned();
        let watched = flight.clone();
        Box::pin(async move {
            let result = watched.await;
            let mut scopes = gate.inner.scopes.lock().unwrap();
            if let Some(scope) = scopes.get_mut(&owner)
                && let Some(at) = scope
                    .reused
                    .iter()
                    .position(|(k, at, _)| *k == key && at.is_none())
            {
                if matches!(&result, Ok(output) if output.code == 0) {
                    scope.reused[at].1 = Some(gate.inner.clock.now());
                } else {
                    scope.reused.remove(at);
                }
            }
            result
        })
    }
}

#[cfg(test)]
mod tests;
