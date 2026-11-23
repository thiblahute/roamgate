//! order.test.ts: the user's order on the server, through a harness that
//! saves as module.ts does (the stored form in a settings.json of its own,
//! the next version for a pushed change, a push to every page).

use std::sync::{Arc, Mutex, OnceLock};

use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use super::{ChangeMeta, MrOrder, SaveFn, push_of, pushed_changes};
use crate::inbox::SettingsFn;
use crate::inbox::test_support::{FnFetchers, SharedStore, failed, inbox_of, store};
use crate::rpc::{MrReviewsRpcDeps, RpcResult, handle_mr_reviews_rpc};
use crate::settings::{mr_reviews_settings, normalize_stored_mr_reviews, stored_mr_reviews};
use crate::shared::order::OrderOp;

const HOST: &str = "gl.example";

fn item(n: u64, reasons: Value) -> Value {
    json!({
        "provider": "gitlab",
        "host": HOST,
        "project": "g/p",
        "number": n,
        "key": key(n),
        "url": format!("https://{HOST}/g/p/-/merge_requests/{n}"),
        "title": format!("MR {n}"),
        "author": "alice",
        "draft": false,
        "state": "open",
        "updatedAt": format!("2026-11-0{n}T00:00:00Z"),
        "headSha": "a".repeat(40),
        "sourceBranch": "x",
        "targetBranch": "main",
        "pipeline": null,
        "notes": 0,
        "reasons": reasons,
    })
}

fn key(n: u64) -> String {
    format!("gitlab:{HOST}/g/p#{n}")
}

fn ranked(n: u64, score: u64) -> Value {
    json!({
        "updatedAt": format!("2026-11-0{n}T00:00:00Z"),
        "version": "v",
        "pick": true,
        "score": score,
        "reason": format!("reason {n}"),
        "at": "t",
    })
}

/// settings.json's `mr_reviews`, as written.
pub(crate) type Persisted = Arc<Mutex<Value>>;

pub(crate) struct Reviews {
    pub(crate) store: SharedStore,
    pub(crate) order: Arc<MrOrder>,
    pub(crate) deps: MrReviewsRpcDeps,
    pub(crate) pushes: Arc<Mutex<Vec<Value>>>,
}

impl Reviews {
    async fn shown(&self, section: &str) -> Vec<u64> {
        self.order
            .view()
            .await
            .section(section)
            .iter()
            .map(|e| e["number"].as_u64().unwrap())
            .collect()
    }

    pub(crate) async fn call(&self, method: &str, params: Value) -> RpcResult<Value> {
        handle_mr_reviews_rpc(
            &self.deps,
            &format!("bridge.mr_reviews.{method}"),
            params.as_object().unwrap(),
        )
        .await
    }

    pub(crate) async fn settings(&self) -> Obj {
        (self.deps.settings)().await
    }

    pub(crate) fn pushes(&self) -> Vec<Value> {
        self.pushes.lock().unwrap().clone()
    }

    pub(crate) fn last_undo(&self) -> i64 {
        self.pushes().last().unwrap()["undo"].as_i64().unwrap()
    }
}

/// The settings in effect: settings.json's, normalized as read.
pub(crate) fn read(persisted: &Persisted) -> Obj {
    let normalized = normalize_stored_mr_reviews(Some(&persisted.lock().unwrap()));
    mr_reviews_settings(normalized.as_ref().and_then(Value::as_object))
}

/// The reviews module over `persisted` and `store` (`createMrReviews`).
pub(crate) fn reviews(persisted: &Persisted, store: &SharedStore) -> Reviews {
    let pushes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let settings: SettingsFn = {
        let persisted = persisted.clone();
        Arc::new(move || {
            let value = read(&persisted);
            Box::pin(async move { value })
        })
    };
    let fetchers = FnFetchers {
        gitlab: Box::new(|_, _| Err(failed("glab failed"))),
        ..FnFetchers::default()
    };
    let inbox = inbox_of(Arc::new(fetchers), settings.clone(), store, None);
    let order_cell: Arc<OnceLock<Arc<MrOrder>>> = Arc::new(OnceLock::new());
    let save: SaveFn = {
        let (persisted, pushes, order_cell) =
            (persisted.clone(), pushes.clone(), order_cell.clone());
        Arc::new(move |next: Obj, meta: ChangeMeta| {
            let before = read(&persisted);
            let changed = pushed_changes(&before, &next);
            let mut versioned = next.clone();
            let version = super::order_version(&before) + i64::from(!changed.is_empty());
            versioned.insert("orderVersion".into(), json!(version));
            *persisted.lock().unwrap() = Value::Object(stored_mr_reviews(&versioned));
            let saved = read(&persisted);
            if !changed.is_empty() {
                let order = order_cell.get().unwrap();
                // Undo needs what the change started from.
                order.seed(&before);
                order.remember(&saved);
                pushes
                    .lock()
                    .unwrap()
                    .push(push_of(&saved, &changed, &meta));
            }
            Box::pin(async move { Ok(saved) })
        })
    };
    let order = Arc::new(MrOrder::new(inbox.clone(), settings.clone(), save.clone()));
    let _ = order_cell.set(order.clone());
    let deps = MrReviewsRpcDeps {
        inbox: inbox.clone(),
        settings,
        save_settings: save,
        order: order.clone(),
        upstream_changed: None,
        tree: None,
        more: None,
    };
    Reviews {
        store: store.clone(),
        order,
        deps,
        pushes,
    }
}

/// 1 and 2 are for the user, 3 to 6 are suggestions (6 the best scored).
struct Setup {
    _dir: tempfile::TempDir,
    persisted: Persisted,
    t: Reviews,
}

fn setup() -> Setup {
    let persisted: Persisted = Arc::new(Mutex::new(
        json!({"hosts": [{"host": HOST, "provider": "gitlab"}]}),
    ));
    let (dir, shared_store) = store();
    shared_store
        .lock()
        .unwrap()
        .update(|state| {
            state["items"] = json!([
                item(1, json!(["review_requested"])),
                item(2, json!(["assigned"])),
                item(3, json!([])),
                item(4, json!([])),
                item(5, json!([])),
                item(6, json!([])),
            ]);
            for n in [3, 4, 5, 6] {
                state["ranked"][key(n)] = ranked(n, n * 10);
            }
        })
        .unwrap();
    let t = reviews(&persisted, &shared_store);
    Setup {
        _dir: dir,
        persisted,
        t,
    }
}

fn top(keys: &[u64]) -> OrderOp {
    OrderOp::Top(keys.iter().map(|n| key(*n)).collect())
}

fn persisted(setup: &Setup) -> Value {
    setup.persisted.lock().unwrap().clone()
}

#[tokio::test]
async fn an_operation_is_applied_saved_with_a_version_and_pushed() {
    let s = setup();
    let t = &s.t;
    // The inbox's own order: suggestions by score.
    assert_eq!(t.shown("suggested").await, [6, 5, 4, 3]);
    let describe = |moved: &[String]| format!("Claude moved {}", moved.len());
    let result = t
        .order
        .apply(
            &top(&[3, 4]),
            &ChangeMeta {
                undoable: true,
                ..ChangeMeta::agent()
            },
            Some(&describe),
        )
        .await
        .unwrap();
    assert!(result.changed);
    assert_eq!(t.shown("suggested").await, [3, 4, 6, 5]);
    let pushes = t.pushes();
    assert_eq!(pushes.len(), 1);
    assert_eq!(pushes[0]["version"], json!(1));
    assert_eq!(pushes[0]["by"], json!("agent"));
    assert_eq!(pushes[0]["summary"], json!("Claude moved 2"));
    assert_eq!(pushes[0]["undo"], json!(1));
    assert_eq!(pushes[0]["changed"], json!(["order"]));
    assert_eq!(
        pushes[0]["order"].as_array().unwrap()[..4],
        [json!(key(2)), json!(key(1)), json!(key(3)), json!(key(4))]
    );
    // The inbox every page reads carries the order and its version.
    let inbox = t.call("inbox", json!({"viewer": false})).await.unwrap();
    assert_eq!(inbox["orderVersion"], json!(1));
    assert_eq!(inbox["order"], pushes[0]["order"]);
    // Persisted in settings.json.
    assert_eq!(persisted(&s)["order_version"], json!(1));
    assert_eq!(persisted(&s)["order"], pushes[0]["order"]);
    // Nothing changed: no new version, no push.
    t.order
        .apply(&top(&[3]), &ChangeMeta::agent(), None)
        .await
        .unwrap();
    assert_eq!(t.pushes().len(), 1);
}

#[tokio::test]
async fn the_manual_order_wins_over_the_inboxs_sort_in_suggested_and_every_section() {
    let s = setup();
    let t = &s.t;
    t.call("order", json!({"op": "bottom", "keys": [key(6)]}))
        .await
        .unwrap();
    t.call("order", json!({"op": "top", "keys": [key(2)]}))
        .await
        .unwrap();
    assert_eq!(t.shown("suggested").await, [5, 4, 3, 6]);
    assert_eq!(t.shown("mine").await, [2, 1]);
    // A new suggestion (no place yet) shows first, then the order stands.
    t.store
        .lock()
        .unwrap()
        .update(|state| {
            state["items"]
                .as_array_mut()
                .unwrap()
                .push(item(7, json!([])));
            state["ranked"][key(7)] = ranked(7, 1);
        })
        .unwrap();
    assert_eq!(t.shown("suggested").await, [7, 5, 4, 3, 6]);
    // The inbox's sort changing (a better score) does not reshuffle it.
    t.store
        .lock()
        .unwrap()
        .update(|state| {
            state["ranked"][key(3)]["score"] = json!(99);
        })
        .unwrap();
    assert_eq!(t.shown("suggested").await, [7, 5, 4, 3, 6]);
}

#[tokio::test]
async fn concurrent_changes_from_the_user_and_the_agent_both_apply() {
    let s = setup();
    let t = &s.t;
    let bottom = OrderOp::Bottom(vec![key(6)]);
    let agent = ChangeMeta::agent();
    let (a, b, c) = tokio::join!(
        t.call("order", json!({"op": "top", "keys": [key(3)]})),
        t.order.apply(&bottom, &agent, None),
        t.call(
            "order",
            json!({"op": "before", "keys": [key(4)], "target": key(5)})
        ),
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    assert_eq!(t.shown("suggested").await, [3, 4, 5, 6]);
    let versions: Vec<i64> = t
        .pushes()
        .iter()
        .map(|p| p["version"].as_i64().unwrap())
        .collect();
    assert_eq!(versions, [1, 2, 3]);
}

#[tokio::test]
async fn a_stale_whole_list_is_rebased_not_written_over_the_latest_order() {
    let s = setup();
    let t = &s.t;
    // A page loads the inbox at version 0...
    let first = t.call("inbox", json!({"viewer": false})).await.unwrap();
    assert_eq!(first["orderVersion"], json!(0));
    // ... the agent moves 3 to the top and the user moves 6 down...
    t.order
        .apply(&top(&[3]), &ChangeMeta::agent(), None)
        .await
        .unwrap();
    t.call("order", json!({"op": "bottom", "keys": [key(6)]}))
        .await
        .unwrap();
    assert_eq!(t.shown("suggested").await, [3, 5, 4, 6]);
    // ... then the stale page, which saw [2 1 | 6 5 4 3], saves the whole
    // list with only 4 moved to the top of Suggested.
    t.call(
        "settings.update",
        json!({"settings": {
            "order": [key(2), key(1), key(4), key(6), key(5), key(3)],
            "orderVersion": 0,
        }}),
    )
    .await
    .unwrap();
    // Its move is applied; the agent's and the user's stay.
    assert_eq!(t.shown("suggested").await, [4, 3, 5, 6]);
}

#[tokio::test]
async fn undo_takes_the_change_back_on_the_latest_order() {
    let s = setup();
    let t = &s.t;
    let describe = |_: &[String]| "Claude moved 1".to_owned();
    let undoable = ChangeMeta {
        undoable: true,
        ..ChangeMeta::agent()
    };
    t.order
        .apply(&top(&[3]), &undoable, Some(&describe))
        .await
        .unwrap();
    let version = t.pushes()[0]["undo"].as_i64().unwrap();
    // The user moved another one meanwhile.
    t.call("order", json!({"op": "bottom", "keys": [key(6)]}))
        .await
        .unwrap();
    t.call("order", json!({"op": "undo", "version": version}))
        .await
        .unwrap();
    // 3 is back where it was (the end); the user's own move stands.
    assert_eq!(t.shown("suggested").await, [5, 4, 6, 3]);
    // Nothing since: back to the order as it was.
    t.order.apply(&top(&[4]), &undoable, None).await.unwrap();
    t.call("order", json!({"op": "undo", "version": t.last_undo()}))
        .await
        .unwrap();
    assert_eq!(t.shown("suggested").await, [5, 4, 6, 3]);
    let gone = t
        .call("order", json!({"op": "undo", "version": 999}))
        .await
        .unwrap_err();
    assert!(gone.message().contains("undone"));
}

#[tokio::test]
async fn unknown_keys_and_other_sections_are_reported() {
    let s = setup();
    let t = &s.t;
    let result = t
        .order
        .apply(
            &OrderOp::After(vec![key(3), key(1), "ghost".into()], key(6)),
            &ChangeMeta::agent(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.unknown, ["ghost"]);
    assert_eq!(result.elsewhere, [key(1)]);
    assert_eq!(result.moved, [key(3)]);
    assert_eq!(t.shown("suggested").await, [6, 3, 5, 4]);
    let refused = t
        .call("order", json!({"op": "sideways", "keys": [key(1)]}))
        .await
        .unwrap_err();
    assert!(refused.message().contains("op"));
}

#[tokio::test]
async fn pins_and_removals_take_a_version_and_are_pushed_too() {
    let s = setup();
    let t = &s.t;
    t.call(
        "hide",
        json!({"key": key(3), "by": "agent", "summary": "Claude removed"}),
    )
    .await
    .unwrap();
    let last = t.pushes().last().unwrap().clone();
    assert_eq!(last["changed"], json!(["hidden"]));
    assert_eq!(last["by"], json!("agent"));
    assert_eq!(last["summary"], json!("Claude removed"));
    // An agent's removal can be taken back too.
    assert_eq!(last["undo"], json!(1));
    t.call("unhide", json!({"key": key(3)})).await.unwrap();
    let versions: Vec<i64> = t
        .pushes()
        .iter()
        .map(|p| p["version"].as_i64().unwrap())
        .collect();
    assert_eq!(versions, [1, 2]);
    t.call(
        "hide",
        json!({"key": key(4), "by": "agent", "summary": "x"}),
    )
    .await
    .unwrap();
    t.call("order", json!({"op": "undo", "version": t.last_undo()}))
        .await
        .unwrap();
    assert!(t.shown("suggested").await.contains(&4));
}

#[tokio::test]
async fn undo_takes_back_an_agents_override_unless_changed_since() {
    let s = setup();
    let t = &s.t;
    t.call(
        "override",
        json!({"key": key(1), "set": {"next": "ping bob", "labels": ["infra"]}}),
    )
    .await
    .unwrap();
    t.call(
        "override",
        json!({
            "key": key(1),
            "set": {"whose": "reviewer", "next": "wait for bob"},
            "by": "agent",
            "summary": "Claude set the next step",
        }),
    )
    .await
    .unwrap();
    let push = t.pushes().last().unwrap().clone();
    assert_eq!(push["changed"], json!(["overrides"]));
    assert_eq!(push["by"], json!("agent"));
    t.call("override", json!({"key": key(2), "set": {"next": "mine"}}))
        .await
        .unwrap();
    t.call("order", json!({"op": "undo", "version": push["undo"]}))
        .await
        .unwrap();
    let settings = t.settings().await;
    let one = &settings["overrides"][key(1)];
    assert_eq!(one["next"], json!("ping bob"));
    assert_eq!(one["labels"], json!(["infra"]));
    assert!(one.get("whose").is_none());
    // The user's own change after it stands.
    assert_eq!(settings["overrides"][key(2)]["next"], json!("mine"));
    // Changed again since: kept as it is.
    t.call(
        "override",
        json!({"key": key(2), "set": {"next": "agent's"}, "by": "agent"}),
    )
    .await
    .unwrap();
    let second = t.last_undo();
    t.call(
        "override",
        json!({"key": key(2), "set": {"next": "user's"}}),
    )
    .await
    .unwrap();
    t.call("order", json!({"op": "undo", "version": second}))
        .await
        .unwrap();
    assert_eq!(
        t.settings().await["overrides"][key(2)]["next"],
        json!("user's")
    );
}

#[tokio::test]
async fn the_order_and_its_version_survive_a_restart() {
    let s = setup();
    let t = &s.t;
    t.call("order", json!({"op": "top", "keys": [key(4)]}))
        .await
        .unwrap();
    t.call("order", json!({"op": "top", "keys": [key(5)]}))
        .await
        .unwrap();
    // A new server on the same settings.json: same order, next version.
    let again = reviews(&s.persisted, &t.store);
    let view = again.order.view().await;
    assert_eq!(view.version, 2);
    let shown: Vec<u64> = view
        .section("suggested")
        .iter()
        .map(|e| e["number"].as_u64().unwrap())
        .collect();
    assert_eq!(shown, [5, 4, 6, 3]);
}

#[tokio::test]
async fn two_clients_follow_the_same_order_by_push_or_by_the_next_poll() {
    let s = setup();
    let t = &s.t;
    /// A page: what it holds, and how it takes a push.
    #[derive(Clone, Debug, PartialEq)]
    struct Page {
        order: Value,
        version: i64,
    }
    fn take(page: &mut Page, push: &Value) {
        let version = push["version"].as_i64().unwrap();
        if version <= page.version {
            return;
        }
        page.order = push["order"].clone();
        page.version = version;
    }
    let mut desktop = Page {
        order: json!([]),
        version: 0,
    };
    let mut phone = desktop.clone();
    t.order
        .apply(&top(&[3]), &ChangeMeta::agent(), None)
        .await
        .unwrap();
    t.call("order", json!({"op": "bottom", "keys": [key(3)]}))
        .await
        .unwrap();
    t.call("order", json!({"op": "top", "keys": [key(5)]}))
        .await
        .unwrap();
    for (index, push) in t.pushes().iter().enumerate() {
        take(&mut desktop, push);
        // The phone's connection drops after the first push.
        if index == 0 {
            take(&mut phone, push);
        }
    }
    assert_eq!(desktop.version, 3);
    assert_eq!(desktop.order, persisted(&s)["order"]);
    assert_eq!(phone.version, 1);
    // Reconnected, the phone's next poll catches up to the same order.
    let inbox = t.call("inbox", json!({"viewer": false})).await.unwrap();
    let version = inbox["orderVersion"].as_i64().unwrap_or(0);
    if version > phone.version {
        phone.order = inbox.get("order").cloned().unwrap_or(json!([]));
        phone.version = version;
    }
    assert_eq!(phone, desktop);
    // A push the desktop already had (or an older one) changes nothing.
    take(&mut desktop, &t.pushes()[0]);
    assert_eq!(desktop.version, 3);
}

#[test]
fn undo_list_and_record_take_back_only_what_did_not_change_since() {
    let before = json!({"a": 1, "b": 2}).as_object().cloned().unwrap();
    let after = json!({"a": 1, "b": 3, "c": 4})
        .as_object()
        .cloned()
        .unwrap();
    let current = json!({"a": 5, "b": 3, "c": 9})
        .as_object()
        .cloned()
        .unwrap();
    assert_eq!(
        Value::Object(super::undo_record(&before, &after, &current)),
        json!({"a": 5, "b": 2, "c": 9})
    );
    let key_of = |v: &Value| js::sv(v.get("key")).to_owned();
    let list = super::undo_list(
        &[json!({"key": "x"}), json!({"key": "y", "v": 1})],
        &[json!({"key": "y", "v": 2}), json!({"key": "z"})],
        &[json!({"key": "y", "v": 2}), json!({"key": "z"})],
        &key_of,
    );
    assert_eq!(list, [json!({"key": "x"}), json!({"key": "y", "v": 1})]);
}
