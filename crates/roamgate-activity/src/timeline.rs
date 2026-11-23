//! The activity timeline (server/src/activity/timeline.ts, docs/
//! activity.md#timeline): the log's rows for a range turned into spans per
//! local day. Pure: the rows come from the reader, the clock and the day
//! start from the caller. Days are local days (the system's zone, as the
//! Bun server's `Date`), DST-correct through jiff: a day start that falls
//! in a gap moves forward, one in a fold takes the earlier offset, as
//! JavaScript's `new Date(y, m, d, h, m)` does.

use std::collections::{HashMap, HashSet};

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde_json::{Map, Value, json};

use crate::collate::locale_compare;
use crate::protocol::{iso_time, local_zone, person_cause};
use crate::store::SessionRow;

/// A recorder whose last alive stamp is older than this is not running.
pub const RECORDER_STALE_MS: i64 = 150_000;

/// `idle_seconds`' default: how long a sign of a person lasts.
pub const DEFAULT_IDLE_MS: i64 = 300_000;

/// The longest range one timeline request may cover.
pub const TIMELINE_MAX_DAYS: usize = 92;

/// A focus event and the blur that ended it, if any.
#[derive(Debug, Clone, Default)]
pub struct FocusRow {
    pub seq: i64,
    pub start: i64,
    pub end: Option<i64>,
    pub reason: Option<String>,
    pub connection_id: String,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub source: String,
    pub client_id: Option<String>,
    pub client_kind: Option<String>,
    pub session: i64,
    /// What opened it; None on rows older than causes.
    pub cause: Option<String>,
    /// What ended it, on a switch or hidden blur.
    pub end_cause: Option<String>,
}

/// session.idle, session.active and ui.visibility, per client.
#[derive(Debug, Clone, Default)]
pub struct PresenceRow {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub connection_id: String,
    pub client_id: String,
    pub client_kind: String,
    pub visible: Option<bool>,
    pub session: i64,
    pub cause: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AgentRow {
    pub seq: i64,
    pub ts: i64,
    pub connection_id: String,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub name: String,
    pub state: String,
    pub task: Option<String>,
    pub session: i64,
}

#[derive(Debug, Clone, Default)]
pub struct GapInputRow {
    pub connection_id: Option<String>,
    pub start: i64,
    pub end: Option<i64>,
    pub reason: Option<String>,
}

/// What the log holds for `[from, to)` (`TimelineInput`).
#[derive(Debug, Clone, Default)]
pub struct TimelineInput {
    pub from: f64,
    pub to: f64,
    pub now: f64,
    pub day_start: String,
    pub focus: Vec<FocusRow>,
    pub presence: Vec<PresenceRow>,
    pub agents: Vec<AgentRow>,
    pub gaps: Vec<GapInputRow>,
    pub sessions: Vec<SessionRow>,
    /// ActivityWorkspace objects (with their subjects).
    pub workspaces: Vec<Value>,
    /// `idle_seconds` in milliseconds.
    pub idle_ms: Option<i64>,
}

// --- Days ---------------------------------------------------------------

pub fn day_start_minutes(day_start: &str) -> i64 {
    let bytes = day_start.as_bytes();
    if bytes.len() == 5
        && bytes[2] == b':'
        && [0, 1, 3, 4].iter().all(|&i| bytes[i].is_ascii_digit())
    {
        let hours: i64 = day_start[0..2].parse().unwrap_or(0);
        let minutes: i64 = day_start[3..5].parse().unwrap_or(0);
        return hours * 60 + minutes;
    }
    0
}

/// A real calendar date written `YYYY-MM-DD` (`isDate`): ASCII digits, a
/// year JavaScript's `new Date(y, m, d)` keeps as written (100 or later).
pub fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let number = |range: std::ops::Range<usize>| value[range].parse::<i16>().unwrap_or(-1);
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    year >= 100 && Date::new(year, month as i8, day as i8).is_ok()
}

fn parse_date(date: &str) -> (i16, i8, i64) {
    let number = |range: std::ops::Range<usize>| {
        date.get(range)
            .and_then(|t| t.parse::<i64>().ok())
            .unwrap_or(0)
    };
    (number(0..4) as i16, number(5..7) as i8, number(8..10))
}

/// `new Date(y, m - 1, d + days, hours, minutes)` in `zone`: overflowing
/// days roll over, a local time in a gap moves forward.
fn local_ms(zone: &TimeZone, date: &str, days: i64, minutes: i64) -> i64 {
    let (year, month, day) = parse_date(date);
    let first = Date::new(year, month.clamp(1, 12), 1).unwrap_or(Date::constant(2000, 1, 1));
    let civil = first
        .checked_add(jiff::Span::new().days(day - 1 + days))
        .unwrap_or(first);
    let datetime = civil.at((minutes / 60) as i8, (minutes % 60) as i8, 0, 0);
    datetime
        .to_zoned(zone.clone())
        .map(|zoned| zoned.timestamp().as_millisecond())
        .unwrap_or(0)
}

fn format_date(date: Date) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

fn local_date(zone: &TimeZone, ms: i64) -> String {
    match Timestamp::from_millisecond(ms) {
        Ok(timestamp) => format_date(timestamp.to_zoned(zone.clone()).date()),
        Err(_) => String::new(),
    }
}

/// Adds days to a `YYYY-MM-DD` date.
pub fn add_days(date: &str, days: i64) -> String {
    add_days_in(&local_zone(), date, days)
}

fn add_days_in(zone: &TimeZone, date: &str, days: i64) -> String {
    local_date(zone, local_ms(zone, date, days, 12 * 60))
}

/// The local day `date`, from `day_start` to `day_start` the next day.
pub fn day_bounds(date: &str, day_start: &str) -> (i64, i64) {
    day_bounds_in(&local_zone(), date, day_start)
}

fn day_bounds_in(zone: &TimeZone, date: &str, day_start: &str) -> (i64, i64) {
    let minutes = day_start_minutes(day_start);
    (
        local_ms(zone, date, 0, minutes),
        local_ms(zone, date, 1, minutes),
    )
}

/// The day `ms` belongs to, given the day start.
pub fn day_of(ms: i64, day_start: &str) -> String {
    let zone = local_zone();
    let date = local_date(&zone, ms);
    if ms < day_bounds_in(&zone, &date, day_start).0 {
        add_days_in(&zone, &date, -1)
    } else {
        date
    }
}

/// The dates from `first` to `last`, both included.
pub fn dates_between(first: &str, last: &str) -> Vec<String> {
    let zone = local_zone();
    let mut dates = Vec::new();
    let mut date = first.to_owned();
    while date.as_str() <= last && dates.len() <= 100_000 {
        dates.push(date.clone());
        date = add_days_in(&zone, &date, 1);
    }
    dates
}

/// The range of a timeline request (`timelineRange`): `from` and `to` are
/// local dates (both included); either defaults to the other, both to the
/// day `now` is in.
pub fn timeline_range(params: &Value, now: i64, day_start: &str) -> Result<(i64, i64), String> {
    let field = |key: &str| params.get(key).filter(|value| !value.is_null());
    for key in ["from", "to"] {
        if let Some(value) = field(key)
            && !value.as_str().is_some_and(is_date)
        {
            return Err(format!("{key} must be a date, YYYY-MM-DD"));
        }
    }
    let today = day_of(now, day_start);
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let from = text(field("from"));
    let to = text(field("to"));
    let first = from
        .clone()
        .or_else(|| to.clone())
        .unwrap_or_else(|| today.clone());
    let last = to.or(from).unwrap_or(today);
    if last < first {
        return Err("to is before from".into());
    }
    if dates_between(&first, &last).len() > TIMELINE_MAX_DAYS {
        return Err(format!("at most {TIMELINE_MAX_DAYS} days at once"));
    }
    Ok((
        day_bounds(&first, day_start).0,
        day_bounds(&last, day_start).1,
    ))
}

// --- Intervals ----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interval {
    pub start: i64,
    pub end: i64,
}

/// Sorted, merged.
pub fn union(intervals: &[Interval]) -> Vec<Interval> {
    let mut sorted: Vec<Interval> = intervals
        .iter()
        .copied()
        .filter(|e| e.end > e.start)
        .collect();
    sorted.sort_by_key(|entry| entry.start);
    let mut merged: Vec<Interval> = Vec::new();
    for entry in sorted {
        match merged.last_mut() {
            Some(last) if entry.start <= last.end => last.end = last.end.max(entry.end),
            _ => merged.push(entry),
        }
    }
    merged
}

fn length(intervals: &[Interval]) -> i64 {
    union(intervals).iter().map(|e| e.end - e.start).sum()
}

/// `interval` minus the (merged) `cuts`.
fn subtract(interval: Interval, cuts: &[Interval]) -> Vec<Interval> {
    let mut parts = Vec::new();
    let mut cursor = interval.start;
    for cut in cuts {
        if cut.end <= cursor {
            continue;
        }
        if cut.start >= interval.end {
            break;
        }
        if cut.start > cursor {
            parts.push(Interval {
                start: cursor,
                end: cut.start,
            });
        }
        cursor = cursor.max(cut.end);
    }
    if cursor < interval.end {
        parts.push(Interval {
            start: cursor,
            end: interval.end,
        });
    }
    parts
}

fn clip(span: Interval, range: Interval) -> Option<Interval> {
    let start = span.start.max(range.start);
    let end = span.end.min(range.end);
    (end > start).then_some(Interval { start, end })
}

// --- Building -----------------------------------------------------------

#[derive(Debug, Clone)]
struct ResolvedFocus {
    row: FocusRow,
    source: &'static str,
    start: i64,
    end: i64,
    open: bool,
}

impl ResolvedFocus {
    fn interval(&self) -> Interval {
        Interval {
            start: self.start,
            end: self.end,
        }
    }

    fn clipped(&self, range: Interval) -> Option<Self> {
        clip(self.interval(), range).map(|part| Self {
            start: part.start,
            end: part.end,
            ..self.clone()
        })
    }
}

fn timeline_source(row: &FocusRow) -> &'static str {
    if row.source == "herdr" {
        "herdr"
    } else if row.client_kind.as_deref() == Some("phone") {
        "phone"
    } else {
        "browser"
    }
}

/// When what a session left open ends: now while it runs, else its last stamp.
struct SessionEnds {
    latest: Option<SessionRow>,
    running: bool,
    now: i64,
    by_id: HashMap<i64, SessionRow>,
}

impl SessionEnds {
    fn new(sessions: &[SessionRow], now: i64) -> Self {
        let mut latest: Option<&SessionRow> = None;
        for entry in sessions {
            if latest.is_none_or(|best| entry.id > best.id) {
                latest = Some(entry);
            }
        }
        let running = latest
            .is_some_and(|l| l.stopped_at.is_none() && now - l.last_alive <= RECORDER_STALE_MS);
        Self {
            latest: latest.cloned(),
            running,
            now,
            by_id: sessions.iter().map(|s| (s.id, s.clone())).collect(),
        }
    }

    fn end(&self, session: i64) -> (i64, bool) {
        if self.running && self.latest.as_ref().is_some_and(|l| l.id == session) {
            return (self.now, true);
        }
        match self.by_id.get(&session) {
            None => (self.now, true),
            Some(row) => (row.stopped_at.unwrap_or(row.last_alive), false),
        }
    }
}

/// Whether a row with this cause may be a sign of a person: rows older
/// than causes keep the rules they had.
fn may_be_sign(cause: Option<&str>) -> bool {
    cause.is_none() || person_cause(cause)
}

/// When a person was there (the TS `personWindows`): Herdr's TUI time
/// counts only within `idle_ms` of a sign of a person.
fn person_windows(
    focus: &[ResolvedFocus],
    presence: &[PresenceRow],
    idle_ms: i64,
) -> Vec<Interval> {
    let mut windows = Vec::new();
    for entry in focus {
        if entry.source == "herdr" {
            if entry.row.cause.as_deref() == Some("herdr_event") {
                windows.push(Interval {
                    start: entry.row.start,
                    end: entry.row.start + idle_ms,
                });
            }
            if let Some(end) = entry.row.end
                && entry.row.reason.as_deref() == Some("switch")
                && matches!(entry.row.end_cause.as_deref(), Some("herdr_event") | None)
            {
                windows.push(Interval {
                    start: end,
                    end: end + idle_ms,
                });
            }
            continue;
        }
        if !may_be_sign(entry.row.cause.as_deref()) {
            continue;
        }
        let tail = match entry.row.reason.as_deref() {
            Some("idle" | "recorder_stop") => 0,
            _ => idle_ms,
        };
        windows.push(Interval {
            start: entry.start,
            end: entry.end + tail,
        });
    }
    for row in presence {
        if (row.kind == "session.active"
            || (row.kind == "ui.visibility" && row.visible == Some(true)))
            && may_be_sign(row.cause.as_deref())
        {
            windows.push(Interval {
                start: row.ts,
                end: row.ts + idle_ms,
            });
        }
    }
    union(&windows)
}

struct Segment {
    start: i64,
    end: i64,
    workspace_id: String,
    source: &'static str,
}

/// The span with the latest start (then the latest seq) wins an instant.
fn latest<'a>(spans: impl Iterator<Item = &'a ResolvedFocus>) -> Option<&'a ResolvedFocus> {
    let mut best: Option<&ResolvedFocus> = None;
    for span in spans {
        if best.is_none_or(|b| {
            span.start > b.start || (span.start == b.start && span.row.seq > b.row.seq)
        }) {
            best = Some(span);
        }
    }
    best
}

/// Non-overlapping attention for a day: at each instant the most recently
/// started browser or phone span; Herdr spans only where none is running.
fn attention_segments(focus: &[ResolvedFocus], day: Interval) -> Vec<Segment> {
    let spans: Vec<ResolvedFocus> = focus
        .iter()
        .filter(|entry| {
            entry
                .row
                .workspace_id
                .as_deref()
                .is_some_and(|w| !w.is_empty())
        })
        .filter_map(|entry| entry.clipped(day))
        .collect();
    let mut bounds: Vec<i64> = spans.iter().flat_map(|e| [e.start, e.end]).collect();
    bounds.sort_unstable();
    bounds.dedup();
    let mut segments: Vec<Segment> = Vec::new();
    for pair in bounds.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let active: Vec<&ResolvedFocus> = spans
            .iter()
            .filter(|e| e.start <= start && e.end >= end)
            .collect();
        let winner = latest(active.iter().copied().filter(|e| e.source != "herdr"))
            .or_else(|| latest(active.iter().copied()));
        let Some(winner) = winner else { continue };
        let workspace = winner.row.workspace_id.clone().unwrap_or_default();
        match segments.last_mut() {
            Some(last)
                if last.end == start
                    && last.workspace_id == workspace
                    && last.source == winner.source =>
            {
                last.end = end;
            }
            _ => segments.push(Segment {
                start,
                end,
                workspace_id: workspace,
                source: winner.source,
            }),
        }
    }
    segments
}

#[derive(Debug, Clone)]
struct LaneSpan {
    start: i64,
    end: i64,
    open: bool,
    state: String,
}

#[derive(Debug, Clone)]
struct Lane {
    connection_id: String,
    workspace_id: Option<String>,
    pane_id: Option<String>,
    agent: String,
    task: Option<String>,
    spans: Vec<LaneSpan>,
}

fn agent_lanes(
    rows: &[AgentRow],
    ends: &SessionEnds,
    gaps_for: &dyn Fn(&str) -> Vec<Interval>,
    limit: i64,
) -> Vec<Lane> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, Vec<AgentRow>> = HashMap::new();
    for row in rows {
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            row.connection_id,
            row.pane_id.as_deref().unwrap_or(""),
            row.name
        );
        let list = by_key.entry(key.clone()).or_default();
        if list.is_empty() {
            order.push(key);
        }
        list.push(row.clone());
    }
    let mut lanes = Vec::new();
    for key in order {
        let mut list = by_key.remove(&key).unwrap_or_default();
        list.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.seq.cmp(&b.seq)));
        let first = &list[0];
        let mut lane = Lane {
            connection_id: first.connection_id.clone(),
            workspace_id: None,
            pane_id: first.pane_id.clone(),
            agent: first.name.clone(),
            task: None,
            spans: Vec::new(),
        };
        let cuts = gaps_for(&first.connection_id);
        for (index, row) in list.iter().enumerate() {
            if row.workspace_id.as_deref().is_some_and(|w| !w.is_empty()) {
                lane.workspace_id = row.workspace_id.clone();
            }
            if row.task.as_deref().is_some_and(|t| !t.is_empty()) {
                lane.task = row.task.clone();
            }
            let (mut end, open) = if let Some(next) = list.get(index + 1) {
                (next.ts, false)
            } else if row.state == "unknown" {
                // A pane that closed: nothing is known after it.
                (row.ts, false)
            } else {
                ends.end(row.session)
            };
            end = end.min(limit);
            for part in subtract(Interval { start: row.ts, end }, &cuts) {
                let part_open = open && part.end == end;
                match lane.spans.last_mut() {
                    Some(previous) if previous.state == row.state && previous.end == part.start => {
                        previous.end = part.end;
                        previous.open = part_open;
                    }
                    _ => lane.spans.push(LaneSpan {
                        start: part.start,
                        end: part.end,
                        open: part_open,
                        state: row.state.clone(),
                    }),
                }
            }
        }
        if !lane.spans.is_empty() {
            lanes.push(lane);
        }
    }
    lanes.sort_by(|a, b| {
        locale_compare(
            a.workspace_id.as_deref().unwrap_or(""),
            b.workspace_id.as_deref().unwrap_or(""),
        )
        .then_with(|| locale_compare(&a.agent, &b.agent))
        .then_with(|| {
            locale_compare(
                a.pane_id.as_deref().unwrap_or(""),
                b.pane_id.as_deref().unwrap_or(""),
            )
        })
    });
    lanes
}

#[derive(Debug, Clone)]
struct IdleSpan {
    start: i64,
    end: i64,
    open: bool,
    connection_id: String,
    client_id: String,
    client_kind: String,
}

fn idle_spans(
    presence: &[PresenceRow],
    focus: &[FocusRow],
    ends: &SessionEnds,
    limit: i64,
) -> Vec<IdleSpan> {
    struct Signal<'a> {
        seq: i64,
        ts: i64,
        row: Option<&'a PresenceRow>,
    }
    let mut signals: Vec<(&str, Signal<'_>)> = Vec::new();
    for row in presence {
        signals.push((
            &row.client_id,
            Signal {
                seq: row.seq,
                ts: row.ts,
                row: Some(row),
            },
        ));
    }
    // A new focus by the same client also means it is no longer idle.
    for row in focus {
        if let Some(client) = row.client_id.as_deref().filter(|c| !c.is_empty())
            && may_be_sign(row.cause.as_deref())
        {
            signals.push((
                client,
                Signal {
                    seq: row.seq,
                    ts: row.start,
                    row: None,
                },
            ));
        }
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_client: HashMap<String, Vec<Signal<'_>>> = HashMap::new();
    for (client, signal) in signals {
        let list = by_client.entry(client.to_owned()).or_default();
        if list.is_empty() {
            order.push(client.to_owned());
        }
        list.push(signal);
    }
    let mut spans = Vec::new();
    for client in order {
        let mut list = by_client.remove(&client).unwrap_or_default();
        list.sort_by_key(|s| s.seq);
        for (index, signal) in list.iter().enumerate() {
            let Some(row) = signal.row.filter(|row| row.kind == "session.idle") else {
                continue;
            };
            let (mut end, open) = match list.get(index + 1) {
                Some(next) => (next.ts.max(row.ts), false),
                None => ends.end(row.session),
            };
            end = end.min(limit);
            if end > row.ts {
                spans.push(IdleSpan {
                    start: row.ts,
                    end,
                    open,
                    connection_id: row.connection_id.clone(),
                    client_id: row.client_id.clone(),
                    client_kind: row.client_kind.clone(),
                });
            }
        }
    }
    spans.sort_by_key(|s| s.start);
    spans
}

#[derive(Debug, Clone)]
struct GapSpan {
    connection_id: Option<String>,
    reason: Option<String>,
    start: i64,
    end: i64,
    open: bool,
}

#[derive(Debug, Clone, Default)]
struct WorkspaceTotals {
    workspace_id: String,
    attended_ms: i64,
    browser_ms: i64,
    phone_ms: i64,
    herdr_ms: i64,
    working_ms: i64,
    blocked_ms: i64,
}

#[derive(Debug, Clone, Default)]
struct SubjectTotals {
    subject_id: Option<String>,
    label: Option<String>,
    attended_ms: i64,
    browser_ms: i64,
    phone_ms: i64,
    herdr_ms: i64,
    working_ms: i64,
    blocked_ms: i64,
    workspace_ids: Vec<String>,
}

fn finite_ms(value: f64) -> Option<i64> {
    value.is_finite().then_some(value as i64)
}

fn state_length(lanes: &[&Lane], state: &str) -> i64 {
    length(
        &lanes
            .iter()
            .flat_map(|lane| lane.spans.iter())
            .filter(|span| span.state == state)
            .map(|span| Interval {
                start: span.start,
                end: span.end,
            })
            .collect::<Vec<_>>(),
    )
}

/// The timeline of `input` (`buildTimeline`).
pub fn build_timeline(input: &TimelineInput) -> Result<Value, String> {
    let (Some(from), Some(to), Some(now)) = (
        finite_ms(input.from),
        finite_ms(input.to),
        finite_ms(input.now),
    ) else {
        return Err("invalid timeline range".into());
    };
    if to <= from {
        return Err("invalid timeline range".into());
    }
    let day_start = input.day_start.as_str();
    let limit = to.min(now);
    let ends = SessionEnds::new(&input.sessions, now);
    let subjects: HashMap<String, Value> = input
        .workspaces
        .iter()
        .filter_map(|w| {
            Some((
                w.get("id")?.as_str()?.to_owned(),
                w.get("subject").cloned().unwrap_or(Value::Null),
            ))
        })
        .collect();

    let mut gaps: Vec<GapSpan> = input
        .gaps
        .iter()
        .map(|gap| GapSpan {
            connection_id: gap.connection_id.clone(),
            reason: gap.reason.clone(),
            start: gap.start,
            end: gap.end.unwrap_or(now),
            open: gap.end.is_none(),
        })
        .collect();
    // A recorder that is not running now has not recorded since it stopped.
    if let Some(latest) = ends.latest.as_ref().filter(|_| !ends.running) {
        let since = latest.stopped_at.unwrap_or(latest.last_alive);
        if since < now {
            gaps.push(GapSpan {
                connection_id: None,
                reason: Some("recorder".into()),
                start: since,
                end: now,
                open: true,
            });
        }
    }
    let as_interval = |gap: &GapSpan| Interval {
        start: gap.start,
        end: gap.end,
    };
    let recorder_gaps = union(
        &gaps
            .iter()
            .filter(|g| g.connection_id.is_none())
            .map(as_interval)
            .collect::<Vec<_>>(),
    );
    let gaps_for = |connection: &str| {
        union(
            &gaps
                .iter()
                .filter(|g| g.connection_id.as_deref().is_none_or(|c| c == connection))
                .map(as_interval)
                .collect::<Vec<_>>(),
        )
    };

    let focus: Vec<ResolvedFocus> = input
        .focus
        .iter()
        .map(|row| {
            let (end, open) = match row.end {
                Some(end) => (end, false),
                None => ends.end(row.session),
            };
            ResolvedFocus {
                row: row.clone(),
                source: timeline_source(row),
                start: row.start,
                end: row.start.max(end.min(limit)),
                open,
            }
        })
        .collect();
    let idle_ms = input.idle_ms.unwrap_or(DEFAULT_IDLE_MS);
    let windows = person_windows(&focus, &input.presence, idle_ms);
    // Herdr's TUI time, and a page's that no person opened, count only with
    // a sign of a person.
    let attended: Vec<ResolvedFocus> = focus
        .iter()
        .flat_map(|entry| {
            if entry.source == "herdr" || !may_be_sign(entry.row.cause.as_deref()) {
                windows
                    .iter()
                    .filter_map(|window| entry.clipped(*window))
                    .collect::<Vec<_>>()
            } else {
                vec![entry.clone()]
            }
        })
        .collect();
    let idle = idle_spans(&input.presence, &input.focus, &ends, limit);
    let lanes = agent_lanes(&input.agents, &ends, &gaps_for, limit);

    let first_day = day_of(from, day_start);
    let last_day = day_of(from.max(to - 1), day_start);
    let mut days = Vec::new();
    let mut referenced: HashSet<String> = HashSet::new();
    for date in dates_between(&first_day, &last_day) {
        let bounds = day_bounds(&date, day_start);
        let day = Interval {
            start: bounds.0.max(from),
            end: bounds.1.min(to),
        };
        let mut day_focus: Vec<ResolvedFocus> = focus
            .iter()
            .filter_map(|entry| entry.clipped(day))
            .collect();
        day_focus.sort_by(|a, b| a.start.cmp(&b.start).then(a.row.seq.cmp(&b.row.seq)));
        let attention = attention_segments(&attended, day);
        let day_idle: Vec<IdleSpan> = idle
            .iter()
            .filter_map(|entry| {
                clip(
                    Interval {
                        start: entry.start,
                        end: entry.end,
                    },
                    day,
                )
                .map(|part| IdleSpan {
                    start: part.start,
                    end: part.end,
                    ..entry.clone()
                })
            })
            .collect();
        let day_lanes: Vec<Lane> = lanes
            .iter()
            .map(|lane| Lane {
                spans: lane
                    .spans
                    .iter()
                    .filter_map(|span| {
                        clip(
                            Interval {
                                start: span.start,
                                end: span.end,
                            },
                            day,
                        )
                        .map(|part| LaneSpan {
                            start: part.start,
                            end: part.end,
                            ..span.clone()
                        })
                    })
                    .collect(),
                ..lane.clone()
            })
            .filter(|lane| !lane.spans.is_empty())
            .collect();
        let mut day_gaps: Vec<GapSpan> = gaps
            .iter()
            .filter_map(|gap| {
                clip(as_interval(gap), day).map(|part| GapSpan {
                    start: part.start,
                    end: part.end,
                    ..gap.clone()
                })
            })
            .collect();
        day_gaps.sort_by_key(|g| g.start);

        let mut totals: Vec<WorkspaceTotals> = Vec::new();
        fn totals_for<'a>(
            totals: &'a mut Vec<WorkspaceTotals>,
            id: &str,
        ) -> &'a mut WorkspaceTotals {
            match totals.iter().position(|entry| entry.workspace_id == id) {
                Some(index) => &mut totals[index],
                None => {
                    totals.push(WorkspaceTotals {
                        workspace_id: id.to_owned(),
                        ..Default::default()
                    });
                    totals.last_mut().expect("pushed")
                }
            }
        }
        for segment in &attention {
            let entry = totals_for(&mut totals, &segment.workspace_id);
            let duration = segment.end - segment.start;
            entry.attended_ms += duration;
            match segment.source {
                "browser" => entry.browser_ms += duration,
                "phone" => entry.phone_ms += duration,
                _ => entry.herdr_ms += duration,
            }
        }
        let mut by_workspace: Vec<(String, Vec<&Lane>)> = Vec::new();
        for lane in &day_lanes {
            let Some(workspace) = lane.workspace_id.as_deref().filter(|w| !w.is_empty()) else {
                continue;
            };
            match by_workspace.iter_mut().find(|(id, _)| id == workspace) {
                Some((_, list)) => list.push(lane),
                None => by_workspace.push((workspace.to_owned(), vec![lane])),
            }
        }
        for (workspace, list) in &by_workspace {
            let working = state_length(list, "working");
            let blocked = state_length(list, "blocked");
            if working == 0 && blocked == 0 {
                continue;
            }
            let entry = totals_for(&mut totals, workspace);
            entry.working_ms = working;
            entry.blocked_ms = blocked;
        }
        totals.sort_by(|a, b| {
            b.attended_ms
                .cmp(&a.attended_ms)
                .then(b.working_ms.cmp(&a.working_ms))
                .then_with(|| locale_compare(&a.workspace_id, &b.workspace_id))
        });
        let mut subject_list: Vec<SubjectTotals> = Vec::new();
        for entry in &totals {
            let subject = subjects.get(&entry.workspace_id).filter(|s| !s.is_null());
            let key = subject
                .and_then(|s| s.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let index = match subject_list
                .iter()
                .position(|total| total.subject_id == key)
            {
                Some(index) => index,
                None => {
                    subject_list.push(SubjectTotals {
                        subject_id: key.clone(),
                        label: subject
                            .and_then(|s| s.get("label"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        ..Default::default()
                    });
                    subject_list.len() - 1
                }
            };
            let total = &mut subject_list[index];
            total.workspace_ids.push(entry.workspace_id.clone());
            total.attended_ms += entry.attended_ms;
            total.browser_ms += entry.browser_ms;
            total.phone_ms += entry.phone_ms;
            total.herdr_ms += entry.herdr_ms;
        }
        // Agents overlap across a subject's workspaces: count each instant once.
        for total in &mut subject_list {
            let ids: HashSet<&String> = total.workspace_ids.iter().collect();
            let lanes: Vec<&Lane> = day_lanes
                .iter()
                .filter(|lane| {
                    lane.workspace_id
                        .as_ref()
                        .is_some_and(|w| !w.is_empty() && ids.contains(w))
                })
                .collect();
            total.working_ms = state_length(&lanes, "working");
            total.blocked_ms = state_length(&lanes, "blocked");
        }
        subject_list.sort_by(|a, b| {
            b.attended_ms
                .cmp(&a.attended_ms)
                .then(b.working_ms.cmp(&a.working_ms))
                .then_with(|| {
                    locale_compare(
                        a.label.as_deref().unwrap_or("\u{ffff}"),
                        b.label.as_deref().unwrap_or("\u{ffff}"),
                    )
                })
        });
        for workspace in day_focus
            .iter()
            .filter_map(|entry| entry.row.workspace_id.as_deref())
            .chain(
                day_lanes
                    .iter()
                    .filter_map(|lane| lane.workspace_id.as_deref()),
            )
            .filter(|w| !w.is_empty())
        {
            referenced.insert(workspace.to_owned());
        }

        let unrecorded = length(
            &recorder_gaps
                .iter()
                .filter_map(|gap| {
                    clip(
                        Interval {
                            start: gap.start,
                            end: gap.end.min(limit),
                        },
                        day,
                    )
                })
                .collect::<Vec<_>>(),
        );
        let day_idle_length = length(
            &day_idle
                .iter()
                .map(|e| Interval {
                    start: e.start,
                    end: e.end,
                })
                .collect::<Vec<_>>(),
        );
        days.push(json!({
            "date": date,
            "start": iso_time(day.start),
            "end": iso_time(day.end),
            "focus": day_focus.iter().map(|entry| json!({
                "start": iso_time(entry.start),
                "end": iso_time(entry.end),
                "open": entry.open && entry.end == limit,
                "connection_id": entry.row.connection_id,
                "workspace_id": entry.row.workspace_id,
                "pane_id": entry.row.pane_id,
                "source": entry.source,
                "client_id": entry.row.client_id,
                "reason": if entry.row.end.is_none() { None } else { entry.row.reason.clone() },
                "cause": entry.row.cause,
            })).collect::<Vec<_>>(),
            "attention": attention.iter().map(|segment| json!({
                "start": iso_time(segment.start),
                "end": iso_time(segment.end),
                "workspace_id": segment.workspace_id,
                "source": segment.source,
            })).collect::<Vec<_>>(),
            "idle": day_idle.iter().map(|entry| json!({
                "start": iso_time(entry.start),
                "end": iso_time(entry.end),
                "open": entry.open && entry.end == limit,
                "connection_id": entry.connection_id,
                "client_id": entry.client_id,
                "client_kind": entry.client_kind,
            })).collect::<Vec<_>>(),
            "agents": day_lanes.iter().map(|lane| json!({
                "connection_id": lane.connection_id,
                "workspace_id": lane.workspace_id,
                "pane_id": lane.pane_id,
                "agent": lane.agent,
                "task": lane.task,
                "spans": lane.spans.iter().map(|span| json!({
                    "start": iso_time(span.start),
                    "end": iso_time(span.end),
                    "open": span.open && span.end == limit,
                    "state": span.state,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "gaps": day_gaps.iter().map(|gap| json!({
                "connection_id": gap.connection_id,
                "start": iso_time(gap.start),
                "end": if gap.open && gap.end == now { None } else { Some(iso_time(gap.end)) },
                "reason": gap.reason,
                "excluded": false,
            })).collect::<Vec<_>>(),
            "totals": {
                "attended_ms": attention.iter().map(|s| s.end - s.start).sum::<i64>(),
                "idle_ms": day_idle_length,
                "unrecorded_ms": unrecorded,
                "workspaces": totals.iter().map(|entry| json!({
                    "workspace_id": entry.workspace_id,
                    "attended_ms": entry.attended_ms,
                    "browser_ms": entry.browser_ms,
                    "phone_ms": entry.phone_ms,
                    "herdr_ms": entry.herdr_ms,
                    "working_ms": entry.working_ms,
                    "blocked_ms": entry.blocked_ms,
                })).collect::<Vec<_>>(),
                "subjects": subject_list.iter().map(|entry| json!({
                    "subject_id": entry.subject_id,
                    "label": entry.label,
                    "attended_ms": entry.attended_ms,
                    "browser_ms": entry.browser_ms,
                    "phone_ms": entry.phone_ms,
                    "herdr_ms": entry.herdr_ms,
                    "working_ms": entry.working_ms,
                    "blocked_ms": entry.blocked_ms,
                    "workspace_ids": entry.workspace_ids,
                })).collect::<Vec<_>>(),
            },
        }));
    }

    let workspaces: Vec<Value> = input
        .workspaces
        .iter()
        .filter(|w| {
            w.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| referenced.contains(id))
        })
        .map(|w| {
            let mut out = Map::new();
            for key in [
                "id",
                "connection_id",
                "name",
                "path",
                "herdr_workspace_id",
                "subject",
            ] {
                out.insert(key.into(), w.get(key).cloned().unwrap_or(Value::Null));
            }
            Value::Object(out)
        })
        .collect();
    Ok(json!({
        "recording": true,
        "day_start": day_start,
        "now": iso_time(now),
        "from": iso_time(from),
        "to": iso_time(to),
        "recorder_running": ends.running || ends.latest.is_none(),
        "days": days,
        "workspaces": workspaces,
    }))
}

#[cfg(test)]
mod tests;
