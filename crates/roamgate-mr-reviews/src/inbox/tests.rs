//! inbox.test.ts (the inbox) and complexity.test.ts (the inbox under a
//! GitLab complexity limit).

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use roamgate_forge::complexity::estimate_complexity;
use serde_json::{Value, json};

use super::own_forge::{FakeRequest, ForgeOptions, OwnForge, fake_requests};
use super::test_support::*;
use crate::connection::BoxFuture;
use crate::fetchers::{FetchCall, FetchError, FetchResult, InboxFetchers};
use crate::queries::{gitlab_own_list_query, own_details_query};

fn inbox_settings() -> Obj {
    settings(json!({
        "hosts": [
            {"host": "gitlab.example.org", "provider": "gitlab"},
            {"host": "github.com", "provider": "github"},
            {"host": "gitlab.nologin.org", "provider": "gitlab"},
        ],
        "followed": [{"host": "gitlab.example.org", "provider": "gitlab", "project": "group/app"}],
    }))
}

struct Fake {
    calls: Arc<Mutex<Vec<String>>>,
    notes: Arc<AtomicU64>,
}

fn fake_fetchers(gitlab: Option<super::test_support::FnFetchers>) -> (Arc<FnFetchers>, Fake) {
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let notes = Arc::new(AtomicU64::new(1));
    let mut fetchers = FnFetchers::default();
    {
        let (calls, notes) = (calls.clone(), notes.clone());
        fetchers.gitlab = Box::new(move |host, query| {
            calls.lock().unwrap().push(format!("gitlab {host}"));
            if host == "gitlab.nologin.org" {
                return Err(FetchError::NotSignedIn(
                    "Not signed in to gitlab.nologin.org".into(),
                ));
            }
            if query.contains("authoredMergeRequests") {
                return Ok(
                    json!({"data": {"currentUser": {"username": "me", "au": {"nodes": []}}}}),
                );
            }
            assert!(query.contains("project(fullPath: \"group/app\")"));
            Ok(json!({"data": {
                "currentUser": {
                    "username": "me",
                    "rr": {"nodes": [gitlab_mr(1, json!({"userNotesCount": notes.load(Ordering::SeqCst)}))]},
                    "as": {"nodes": []},
                    "todos": {"nodes": []},
                },
                "f0": {"mergeRequests": {"nodes": [gitlab_mr(1, json!({})), gitlab_mr(2, json!({}))]}},
            }}))
        });
    }
    {
        let calls = calls.clone();
        fetchers.github = Box::new(move |host, _| {
            calls.lock().unwrap().push(format!("github {host}"));
            Ok(json!({"data": {"viewer": {"login": "me"}}}))
        });
    }
    {
        let calls = calls.clone();
        fetchers.drafts = Box::new(move |item| {
            calls
                .lock()
                .unwrap()
                .push(format!("drafts {}", number(item)));
            Ok(2)
        });
    }
    if let Some(over) = gitlab {
        fetchers.gitlab = over.gitlab;
    }
    (Arc::new(fetchers), Fake { calls, notes })
}

fn gitlab_only(
    answer: impl Fn(&str, &str) -> FetchResult<Value> + Send + Sync + 'static,
) -> FnFetchers {
    FnFetchers {
        gitlab: Box::new(answer),
        ..FnFetchers::default()
    }
}

const KEY1: &str = "gitlab:gitlab.example.org/group/app#1";

#[tokio::test]
async fn lists_the_users_requests_per_host_says_which_hosts_failed() {
    let (fetchers, fake) = fake_fetchers(None);
    let now = clock("2026-11-04T12:00:00Z");
    let (_dir, shared_store) = store();
    // Draft counts are read only for requests reviewed in Roamgate.
    shared_store
        .lock()
        .unwrap()
        .update(|state| {
            state["reviews"][KEY1] = json!({"connectionId": "c", "sessionId": "s"});
        })
        .unwrap();
    let settings = inbox_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, Some(now.clone()));
    inbox.refresh().await;
    let drafts: Vec<String> = fake
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.starts_with("drafts"))
        .cloned()
        .collect();
    assert_eq!(drafts, ["drafts 1"]);
    let snapshot = inbox.snapshot(&settings);
    let rows: Vec<(u64, String)> = entries(&inbox, &settings)
        .iter()
        .map(|e| (number(e), js::sv(e.get("section")).to_owned()))
        .collect();
    assert_eq!(rows, [(1, "mine".to_owned())]);
    // The followed project's other request is no suggestion until picked.
    // A host's first answer is the baseline: nothing is "new" in it.
    let first = &snapshot["entries"][0];
    assert_eq!(first["isNew"], json!(false));
    assert_eq!(first["unread"]["changed"], json!(false));
    assert_eq!(first["drafts"], json!(2));
    let hosts: Vec<(&str, &str)> = snapshot["hosts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (js::sv(h.get("host")), js::sv(h.get("state"))))
        .collect();
    assert_eq!(
        hosts,
        [
            ("gitlab.example.org", "ok"),
            ("github.com", "ok"),
            ("gitlab.nologin.org", "not_signed_in"),
        ]
    );
    // Drafts are read again only after their TTL.
    fake.calls.lock().unwrap().clear();
    *now.lock().unwrap() += 60_000.0;
    inbox.refresh().await;
    assert!(!fake.calls.lock().unwrap().contains(&"drafts 1".to_owned()));
}

#[tokio::test]
async fn a_request_that_comes_after_the_baseline_is_new() {
    let second = Arc::new(AtomicBool::new(false));
    let flag = second.clone();
    let (fetchers, _) = fake_fetchers(Some(gitlab_only(move |host, _| {
        if host != "gitlab.example.org" {
            return Err(FetchError::NotSignedIn("no".into()));
        }
        let nodes = if flag.load(Ordering::SeqCst) {
            json!([gitlab_mr(1, json!({})), gitlab_mr(5, json!({}))])
        } else {
            json!([gitlab_mr(1, json!({}))])
        };
        Ok(json!({"data": {"currentUser": {"username": "me", "rr": {"nodes": nodes}}}}))
    })));
    let (_dir, shared_store) = store();
    let settings = inbox_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    second.store(true, Ordering::SeqCst);
    inbox.refresh().await;
    let rows = entries(&inbox, &settings);
    assert_eq!(by_number(&rows, 1)["isNew"], json!(false));
    assert_eq!(by_number(&rows, 5)["isNew"], json!(true));
}

#[tokio::test]
async fn unread_follows_what_the_user_saw() {
    let (fetchers, fake) = fake_fetchers(None);
    let (_dir, shared_store) = store();
    let settings = inbox_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    assert!(inbox.mark_seen(KEY1));
    let entry = entries(&inbox, &settings)[0].clone();
    assert_eq!(entry["isNew"], json!(false));
    assert_eq!(entry["unread"]["changed"], json!(false));
    fake.notes.store(4, Ordering::SeqCst);
    inbox.refresh().await;
    let entry = entries(&inbox, &settings)[0].clone();
    assert_eq!(
        entry["unread"],
        json!({"newCommits": false, "newNotes": 3, "changed": true})
    );
}

#[tokio::test]
async fn a_host_that_fails_keeps_its_requests() {
    let (fetchers, _) = fake_fetchers(None);
    let (_dir, shared_store) = store();
    let settings = inbox_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    let (failing_fetchers, _) = fake_fetchers(Some(gitlab_only(|_, _| Err(failed("timeout")))));
    let failing = inbox_of(failing_fetchers, fixed(&settings), &shared_store, None);
    failing.refresh().await;
    let snapshot = failing.snapshot(&settings);
    let numbers: Vec<u64> = entries(&failing, &settings).iter().map(number).collect();
    assert_eq!(numbers, [1]);
    assert_eq!(snapshot["hosts"][0]["state"], json!("error"));
}

#[tokio::test]
async fn suggestions_picked_ones_show_not_interested_ones_go() {
    let (fetchers, _) = fake_fetchers(None);
    let (_dir, shared_store) = store();
    let settings = inbox_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    let key = "gitlab:gitlab.example.org/group/app#2";
    shared_store
        .lock()
        .unwrap()
        .update(|state| {
            state["ranked"][key] = json!({
                "updatedAt": "2026-11-03T10:00:00Z",
                "pick": true,
                "score": 80,
                "reason": "touches files you changed",
                "at": "now",
            });
        })
        .unwrap();
    let suggested: Vec<(u64, Value)> = section(&inbox, &settings, "suggested")
        .iter()
        .map(|e| (number(e), e["reason"].clone()))
        .collect();
    assert_eq!(suggested, [(2, json!("touches files you changed"))]);
    inbox.feedback(key, Some("not_interested"));
    assert!(section(&inbox, &settings, "suggested").is_empty());
    let feedback: Vec<(String, String)> = shared_store.lock().unwrap().get()["feedback"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                js::sv(f.get("key")).to_owned(),
                js::sv(f.get("verdict")).to_owned(),
            )
        })
        .collect();
    assert_eq!(feedback, [(key.to_owned(), "not_interested".to_owned())]);
}

#[tokio::test]
async fn a_closed_requests_review_starts_aging() {
    let (_dir, shared_store) = store();
    shared_store
        .lock()
        .unwrap()
        .update(|state| {
            state["reviews"][KEY1] = json!({"connectionId": "c", "sessionId": "s"});
        })
        .unwrap();
    let (fetchers, _) = fake_fetchers(Some(gitlab_only(|_, _| {
        Ok(json!({"data": {"currentUser": {
            "username": "me",
            "rr": {"nodes": [gitlab_mr(1, json!({"state": "merged"}))]},
        }}}))
    })));
    let mut settings = inbox_settings();
    settings["hosts"] = json!([{"host": "gitlab.example.org", "provider": "gitlab"}]);
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    assert!(shared_store.lock().unwrap().get()["reviews"][KEY1]["closedAt"].is_string());
}

// complexity.test.ts: the inbox under a GitLab complexity limit.

const FREEDESKTOP: &str = "gitlab.freedesktop.org";
const FOLLOWED: [&str; 3] = [
    "gstreamer/gstreamer",
    "gstreamer/gst-plugins-rs",
    "gstreamer/gstreamer-rs",
];

fn complexity_settings() -> Obj {
    settings(json!({
        "hosts": [{"host": FREEDESKTOP, "provider": "gitlab"}],
        "followed": FOLLOWED.iter().map(|p| json!({"host": FREEDESKTOP, "provider": "gitlab", "project": p})).collect::<Vec<_>>(),
    }))
}

fn hour_at(index: usize) -> String {
    js::iso(js::date_parse("2026-11-10T00:00:00Z") + index as f64 * 3_600_000.0)
}

fn mine() -> Vec<FakeRequest> {
    let projects = [
        "gstreamer/gstreamer",
        "gstreamer/gst-plugins-rs",
        "gstreamer/cerbero",
        "gstreamer/orc",
        "gstreamer/gstreamer-rs",
        "pipewire/wireplumber",
    ];
    fake_requests(30, "open", hour_at, 1, &projects)
        .into_iter()
        .map(|r| FakeRequest {
            pipeline: Some("success"),
            approved_by: vec!["bob".into()],
            ..r
        })
        .collect()
}

fn others() -> Vec<FakeRequest> {
    FOLLOWED
        .iter()
        .enumerate()
        .map(|(index, project)| FakeRequest {
            project: (*project).into(),
            number: 900 + index as u64,
            state: "open",
            created_at: hour_at(index),
            updated_at: hour_at(index),
            ..FakeRequest::default()
        })
        .collect()
}

fn complexity_inbox(
    fetchers: Arc<dyn InboxFetchers>,
) -> (tempfile::TempDir, SharedStore, super::MrInbox) {
    let (dir, shared_store) = store();
    let inbox = inbox_of(
        fetchers,
        fixed(&complexity_settings()),
        &shared_store,
        Some(clock("2026-11-17T12:00:00Z")),
    );
    (dir, shared_store, inbox)
}

fn pairs(requests: &[FakeRequest]) -> Vec<(String, u64)> {
    requests
        .iter()
        .map(|r| (r.project.clone(), r.number))
        .collect()
}

#[tokio::test]
async fn the_details_and_the_followed_projects_arrive_in_more_queries_without_an_error() {
    // The forge counts above the estimate, so the first queries are refused.
    let forge = OwnForge::new(
        "gitlab",
        FREEDESKTOP,
        mine(),
        ForgeOptions {
            max_complexity: Some(250.0),
            complexity_scale: Some(1.5),
            followed: others(),
            ..ForgeOptions::default()
        },
    );
    // Unguarded, the details of all six projects in one query are refused.
    assert!(
        estimate_complexity(&own_details_query("gitlab", &pairs(&mine()), "full")) * 1.5 > 250.0
    );
    let (_dir, shared_store, inbox) = complexity_inbox(forge.clone());
    let settings = complexity_settings();
    inbox.refresh().await;
    let snapshot = inbox.snapshot(&settings);
    assert_eq!(snapshot["hosts"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["hosts"][0]["host"], json!(FREEDESKTOP));
    assert_eq!(snapshot["hosts"][0]["state"], json!("ok"));
    assert!(snapshot["hosts"][0].get("message").is_none());
    let authored = section(&inbox, &settings, "authored");
    assert_eq!(authored.len(), 30);
    assert!(
        authored
            .iter()
            .all(|e| e["pipeline"] == json!("success") && e["own"]["approved"] == json!(true))
    );
    // The followed projects' requests are there too.
    let mut followed: Vec<u64> = shared_store.lock().unwrap().get()["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["number"].as_u64())
        .filter(|n| *n >= 900)
        .collect();
    followed.sort();
    assert_eq!(followed, [900, 901, 902]);
    assert!(!forge.refused().is_empty());
    let calls = forge.take();
    assert!(calls.iter().filter(|c| c.kind == "details").count() > 1);
    assert!(calls.iter().filter(|c| c.kind == "inbox").count() > 1);
    // Every request's details were asked once among the answered queries.
    let mut asked: Vec<u64> = calls
        .iter()
        .filter(|c| c.kind == "details")
        .flat_map(|c| c.numbers.clone())
        .collect();
    asked.sort();
    assert_eq!(asked, mine().iter().map(|r| r.number).collect::<Vec<_>>());

    // The next refresh uses the learned limit: no refusal at all.
    forge.clear_refused();
    forge.update(|list| {
        list.into_iter()
            .map(|r| FakeRequest {
                updated_at: hour_at(100 + r.number as usize),
                pipeline: Some("failed"),
                ..r
            })
            .collect()
    });
    inbox.refresh().await;
    assert!(forge.refused().is_empty());
    assert_eq!(inbox.snapshot(&settings)["hosts"][0]["state"], json!("ok"));
    assert!(
        section(&inbox, &settings, "authored")
            .iter()
            .all(|e| e["pipeline"] == json!("failed"))
    );
}

/// The fake forge behind a gate refusing the first page's lists together.
struct Refusing {
    forge: Arc<OwnForge>,
    together: f64,
    refusals: AtomicUsize,
}

impl InboxFetchers for Refusing {
    fn gitlab<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>> {
        let complexity = estimate_complexity(query);
        if query.contains("authoredMergeRequests") && complexity > self.together - 10.0 {
            self.refusals.fetch_add(1, Ordering::SeqCst);
            let message = format!(
                "GitLab: glab: Query has complexity of {complexity}, which exceeds max complexity of {}",
                self.together - 10.0
            );
            return Box::pin(async move { Err(FetchError::Failed(message)) });
        }
        self.forge.gitlab(host, query, call)
    }

    fn github<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>> {
        self.forge.github(host, query, call)
    }

    fn gitlab_drafts<'a>(&'a self, item: &'a Obj) -> BoxFuture<'a, FetchResult<usize>> {
        self.forge.gitlab_drafts(item)
    }
}

#[tokio::test]
async fn the_light_list_is_split_too_when_its_lists_are_too_much_together() {
    // A host that refuses the first page's lists together (as a smaller
    // limit would), and takes each on its own.
    let forge = OwnForge::new(
        "gitlab",
        FREEDESKTOP,
        mine(),
        ForgeOptions {
            followed: others(),
            ..ForgeOptions::default()
        },
    );
    let refusing = Arc::new(Refusing {
        forge,
        together: estimate_complexity(&gitlab_own_list_query(None, None)),
        refusals: AtomicUsize::new(0),
    });
    let (_dir, _store, inbox) = complexity_inbox(refusing.clone());
    let settings = complexity_settings();
    inbox.refresh().await;
    assert_eq!(refusing.refusals.load(Ordering::SeqCst), 1);
    assert_eq!(inbox.snapshot(&settings)["hosts"][0]["state"], json!("ok"));
    assert_eq!(section(&inbox, &settings, "authored").len(), 30);
}

#[tokio::test]
async fn a_field_refusal_still_falls_back_to_fewer_fields() {
    let forge = OwnForge::new(
        "gitlab",
        FREEDESKTOP,
        mine(),
        ForgeOptions {
            refuse_full: true,
            max_complexity: Some(250.0),
            complexity_scale: Some(1.5),
            ..ForgeOptions::default()
        },
    );
    let (_dir, _store, inbox) = complexity_inbox(forge);
    let settings = complexity_settings();
    inbox.refresh().await;
    let authored = section(&inbox, &settings, "authored");
    assert_eq!(authored.len(), 30);
    assert!(
        authored
            .iter()
            .all(|e| e.get("own").is_some_and(|o| !o.is_null()))
    );
}
