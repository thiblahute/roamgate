//! What the time-report provider gets for `day` and `refresh` (server/src/
//! time-report/day-input.ts and rpc.ts's `dayInput`): everything recorded
//! for a date, as it may leave Roamgate. Excluded connections and subjects
//! are dropped, and the time they had the attention goes as anonymous
//! excluded gaps. Built in the core while it owns the activity family; Bun
//! builds it (the `activity.dayInput` reverse call) while Bun does.

use std::collections::HashSet;

use roamgate_base::settings::normalize_activity_settings;
use serde_json::{Value, json};

use crate::protocol::{iso_time, parse_time};
use crate::reader::{ActivityReader, PAGE_LIMIT_MAX, PageQuery, ReaderError};
use crate::timeline::{Interval, day_bounds, union};

/// `activity` in settings.json, normalised (`GuiActivitySettings`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivitySettings {
    pub enabled: bool,
    pub retention_days: i64,
    pub idle_seconds: i64,
    pub day_start: String,
    pub subject_roots: Vec<String>,
    pub record_agent_titles: bool,
    pub exclude_connections: Vec<String>,
    pub exclude_subjects: Vec<String>,
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

impl ActivitySettings {
    /// From settings.json's raw content (its `activity`).
    pub fn from_settings(raw: &Value) -> Self {
        Self::normalize(raw.get("activity"))
    }

    pub fn normalize(raw: Option<&Value>) -> Self {
        let value = normalize_activity_settings(raw);
        Self {
            enabled: value["enabled"] == true,
            retention_days: value["retention_days"].as_i64().unwrap_or(90),
            idle_seconds: value["idle_seconds"].as_i64().unwrap_or(300),
            day_start: value["day_start"].as_str().unwrap_or("00:00").to_owned(),
            subject_roots: strings(&value["subject_roots"]),
            record_agent_titles: value["record_agent_titles"] == true,
            exclude_connections: strings(&value["exclude"]["connections"]),
            exclude_subjects: strings(&value["exclude"]["subjects"]),
        }
    }
}

impl Default for ActivitySettings {
    fn default() -> Self {
        Self::normalize(None)
    }
}

/// A workspace whose subject, or one of its groups, the user excluded.
pub fn subject_excluded(workspace: &Value, excluded: &[String]) -> bool {
    let subject = &workspace["subject"];
    if subject.is_null() || excluded.is_empty() {
        return false;
    }
    let names: HashSet<&str> = excluded.iter().map(String::as_str).collect();
    let mut groups = vec![subject];
    if let Some(list) = subject["groups"].as_array() {
        groups.extend(list.iter());
    }
    groups.iter().any(|group| {
        group["id"].as_str().is_some_and(|id| names.contains(id))
            || group["label"]
                .as_str()
                .is_some_and(|label| names.contains(label))
    })
}

/// The day's input (`buildDayInput`).
pub fn build_day_input(
    reader: &ActivityReader,
    settings: &ActivitySettings,
    date: &str,
    timezone: &str,
) -> Result<Value, ReaderError> {
    let (start, end) = day_bounds(date, &settings.day_start);
    let excluded_connections = &settings.exclude_connections;
    // Every connection, to place what excluded ones covered.
    let timeline = reader.timeline(
        (start, end),
        &settings.day_start,
        &[],
        Some(settings.idle_seconds),
    )?;
    let day = timeline["days"].get(0).cloned().unwrap_or(Value::Null);
    let workspace_by_id = |id: &str| {
        timeline["workspaces"]
            .as_array()
            .and_then(|list| list.iter().find(|w| w["id"] == id))
            .cloned()
    };
    let mut events: Vec<Value> = Vec::new();
    let mut workspaces: Vec<Value> = Vec::new();
    let mut after = 0;
    loop {
        let page = reader.page(&PageQuery {
            after: Some(after),
            from: Some(start),
            to: Some(end),
            exclude_connections: excluded_connections.clone(),
            limit: PAGE_LIMIT_MAX,
            ..Default::default()
        })?;
        for workspace in page["workspaces"].as_array().into_iter().flatten() {
            match workspaces.iter_mut().find(|w| w["id"] == workspace["id"]) {
                Some(existing) => *existing = workspace.clone(),
                None => workspaces.push(workspace.clone()),
            }
        }
        events.extend(page["events"].as_array().into_iter().flatten().cloned());
        match page["next_cursor"].as_str() {
            Some(cursor) => after = cursor.parse().unwrap_or(i64::MAX),
            None => break,
        }
    }
    let dropped: HashSet<String> = workspaces
        .iter()
        .filter(|w| subject_excluded(w, &settings.exclude_subjects))
        .filter_map(|w| w["id"].as_str().map(str::to_owned))
        .collect();
    let left_out = |connection: Option<&str>, workspace: Option<&str>| {
        connection.is_some_and(|c| excluded_connections.iter().any(|e| e == c))
            || workspace.is_some_and(|w| dropped.contains(w))
    };
    // The attention spans that are left out, whoever's subject they are.
    let excluded_time = union(
        &day["focus"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|span| {
                if span["connection_id"]
                    .as_str()
                    .is_some_and(|c| excluded_connections.iter().any(|e| e == c))
                {
                    return true;
                }
                let Some(workspace) = span["workspace_id"].as_str().filter(|w| !w.is_empty())
                else {
                    return false;
                };
                if dropped.contains(workspace) {
                    return true;
                }
                workspace_by_id(workspace)
                    .is_some_and(|w| subject_excluded(&w, &settings.exclude_subjects))
            })
            .map(|span| Interval {
                start: span["start"].as_str().and_then(parse_time).unwrap_or(0),
                end: span["end"].as_str().and_then(parse_time).unwrap_or(0),
            })
            .collect::<Vec<_>>(),
    );
    let mut gaps: Vec<Value> = day["gaps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|gap| {
            gap["connection_id"]
                .as_str()
                .is_none_or(|c| !excluded_connections.iter().any(|e| e == c))
        })
        .cloned()
        .collect();
    for span in excluded_time {
        gaps.push(json!({
            "connection_id": null,
            "start": iso_time(span.start),
            "end": iso_time(span.end),
            "reason": null,
            "excluded": true,
        }));
    }
    gaps.sort_by_key(|gap| gap["start"].as_str().and_then(parse_time).unwrap_or(0));
    Ok(json!({
        "date": date,
        "timezone": timezone,
        "day_start": settings.day_start,
        "idle_seconds": settings.idle_seconds,
        "events": events
            .into_iter()
            .filter(|event| !left_out(event["connection_id"].as_str(), event["workspace_id"].as_str()))
            .collect::<Vec<_>>(),
        "workspaces": workspaces
            .into_iter()
            .filter(|w| !left_out(w["connection_id"].as_str(), w["id"].as_str()))
            .collect::<Vec<_>>(),
        "recording_gaps": gaps,
    }))
}

/// The system's IANA zone name, as `Intl.DateTimeFormat().resolvedOptions()
/// .timeZone` gives it.
pub fn system_zone_name() -> String {
    crate::protocol::local_zone()
        .iana_name()
        .map(str::to_owned)
        .unwrap_or_else(|| "UTC".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ActivityStore, Client, NewEvent, WorkspaceRow};
    use crate::subjects::SubjectResolver;
    use roamgate_base::paths::{DataContext, Platform};

    /// A log with work in two folders on two connections, one span each
    /// (time-report/rpc.test.ts's `log`).
    fn log(context: &DataContext, directory: &std::path::Path, at: impl Fn(i64) -> i64) {
        let store = ActivityStore::open(context, directory).unwrap();
        let session = store.start_session(at(8)).unwrap();
        let workspaces = [
            ("ws_gst", "local", "gst", "/Users/me/devel/gstreamer/gst"),
            ("ws_home", "local", "taxes", "/Users/me/private/taxes"),
            ("ws_box", "box", "box", "/home/me/devel/gstreamer/box"),
        ];
        for (id, connection, name, path) in workspaces {
            store
                .upsert_workspace(&WorkspaceRow {
                    id: id.into(),
                    connection_id: connection.into(),
                    name: name.into(),
                    path: Some(path.into()),
                    herdr_workspace_id: Some("w1".into()),
                    repo_root: None,
                    repo_is_worktree: None,
                    seen_at: at(8),
                })
                .unwrap();
        }
        let client = Some(Client {
            id: "c1".into(),
            kind: "desktop".into(),
        });
        for (hour, (id, connection, _, _)) in (9..).zip(workspaces) {
            let focus = store
                .append(&NewEvent {
                    ts: at(hour),
                    kind: "workspace.focus",
                    connection_id: connection.into(),
                    session,
                    workspace_id: Some(id.into()),
                    client: client.clone(),
                    source: Some("browser"),
                    ..Default::default()
                })
                .unwrap();
            store
                .append(&NewEvent {
                    ts: at(hour + 1),
                    kind: "workspace.blur",
                    connection_id: connection.into(),
                    session,
                    workspace_id: Some(id.into()),
                    client: client.clone(),
                    source: Some("browser"),
                    reason: Some("switch"),
                    span: Some(focus),
                    ..Default::default()
                })
                .unwrap();
        }
        store.alive(session, at(18)).unwrap();
    }

    #[test]
    fn excluded_connections_and_subjects_leave_as_anonymous_excluded_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::Unix, None);
        let directory = dir.path().join("roamgate");
        let start = day_bounds("2026-11-02", "00:00").0;
        let at = move |hour: i64| start + hour * 3_600_000;
        log(&context, &directory, at);
        let roots = ["~/devel/gstreamer".to_owned(), "~/private".to_owned()];
        let reader = ActivityReader::open(
            &context,
            &directory,
            Box::new(move || at(18)),
            Some(SubjectResolver::new(&roots, None, Some("/Users/me"))),
        )
        .unwrap()
        .unwrap();
        let settings = ActivitySettings {
            enabled: true,
            idle_seconds: 120,
            subject_roots: roots.to_vec(),
            exclude_connections: vec!["box".into()],
            exclude_subjects: vec!["private".into()],
            ..ActivitySettings::default()
        };
        let input = build_day_input(&reader, &settings, "2026-11-02", "UTC").unwrap();
        let ids: Vec<&str> = input["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["ws_gst"]);
        assert!(
            input["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["workspace_id"] == "ws_gst")
        );
        let gaps = input["recording_gaps"].as_array().unwrap();
        assert_eq!(gaps.len(), 1);
        let gap = &gaps[0];
        assert_eq!(
            (
                gap["connection_id"].clone(),
                gap["reason"].clone(),
                gap["excluded"].clone()
            ),
            (Value::Null, Value::Null, json!(true))
        );
        let ms = |v: &Value| parse_time(v.as_str().unwrap()).unwrap();
        assert_eq!((ms(&gap["start"]), ms(&gap["end"])), (at(10), at(12)));
        assert!(!input.to_string().contains("taxes"));
    }
}
