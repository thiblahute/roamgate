//! Ranger task schedules (`assistant/task-schedule.ts`): validation and the
//! next run time, held to `contract/vectors/task-schedule.json`.
//!
//! A daily time is a wall-clock time in an IANA zone: a time a clock change
//! skips does not fire that day, and a time it repeats fires at its first
//! occurrence only.

use std::sync::LazyLock;

use jiff::civil::{Date, DateTime, Time};
use jiff::tz::{AmbiguousOffset, TimeZone};
use regex::Regex;
use roamgate_agents::js;
use serde_json::{Map, Value, json};

use crate::errors::AssistantError;

/// The largest instant JavaScript dates hold, either side of the epoch.
const MAX_INSTANT: f64 = 8.64e15;
const MINUTE: f64 = 60_000.0;

/// `validateTaskSchedule`: the exact shapes, a `once` time normalised to
/// millisecond precision.
pub fn validate_task_schedule(value: &Value) -> Result<Value, AssistantError> {
    let Some(map) = value.as_object() else {
        return Err(AssistantError::user("Invalid task schedule"));
    };
    let keys: &[&str] = match map.get("type").and_then(Value::as_str) {
        Some("once") => &["type", "at"],
        Some("interval") => &["type", "minutes"],
        Some("daily") => &["type", "time", "timezone"],
        _ => &[],
    };
    if keys.is_empty() || map.len() != keys.len() || !keys.iter().all(|key| map.contains_key(*key))
    {
        return Err(AssistantError::user("Invalid task schedule fields"));
    }
    match map["type"].as_str() {
        Some("once") => validate_once(map),
        Some("interval") => {
            let minutes = map["minutes"]
                .as_f64()
                .filter(|m| m.is_finite() && m.fract() == 0.0 && (1.0..=525_600.0).contains(m));
            match minutes {
                Some(minutes) => Ok(json!({"type": "interval", "minutes": js::number(minutes)})),
                None => Err(AssistantError::user(
                    "Task interval must be 1 to 525600 whole minutes",
                )),
            }
        }
        _ => {
            static TIME: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^(?:[01]\d|2[0-3]):[0-5]\d$").unwrap());
            let time = map["time"].as_str().filter(|t| TIME.is_match(t));
            let zone = map["timezone"]
                .as_str()
                .filter(|z| !z.is_empty() && !z.starts_with(['+', '-']));
            let (Some(time), Some(zone)) = (time, zone) else {
                return Err(AssistantError::user(
                    "Daily tasks require HH:mm and an IANA timezone",
                ));
            };
            if TimeZone::get(zone).is_err() {
                return Err(AssistantError::user("Invalid task timezone"));
            }
            Ok(json!({"type": "daily", "time": time, "timezone": zone}))
        }
    }
}

fn validate_once(map: &Map<String, Value>) -> Result<Value, AssistantError> {
    static AT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$").unwrap()
    });
    if let Some(at) = map["at"].as_str()
        && let Some(caps) = AT.captures(at)
    {
        let millis = caps.get(4).map_or("", |m| m.as_str());
        let canonical = format!("{}T{}:{}.{:0<3}Z", &caps[1], &caps[2], &caps[3], millis);
        let instant = js::date_parse(at);
        // Date.parse normalises invalid dates such as February 30: refuse them.
        if instant.is_finite() && js::try_iso(instant).as_deref() == Some(canonical.as_str()) {
            return Ok(json!({"type": "once", "at": canonical}));
        }
    }
    Err(AssistantError::user(
        "Task time must be a valid UTC ISO timestamp",
    ))
}

/// The zone a daily schedule names, as `Intl` resolves it (`scheduleKey`):
/// UTC and GMT under any of their names are `UTC`.
pub fn resolved_timezone(zone: &str) -> Option<String> {
    const UTC: [&str; 18] = [
        "utc",
        "etc/utc",
        "etc/uct",
        "uct",
        "universal",
        "etc/universal",
        "zulu",
        "etc/zulu",
        "gmt",
        "etc/gmt",
        "etc/gmt+0",
        "etc/gmt-0",
        "etc/gmt0",
        "gmt0",
        "gmt+0",
        "gmt-0",
        "greenwich",
        "etc/greenwich",
    ];
    let tz = TimeZone::get(zone).ok()?;
    if UTC.contains(&zone.to_ascii_lowercase().as_str()) {
        return Some("UTC".to_owned());
    }
    Some(tz.iana_name().unwrap_or(zone).to_owned())
}

/// `nextTaskTime(schedule, after)`: the next run strictly after `after`
/// (ms since the epoch), or None for a `once` already past.
pub fn next_task_time(schedule: &Value, after: f64) -> Result<Option<f64>, AssistantError> {
    if !after.is_finite() || after.abs() > MAX_INSTANT {
        return Err(AssistantError::internal(
            "Invalid task schedule reference time",
        ));
    }
    match schedule.get("type").and_then(Value::as_str) {
        Some("once") => {
            let instant = js::date_parse(schedule.get("at").and_then(Value::as_str).unwrap_or(""));
            Ok((instant > after).then_some(instant))
        }
        Some("interval") => {
            let minutes = schedule
                .get("minutes")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN);
            Ok(Some(after + minutes * MINUTE))
        }
        _ => Ok(next_daily(schedule, after)),
    }
}

fn next_daily(schedule: &Value, after: f64) -> Option<f64> {
    let zone = schedule.get("timezone").and_then(Value::as_str)?;
    let tz = TimeZone::get(zone).ok()?;
    let (hour, minute) = schedule
        .get("time")
        .and_then(Value::as_str)
        .and_then(|time| time.split_once(':'))
        .and_then(|(h, m)| Some((h.parse::<i8>().ok()?, m.parse::<i8>().ok()?)))?;
    let at = Time::new(hour, minute, 0, 0).ok()?;
    let start = jiff::Timestamp::from_millisecond(after.floor() as i64).ok()?;
    let mut day: Date = start.to_zoned(tz.clone()).date();
    // Probe days, not every minute; the bound also ends impossible dates.
    for _ in 0..370 {
        let wall = DateTime::from_parts(day, at);
        let earliest = match tz.to_ambiguous_timestamp(wall).offset() {
            AmbiguousOffset::Unambiguous { offset } => Some(offset),
            // A gap has no such time that day.
            AmbiguousOffset::Gap { .. } => None,
            // A fold fires at its first occurrence only, even when `after`
            // lies between the two.
            AmbiguousOffset::Fold { before, .. } => Some(before),
        };
        if let Some(offset) = earliest
            && let Ok(instant) = offset.to_timestamp(wall)
        {
            let ms = instant.as_millisecond() as f64;
            if ms > after {
                return Some(ms);
            }
        }
        day = day.tomorrow().ok()?;
    }
    None
}

#[cfg(test)]
mod tests {
    use roamgate_protocol::vectors::{self, Call};

    use super::*;

    fn number_arg(value: &Value) -> f64 {
        if let Some(("$num", Value::String(name))) = vectors::tag(value) {
            return match name.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ => -0.0,
            };
        }
        value.as_f64().unwrap_or(f64::NAN)
    }

    fn decode(value: &Value) -> Value {
        if let Some(("$num", _)) = vectors::tag(value) {
            return json!(number_arg(value).to_string());
        }
        match value {
            Value::Object(map) => {
                Value::Object(map.iter().map(|(k, v)| (k.clone(), decode(v))).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(decode).collect()),
            other => other.clone(),
        }
    }

    fn run(call: &Call) -> Result<Value, String> {
        match call.target().as_str() {
            "task-schedule.validateTaskSchedule" => {
                validate_task_schedule(&js::js_value(decode(&call.args[0])))
                    .map_err(|error| error.to_string())
            }
            "task-schedule.nextTaskTime" => next_task_time(
                &js::js_value(call.args[0].clone()),
                number_arg(&call.args[1]),
            )
            .map(|next| next.map_or(Value::Null, js::number))
            .map_err(|error| error.to_string()),
            other => panic!("task-schedule.json names {other}, unknown here"),
        }
    }

    /// Every case of `contract/vectors/task-schedule.json`; the ledger's
    /// rows of task-schedule.test.ts name the vector file.
    #[test]
    fn task_schedule_vectors() {
        let file = vectors::load("task-schedule");
        let mut failures = Vec::new();
        for case in &file.cases {
            for (index, call) in case.calls.iter().enumerate() {
                let got = run(call);
                let ok = match (&got, &call.throws) {
                    (Err(message), Some(want)) => message == want,
                    (Ok(value), None) => value == call.result.as_ref().unwrap_or(&Value::Null),
                    _ => false,
                };
                if !ok {
                    failures.push(format!(
                        "{} #{index}: got {got:?}, want {:?} / {:?}",
                        case.title(),
                        call.result,
                        call.throws
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
