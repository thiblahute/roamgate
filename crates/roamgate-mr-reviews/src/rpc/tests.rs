//! inbox.pins.test.ts (pinned and hidden requests) and the RPC rows of
//! inbox.test.ts (settings saved through the stored form, the user's order).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use roamgate_base::settings::sections::{MAX_HIDDEN, MAX_PINNED};
use serde_json::{Value, json};

use super::{MrReviewsRpcDeps, RpcResult, handle_mr_reviews_rpc};
use crate::inbox::MrInbox;
use crate::inbox::test_support::*;
use crate::order::{ChangeMeta, MrOrder, SaveFn};
use crate::settings::{
    default_settings, mr_reviews_settings, normalize_stored_mr_reviews, stored_mr_reviews,
};

struct Pins {
    _dir: tempfile::TempDir,
    inbox: MrInbox,
    deps: MrReviewsRpcDeps,
    current: Arc<Mutex<Obj>>,
    reads: Arc<Mutex<Vec<String>>>,
    notes: Arc<Mutex<HashMap<u64, u64>>>,
}

impl Pins {
    async fn call(&self, method: &str, params: Value) -> RpcResult<Value> {
        handle_mr_reviews_rpc(
            &self.deps,
            &format!("bridge.mr_reviews.{method}"),
            params.as_object().unwrap(),
        )
        .await
    }

    fn settings(&self) -> Obj {
        self.current.lock().unwrap().clone()
    }

    fn rows(&self) -> Vec<Obj> {
        entries(&self.inbox, &self.settings())
    }

    fn row(&self, number: u64) -> Option<Obj> {
        self.rows()
            .into_iter()
            .find(|e| e["number"].as_u64() == Some(number))
    }

    fn reads(&self) -> Vec<String> {
        self.reads.lock().unwrap().clone()
    }

    fn pinned_numbers(&self) -> Vec<u64> {
        self.settings()["pinned"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["number"].as_u64())
            .collect()
    }
}

/// The settings saved as given (`saveSettings` of the TS tests).
fn saving(current: &Arc<Mutex<Obj>>) -> SaveFn {
    let current = current.clone();
    Arc::new(move |next: Obj, _: ChangeMeta| {
        *current.lock().unwrap() = next.clone();
        Box::pin(async move { Ok(next) })
    })
}

fn deps_over(inbox: &MrInbox, current: &Arc<Mutex<Obj>>) -> MrReviewsRpcDeps {
    let save = saving(current);
    MrReviewsRpcDeps {
        inbox: inbox.clone(),
        settings: shared(current),
        save_settings: save.clone(),
        order: Arc::new(MrOrder::new(inbox.clone(), shared(current), save)),
        upstream_changed: None,
        tree: None,
        more: None,
    }
}

fn pins() -> Pins {
    let reads = Arc::new(Mutex::new(Vec::<String>::new()));
    let notes = Arc::new(Mutex::new(HashMap::from([(1, 1), (7, 2)])));
    let one = Regex::new(r#"mergeRequest\(iid: "(\d+)"\)"#).unwrap();
    let fetchers = FnFetchers {
        gitlab: {
            let (reads, notes) = (reads.clone(), notes.clone());
            Box::new(move |_, query| {
                if let Some(found) = one.captures(query) {
                    let iid: u64 = found[1].parse().unwrap();
                    reads.lock().unwrap().push(format!("one {iid}"));
                    if iid == 404 {
                        return Ok(json!({"data": {"project": {"mergeRequest": null}}}));
                    }
                    if iid == 500 {
                        return Err(failed("boom"));
                    }
                    let count = notes.lock().unwrap().get(&iid).copied().unwrap_or(0);
                    return Ok(
                        json!({"data": {"project": {"mergeRequest": gitlab_mr(iid, json!({"userNotesCount": count}))}}}),
                    );
                }
                if query.contains("authoredMergeRequests") {
                    reads.lock().unwrap().push("own".into());
                    return Ok(
                        json!({"data": {"currentUser": {"username": "me", "au": {"nodes": []}}}}),
                    );
                }
                reads.lock().unwrap().push("inbox".into());
                let count = notes.lock().unwrap().get(&1).copied().unwrap_or(0);
                Ok(json!({"data": {"currentUser": {
                    "username": "me",
                    "rr": {"nodes": [gitlab_mr(1, json!({"userNotesCount": count}))]},
                    "as": {"nodes": []},
                    "todos": {"nodes": []},
                }}}))
            })
        },
        ..FnFetchers::default()
    };
    let current = Arc::new(Mutex::new(settings(json!({"hosts": [
        {"host": "gitlab.example.org", "provider": "gitlab"},
        {"host": "github.com", "provider": "github"},
    ]}))));
    let (dir, shared_store) = store();
    let inbox = inbox_of(Arc::new(fetchers), shared(&current), &shared_store, None);
    let deps = deps_over(&inbox, &current);
    Pins {
        _dir: dir,
        inbox,
        deps,
        current,
        reads,
        notes,
    }
}

fn url(iid: u64) -> String {
    format!("https://gitlab.example.org/group/app/-/merge_requests/{iid}")
}

const KEY1: &str = "gitlab:gitlab.example.org/group/app#1";

#[test]
fn settings_keep_them_checked_and_capped() {
    let mut pinned = vec![
        json!({"provider": "gitlab", "host": "GitLab.Example.org", "project": "g/a", "number": 3}),
        json!({"provider": "gitlab", "host": "gitlab.example.org", "project": "g/a", "number": 3}),
        json!({"provider": "svn", "host": "x.org", "project": "g/a", "number": 4}),
        json!({"provider": "github", "host": "github.com", "project": "../x", "number": 5}),
        json!({"provider": "github", "host": "github.com", "project": "o/r", "number": 0}),
    ];
    pinned.extend((0..MAX_PINNED + 5).map(|index| {
        json!({"provider": "github", "host": "github.com", "project": "o/r", "number": index + 10})
    }));
    let mut hidden = vec![
        json!({"key": "a", "marker": "m"}),
        json!({"key": "a", "marker": "again"}),
        json!({"key": "", "marker": "m"}),
        json!({"key": "b", "marker": 3}),
    ];
    hidden.extend(
        (0..MAX_HIDDEN + 5).map(|index| json!({"key": format!("k{index}"), "marker": "m"})),
    );
    let stored =
        normalize_stored_mr_reviews(Some(&json!({"pinned": pinned, "hidden": hidden}))).unwrap();
    assert_eq!(stored["pinned"].as_array().unwrap().len(), MAX_PINNED);
    assert_eq!(
        stored["pinned"][0],
        json!({"provider": "gitlab", "host": "gitlab.example.org", "project": "g/a", "number": 3})
    );
    // The oldest hidden ones are forgotten first.
    let kept = stored["hidden"].as_array().unwrap();
    assert_eq!(kept.len(), MAX_HIDDEN);
    assert_eq!(
        kept.last().unwrap()["key"],
        json!(format!("k{}", MAX_HIDDEN + 4))
    );
    assert_eq!(mr_reviews_settings(None)["pinned"], json!([]));
    let round = stored_mr_reviews(&mr_reviews_settings(stored.as_object()));
    assert_eq!(round["pinned"].as_array().unwrap().len(), MAX_PINNED);
    assert!(
        stored_mr_reviews(&default_settings())
            .get("pinned")
            .is_none()
    );
}

#[tokio::test]
async fn pinning_a_listed_request_reads_nothing_unpinning_puts_it_back() {
    let t = pins();
    t.inbox.refresh().await;
    t.reads.lock().unwrap().clear();
    let pinned = t.call("pin", json!({"text": url(1)})).await.unwrap();
    let key = js::sv(pinned.get("key")).to_owned();
    assert!(t.reads().is_empty());
    let section = |t: &Pins| {
        t.rows()
            .into_iter()
            .find(|e| super::key_of(e) == key)
            .map(|e| e["section"].clone())
    };
    assert_eq!(section(&t), Some(json!("pinned")));
    t.call("unpin", json!({"key": key})).await.unwrap();
    assert_eq!(section(&t), Some(json!("mine")));
    assert_eq!(t.settings()["hidden"], json!([]));
}

#[tokio::test]
async fn pin_by_url_read_from_the_forge_listed_as_pinned_kept_in_the_settings() {
    let t = pins();
    t.inbox.refresh().await;
    let pinned = t.call("pin", json!({"text": url(7)})).await.unwrap();
    assert_eq!(
        pinned["key"],
        json!("gitlab:gitlab.example.org/group/app#7")
    );
    let entry = t.row(7).unwrap();
    assert_eq!(entry["section"], json!("pinned"));
    assert_eq!(entry["title"], json!("MR 7"));
    assert!(entry.get("unavailable").is_none());
    let sections: Vec<Value> = t.rows().iter().map(|e| e["section"].clone()).collect();
    assert_eq!(sections, [json!("pinned"), json!("mine")]);
    assert_eq!(t.pinned_numbers(), [7]);
    // Pinning again changes nothing; the refresh reads it again (open).
    t.call("pin", json!({"text": url(7)})).await.unwrap();
    assert_eq!(t.pinned_numbers().len(), 1);
    assert_eq!(
        t.inbox.item(js::sv(pinned.get("key"))).unwrap()["title"],
        json!("MR 7")
    );
    t.reads.lock().unwrap().clear();
    t.inbox.refresh().await;
    assert_eq!(t.reads(), ["inbox", "own", "one 7"]);
    // One the inbox lists is pinned without another call.
    t.call("pin", json!({"text": url(1)})).await.unwrap();
    t.reads.lock().unwrap().clear();
    t.inbox.refresh().await;
    assert_eq!(t.reads(), ["inbox", "own", "one 7"]);
    assert_eq!(t.row(1).unwrap()["section"], json!("pinned"));
    // Unpinned, it is back in For you.
    t.call("unpin", json!({"key": KEY1})).await.unwrap();
    assert_eq!(t.row(1).unwrap()["section"], json!("mine"));
}

#[tokio::test]
async fn pin_refuses_other_hosts_other_text_and_says_when_a_request_is_not_found() {
    let t = pins();
    let other = t
        .call(
            "pin",
            json!({"text": "https://elsewhere.org/g/p/-/merge_requests/3"}),
        )
        .await
        .unwrap_err();
    assert!(other.message().contains("not one of your forge hosts"));
    let text = t.call("pin", json!({"text": "hello"})).await.unwrap_err();
    assert!(text.message().contains("paste its URL"));
    let empty = t.call("pin", json!({"text": ""})).await.unwrap_err();
    assert!(empty.message().contains("required"));
    t.inbox.refresh().await;
    t.call("pin", json!({"text": url(404)})).await.unwrap();
    let gone = t.row(404).unwrap();
    assert_eq!(gone["section"], json!("pinned"));
    assert!(js::sv(gone.get("unavailable")).contains("Not found"));
    assert_eq!(gone["url"], json!(url(404)));
    // A host that fails keeps the pin, with the reason.
    t.call("pin", json!({"text": url(500)})).await.unwrap();
    assert_eq!(t.row(500).unwrap()["unavailable"], json!("boom"));
    // Removing it unpins it.
    assert_eq!(
        t.call(
            "hide",
            json!({"key": "gitlab:gitlab.example.org/group/app#404"})
        )
        .await
        .unwrap(),
        json!({"ok": true, "action": "unpinned"})
    );
    assert_eq!(t.pinned_numbers(), [500]);
}

#[tokio::test]
async fn a_pin_is_capped() {
    let t = pins();
    t.inbox.refresh().await;
    for n in 0..MAX_PINNED as u64 {
        t.call("pin", json!({"text": url(1000 + n)})).await.unwrap();
    }
    let refused = t.call("pin", json!({"text": url(9999)})).await.unwrap_err();
    assert!(refused.message().contains("At most"));
}

#[tokio::test]
async fn hide_out_of_the_view_until_something_happens_on_it_restorable() {
    let t = pins();
    t.inbox.refresh().await;
    assert_eq!(
        t.call("hide", json!({"key": KEY1})).await.unwrap(),
        json!({"ok": true, "action": "hidden"})
    );
    let hidden_keys = |t: &Pins| -> Vec<String> {
        t.settings()["hidden"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| js::sv(h.get("key")).to_owned())
            .collect()
    };
    assert_eq!(hidden_keys(&t), [KEY1]);
    let (rows, hidden) = t.inbox.entries(&t.settings());
    assert!(rows.is_empty());
    assert_eq!(hidden.iter().map(super::key_of).collect::<Vec<_>>(), [KEY1]);
    // A new comment brings it back; the list of hidden ones drops it.
    t.notes.lock().unwrap().insert(1, 2);
    t.inbox.refresh().await;
    let (rows, hidden) = t.inbox.entries(&t.settings());
    assert_eq!(rows.iter().map(super::key_of).collect::<Vec<_>>(), [KEY1]);
    assert!(hidden.is_empty());
    // Hidden again, then restored by hand.
    t.call("hide", json!({"key": KEY1})).await.unwrap();
    assert!(t.rows().is_empty());
    t.call("unhide", json!({"key": KEY1})).await.unwrap();
    assert_eq!(t.rows().len(), 1);
    let missing = t
        .call(
            "hide",
            json!({"key": "gitlab:gitlab.example.org/group/app#99"}),
        )
        .await
        .unwrap_err();
    assert!(missing.message().contains("no such request"));
}

#[tokio::test]
async fn pinning_a_hidden_request_shows_it_again_settings_saves_keep_both() {
    let t = pins();
    t.inbox.refresh().await;
    t.call("hide", json!({"key": KEY1})).await.unwrap();
    t.call("pin", json!({"text": url(1)})).await.unwrap();
    assert_eq!(t.settings()["hidden"], json!([]));
    t.call("hide", json!({"key": KEY1})).await.unwrap();
    assert_eq!(t.settings()["pinned"], json!([]));
    t.call("pin", json!({"text": url(7)})).await.unwrap();
    t.call("settings.update", json!({"settings": {"retentionDays": 5}}))
        .await
        .unwrap();
    assert_eq!(t.pinned_numbers(), [7]);
    t.call("settings.update", json!({"settings": {"order": [KEY1]}}))
        .await
        .unwrap();
    assert_eq!(t.pinned_numbers().len(), 1);
}

// inbox.test.ts: the settings through the RPC.

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

/// Fetchers that count the inbox's reads (a refresh asks every host).
fn counting(count: &Arc<AtomicUsize>) -> Arc<FnFetchers> {
    let count = count.clone();
    Arc::new(FnFetchers {
        gitlab: Box::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"data": {"currentUser": {"username": "me"}}}))
        }),
        ..FnFetchers::default()
    })
}

async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn the_rpc_saves_through_the_stored_form() {
    let (_dir, shared_store) = store();
    let reads = Arc::new(AtomicUsize::new(0));
    let inbox = inbox_of(
        counting(&reads),
        fixed(&inbox_settings()),
        &shared_store,
        None,
    );
    let defaults = Arc::new(Mutex::new(default_settings()));
    let deps = deps_over(&inbox, &defaults);
    let result = handle_mr_reviews_rpc(
        &deps,
        "bridge.mr_reviews.settings.update",
        json!({"settings": {
            "followed": [{"host": "gitlab.example.org", "provider": "gitlab", "project": "g/p"}],
            "retentionDays": 5,
        }})
        .as_object()
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        defaults.lock().unwrap()["followed"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(result["retentionDays"], json!(5));
    let current = Arc::new(Mutex::new(inbox_settings()));
    let refused = handle_mr_reviews_rpc(
        &deps_over(&inbox, &current),
        "bridge.mr_reviews.feedback",
        json!({"key": "k", "verdict": "submit"})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap_err();
    assert!(refused.message().contains("verdict"));
}

#[tokio::test]
async fn the_users_order_kept_checked_saved_alone_without_a_refresh() {
    assert_eq!(
        normalize_stored_mr_reviews(Some(&json!({"order": ["a", "a", 3, "", "b"]}))).unwrap()["order"],
        json!(["a", "b"])
    );
    assert_eq!(mr_reviews_settings(None)["order"], json!([]));
    let mut first = inbox_settings();
    first["order"] = json!(["x"]);
    let current = Arc::new(Mutex::new(first));
    let reads = Arc::new(AtomicUsize::new(0));
    let (_dir, shared_store) = store();
    let inbox = inbox_of(counting(&reads), shared(&current), &shared_store, None);
    let deps = deps_over(&inbox, &current);
    let call = |params: Value| {
        let deps = deps.clone();
        async move {
            handle_mr_reviews_rpc(
                &deps,
                "bridge.mr_reviews.settings.update",
                params.as_object().unwrap(),
            )
            .await
            .unwrap()
        }
    };
    call(json!({"settings": {"order": ["b", "a"]}})).await;
    settle().await;
    assert_eq!(current.lock().unwrap()["order"], json!(["b", "a"]));
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    // Saving the other settings keeps it, and refreshes.
    call(json!({"settings": {"retentionDays": 4}})).await;
    settle().await;
    assert_eq!(current.lock().unwrap()["order"], json!(["b", "a"]));
    assert!(reads.load(Ordering::SeqCst) > 0);
    // Every browser reads it with the inbox.
    let settings = current.lock().unwrap().clone();
    assert_eq!(inbox.snapshot(&settings)["order"], json!(["b", "a"]));
    let mut unordered = settings.clone();
    unordered["order"] = json!([]);
    assert!(inbox.snapshot(&unordered).get("order").is_none());
}
