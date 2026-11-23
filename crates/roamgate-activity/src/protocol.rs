//! The activity protocol's shapes and helpers (server/src/activity/
//! protocol.ts, docs/activity.md, activity.schema.json): what the log reads
//! back as. Times are written in local time with their offset, as the Bun
//! server's `isoTime` writes them.

use jiff::Timestamp;
use jiff::tz::TimeZone;

/// The event kinds of the log.
pub const EVENT_KINDS: [&str; 6] = [
    "workspace.focus",
    "workspace.blur",
    "agent.state",
    "session.idle",
    "session.active",
    "ui.visibility",
];

/// Whether a cause is a sign of a person (`personCause`).
pub fn person_cause(cause: Option<&str>) -> bool {
    matches!(cause, Some("user_input" | "user_focus"))
}

/// Herdr's `done` (finished, not yet seen) is reported as idle (`agentState`).
pub fn agent_state(status: Option<&serde_json::Value>) -> &'static str {
    match status.and_then(|value| value.as_str()) {
        Some("working") => "working",
        Some("idle" | "done") => "idle",
        Some("blocked") => "blocked",
        _ => "unknown",
    }
}

/// Opaque, and ordered as strings the way the log is (`eventId`).
pub fn event_id(seq: i64) -> String {
    format!("{seq:016}")
}

/// The system's time zone, as the Bun server's `Date` reads it (TZ, else
/// the system's).
pub fn local_zone() -> TimeZone {
    TimeZone::system()
}

/// ISO 8601 in local time with its offset, as the protocol writes times
/// (`isoTime`): `2026-11-02T09:00:00.000-03:00`.
pub fn iso_time(ms: i64) -> String {
    iso_time_in(ms, &local_zone())
}

/// [`iso_time`] in a given zone.
pub fn iso_time_in(ms: i64, zone: &TimeZone) -> String {
    let Ok(timestamp) = Timestamp::from_millisecond(ms) else {
        return String::from("Invalid Date");
    };
    let zoned = timestamp.to_zoned(zone.clone());
    // JavaScript's getTimezoneOffset: whole minutes.
    let offset = zoned.offset().seconds() / 60;
    let sign = if offset >= 0 { '+' } else { '-' };
    let abs = offset.abs();
    let date = zoned.datetime();
    format!(
        "{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{}{:02}:{:02}",
        date.year(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.subsec_nanosecond() / 1_000_000,
        sign,
        abs / 60,
        abs % 60
    )
}

/// `Date.parse` of a time this module wrote (or any RFC 3339 time), as
/// epoch milliseconds.
pub fn parse_time(text: &str) -> Option<i64> {
    text.parse::<Timestamp>()
        .ok()
        .map(|timestamp| timestamp.as_millisecond())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_carry_their_offset_and_milliseconds() {
        let zone = TimeZone::get("America/Sao_Paulo").unwrap();
        assert_eq!(
            iso_time_in(1_762_084_800_123, &zone),
            "2025-11-02T09:00:00.123-03:00"
        );
        assert_eq!(
            iso_time_in(0, &TimeZone::UTC),
            "1970-01-01T00:00:00.000+00:00"
        );
        let india = TimeZone::get("Asia/Kolkata").unwrap();
        assert_eq!(iso_time_in(0, &india), "1970-01-01T05:30:00.000+05:30");
        assert_eq!(parse_time("1970-01-01T05:30:00.000+05:30"), Some(0));
        assert_eq!(event_id(42), "0000000000000042");
        assert_eq!(agent_state(Some(&serde_json::json!("done"))), "idle");
        assert_eq!(agent_state(None), "unknown");
    }
}
