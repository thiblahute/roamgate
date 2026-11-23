use super::*;
use roamgate_base::paths::Platform;

const CLOCK: i64 = 1_000_000;

fn context(root: &Path) -> DataContext {
    DataContext::new(root, Platform::Unix, None)
}

fn feed(root: &Path) -> Feed {
    Feed::open(context(root), root.join("notifications.json"))
}

fn task(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn blocked() -> Map<String, Value> {
    task(json!({
        "kind": "blocked",
        "connectionId": "alpha",
        "runtimeGeneration": 3,
        "workspaceId": "w1",
        "workspaceLabel": "roamgate",
        "paneId": "p1",
        "agent": "Claude",
    }))
}

fn completed() -> Map<String, Value> {
    let mut task = blocked();
    task.insert("kind".into(), json!("completed"));
    task.insert("paneId".into(), json!("p2"));
    task
}

fn ranger() -> Map<String, Value> {
    task(json!({
        "task_id": "e68b82c6-0d6b-4083-b6b3-c3a7de983f94",
        "run_id": "9023a84e-e705-4c34-bcce-77c951e2de56",
        "status": "succeeded",
        "title": "Ranger task completed",
        "body": "Check agent progress",
    }))
}

fn tag_p1() -> String {
    serde_json::to_string(&json!(["roamgate-task", "alpha", 3, "p1"])).unwrap()
}

/// notification-feed.test.ts: "a notification is the push payload plus
/// its id, time, kind, group and page" (what the feed keeps; the socket's
/// `url` is the front's origin plus `path`).
#[test]
fn a_notification_is_the_push_payload_plus_its_id_time_kind_group_and_page() {
    let root = tempfile::tempdir().unwrap();
    let mut f = feed(root.path());
    let (event, _, change) = f.publish(&blocked(), &Extra::default(), CLOCK);
    assert_eq!(change.deliver, vec![1]);
    let target = json!({
        "connectionId": "alpha",
        "runtimeGeneration": 3,
        "workspaceId": "w1",
        "paneId": "p1",
    });
    assert_eq!(
        Value::Object(event),
        json!({
            "event": "notification",
            "id": 1,
            "at": CLOCK,
            "kind": "blocked",
            "title": "Roamgate agent needs input",
            "body": "Claude \u{b7} roamgate \u{b7} p1",
            "tag": tag_p1(),
            "group": "roamgate",
            "path": format!(
                "/#roamgate-task={}",
                crate::payload::encode_uri_component(&target.to_string())
            ),
            "pref": "blocked",
            "pane": "alpha\np1",
        })
    );
    let (event, _, _) = f.publish(&ranger(), &Extra::default(), CLOCK);
    assert_eq!(event["id"], 2);
    assert_eq!(event["kind"], "ranger_task");
    assert_eq!(event["group"], "Ranger");
    assert_eq!(event["title"], "Ranger task completed");
    assert!(!event.contains_key("pane"));
    let mut look = blocked();
    look.insert("title".into(), json!("Look"));
    look.insert("body".into(), json!("at this"));
    let extra = Extra {
        kind: Some(json!("review")),
        ..Extra::default()
    };
    let (event, _, _) = f.publish(&look, &extra, CLOCK);
    assert_eq!(
        (event["id"].clone(), event["kind"].clone()),
        (json!(3), json!("review"))
    );
    assert_eq!(event["title"], "Look");
}

/// notification-feed.test.ts: "the feed and its ids live through a
/// restart".
#[test]
fn the_feed_and_its_ids_live_through_a_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut first = feed(root.path());
    first.publish(&blocked(), &Extra::default(), CLOCK);
    first.publish(&completed(), &Extra::default(), CLOCK);
    let text = std::fs::read_to_string(root.path().join("notifications.json")).unwrap();
    assert!(text.ends_with("}\n"));
    let saved: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(saved["last"], 2);
    let mut second = feed(root.path());
    assert_eq!(second.saved().events.len(), 2);
    let (event, _, _) = second.publish(&ranger(), &Extra::default(), CLOCK);
    assert_eq!(event["id"], 3);
}

/// notification-feed.test.ts: "old events are dropped after a day, and
/// beyond 200".
#[test]
fn old_events_are_dropped_after_a_day_and_beyond_200() {
    let root = tempfile::tempdir().unwrap();
    let mut f = feed(root.path());
    f.publish(&blocked(), &Extra::default(), CLOCK);
    let later = CLOCK + 25 * 60 * 60 * 1000;
    for n in 0..205 {
        let mut task = completed();
        task.insert("paneId".into(), json!(format!("p{}", n + 10)));
        f.publish(&task, &Extra::default(), later);
    }
    let ids: Vec<i64> = f
        .saved()
        .events
        .iter()
        .map(|event| event["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids.len(), 200);
    assert_eq!(ids[0], 7);
    assert_eq!(f.saved().last, 206);
    assert_eq!(load(&context(root.path()), f.path()), f.saved().clone());
}

/// notification-feed.test.ts: "a clear goes out only for a notification
/// still out".
#[test]
fn a_clear_goes_out_only_for_a_notification_still_out() {
    let root = tempfile::tempdir().unwrap();
    let mut f = feed(root.path());
    assert!(!f.clear_pane("alpha", "p1", CLOCK).changed());
    f.publish(&blocked(), &Extra::default(), CLOCK);
    f.publish(&completed(), &Extra::default(), CLOCK);
    // The agent went back to work: its blocked notification is withdrawn,
    // the completed one of another pane stays.
    assert_eq!(f.clear_blocked_pane("alpha", "p1", CLOCK).deliver, vec![3]);
    assert!(!f.clear_blocked_pane("alpha", "p2", CLOCK).changed());
    assert_eq!(
        Value::Object(f.saved().events.last().unwrap().clone()),
        json!({ "event": "notification_clear", "id": 3, "at": CLOCK, "tag": tag_p1() })
    );
    assert_eq!(f.clear_pane("alpha", "p2", CLOCK).deliver, vec![4]);
}

/// notification-feed.test.ts: "an action answers the agent's permission
/// prompt": what the feed keeps of it (the front answers the prompt).
#[test]
fn an_action_answers_the_agent_s_permission_prompt() {
    let root = tempfile::tempdir().unwrap();
    let mut f = feed(root.path());
    let actions = json!([{ "id": "allow", "label": "Allow" }, { "id": "deny", "label": "Deny" }]);
    let extra = Extra {
        actions: Some(actions.clone()),
        prompt: Some(json!({ "connectionId": "alpha", "promptId": "prompt-1" })),
        ..Extra::default()
    };
    let (event, _, _) = f.publish(&blocked(), &extra, CLOCK);
    assert_eq!(event["actions"], actions);
    // A blocked status for the same pane keeps the prompt's actions (after
    // the pane, as Bun adds them).
    let (again, _, _) = f.publish(&blocked(), &Extra::default(), CLOCK);
    assert_eq!(again["actions"], actions);
    assert_eq!(
        again.keys().rev().take(3).collect::<Vec<_>>(),
        ["actions", "prompt", "pane"]
    );
    // Nor does the agent's status withdraw it: the prompt does.
    assert!(!f.clear_blocked_pane("alpha", "p1", CLOCK).changed());
    assert_eq!(f.clear_prompt("prompt-1", CLOCK).deliver, vec![3]);
    assert!(
        f.saved()
            .events
            .iter()
            .all(|event| event["event"] == "notification_clear")
    );
}

/// The file Bun wrote is read as Bun reads it: invalid events dropped,
/// unknown fields and the order of the rest kept, integral doubles as
/// integers, and a file that is not a feed (or too large) as none.
#[test]
fn reads_the_file_as_bun_does() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("notifications.json");
    std::fs::write(
        &path,
        r#"{"version":1,"last":5.0,"events":[
          {"event":"notification","id":4,"at":1.5,"kind":"work","title":"t","body":"b","tag":"x","group":"g","path":"/","pref":"blocked","extra":true},
          {"event":"notification","id":5,"at":2,"title":"t","body":"b","tag":"y","group":"g","path":"/","pref":"maybe"},
          {"event":"notification_clear","id":3,"at":1,"tag":"z"},
          {"event":"other","id":6,"at":1,"tag":"w"},
          [1]
        ]}"#,
    )
    .unwrap();
    let saved = load(&context(root.path()), &path);
    assert_eq!(saved.last, 5);
    assert_eq!(
        saved
            .events
            .iter()
            .map(|event| event["id"].clone())
            .collect::<Vec<_>>(),
        [json!(4), json!(3)]
    );
    assert_eq!(saved.events[0]["extra"], true);
    for invalid in [
        r#"{"version":2,"last":0,"events":[]}"#,
        r#"{"version":1,"last":0.5,"events":[]}"#,
        r#"{"version":1,"last":0}"#,
        "not json",
    ] {
        std::fs::write(&path, invalid).unwrap();
        assert_eq!(
            load(&context(root.path()), &path),
            Saved::default(),
            "{invalid}"
        );
    }
    std::fs::write(&path, vec![b' '; (MAX_FILE_BYTES + 1) as usize]).unwrap();
    assert_eq!(load(&context(root.path()), &path), Saved::default());
}
