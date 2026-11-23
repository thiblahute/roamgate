//! server/src/activity/timeline.test.ts, case for case.

use super::*;
use crate::protocol::parse_time;
use std::sync::atomic::{AtomicI64, Ordering};

const MIN: i64 = 60_000;

/// `date` at hh:mm, local time.
fn on(date: &str, hours: i64, minutes: i64) -> i64 {
    day_bounds(date, &format!("{hours:02}:{minutes:02}")).0
}

/// 2026-11-02 at hh:mm, local time.
fn at(hours: i64, minutes: i64) -> i64 {
    on("2026-11-02", hours, minutes)
}

fn ms(value: &Value) -> i64 {
    parse_time(value.as_str().unwrap()).unwrap()
}

fn workspace(id: &str) -> Value {
    json!({
        "id": id,
        "connection_id": "local",
        "name": id.to_uppercase(),
        "path": format!("/src/{id}"),
        "subject": null,
        "repo": null,
        "herdr_workspace_id": format!("h-{id}"),
    })
}

static SEQ: AtomicI64 = AtomicI64::new(0);
fn next() -> i64 {
    SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

fn focus(start: i64, end: Option<i64>, workspace: &str) -> FocusRow {
    FocusRow {
        seq: next(),
        start,
        end,
        reason: end.map(|_| "switch".to_owned()),
        connection_id: "local".into(),
        workspace_id: Some(workspace.into()),
        tab_id: None,
        pane_id: Some("p1".into()),
        source: "browser".into(),
        client_id: Some("c1".into()),
        client_kind: Some("desktop".into()),
        session: 1,
        cause: None,
        end_cause: None,
    }
}

fn herdr(mut row: FocusRow) -> FocusRow {
    row.source = "herdr".into();
    row.client_id = None;
    row
}

fn agent(ts: i64, state: &str) -> AgentRow {
    AgentRow {
        seq: next(),
        ts,
        connection_id: "local".into(),
        workspace_id: Some("a".into()),
        pane_id: Some("p1".into()),
        name: "claude".into(),
        state: state.into(),
        task: None,
        session: 1,
    }
}

fn presence(ts: i64, kind: &str) -> PresenceRow {
    PresenceRow {
        seq: next(),
        ts,
        kind: kind.into(),
        connection_id: "local".into(),
        client_id: "c1".into(),
        client_kind: "desktop".into(),
        visible: (kind == "ui.visibility").then_some(true),
        session: 1,
        cause: None,
    }
}

fn input() -> TimelineInput {
    let (start, end) = day_bounds("2026-11-02", "00:00");
    TimelineInput {
        from: start as f64,
        to: end as f64,
        now: at(18, 0) as f64,
        day_start: "00:00".into(),
        sessions: vec![SessionRow {
            id: 1,
            started_at: at(8, 0),
            last_alive: at(18, 0) - MIN,
            stopped_at: None,
        }],
        workspaces: vec![workspace("a"), workspace("b"), workspace("c")],
        ..Default::default()
    }
}

fn segments(day: &Value) -> Vec<(String, String, i64)> {
    day["attention"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["workspace_id"].as_str().unwrap().to_owned(),
                s["source"].as_str().unwrap().to_owned(),
                (ms(&s["end"]) - ms(&s["start"])) / MIN,
            )
        })
        .collect()
}

fn workspace_totals<'a>(day: &'a Value, id: &str) -> Option<&'a Value> {
    day["totals"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["workspace_id"] == id)
}

#[test]
fn days_follow_the_day_start_in_local_time() {
    assert_eq!(day_of(at(3, 0), "04:00"), "2026-11-01");
    assert_eq!(day_of(at(4, 0), "04:00"), "2026-11-02");
    assert_eq!(
        day_bounds("2026-11-02", "04:00"),
        (at(4, 0), on("2026-11-03", 4, 0))
    );
    assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
    assert!(!is_date("2026-02-29"));
    assert!(is_date("2028-02-29"));
    assert!(!is_date("today"));
}

#[test]
fn days_follow_dst_in_the_system_zone() {
    // A day that loses an hour, and one that gains it, in São Paulo's 2018
    // rules (midnight itself was skipped).
    let zone = TimeZone::get("America/Sao_Paulo").unwrap();
    let (start, end) = day_bounds_in(&zone, "2018-11-04", "00:00");
    assert_eq!(end - start, 23 * 60 * MIN);
    assert_eq!(iso_time_in(start, &zone), "2018-11-04T01:00:00.000-02:00");
    let (start, end) = day_bounds_in(&zone, "2019-02-16", "00:00");
    assert_eq!(end - start, 25 * 60 * MIN);
}

use crate::protocol::iso_time_in;

#[test]
fn days_are_dates_validated_like_javascript() {
    for good in ["2026-11-03", "2024-02-29", "0100-01-01", "9999-12-31"] {
        assert!(is_date(good), "{good}");
    }
    for bad in [
        "today",
        "2026-11-3",
        "2026-13-01",
        "2025-02-29",
        "2026-11-31",
        "0099-01-01",
        "2026-11-03T00:00",
        "\u{ff12}\u{ff10}\u{ff12}\u{ff16}-11-03",
        "2026/11/03",
    ] {
        assert!(!is_date(bad), "{bad}");
    }
}

#[test]
fn focus_spans_carry_their_source_and_reason_open_ones_end_now() {
    let mut phone = focus(at(11, 0), None, "b");
    phone.client_kind = Some("phone".into());
    phone.client_id = Some("ph".into());
    let timeline = build_timeline(&TimelineInput {
        focus: vec![focus(at(9, 0), Some(at(10, 0)), "a"), phone],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    assert_eq!(timeline["recorder_running"], true);
    assert_eq!(day["focus"].as_array().unwrap().len(), 2);
    assert_eq!(day["focus"][0]["source"], "browser");
    assert_eq!(day["focus"][0]["reason"], "switch");
    assert_eq!(day["focus"][0]["open"], false);
    assert_eq!(day["focus"][0]["workspace_id"], "a");
    assert_eq!(ms(&day["focus"][1]["end"]), at(18, 0));
    assert_eq!(day["focus"][1]["source"], "phone");
    assert_eq!(day["focus"][1]["open"], true);
    assert_eq!(day["focus"][1]["reason"], Value::Null);
    let ids: Vec<&str> = timeline["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a", "b"]);
}

#[test]
fn spans_are_clipped_to_the_range_and_split_across_days() {
    let from = day_bounds("2026-11-01", "00:00").0;
    let timeline = build_timeline(&TimelineInput {
        from: from as f64,
        focus: vec![focus(on("2026-11-01", 23, 0), Some(at(1, 0)), "a")],
        ..input()
    })
    .unwrap();
    let dates: Vec<&str> = timeline["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["date"].as_str().unwrap())
        .collect();
    assert_eq!(dates, ["2026-11-01", "2026-11-02"]);
    assert_eq!(timeline["days"][0]["totals"]["attended_ms"], 60 * MIN);
    assert_eq!(timeline["days"][1]["totals"]["attended_ms"], 60 * MIN);
    assert_eq!(ms(&timeline["days"][1]["focus"][0]["start"]), at(0, 0));
}

#[test]
fn browser_and_phone_attention_wins_herdr_only_fills_the_holes() {
    let mut hidden = focus(at(10, 0), Some(at(11, 0)), "a");
    hidden.reason = Some("hidden".into());
    let mut phone = focus(at(10, 30), Some(at(10, 45)), "b");
    phone.client_kind = Some("phone".into());
    phone.client_id = Some("ph".into());
    let timeline = build_timeline(&TimelineInput {
        focus: vec![herdr(focus(at(9, 0), Some(at(12, 0)), "c")), hidden, phone],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    assert_eq!(
        segments(day),
        vec![
            ("a".into(), "browser".into(), 30),
            ("b".into(), "phone".into(), 15),
            ("a".into(), "browser".into(), 15),
            ("c".into(), "herdr".into(), 5),
        ]
    );
    let c = workspace_totals(day, "c").unwrap();
    assert_eq!(
        (c["herdr_ms"].as_i64(), c["attended_ms"].as_i64()),
        (Some(5 * MIN), Some(5 * MIN))
    );
    let a = workspace_totals(day, "a").unwrap();
    assert_eq!(
        (a["browser_ms"].as_i64(), a["attended_ms"].as_i64()),
        (Some(45 * MIN), Some(45 * MIN))
    );
    assert_eq!(workspace_totals(day, "b").unwrap()["phone_ms"], 15 * MIN);
    assert_eq!(day["totals"]["attended_ms"], 65 * MIN);
    let herdr_span = day["focus"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["source"] == "herdr")
        .unwrap();
    assert_eq!(herdr_span["workspace_id"], "c");
}

#[test]
fn an_overnight_herdr_span_with_no_sign_of_a_person_is_not_attended() {
    let from = day_bounds("2026-11-01", "00:00").0;
    let evening = on("2026-11-01", 22, 44);
    let mut idle = focus(on("2026-11-01", 22, 0), Some(evening - 9 * MIN), "a");
    idle.reason = Some("idle".into());
    let timeline = build_timeline(&TimelineInput {
        from: from as f64,
        now: at(9, 0) as f64,
        sessions: vec![SessionRow {
            id: 1,
            started_at: evening,
            last_alive: at(9, 0) - MIN,
            stopped_at: None,
        }],
        focus: vec![
            idle,
            herdr(focus(evening, Some(at(8, 4)), "c")),
            herdr(focus(at(8, 4), None, "b")),
        ],
        ..input()
    })
    .unwrap();
    let yesterday = &timeline["days"][0];
    let today = &timeline["days"][1];
    assert_eq!(yesterday["totals"]["attended_ms"], 35 * MIN);
    assert_eq!(
        segments(yesterday)
            .iter()
            .map(|s| s.1.as_str())
            .collect::<Vec<_>>(),
        ["browser"]
    );
    assert_eq!(segments(today), vec![("b".into(), "herdr".into(), 5)]);
    assert_eq!(today["totals"]["attended_ms"], 5 * MIN);
    assert!(workspace_totals(today, "c").is_none());
}

fn hour_of(value: &Value) -> i64 {
    let at = ms(value);
    let date = day_of(at, "00:00");
    (at - day_bounds(&date, "00:00").0) / (60 * MIN)
}

#[test]
fn herdr_time_counts_after_input_a_page_brought_to_the_front_or_a_switch() {
    let desktop = |mut row: FocusRow| {
        row.connection_id = "desktop".into();
        herdr(row)
    };
    let mut hidden = presence(at(15, 0), "ui.visibility");
    hidden.visible = Some(false);
    let timeline = build_timeline(&TimelineInput {
        idle_ms: Some(10 * MIN),
        focus: vec![
            herdr(focus(at(8, 0), Some(at(17, 0)), "c")),
            desktop(focus(at(7, 0), Some(at(8, 0)), "b")),
            desktop(focus(at(9, 0), Some(at(9, 30)), "b")),
        ],
        presence: vec![
            presence(at(12, 0), "session.active"),
            presence(at(14, 0), "ui.visibility"),
            hidden,
        ],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    let got: Vec<(i64, String, i64)> = day["attention"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                hour_of(&s["start"]),
                s["workspace_id"].as_str().unwrap().to_owned(),
                (ms(&s["end"]) - ms(&s["start"])) / MIN,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (8, "c".into(), 10),
            (9, "c".into(), 10),
            (12, "c".into(), 10),
            (14, "c".into(), 10)
        ]
    );
    assert_eq!(day["totals"]["attended_ms"], 40 * MIN);
}

#[test]
fn idle_runs_from_session_idle_to_the_clients_next_sign_of_life() {
    let mut idle = focus(at(9, 0), Some(at(9, 55)), "a");
    idle.reason = Some("idle".into());
    let with_client = |mut row: PresenceRow, client: &str| {
        row.client_id = client.into();
        row
    };
    let first = presence(at(9, 55), "session.idle");
    let active = presence(at(10, 30), "session.active");
    let c2 = with_client(presence(at(12, 0), "session.idle"), "c2");
    let mut hidden = with_client(presence(at(12, 10), "ui.visibility"), "c2");
    hidden.visible = Some(false);
    let c3 = with_client(presence(at(17, 0), "session.idle"), "c3");
    let timeline = build_timeline(&TimelineInput {
        focus: vec![idle],
        presence: vec![first, active, c2, hidden, c3],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    let idle: Vec<(String, i64, bool)> = day["idle"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["client_id"].as_str().unwrap().to_owned(),
                (ms(&s["end"]) - ms(&s["start"])) / MIN,
                s["open"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        idle,
        vec![
            ("c1".into(), 35, false),
            ("c2".into(), 10, false),
            ("c3".into(), 60, true)
        ]
    );
    assert_eq!(day["totals"]["idle_ms"], 105 * MIN);
}

#[test]
fn agent_lanes_are_built_from_consecutive_states_cut_by_gaps() {
    let mut codex = agent(at(9, 0), "working");
    codex.pane_id = Some("p2".into());
    codex.name = "codex".into();
    let timeline = build_timeline(&TimelineInput {
        agents: vec![
            agent(at(9, 0), "working"),
            agent(at(10, 0), "blocked"),
            agent(at(10, 30), "working"),
            agent(at(12, 0), "idle"),
            agent(at(13, 0), "unknown"),
            codex,
        ],
        gaps: vec![GapInputRow {
            connection_id: Some("local".into()),
            start: at(11, 0),
            end: Some(at(11, 30)),
            reason: Some("x".into()),
        }],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    let lane = |name: &str| {
        day["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["agent"] == name)
            .unwrap()
            .clone()
    };
    let claude: Vec<(String, i64)> = lane("claude")["spans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["state"].as_str().unwrap().to_owned(),
                (ms(&s["end"]) - ms(&s["start"])) / MIN,
            )
        })
        .collect();
    assert_eq!(
        claude,
        vec![
            ("working".into(), 60),
            ("blocked".into(), 30),
            ("working".into(), 30),
            ("working".into(), 30),
            ("idle".into(), 60)
        ]
    );
    let codex = lane("codex");
    let last = codex["spans"].as_array().unwrap().last().unwrap();
    assert_eq!(
        (last["state"].as_str(), last["open"].as_bool()),
        (Some("working"), Some(true))
    );
    let totals = workspace_totals(day, "a").unwrap();
    assert_eq!(totals["working_ms"], (9 * 60 - 30) * MIN);
    assert_eq!(totals["blocked_ms"], 30 * MIN);
}

#[test]
fn a_stopped_recorder_ends_open_spans_at_its_last_stamp_and_leaves_a_gap() {
    let timeline = build_timeline(&TimelineInput {
        sessions: vec![SessionRow {
            id: 1,
            started_at: at(8, 0),
            last_alive: at(12, 0),
            stopped_at: None,
        }],
        focus: vec![focus(at(11, 0), None, "a")],
        agents: vec![agent(at(11, 0), "working")],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    assert_eq!(timeline["recorder_running"], false);
    assert_eq!(day["focus"][0]["open"], false);
    assert_eq!(ms(&day["focus"][0]["end"]), at(12, 0));
    assert_eq!(ms(&day["agents"][0]["spans"][0]["end"]), at(12, 0));
    let gaps = day["gaps"].as_array().unwrap();
    assert_eq!(gaps.len(), 1);
    assert!(gaps[0]["start"].is_string());
    assert_eq!(
        gaps[0],
        json!({"connection_id": null, "start": gaps[0]["start"], "end": null, "reason": "recorder", "excluded": false})
    );
    assert_eq!(day["totals"]["unrecorded_ms"], 6 * 60 * MIN);
}

#[test]
fn an_open_gap_spanning_days_ends_at_midnight_on_the_earlier_day() {
    let from = day_bounds("2026-11-01", "00:00").0;
    let timeline = build_timeline(&TimelineInput {
        from: from as f64,
        gaps: vec![GapInputRow {
            connection_id: Some("local".into()),
            start: on("2026-11-01", 22, 0),
            end: None,
            reason: Some("disconnected".into()),
        }],
        ..input()
    })
    .unwrap();
    assert_eq!(ms(&timeline["days"][0]["gaps"][0]["end"]), at(0, 0));
    assert_eq!(timeline["days"][1]["gaps"][0]["end"], Value::Null);
}

#[test]
fn an_invalid_range_is_refused() {
    assert!(
        build_timeline(&TimelineInput {
            from: f64::NAN,
            ..input()
        })
        .is_err()
    );
    assert!(
        build_timeline(&TimelineInput {
            to: (at(0, 0) - 1) as f64,
            ..input()
        })
        .is_err()
    );
}

#[test]
fn a_requests_range_is_whole_local_days_today_by_default() {
    let day = |date: &str, start: &str| day_bounds(date, start);
    assert_eq!(
        timeline_range(&json!({}), at(9, 0), "00:00"),
        Ok(day("2026-11-02", "00:00"))
    );
    assert_eq!(
        timeline_range(&json!({}), at(3, 0), "04:00"),
        Ok(day("2026-11-01", "04:00"))
    );
    assert_eq!(
        timeline_range(&json!({"from": "2026-11-01"}), at(9, 0), "00:00"),
        Ok(day("2026-11-01", "00:00"))
    );
    assert_eq!(
        timeline_range(
            &json!({"from": "2026-10-30", "to": "2026-11-01"}),
            at(9, 0),
            "00:00"
        ),
        Ok((
            day_bounds("2026-10-30", "00:00").0,
            day_bounds("2026-11-01", "00:00").1
        ))
    );
    assert!(timeline_range(&json!({"from": "x"}), at(9, 0), "00:00").is_err());
    assert!(
        timeline_range(
            &json!({"from": "2026-11-02", "to": "2026-11-01"}),
            at(9, 0),
            "00:00"
        )
        .is_err()
    );
    assert!(
        timeline_range(
            &json!({"from": "2025-01-01", "to": "2026-11-01"}),
            at(9, 0),
            "00:00"
        )
        .is_err()
    );
}

#[test]
fn totals_per_subject_add_up_its_workspaces_agents_overlap_once() {
    let subject = json!({
        "id": "dir:~/devel/gstreamer/ocio",
        "label": "ocio",
        "source": "directory",
        "path": "/src/ocio",
        "groups": [
            {"id": "dir:~/devel/gstreamer", "label": "gstreamer"},
            {"id": "dir:~/devel/gstreamer/ocio", "label": "ocio"},
        ],
    });
    let with_subject = |id: &str| {
        let mut w = workspace(id);
        w["subject"] = subject.clone();
        w
    };
    let lane = |ts: i64, state: &str, workspace: &str, pane: &str| {
        let mut row = agent(ts, state);
        row.workspace_id = Some(workspace.into());
        row.pane_id = Some(pane.into());
        row
    };
    let timeline = build_timeline(&TimelineInput {
        workspaces: vec![with_subject("a"), with_subject("b"), workspace("c")],
        focus: vec![
            focus(at(9, 0), Some(at(10, 0)), "a"),
            focus(at(10, 0), Some(at(11, 0)), "b"),
            focus(at(11, 0), Some(at(11, 30)), "c"),
        ],
        agents: vec![
            lane(at(9, 0), "working", "a", "pa"),
            lane(at(10, 0), "idle", "a", "pa"),
            lane(at(9, 30), "working", "b", "pb"),
            lane(at(10, 30), "idle", "b", "pb"),
        ],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    assert_eq!(
        day["totals"]["subjects"],
        json!([
            {
                "subject_id": subject["id"], "label": "ocio",
                "attended_ms": 120 * MIN, "browser_ms": 120 * MIN, "phone_ms": 0, "herdr_ms": 0,
                "working_ms": 90 * MIN, "blocked_ms": 0, "workspace_ids": ["a", "b"],
            },
            {
                "subject_id": null, "label": null,
                "attended_ms": 30 * MIN, "browser_ms": 30 * MIN, "phone_ms": 0, "herdr_ms": 0,
                "working_ms": 0, "blocked_ms": 0, "workspace_ids": ["c"],
            },
        ])
    );
    let a = timeline["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == "a")
        .unwrap();
    assert_eq!(a["subject"], subject);
}

#[test]
fn only_a_persons_causes_are_signs_loads_reconnects_follows_and_listings_are_not() {
    let caused = |mut row: FocusRow, cause: &str, end_cause: Option<&str>| {
        row.cause = Some(cause.into());
        row.end_cause = end_cause.map(str::to_owned);
        row
    };
    let desktop = |mut row: FocusRow| {
        row.connection_id = "desktop".into();
        herdr(row)
    };
    let mut reload = caused(focus(at(9, 0), Some(at(9, 6)), "a"), "reconnect", None);
    reload.reason = Some("idle".into());
    let presence_caused = |kind: &str, ts: i64, cause: &str| {
        let mut row = presence(ts, kind);
        row.cause = Some(cause.into());
        row
    };
    let timeline = build_timeline(&TimelineInput {
        idle_ms: Some(10 * MIN),
        focus: vec![
            caused(herdr(focus(at(8, 0), None, "c")), "recorder_start", None),
            reload,
            caused(
                desktop(focus(at(10, 0), Some(at(10, 30)), "b")),
                "herdr_listing",
                Some("herdr_listing"),
            ),
            caused(
                desktop(focus(at(11, 0), Some(at(11, 30)), "b")),
                "herdr_event",
                Some("herdr_listing"),
            ),
            caused(
                focus(at(13, 0), Some(at(13, 5)), "a"),
                "user_input",
                Some("follow_herdr"),
            ),
        ],
        presence: vec![
            presence_caused("ui.visibility", at(9, 0), "page_load"),
            presence_caused("ui.visibility", at(12, 0), "reconnect"),
            presence_caused("ui.visibility", at(14, 0), "user_focus"),
            presence_caused("session.active", at(15, 0), "user_input"),
        ],
        ..input()
    })
    .unwrap();
    let day = &timeline["days"][0];
    let got: Vec<(i64, i64, String, i64)> = day["attention"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let start = ms(&s["start"]);
            let minutes = (start - at(0, 0)) / MIN;
            (
                minutes / 60,
                minutes % 60,
                s["workspace_id"].as_str().unwrap().to_owned(),
                (ms(&s["end"]) - start) / MIN,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (11, 0, "b".into(), 10),
            (13, 0, "a".into(), 5),
            (13, 5, "c".into(), 10),
            (14, 0, "c".into(), 10),
            (15, 0, "c".into(), 10)
        ]
    );
    let reload = day["focus"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["workspace_id"] == "a")
        .unwrap();
    assert_eq!(reload["cause"], "reconnect");
}
