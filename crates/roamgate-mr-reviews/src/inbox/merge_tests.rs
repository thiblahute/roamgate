//! inbox.merge.test.ts: scheduled merges and merge bots (section 15)
//! through the inbox, against the fake forge: what the rows say, their
//! lanes, and what it costs.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_agents::js::{self, Obj};
use serde_json::json;

use super::own_forge::{FakeRequest, ForgeOptions, Note, OwnForge};
use super::test_support::*;
use super::{MrInbox, MrInboxDeps};
use crate::inference::{meaningful, row_facts};
use crate::settings::{mr_reviews_settings, normalize_stored_mr_reviews, stored_mr_reviews};
use crate::shared::filter::{matches, parse};

const HOUR: f64 = 3_600_000.0;
const DAY: f64 = 24.0 * HOUR;
const NOW: &str = "2026-11-16T12:00:00Z";

fn now() -> f64 {
    js::date_parse(NOW)
}

fn ago(ms: f64) -> String {
    js::iso(now() - ms)
}

fn filter(entry: &Obj, text: &str) -> bool {
    matches(entry, &parse(text))
}

fn request(number: u64) -> FakeRequest {
    FakeRequest {
        project: "media/engine".into(),
        number,
        state: "open",
        created_at: ago(10.0 * DAY + number as f64),
        updated_at: ago(5.0 * HOUR),
        pipeline: Some("success"),
        ..FakeRequest::default()
    }
}

fn note(author: &str, at: String, body: &str, system: bool) -> Note {
    Note {
        author: author.into(),
        at,
        body: body.into(),
        system,
    }
}

fn gitlab_requests() -> Vec<FakeRequest> {
    vec![
        FakeRequest {
            labels: vec!["Merge after: 2 days".into()],
            label_events: vec![("Merge after: 2 days".into(), None, ago(DAY))],
            ..request(1)
        },
        FakeRequest {
            assignees: vec!["marge-bot".into()],
            ..request(2)
        },
        FakeRequest {
            pipeline: Some("failed"),
            notes: vec![
                note("me", ago(3.0 * HOUR), "assigned to @marge-bot", true),
                note(
                    "marge-bot",
                    ago(2.0 * HOUR),
                    "I couldn't merge this branch: CI failed!",
                    false,
                ),
                note(
                    "marge-bot",
                    ago(2.0 * HOUR - 1000.0),
                    "unassigned @marge-bot",
                    true,
                ),
            ],
            ..request(3)
        },
        FakeRequest {
            labels: vec!["merge-after: 1 day".into()],
            label_events: vec![("merge-after: 1 day".into(), None, ago(3.0 * DAY))],
            ..request(4)
        },
        request(5),
    ]
}

fn gitlab_settings() -> Obj {
    settings(json!({"hosts": [{"host": "gitlab.example.org", "provider": "gitlab"}]}))
}

struct Merging {
    _dir: tempfile::TempDir,
    inbox: MrInbox,
}

fn inbox_with(
    forge: &Arc<OwnForge>,
    settings: &Obj,
    clock: Arc<Mutex<f64>>,
    on_change: Option<Arc<dyn Fn() + Send + Sync>>,
) -> Merging {
    let (dir, shared_store) = store();
    let mut deps = MrInboxDeps::new(forge.clone(), fixed(settings), shared_store);
    deps.now = Arc::new(move || *clock.lock().unwrap());
    deps.on_change = on_change;
    Merging {
        _dir: dir,
        inbox: MrInbox::new(deps),
    }
}

fn gitlab_forge(requests: Vec<FakeRequest>) -> Arc<OwnForge> {
    OwnForge::new(
        "gitlab",
        "gitlab.example.org",
        requests,
        ForgeOptions::default(),
    )
}

#[tokio::test]
async fn rows_lanes_and_next_steps() {
    let settings = gitlab_settings();
    let forge = gitlab_forge(gitlab_requests());
    let t = inbox_with(&forge, &settings, clock(NOW), None);
    t.inbox.refresh().await;
    let rows = entries(&t.inbox, &settings);

    let scheduled = by_number(&rows, 1);
    let after = &scheduled["merge"]["after"];
    assert_eq!(after["label"], json!("Merge after: 2 days"));
    assert_eq!(after["from"], json!("label"));
    assert_eq!(after["since"], json!(ago(DAY)));
    assert_eq!(after["at"], json!(js::iso(now() + DAY)));
    assert_eq!(after["ready"], json!(false));
    assert_eq!(scheduled["lane"], json!("waiting"));
    assert_eq!(scheduled["laneWhy"], json!("merge after 2 days"));
    assert!(js::sv(scheduled["next"].get("text")).contains("Waiting on time"));
    assert!(filter(&scheduled, "waiting:time"));
    assert!(filter(&scheduled, "merge-after:waiting"));
    assert!(!filter(&scheduled, "waiting:reviewer"));

    let merging = by_number(&rows, 2);
    assert_eq!(
        merging["merge"]["bot"],
        json!({"name": "marge-bot", "via": "assignee", "queued": true})
    );
    assert_eq!(merging["lane"], json!("merging"));
    assert_eq!(merging["laneWhy"], json!("queued to merge by marge-bot"));
    assert!(filter(&merging, "state:merging"));
    assert!(filter(&merging, "bot:marge-bot"));
    assert!(filter(&merging, "waiting:marge-bot"));
    assert!(filter(&merging, "lane:merging"));

    let failed = by_number(&rows, 3);
    assert_eq!(
        failed["merge"]["bot"]["failed"],
        json!({"reason": "CI failed!", "at": ago(2.0 * HOUR - 1000.0)})
    );
    assert_eq!(failed["lane"], json!("your_move"));
    assert_eq!(
        failed["next"]["text"],
        json!("marge-bot could not merge: CI failed!")
    );
    assert!(filter(&failed, "bot:failed"));

    let ready = by_number(&rows, 4);
    assert_eq!(ready["merge"]["after"]["ready"], json!(true));
    assert_eq!(ready["lane"], json!("your_move"));
    assert_eq!(
        ready["next"]["text"],
        json!("Merge it: the merge-after delay (1 day) is over")
    );
    assert!(filter(&ready, "merge-after:ready"));

    let plain = by_number(&rows, 5);
    assert!(plain.get("merge").is_none());
    assert_eq!(plain["lane"], json!("waiting"));
    assert!(filter(&plain, "merge-after:no"));
    assert!(filter(&plain, "-bot:any"));
}

fn label_numbers(calls: &[super::own_forge::FakeCall]) -> Vec<u64> {
    let mut out: Vec<u64> = calls
        .iter()
        .filter(|c| c.kind == "labels")
        .flat_map(|c| c.numbers.clone())
        .collect();
    out.sort();
    out
}

#[tokio::test]
async fn label_times_are_read_once_per_label_change_never_on_a_steady_refresh() {
    let settings = gitlab_settings();
    let time = clock(NOW);
    let forge = gitlab_forge(gitlab_requests());
    let t = inbox_with(&forge, &settings, time.clone(), None);
    t.inbox.refresh().await;
    assert_eq!(label_numbers(&forge.take()), [1, 4]);

    // Nothing changed: the list only.
    *time.lock().unwrap() += 10.0 * 60_000.0;
    t.inbox.refresh().await;
    let kinds: Vec<&str> = forge
        .take()
        .iter()
        .map(|c| c.kind)
        .filter(|k| *k != "inbox")
        .collect();
    assert_eq!(kinds, ["list"]);

    // A comment on 1: its details again, its label times kept.
    let at = js::iso(*time.lock().unwrap());
    forge.update(|list| {
        list.into_iter()
            .map(|r| {
                if r.number == 1 {
                    FakeRequest {
                        updated_at: at.clone(),
                        ..r
                    }
                } else {
                    r
                }
            })
            .collect()
    });
    *time.lock().unwrap() += 10.0 * 60_000.0;
    t.inbox.refresh().await;
    let second = forge.take();
    let details: Vec<u64> = second
        .iter()
        .filter(|c| c.kind == "details")
        .flat_map(|c| c.numbers.clone())
        .collect();
    assert_eq!(details, [1]);
    assert!(!second.iter().any(|c| c.kind == "labels"));
    assert_eq!(
        by_number(&entries(&t.inbox, &settings), 1)["merge"]["after"]["from"],
        json!("label")
    );

    // Its label changed: read once more.
    let at = js::iso(*time.lock().unwrap());
    forge.update(|list| {
        list.into_iter()
            .map(|r| {
                if r.number == 1 {
                    FakeRequest {
                        updated_at: at.clone(),
                        labels: vec!["Merge after: 3 days".into()],
                        label_events: vec![("Merge after: 3 days".into(), None, at.clone())],
                        ..r
                    }
                } else {
                    r
                }
            })
            .collect()
    });
    *time.lock().unwrap() += 10.0 * 60_000.0;
    t.inbox.refresh().await;
    assert_eq!(label_numbers(&forge.take()), [1]);
    assert_eq!(
        by_number(&entries(&t.inbox, &settings), 1)["merge"]["after"]["delay"],
        json!("3 days")
    );
}

#[tokio::test]
async fn a_scope_turning_the_bots_off_there_and_a_projects_own_label() {
    let scoped = settings(json!({
        "hosts": [{"host": "gitlab.example.org", "provider": "gitlab"}],
        "merge": {"scopes": {"gitlab.example.org/media/*": {"bots": [], "afterLabels": ["^soak (?<delay>.+)$"]}}},
    }));
    let mut requests = vec![gitlab_requests().remove(1)];
    requests.push(FakeRequest {
        labels: vec!["soak 1 week".into()],
        ..request(6)
    });
    let forge = gitlab_forge(requests);
    let t = inbox_with(&forge, &scoped, clock(NOW), None);
    t.inbox.refresh().await;
    let rows = entries(&t.inbox, &scoped);
    assert!(by_number(&rows, 2).get("merge").is_none());
    assert_eq!(by_number(&rows, 2)["lane"], json!("waiting"));
    assert_eq!(
        by_number(&rows, 6)["merge"]["after"]["delay"],
        json!("1 week")
    );
}

#[tokio::test]
async fn an_override_still_wins_over_the_merge_facts() {
    let settings = gitlab_settings();
    let forge = gitlab_forge(gitlab_requests());
    let t = inbox_with(&forge, &settings, clock(NOW), None);
    t.inbox.refresh().await;
    let two = by_number(&entries(&t.inbox, &settings), 2);
    let key = super::key_of(&two).to_owned();
    let marker = format!("{}|3|open", js::sv(two.get("headSha")));
    let mut with_override = settings.clone();
    with_override["overrides"] =
        json!({key: {"whose": "me", "at": ago(HOUR), "by": "user", "marker": marker}});
    assert_eq!(
        by_number(&entries(&t.inbox, &with_override), 2)["lane"],
        json!("your_move")
    );
}

#[tokio::test(start_paused = true)]
async fn the_time_passing_moves_the_row_wakes_the_board_and_is_a_meaningful_event() {
    let settings = gitlab_settings();
    let time = clock(NOW);
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = changes.clone();
    let forge = gitlab_forge(gitlab_requests().into_iter().take(1).collect());
    let t = inbox_with(
        &forge,
        &settings,
        time.clone(),
        Some(Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        })),
    );
    t.inbox.refresh().await;
    let before = by_number(&entries(&t.inbox, &settings), 1);
    assert_eq!(before["lane"], json!("waiting"));
    let facts_before = row_facts(&before, &[], "me");
    changes.store(0, Ordering::SeqCst);
    *time.lock().unwrap() += DAY + 2_000.0;
    tokio::time::advance(Duration::from_millis((DAY + 2_000.0) as u64)).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    assert!(changes.load(Ordering::SeqCst) > 0);
    let after = by_number(&entries(&t.inbox, &settings), 1);
    assert_eq!(after["lane"], json!("your_move"));
    assert!(meaningful(&facts_before, &row_facts(&after, &[], "me")));
}

#[tokio::test]
async fn auto_merge_the_merge_queue_a_removal_and_a_label_time_from_the_timeline() {
    let settings = settings(json!({"hosts": [{"host": "github.com", "provider": "github"}]}));
    let widgets = |number: u64| FakeRequest {
        project: "acme/widgets".into(),
        ..request(number)
    };
    let requests = vec![
        FakeRequest {
            auto_merge: Some(("me".into(), ago(HOUR))),
            timeline: vec![
                json!({"__typename": "AutoMergeEnabledEvent", "createdAt": ago(HOUR), "actor": {"login": "me"}}),
            ],
            ..widgets(11)
        },
        FakeRequest {
            queue: Some((2, ago(HOUR))),
            ..widgets(12)
        },
        FakeRequest {
            timeline: vec![
                json!({"__typename": "AddedToMergeQueueEvent", "createdAt": ago(3.0 * HOUR), "actor": {"login": "me"}}),
                json!({"__typename": "RemovedFromMergeQueueEvent", "createdAt": ago(2.0 * HOUR), "actor": {"login": "github-merge-queue"}, "reason": "FAILED_CHECKS"}),
            ],
            ..widgets(13)
        },
        FakeRequest {
            labels: vec!["merge after 2 days".into()],
            timeline: vec![
                json!({"__typename": "LabeledEvent", "createdAt": ago(HOUR), "actor": {"login": "me"}, "label": {"name": "merge after 2 days"}}),
            ],
            ..widgets(14)
        },
    ];
    let forge = OwnForge::new("github", "github.com", requests, ForgeOptions::default());
    let t = inbox_with(&forge, &settings, clock(NOW), None);
    t.inbox.refresh().await;
    // No call beyond the list and the details.
    let mut kinds: Vec<&str> = forge.take().iter().map(|c| c.kind).collect();
    kinds.sort();
    kinds.dedup();
    assert_eq!(kinds, ["details", "inbox", "list"]);
    let rows = entries(&t.inbox, &settings);
    assert_eq!(
        by_number(&rows, 11)["laneWhy"],
        json!("auto-merge set by me")
    );
    assert_eq!(by_number(&rows, 11)["lane"], json!("merging"));
    assert_eq!(
        by_number(&rows, 12)["laneWhy"],
        json!("#2 in the merge queue")
    );
    assert_eq!(by_number(&rows, 13)["lane"], json!("your_move"));
    assert_eq!(
        by_number(&rows, 13)["laneWhy"],
        json!("left the merge queue")
    );
    assert_eq!(
        by_number(&rows, 11)["next"]["text"],
        json!("Merges itself once the pipeline succeeds")
    );
    assert_eq!(
        by_number(&rows, 13)["next"]["text"],
        json!("Removed from the merge queue: failed checks")
    );
    let after = &by_number(&rows, 14)["merge"]["after"];
    assert_eq!(after["from"], json!("label"));
    assert_eq!(after["since"], json!(ago(HOUR)));
    assert_eq!(after["ready"], json!(false));
}

#[test]
fn checked_kept_as_stored_and_back() {
    let stored = normalize_stored_mr_reviews(Some(&json!({
        "merge": {
            "after_labels": ["^soak (?<delay>.+)$", "^broken ("],
            "bots": ["@Marge-Bot", "mergify[bot]", "not a name!"],
            "scopes": {
                "https://GitLab.example.org/media/*": {"bots": []},
                "bad scope!": {"bots": ["x"]},
                "gitlab.example.org": {"nothing": 1},
            },
        },
    })))
    .unwrap();
    assert_eq!(
        stored["merge"],
        json!({
            "after_labels": ["^soak (?<delay>.+)$"],
            "bots": ["marge-bot", "mergify"],
            "scopes": {"gitlab.example.org/media/*": {"bots": []}},
        })
    );
    let settings = mr_reviews_settings(stored.as_object());
    assert_eq!(
        settings["merge"],
        json!({
            "afterLabels": ["^soak (?<delay>.+)$"],
            "bots": ["marge-bot", "mergify"],
            "scopes": {"gitlab.example.org/media/*": {"bots": []}},
        })
    );
    assert_eq!(stored_mr_reviews(&settings)["merge"], stored["merge"]);
    // All defaults: nothing written.
    assert!(
        stored_mr_reviews(&mr_reviews_settings(None))
            .get("merge")
            .is_none()
    );
}
