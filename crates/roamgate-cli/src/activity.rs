//! `roamgate activity` (server/src/cli/activity.ts): reads the activity log
//! without the server, with the CLI's error conventions (a failure is
//! `roamgate activity: <reason>` and exit 1, a usage error adds the help
//! hint and exits 2; with `--json` or `--ndjson` the error is JSON on
//! stderr). The log is opened read-only.

use std::collections::BTreeMap;
use std::path::Path;

use roamgate_activity::day_input::ActivitySettings;
use roamgate_activity::protocol::{EVENT_KINDS, local_zone, parse_time};
use roamgate_activity::reader::{
    ActivityReader, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, PageQuery, WorkspacesQuery, event_seq,
};
use roamgate_activity::store::activity_storage_path;
use roamgate_activity::subjects::SubjectResolver;
use roamgate_activity::timeline::{day_bounds, is_date, timeline_range};
use roamgate_base::env::roamgate_env;
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};

use crate::commands::CliRuntime;
use crate::output::Printed;
use crate::service::read_service_environment;

pub fn activity_help() -> String {
    format!(
        "Read the activity log (docs/activity.md), without the server.

Usage:
  roamgate activity today [--by workspace|subject] [--json]
  roamgate activity day <YYYY-MM-DD> [--by workspace|subject] [--json]
  roamgate activity range <from> <to> [--by workspace|subject] [--json]
  roamgate activity events [--after ID] [--from T] [--to T]
                           [--connection ID] [--workspace ID]
                           [--kind K[,K...]] [--limit N] [--json | --ndjson]
  roamgate activity workspaces [--from T] [--to T] [--connection ID] [--json]
  roamgate activity status [--json]

today, day and range print attended time and agent working and blocked
time per workspace, or per subject with --by subject; with --json, the
timeline (days of spans and totals per workspace and per subject).
A subject is a group of the Workspaces tree, else the first folder under an
activity.subject_roots entry.
Days start at the activity.day_start setting, in local time.

events prints events in log (id) order. --after resumes after an event id
(a page's next_cursor); ts is not monotonic in id order. --from and --to are
dates or ISO 8601 times. --limit defaults to {PAGE_LIMIT_DEFAULT}, at most {PAGE_LIMIT_MAX}.
--json prints an ActivityPage, --ndjson one Event per line.

status says whether the log is recording, the recorder's last alive stamp,
each connection's state and today's recording gaps.

Connections listed in activity.exclude.connections are left out of
everything but status. The log is opened read-only.
"
    )
}

enum Failure {
    Failed(String),
    Usage(String),
}

impl Failure {
    fn message(&self) -> &str {
        match self {
            Self::Failed(message) | Self::Usage(message) => message,
        }
    }
}

/// Flags as `util.parseArgs` reads them, strictly: booleans and strings.
struct Parsed {
    values: BTreeMap<String, Option<String>>,
    positionals: Vec<String>,
}

impl Parsed {
    fn flag(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    fn string(&self, name: &str) -> Option<&str> {
        self.values.get(name).and_then(|v| v.as_deref())
    }
}

fn parse(
    args: &[String],
    booleans: &[&str],
    strings: &[&str],
    max_positionals: usize,
) -> Result<Parsed, Failure> {
    let mut values = BTreeMap::new();
    let mut positionals = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--" {
            positionals.extend(rest.by_ref().cloned());
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (long, None),
            };
            if booleans.contains(&name) {
                if inline.is_some() {
                    return Err(Failure::Usage(format!(
                        "Option '--{name}' does not take an argument"
                    )));
                }
                values.insert(name.to_owned(), None);
            } else if strings.contains(&name) {
                let value = match inline {
                    Some(value) => value,
                    None => match rest.next() {
                        Some(value) => value.clone(),
                        None => {
                            return Err(Failure::Usage(format!(
                                "Option '--{name} <value>' argument missing"
                            )));
                        }
                    },
                };
                values.insert(name.to_owned(), Some(value));
            } else {
                return Err(Failure::Usage(format!("Unknown option '--{name}'")));
            }
        } else if let Some(short) = arg.strip_prefix('-').filter(|short| !short.is_empty()) {
            let letter = short.chars().next().unwrap_or('-');
            return Err(Failure::Usage(format!("Unknown option '-{letter}'")));
        } else {
            positionals.push(arg.clone());
        }
    }
    if positionals.len() > max_positionals {
        return Err(Failure::Usage(format!(
            "unexpected argument: {}",
            positionals[max_positionals]
        )));
    }
    Ok(Parsed {
        values,
        positionals,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Text,
    Json,
    Ndjson,
}

fn format_of(parsed: &Parsed) -> Result<Format, Failure> {
    match (parsed.flag("json"), parsed.flag("ndjson")) {
        (true, true) => Err(Failure::Usage("--json and --ndjson are exclusive".into())),
        (_, true) => Ok(Format::Ndjson),
        (true, _) => Ok(Format::Json),
        _ => Ok(Format::Text),
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn pad_end(text: &str, width: usize) -> String {
    format!(
        "{text}{}",
        " ".repeat(width.saturating_sub(utf16_len(text)))
    )
}

fn pad_start(text: &str, width: usize) -> String {
    format!(
        "{}{text}",
        " ".repeat(width.saturating_sub(utf16_len(text)))
    )
}

/// `Math.round(ms / 60_000)` minutes as `5m`, `1h30m` or `2h`.
pub fn format_duration(ms: i64) -> String {
    let minutes = (ms as f64 / 60_000.0 + 0.5).floor() as i64;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h{rest:02}m")
    }
}

#[derive(Default, Clone, Copy)]
struct Row {
    attended: i64,
    herdr: i64,
    working: i64,
    blocked: i64,
}

/// Totals summed over the timeline's days, one line per workspace or subject.
pub fn timeline_summary(timeline: &Value, by: &str) -> String {
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    let days = timeline["days"].as_array().cloned().unwrap_or_default();
    if by == "subject" {
        for day in &days {
            for entry in day["totals"]["subjects"].as_array().into_iter().flatten() {
                names.insert(
                    entry["subject_id"].as_str().unwrap_or("").to_owned(),
                    entry["label"].as_str().unwrap_or("(no subject)").to_owned(),
                );
            }
        }
    } else {
        for workspace in timeline["workspaces"].as_array().into_iter().flatten() {
            names.insert(
                workspace["id"].as_str().unwrap_or("").to_owned(),
                workspace["name"].as_str().unwrap_or("").to_owned(),
            );
        }
    }
    let mut rows: Vec<(String, Row)> = Vec::new();
    let (mut attended, mut idle, mut unrecorded) = (0, 0, 0);
    let number = |value: &Value| value.as_i64().unwrap_or(0);
    for day in &days {
        let totals = &day["totals"];
        attended += number(&totals["attended_ms"]);
        idle += number(&totals["idle_ms"]);
        unrecorded += number(&totals["unrecorded_ms"]);
        let (list, key) = if by == "subject" {
            ("subjects", "subject_id")
        } else {
            ("workspaces", "workspace_id")
        };
        for entry in totals[list].as_array().into_iter().flatten() {
            let id = entry[key].as_str().unwrap_or("").to_owned();
            let index = match rows.iter().position(|(known, _)| *known == id) {
                Some(index) => index,
                None => {
                    rows.push((id, Row::default()));
                    rows.len() - 1
                }
            };
            let row = &mut rows[index].1;
            row.attended += number(&entry["attended_ms"]);
            row.herdr += number(&entry["herdr_ms"]);
            row.working += number(&entry["working_ms"]);
            row.blocked += number(&entry["blocked_ms"]);
        }
    }
    let date = |day: Option<&Value>| {
        day.and_then(|d| d["date"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    let (first, last) = (date(days.first()), date(days.last()));
    let title = if first == last {
        first
    } else {
        format!("{first} to {last}")
    };
    let mut lines = vec![format!(
        "{title}  attended {}  idle {}{}{}",
        format_duration(attended),
        format_duration(idle),
        if unrecorded != 0 {
            format!("  not recorded {}", format_duration(unrecorded))
        } else {
            String::new()
        },
        if timeline["recorder_running"] == true {
            ""
        } else {
            "  (recorder not running)"
        }
    )];
    if rows.is_empty() {
        lines.push("  no activity".into());
        return lines.join("\n");
    }
    rows.sort_by(|a, b| {
        b.1.attended
            .cmp(&a.1.attended)
            .then(b.1.working.cmp(&a.1.working))
    });
    let label = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_owned());
    let width = rows
        .iter()
        .map(|(id, _)| utf16_len(&label(id)))
        .max()
        .unwrap_or(0)
        .max(by.len());
    let cell = |ms: i64| {
        pad_start(
            &if ms != 0 {
                format_duration(ms)
            } else {
                "-".into()
            },
            8,
        )
    };
    lines.push(format!(
        "  {}  {}  {}  {}  {}",
        pad_end(by, width),
        pad_start("attended", 8),
        pad_start("of herdr", 8),
        pad_start("working", 8),
        pad_start("blocked", 8)
    ));
    for (id, row) in &rows {
        lines.push(format!(
            "  {}  {}  {}  {}  {}",
            pad_end(&label(id), width),
            cell(row.attended),
            cell(row.herdr),
            cell(row.working),
            cell(row.blocked)
        ));
    }
    lines.join("\n")
}

/// The command's context: who runs it and what time it is.
pub struct ActivityCli<'a> {
    pub runtime: &'a CliRuntime,
    pub now: &'a (dyn Fn() -> i64 + Send + Sync),
}

impl ActivityCli<'_> {
    fn platform(&self) -> Platform {
        if self.runtime.platform == "win32" {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }

    fn data_root(&self) -> std::path::PathBuf {
        DataContext::new(
            self.runtime.home.clone(),
            self.platform(),
            self.runtime.app_data.clone(),
        )
        .data_root()
    }

    fn context(&self) -> DataContext {
        DataContext::new(
            self.runtime.home.clone(),
            self.platform(),
            self.runtime.app_data.clone(),
        )
    }

    /// settings.json as the server reads it (`settingsFileFor`).
    fn settings_file(&self) -> Value {
        let service = read_service_environment(&self.runtime.service()).ok();
        let path = service
            .as_ref()
            .and_then(|env| roamgate_env(env, "SETTINGS_PATH"))
            .or_else(|| roamgate_env(self.runtime.env.as_ref(), "SETTINGS_PATH"))
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| self.data_root().join("settings.json"));
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        }
    }

    fn display_path(&self, path: &Path) -> String {
        let text = path.display().to_string();
        if self.runtime.platform == "win32" {
            return text;
        }
        let home = self.runtime.home.display().to_string();
        if text == home || text.starts_with(&format!("{home}/")) {
            format!("~{}", &text[home.len()..])
        } else {
            text
        }
    }

    /// `roamgate activity <args>`.
    pub fn run(&self, args: &[String]) -> Printed {
        let mut printed = Printed::default();
        let action = args.first();
        let wants_help = action.map(String::as_str) == Some("help")
            || args.iter().any(|a| a == "--help" || a == "-h");
        let Some(action) = action.filter(|_| !wants_help) else {
            printed.log(&activity_help());
            return printed.exit(0);
        };
        let json = args.iter().any(|a| a == "--json" || a == "--ndjson");
        match self.action(action, &args[1..], &mut printed) {
            Ok(()) => printed.exit(0),
            Err(failure) if json => {
                printed.error(&json!({"error": failure.message()}).to_string());
                printed.exit(if matches!(failure, Failure::Usage(_)) {
                    2
                } else {
                    1
                })
            }
            Err(Failure::Failed(message)) => {
                printed.error(&format!("roamgate activity: {message}"));
                printed.exit(1)
            }
            Err(Failure::Usage(message)) => {
                printed.error(&format!("roamgate activity: {message}"));
                printed.error("Run `roamgate activity --help` for usage.");
                printed.exit(2)
            }
        }
    }

    /// A date (its day start) or an ISO 8601 time, as epoch ms.
    fn parse_time(
        &self,
        value: Option<&str>,
        flag: &str,
        day_start: &str,
        end: bool,
    ) -> Result<Option<i64>, Failure> {
        let Some(value) = value else { return Ok(None) };
        if is_date(value) {
            let (start, stop) = day_bounds(value, day_start);
            return Ok(Some(if end { stop } else { start }));
        }
        let iso = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T").expect("valid regex");
        let parsed = iso
            .is_match(value)
            .then(|| {
                parse_time(value).or_else(|| {
                    // No offset: local time, as Date.parse reads it.
                    value
                        .parse::<jiff::civil::DateTime>()
                        .ok()
                        .and_then(|dt| dt.to_zoned(local_zone()).ok())
                        .map(|zoned| zoned.timestamp().as_millisecond())
                })
            })
            .flatten();
        parsed
            .map(Some)
            .ok_or_else(|| Failure::Usage(format!("{flag} must be a date or an ISO 8601 time")))
    }

    fn reader(&self, subjects: SubjectResolver) -> Result<ActivityReader, Failure> {
        let now = (self.now)();
        let directory = self.data_root();
        ActivityReader::open(
            &self.context(),
            &directory,
            Box::new(move || now),
            Some(subjects),
        )
        .map_err(|error| Failure::Failed(error.to_string()))?
        .ok_or_else(|| {
            Failure::Failed(format!(
                "no activity log at {}; set activity.enabled in settings.json",
                self.display_path(&activity_storage_path(&directory))
            ))
        })
    }

    fn print(printed: &mut Printed, format: Format, value: &Value, text: impl FnOnce() -> String) {
        printed.log(&if format == Format::Text {
            text()
        } else {
            pretty(value)
        });
    }

    fn action(&self, action: &str, rest: &[String], printed: &mut Printed) -> Result<(), Failure> {
        let raw = self.settings_file();
        let settings = ActivitySettings::from_settings(&raw);
        let subjects = || SubjectResolver::from_settings(&raw);
        let excluded = settings.exclude_connections.clone();
        let failed =
            |error: roamgate_activity::reader::ReaderError| Failure::Failed(error.to_string());
        match action {
            "today" | "day" | "range" => {
                let count = match action {
                    "today" => 0,
                    "day" => 1,
                    _ => 2,
                };
                let parsed = parse(rest, &["json"], &["by"], count)?;
                let by = parsed.string("by").unwrap_or("workspace").to_owned();
                if by != "workspace" && by != "subject" {
                    return Err(Failure::Usage("--by must be workspace or subject".into()));
                }
                if parsed.positionals.len() != count {
                    return Err(Failure::Usage(
                        if action == "day" {
                            "day needs a date, YYYY-MM-DD"
                        } else {
                            "range needs two dates, YYYY-MM-DD"
                        }
                        .into(),
                    ));
                }
                let first = parsed.positionals.first().cloned();
                let last = parsed.positionals.get(1).cloned().or_else(|| first.clone());
                let range = timeline_range(
                    &json!({"from": first, "to": last}),
                    (self.now)(),
                    &settings.day_start,
                )
                .map_err(Failure::Usage)?;
                let reader = self.reader(subjects())?;
                let timeline = reader
                    .timeline(
                        range,
                        &settings.day_start,
                        &excluded,
                        Some(settings.idle_seconds),
                    )
                    .map_err(failed)?;
                let format = format_of(&parsed)?;
                Self::print(printed, format, &timeline, || {
                    timeline_summary(&timeline, &by)
                });
                Ok(())
            }
            "events" => {
                let parsed = parse(
                    rest,
                    &["json", "ndjson"],
                    &[
                        "after",
                        "from",
                        "to",
                        "connection",
                        "workspace",
                        "kind",
                        "limit",
                    ],
                    0,
                )?;
                let format = format_of(&parsed)?;
                let after = match parsed.string("after") {
                    None => None,
                    Some(text) => Some(
                        event_seq(text)
                            .ok_or_else(|| Failure::Usage("--after must be an event id".into()))?,
                    ),
                };
                let limit = match parsed.string("limit") {
                    None => PAGE_LIMIT_DEFAULT as f64,
                    Some(text) => {
                        let text = roamgate_base::settings::js_trim(text);
                        if text.is_empty() {
                            0.0
                        } else {
                            text.parse::<f64>().unwrap_or(f64::NAN)
                        }
                    }
                };
                if limit.fract() != 0.0 || !(1.0..=PAGE_LIMIT_MAX as f64).contains(&limit) {
                    return Err(Failure::Usage(format!(
                        "--limit must be 1 to {PAGE_LIMIT_MAX}"
                    )));
                }
                let kinds: Vec<String> = parsed
                    .string("kind")
                    .map(|text| {
                        text.split(',')
                            .map(|k| roamgate_base::settings::js_trim(k).to_owned())
                            .filter(|k| !k.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                for kind in &kinds {
                    if !EVENT_KINDS.contains(&kind.as_str()) {
                        return Err(Failure::Usage(format!("unknown event kind: {kind}")));
                    }
                }
                let from =
                    self.parse_time(parsed.string("from"), "--from", &settings.day_start, false)?;
                let to = self.parse_time(parsed.string("to"), "--to", &settings.day_start, true)?;
                let reader = self.reader(subjects())?;
                let page = reader
                    .page(&PageQuery {
                        after,
                        from,
                        to,
                        connection: parsed.string("connection").map(str::to_owned),
                        workspace: parsed.string("workspace").map(str::to_owned),
                        kinds,
                        exclude_connections: excluded,
                        limit: limit as i64,
                    })
                    .map_err(failed)?;
                if format == Format::Ndjson {
                    for event in page["events"].as_array().into_iter().flatten() {
                        printed.log(&event.to_string());
                    }
                    return Ok(());
                }
                Self::print(printed, format, &page, || {
                    let names: BTreeMap<&str, &str> = page["workspaces"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|w| Some((w["id"].as_str()?, w["name"].as_str()?)))
                        .collect();
                    let mut lines: Vec<String> = page["events"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|event| {
                            let detail = if let Some(agent) =
                                event.get("agent").filter(|a| a.is_object())
                            {
                                format!(
                                    "{} {}",
                                    agent["name"].as_str().unwrap_or(""),
                                    agent["state"].as_str().unwrap_or("")
                                )
                            } else if let Some(reason) = event.get("reason").and_then(Value::as_str)
                            {
                                reason.to_owned()
                            } else if let Some(visible) =
                                event.get("visible").filter(|v| !v.is_null())
                            {
                                format!("visible={visible}")
                            } else {
                                String::new()
                            };
                            let place = event["workspace_id"]
                                .as_str()
                                .filter(|w| !w.is_empty())
                                .map(|w| names.get(w).copied().unwrap_or(w).to_owned())
                                .unwrap_or_default();
                            let by = if let Some(client) =
                                event.get("client").filter(|c| c.is_object())
                            {
                                client["kind"].as_str().unwrap_or("").to_owned()
                            } else if event.get("source").and_then(Value::as_str) == Some("herdr") {
                                "herdr".to_owned()
                            } else {
                                String::new()
                            };
                            [
                                event["id"].as_str().unwrap_or("").to_owned(),
                                event["ts"].as_str().unwrap_or("").to_owned(),
                                event["kind"].as_str().unwrap_or("").to_owned(),
                                event["connection_id"].as_str().unwrap_or("").to_owned(),
                                place,
                                by,
                                detail,
                            ]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join("  ")
                        })
                        .collect();
                    if let Some(cursor) = page["next_cursor"].as_str() {
                        lines.push(format!("more: --after {cursor}"));
                    }
                    let text = lines.join("\n");
                    if text.is_empty() {
                        "no events".into()
                    } else {
                        text
                    }
                });
                Ok(())
            }
            "workspaces" => {
                let parsed = parse(rest, &["json"], &["from", "to", "connection"], 0)?;
                let from =
                    self.parse_time(parsed.string("from"), "--from", &settings.day_start, false)?;
                let to = self.parse_time(parsed.string("to"), "--to", &settings.day_start, true)?;
                let reader = self.reader(subjects())?;
                let workspaces: Vec<Value> = reader
                    .workspaces(&WorkspacesQuery {
                        from,
                        to,
                        connection: parsed.string("connection").map(str::to_owned),
                    })
                    .map_err(failed)?
                    .into_iter()
                    .filter(|w| !excluded.iter().any(|e| w["connection_id"] == e.as_str()))
                    .collect();
                let format = format_of(&parsed)?;
                Self::print(
                    printed,
                    format,
                    &json!({ "workspaces": workspaces }),
                    || {
                        if workspaces.is_empty() {
                            return "no workspaces".into();
                        }
                        workspaces
                            .iter()
                            .map(|w| {
                                format!(
                                    "{}  {}  {}  {}",
                                    w["name"].as_str().unwrap_or(""),
                                    w["connection_id"].as_str().unwrap_or(""),
                                    w["subject"]["label"].as_str().unwrap_or("-"),
                                    w["path"].as_str().unwrap_or("-")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    },
                );
                Ok(())
            }
            "status" => {
                let parsed = parse(rest, &["json"], &[], 0)?;
                let at = (self.now)();
                let range =
                    timeline_range(&json!({}), at, &settings.day_start).map_err(Failure::Usage)?;
                let directory = self.data_root();
                let reader = ActivityReader::open(
                    &self.context(),
                    &directory,
                    Box::new(move || at),
                    Some(subjects()),
                )
                .map_err(failed)?;
                let status = match reader {
                    Some(reader) => reader
                        .status(settings.enabled, settings.retention_days, range.0, at)
                        .map_err(failed)?,
                    None => json!({
                        "recording": false,
                        "retention_days": settings.retention_days,
                        "last_alive": null,
                        "gaps": [],
                        "connections": [],
                    }),
                };
                let format = format_of(&parsed)?;
                Self::print(printed, format, &status, || {
                    let mut lines = vec![
                        format!(
                            "recording: {}{}",
                            if status["recording"] == true {
                                "yes"
                            } else {
                                "no"
                            },
                            if settings.enabled {
                                ""
                            } else {
                                " (activity.enabled is off)"
                            }
                        ),
                        format!(
                            "last alive: {}",
                            status["last_alive"].as_str().unwrap_or("never")
                        ),
                        format!("retention: {} days", status["retention_days"]),
                    ];
                    for entry in status["connections"].as_array().into_iter().flatten() {
                        lines.push(format!(
                            "connection {}: {}{}",
                            entry["id"].as_str().unwrap_or(""),
                            entry["state"].as_str().unwrap_or(""),
                            entry["recording_since"]
                                .as_str()
                                .map(|s| format!(" since {s}"))
                                .unwrap_or_default()
                        ));
                    }
                    for gap in status["gaps"].as_array().into_iter().flatten() {
                        lines.push(format!(
                            "gap {}: {} to {}{}",
                            gap["connection_id"].as_str().unwrap_or("(recorder)"),
                            gap["start"].as_str().unwrap_or(""),
                            gap["end"].as_str().unwrap_or("now"),
                            gap["reason"]
                                .as_str()
                                .filter(|r| !r.is_empty())
                                .map(|r| format!(" ({r})"))
                                .unwrap_or_default()
                        ));
                    }
                    lines.join("\n")
                });
                Ok(())
            }
            other => Err(Failure::Usage(format!("unknown activity action: {other}"))),
        }
    }
}

/// `JSON.stringify(value, null, 2)`.
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

#[cfg(test)]
mod tests;
