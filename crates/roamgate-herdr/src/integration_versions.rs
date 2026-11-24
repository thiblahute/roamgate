//! The versions of Herdr's agent integrations (herdr/integration-versions.ts):
//! an `integration.list` answer missing an installed or available version
//! is supplemented from the connection's own host's Herdr CLI
//! (`herdr integration status`), only when that CLI is the Herdr the
//! connection talks to. Anything failing keeps Herdr's list.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;

use serde_json::{Map, Value};

/// How long each CLI run may take.
pub const CLI_TIMEOUT_MS: u64 = 5_000;
const MAX_STATUS_LENGTH: usize = 64 * 1024;

/// The command an SSH host runs: its herdr, from PATH or ~/.local/bin.
pub const SSH_STATUS_COMMAND: &str = "if command -v herdr >/dev/null 2>&1; then bin=herdr; else bin=\"$HOME/.local/bin/herdr\"; fi; \"$bin\" --version && \"$bin\" integration status";

/// A CLI run: on the SSH host (`bash -lc <SSH_STATUS_COMMAND>`, quoted by
/// the runner's shell), or an argv on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliRun {
    Ssh,
    Local(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Version {
    outdated: bool,
    installed: f64,
    available: Option<f64>,
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn number(digits: &str) -> Option<f64> {
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    (value <= MAX_SAFE_INTEGER).then_some(value)
}

/// `(digits)` then the rest after `close`, for `v(\d+)` patterns.
fn digits_then<'a>(text: &'a str, close: &str) -> Option<(&'a str, &'a str)> {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let (digits, rest) = text.split_at(end);
    Some((digits, rest.strip_prefix(close)?))
}

/// `name: current (vN)` or `name: outdated (vN < vM)`, with an optional
/// ` (...)` after: None for anything else.
fn parse_line(rest: &str) -> Option<Version> {
    let (installed, available, tail) = if let Some(after) = rest.strip_prefix("current (v") {
        let (installed, tail) = digits_then(after, ")")?;
        (installed, None, tail)
    } else {
        let after = rest.strip_prefix("outdated (v")?;
        let (installed, after) = digits_then(after, " < v")?;
        let (available, tail) = digits_then(after, ")")?;
        (installed, Some(available), tail)
    };
    if !tail.is_empty() {
        let inner = tail.strip_prefix(" (")?.strip_suffix(')')?;
        if inner.contains(['\r', '\n']) {
            return None;
        }
    }
    let installed = number(installed)?;
    let available = match available {
        Some(available) => Some(number(available)?),
        None => None,
    };
    if available.is_some_and(|available| installed >= available) {
        return None;
    }
    Some(Version {
        outdated: available.is_some(),
        installed,
        available,
    })
}

/// The target a line is about (`^([a-z][a-z0-9_-]*): `), dashes as
/// underscores, and the rest of the line.
fn target_of(line: &str) -> Option<(String, &str)> {
    let (name, rest) = line.split_once(": ")?;
    let mut chars = name.chars();
    let first = chars.next()?;
    if !first.is_ascii_lowercase()
        || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return None;
    }
    Some((name.replace('-', "_"), rest))
}

fn parse_integration_versions(stdout: &str) -> HashMap<String, Version> {
    let mut versions = HashMap::new();
    let mut seen = HashSet::new();
    for line in stdout.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some((target, rest)) = target_of(line) else {
            continue;
        };
        if !seen.insert(target.clone()) {
            versions.remove(&target);
            continue;
        }
        if let Some(version) = parse_line(rest) {
            versions.insert(target, version);
        }
    }
    versions
}

fn needs_versions(item: &Map<String, Value>) -> bool {
    if !item.get("target").is_some_and(Value::is_string) {
        return false;
    }
    match item.get("state").and_then(Value::as_str) {
        Some("current") => !item.contains_key("installed_version"),
        Some("outdated") => {
            !item.contains_key("installed_version") || !item.contains_key("available_version")
        }
        _ => false,
    }
}

fn js_number(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(|number| {
            if value.fract() == 0.0 {
                Value::from(value as i64)
            } else {
                Value::Number(number)
            }
        })
        .unwrap_or(Value::Null)
}

/// JavaScript's `!==` of a JSON value and a number.
fn differs(value: &Value, number: f64) -> bool {
    value.as_f64() != Some(number)
}

fn merged(item: &Map<String, Value>, versions: &HashMap<String, Version>) -> Value {
    if !needs_versions(item) {
        return Value::Object(item.clone());
    }
    let target = item["target"].as_str().unwrap_or("").replace('-', "_");
    let Some(cli) = versions.get(&target) else {
        return Value::Object(item.clone());
    };
    let state = item.get("state").and_then(Value::as_str);
    let cli_state = if cli.outdated { "outdated" } else { "current" };
    if state != Some(cli_state)
        || item
            .get("installed_version")
            .is_some_and(|installed| differs(installed, cli.installed))
        || match (item.get("available_version"), cli.available) {
            (Some(available), Some(cli)) => differs(available, cli),
            _ => false,
        }
    {
        return Value::Object(item.clone());
    }
    let mut out = item.clone();
    if out.get("installed_version").is_none_or(Value::is_null) {
        out.insert("installed_version".into(), js_number(cli.installed));
    }
    if !item.contains_key("available_version")
        && let Some(available) = cli.available
    {
        out.insert("available_version".into(), js_number(available));
    }
    Value::Object(out)
}

/// `enrichIntegrationVersions`: `result` with the versions the host's CLI
/// gives. `version` is Herdr's (its ping), asked only when a version is
/// missing; `binary` finds this machine's herdr; `run` runs a CLI and
/// answers `(code, stdout)`.
pub async fn enrich_integration_versions<P, B, R, Fut>(
    result: Value,
    ssh: bool,
    version: P,
    binary: B,
    run: R,
) -> Value
where
    P: Future<Output = Result<Value, String>>,
    B: FnOnce() -> Option<PathBuf>,
    R: Fn(CliRun) -> Fut,
    Fut: Future<Output = Result<(i32, String), String>>,
{
    let Some(items) = result.get("integrations").and_then(Value::as_array) else {
        return result;
    };
    let Some(items) = items
        .iter()
        .map(Value::as_object)
        .collect::<Option<Vec<&Map<String, Value>>>>()
    else {
        return result;
    };
    if !items.iter().any(|item| needs_versions(item)) {
        return result;
    }
    let Ok(ping) = version.await else {
        return result;
    };
    let Some(version) = ping
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| !version.is_empty())
    else {
        return result;
    };
    let expected = format!("herdr {version}");
    let utf16 = |text: &str| text.encode_utf16().count();
    let stdout = if ssh {
        let Ok((code, stdout)) = run(CliRun::Ssh).await else {
            return result;
        };
        if code != 0 || utf16(&stdout) > MAX_STATUS_LENGTH {
            return result;
        }
        let Some((first, rest)) = stdout.split_once('\n') else {
            return result;
        };
        if first.trim() != expected {
            return result;
        }
        rest.to_owned()
    } else {
        let Some(binary) = binary() else {
            return result;
        };
        let binary = binary.to_string_lossy().into_owned();
        let Ok((code, cli)) = run(CliRun::Local(vec![binary.clone(), "--version".into()])).await
        else {
            return result;
        };
        if code != 0 || cli.trim() != expected {
            return result;
        }
        let Ok((code, stdout)) = run(CliRun::Local(vec![
            binary,
            "integration".into(),
            "status".into(),
        ]))
        .await
        else {
            return result;
        };
        if code != 0 || utf16(&stdout) > MAX_STATUS_LENGTH {
            return result;
        }
        stdout
    };
    let versions = parse_integration_versions(&stdout);
    let integrations: Vec<Value> = items.iter().map(|item| merged(item, &versions)).collect();
    let mut out = result.as_object().cloned().unwrap_or_default();
    out.insert("integrations".into(), Value::Array(integrations));
    Value::Object(out)
}
