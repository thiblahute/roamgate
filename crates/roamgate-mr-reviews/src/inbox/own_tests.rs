//! inbox.own.test.ts: the user's own requests, their queries, what
//! changed since the user looked, and the inbox reading them.

use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use roamgate_base::log::{Logger, LoggerOptions};
use serde_json::{Value, json};

use super::own_forge::{FakeRequest, ForgeOptions, OwnForge, PROJECTS, fake_requests};
use super::test_support::*;
use super::{MrInbox, MrInboxDeps, OWN_DETAILS_TTL_MS};
use crate::queries::{
    OWN_MAX_PAGES, OWN_PAGE, github_own_list_query, gitlab_own_list_query, own_details_query,
    parse_own_details, parse_own_list, unknown_field_error, with_own_details,
};
use crate::shared::types::{seen_of, unread};

fn gitlab_settings() -> Obj {
    settings(json!({"hosts": [{"host": "gitlab.example.org", "provider": "gitlab"}]}))
}

fn mr(iid: u64, extra: Value) -> Value {
    let mut node = json!({
        "iid": iid.to_string(),
        "title": format!("MR {iid}"),
        "webUrl": format!("https://gitlab.example.org/group/app/-/merge_requests/{iid}"),
        "state": "opened",
        "updatedAt": "2026-11-03T10:00:00Z",
        "userNotesCount": 1,
        "diffHeadSha": "aaaaaaa1",
        "sourceBranch": format!("topic-{iid}"),
        "targetBranch": "main",
        "project": {"fullPath": "group/app"},
        "author": {"username": "me"},
        "headPipeline": {"status": "RUNNING"},
        "conflicts": false,
        "shouldBeRebased": false,
        "approved": false,
        "approvedBy": {"nodes": []},
        "resolvableDiscussionsCount": 2,
        "resolvedDiscussionsCount": 1,
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        node[key] = value;
    }
    node
}

#[test]
fn gitlab_lists_the_open_ones_paged_the_first_page_with_the_latest_settled() {
    let first = gitlab_own_list_query(None, None);
    assert!(first.contains("authoredMergeRequests(state: opened"));
    assert!(first.contains("pageInfo { hasNextPage endCursor }"));
    assert!(first.contains("state: merged"));
    assert!(first.contains("state: closed"));
    // The list is light: the costly fields are the details'.
    assert!(!first.contains("approvedBy"));
    assert!(!first.contains("headPipeline"));
    let next = gitlab_own_list_query(Some("abc"), None);
    assert!(next.contains("after: \"abc\""));
    assert!(!next.contains("state: merged"));
}

#[test]
fn github_searches_the_open_ones_paged_the_first_page_with_the_latest_closed() {
    let first = github_own_list_query(None, None);
    assert!(first.contains("is:pr is:open author:@me"));
    assert!(first.contains("is:pr is:closed author:@me"));
    assert!(!first.contains("statusCheckRollup"));
    assert!(!github_own_list_query(Some("xyz"), None).contains("is:closed"));
}

#[test]
fn details_are_asked_by_project_full_or_basic() {
    let refs = vec![
        ("group/app".to_owned(), 1),
        ("group/app".to_owned(), 2),
        ("other/tool".to_owned(), 3),
    ];
    let gitlab = own_details_query("gitlab", &refs, "full");
    assert!(
        gitlab.contains("p0: project(fullPath: \"group/app\") { mergeRequests(iids: [\"1\",\"2\"]")
    );
    assert!(gitlab.contains("p1: project(fullPath: \"other/tool\")"));
    assert!(gitlab.contains("approvedBy"));
    assert!(!own_details_query("gitlab", &refs, "basic").contains("approvedBy"));
    let github = own_details_query("github", &refs, "full");
    assert!(
        github.contains(
            "p0: repository(owner: \"group\", name: \"app\") { n1: pullRequest(number: 1)"
        )
    );
    assert!(github.contains("latestOpinionatedReviews"));
}

#[test]
fn gitlab_the_list_then_status_from_the_details() {
    let (items, next) = parse_own_list(
        "gitlab",
        "gitlab.example.org",
        &json!({"data": {"currentUser": {
            "op": {"pageInfo": {"hasNextPage": true, "endCursor": "c1"}, "nodes": [mr(1, json!({}))]},
            "mg": {"nodes": [mr(2, json!({"state": "merged"}))]},
            "cl": {"nodes": [mr(3, json!({"state": "closed"}))]},
        }}}),
    )
    .unwrap();
    assert_eq!(next.as_deref(), Some("c1"));
    let states: Vec<(u64, &str)> = items
        .iter()
        .map(|i| (number(i), js::sv(i.get("state"))))
        .collect();
    assert_eq!(states, [(1, "open"), (2, "merged"), (3, "closed")]);
    assert_eq!(items[0]["reasons"], json!(["authored"]));
    let details = parse_own_details(
        "gitlab",
        "gitlab.example.org",
        &json!({"data": {"p0": {"mergeRequests": {"nodes": [
            mr(1, json!({"approved": true, "approvedBy": {"nodes": [{"username": "bob"}]}, "conflicts": true})),
            mr(2, json!({"detailedMergeStatus": "NEED_REBASE"})),
        ]}}}}),
    )
    .unwrap();
    let of = |key: &str| {
        details
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, d)| d.clone())
    };
    let one = with_own_details(&items[0], of(super::key_of(&items[0])).as_ref());
    assert_eq!(
        one["own"],
        json!({
            "approvedBy": ["bob"],
            "approved": true,
            "changesRequested": [],
            "unresolved": 1,
            "conflicts": true,
            "needsRebase": false,
        })
    );
    assert_eq!(one["pipeline"], json!("running"));
    // A running pipeline is read again even when nothing else changed.
    assert_eq!(
        of(super::key_of(&items[0])).unwrap()["settling"],
        json!(true)
    );
    assert_eq!(
        of(super::key_of(&items[1])).unwrap()["own"]["needsRebase"],
        json!(true)
    );
}

#[test]
fn github_reviews_open_threads_and_conflicts() {
    let details = parse_own_details(
        "github",
        "github.com",
        &json!({"data": {"p0": {"n9": {
            "number": 9,
            "url": "https://github.com/acme/widgets/pull/9",
            "updatedAt": "2026-11-03T10:00:00Z",
            "headRefOid": "bbbbbbb2",
            "repository": {"nameWithOwner": "acme/widgets"},
            "comments": {"totalCount": 1},
            "reviewThreads": {"totalCount": 2},
            "mergeable": "CONFLICTING",
            "reviewDecision": "CHANGES_REQUESTED",
            "latestOpinionatedReviews": {"nodes": [
                {"state": "APPROVED", "author": {"login": "ann"}},
                {"state": "CHANGES_REQUESTED", "author": {"login": "bo"}},
            ]},
            "openThreads": {"nodes": [{"isResolved": false}, {"isResolved": true}]},
        }}}}),
    )
    .unwrap();
    let entry = &details[0].1;
    assert_eq!(entry["notes"], json!(3));
    assert_eq!(entry["settling"], json!(false));
    assert_eq!(
        entry["own"],
        json!({
            "approvedBy": ["ann"],
            "approved": false,
            "changesRequested": ["bo"],
            "unresolved": 1,
            "conflicts": true,
            "needsRebase": false,
        })
    );
}

#[test]
fn an_answer_refusing_a_field_is_told_apart_from_others() {
    assert!(unknown_field_error(
        &json!({"errors": [{"message": "Field 'approved' doesn't exist on type 'MergeRequest'"}]})
    ));
    assert!(!unknown_field_error(
        &json!({"data": {}, "errors": [{"message": "x"}]})
    ));
}

fn seen_item() -> Obj {
    json!({
        "updatedAt": "2026-11-03T10:00:00Z",
        "headSha": "aaaaaaa1",
        "notes": 1,
        "state": "open",
        "pipeline": "running",
        "own": {
            "approvedBy": [],
            "approved": false,
            "changesRequested": [],
            "unresolved": 1,
            "conflicts": false,
            "needsRebase": false,
        },
    })
    .as_object()
    .cloned()
    .unwrap()
}

#[test]
fn pipeline_approvals_conflicts_threads_and_state_are_said() {
    let item = seen_item();
    let seen = seen_of(&item, "2026-11-03T11:00:00Z");
    assert_eq!(unread(&item, Some(&seen)).unwrap()["changed"], json!(false));
    let mut later = item.clone();
    later["updatedAt"] = json!("2026-11-03T12:00:00Z");
    later["state"] = json!("merged");
    later["pipeline"] = json!("failed");
    later["own"]["approvedBy"] = json!(["bob"]);
    later["own"]["conflicts"] = json!(true);
    later["own"]["unresolved"] = json!(3);
    assert_eq!(
        Value::Object(unread(&later, Some(&seen)).unwrap()),
        json!({
            "newCommits": false,
            "newNotes": 0,
            "changed": true,
            "state": "merged",
            "pipeline": "failed",
            "newApprovals": ["bob"],
            "conflicts": true,
            "unresolved": 3,
        })
    );
}

#[test]
fn a_record_from_before_these_were_kept_says_no_such_change() {
    let item = seen_item();
    let old =
        json!({"at": "x", "updatedAt": item["updatedAt"], "headSha": item["headSha"], "notes": 1});
    let mut changed = item.clone();
    changed["pipeline"] = json!("failed");
    changed["state"] = json!("merged");
    assert_eq!(
        Value::Object(unread(&changed, old.as_object()).unwrap()),
        json!({"newCommits": false, "newNotes": 0, "changed": false})
    );
}

/// The own-requests fake of the inbox tests: what was asked, and the own
/// list a test changes.
struct OwnFake {
    asked: Arc<Mutex<Vec<String>>>,
    own: Arc<Mutex<Vec<Value>>>,
}

type Over = Option<Box<dyn Fn(&str) -> crate::fetchers::FetchResult<Value> + Send + Sync>>;

fn own_fetchers(over_own: Over, over_details: Over) -> (Arc<FnFetchers>, OwnFake) {
    let asked = Arc::new(Mutex::new(Vec::<String>::new()));
    let own = Arc::new(Mutex::new(vec![mr(5, json!({}))]));
    let fake = OwnFake {
        asked: asked.clone(),
        own: own.clone(),
    };
    let fetchers = FnFetchers {
        gitlab: Box::new(move |_, query| {
            if query.contains("op: authoredMergeRequests") {
                asked.lock().unwrap().push("list".into());
                if let Some(over) = &over_own {
                    return over(query);
                }
                let nodes = own.lock().unwrap().clone();
                return Ok(json!({"data": {"currentUser": {
                    "username": "me",
                    "op": {"pageInfo": {"hasNextPage": false}, "nodes": nodes},
                }}}));
            }
            if query.contains("mergeRequests(iids:") {
                let kind = if query.contains("assignees") {
                    "details full"
                } else if query.contains("approvedBy") {
                    "details nomerge"
                } else {
                    "details basic"
                };
                asked.lock().unwrap().push(kind.into());
                if let Some(over) = &over_details {
                    return over(query);
                }
                let nodes = own.lock().unwrap().clone();
                return Ok(json!({"data": {"p0": {"mergeRequests": {"nodes": nodes}}}}));
            }
            asked.lock().unwrap().push("inbox".into());
            Ok(json!({"data": {"currentUser": {
                "username": "me",
                "rr": {"nodes": []},
                // Authors often assign themselves: still theirs.
                "as": {"nodes": [mr(5, json!({}))]},
                "todos": {"nodes": []},
            }}}))
        }),
        ..FnFetchers::default()
    };
    (Arc::new(fetchers), fake)
}

#[tokio::test]
async fn listed_as_mine_never_new_and_what_changes_after_shows() {
    let (fetchers, fake) = own_fetchers(None, None);
    let (_dir, shared_store) = store();
    let settings = gitlab_settings();
    let inbox = inbox_of(
        fetchers,
        fixed(&settings),
        &shared_store,
        Some(clock("2026-11-04T12:00:00Z")),
    );
    inbox.refresh().await;
    let entry = entries(&inbox, &settings)[0].clone();
    assert_eq!(entry["section"], json!("authored"));
    let mut reasons: Vec<&str> = entry["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    reasons.sort();
    assert_eq!(reasons, ["assigned", "authored"]);
    assert_eq!(entry["isNew"], json!(false));
    assert_eq!(entry["unread"]["changed"], json!(false));
    assert_eq!(entry["own"]["unresolved"], json!(1));
    *fake.own.lock().unwrap() = vec![mr(
        5,
        json!({
            "updatedAt": "2026-11-04T11:00:00Z",
            "headPipeline": {"status": "FAILED"},
            "approvedBy": {"nodes": [{"username": "bob"}]},
        }),
    )];
    inbox.refresh().await;
    let entry = entries(&inbox, &settings)[0].clone();
    assert_eq!(entry["unread"]["changed"], json!(true));
    assert_eq!(entry["unread"]["pipeline"], json!("failed"));
    assert_eq!(entry["unread"]["newApprovals"], json!(["bob"]));
    // Looked at: nothing new any more.
    inbox.mark_seen(super::key_of(&entry));
    let entry = entries(&inbox, &settings)[0].clone();
    assert_eq!(entry["unread"]["changed"], json!(false));
}

#[tokio::test]
async fn a_host_refusing_the_full_fields_is_asked_fewer_then_the_basic_ones_from_then_on() {
    let (fetchers, fake) = own_fetchers(
        None,
        Some(Box::new(|query| {
            Ok(if query.contains("approvedBy") {
                json!({"errors": [{"message": "Field 'approved' doesn't exist"}]})
            } else {
                json!({"data": {"p0": {"mergeRequests": {"nodes": [mr(5, json!({}))]}}}})
            })
        })),
    );
    let (_dir, shared_store) = store();
    let settings = gitlab_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    inbox.refresh().await;
    // Its pipeline runs: its details are read again on the second.
    assert_eq!(
        *fake.asked.lock().unwrap(),
        [
            "inbox",
            "list",
            "details full",
            "details nomerge",
            "details basic",
            "inbox",
            "list",
            "details basic",
        ]
    );
    let entry = by_number(&entries(&inbox, &settings), 5);
    assert_eq!(entry["own"]["unresolved"], json!(1));
}

#[tokio::test]
async fn own_requests_not_read_keep_what_was_known() {
    let fail = Arc::new(Mutex::new(false));
    let failing = fail.clone();
    let (fetchers, _) = own_fetchers(
        Some(Box::new(move |_| {
            if *failing.lock().unwrap() {
                return Err(failed("timeout"));
            }
            Ok(json!({"data": {"currentUser": {
                "op": {"pageInfo": {"hasNextPage": false}, "nodes": [mr(7, json!({}))]},
            }}}))
        })),
        None,
    );
    let (_dir, shared_store) = store();
    let settings = gitlab_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    *fail.lock().unwrap() = true;
    inbox.refresh().await;
    let numbers: Vec<u64> = section(&inbox, &settings, "authored")
        .iter()
        .map(number)
        .collect();
    assert_eq!(numbers, [7]);
}

#[tokio::test]
async fn details_not_read_keep_those_known_the_list_stands() {
    let fail = Arc::new(Mutex::new(false));
    let failing = fail.clone();
    let (fetchers, fake) = own_fetchers(
        None,
        Some(Box::new(move |_| {
            if *failing.lock().unwrap() {
                return Err(failed("timeout"));
            }
            Ok(json!({"data": {"p0": {"mergeRequests": {"nodes": [mr(5, json!({}))]}}}}))
        })),
    );
    let (_dir, shared_store) = store();
    let settings = gitlab_settings();
    let inbox = inbox_of(fetchers, fixed(&settings), &shared_store, None);
    inbox.refresh().await;
    *fail.lock().unwrap() = true;
    *fake.own.lock().unwrap() = vec![mr(5, json!({"updatedAt": "2026-11-04T11:00:00Z"}))];
    inbox.refresh().await;
    let entry = entries(&inbox, &settings)[0].clone();
    assert_eq!(entry["updatedAt"], json!("2026-11-04T11:00:00Z"));
    assert_eq!(entry["own"]["unresolved"], json!(1));
    assert_eq!(entry["pipeline"], json!("running"));
}

/// Old quiet open requests behind many recently merged ones.
fn old_open_new_merged() -> Vec<FakeRequest> {
    let day = |offset: usize| {
        js::iso(js::date_parse("2026-11-04T00:00:00Z") - offset as f64 * 3_600_000.0)
    };
    let mut out = fake_requests(
        26,
        "open",
        |index| {
            js::iso(js::date_parse("2021-03-01T00:00:00Z") + index as f64 * 15.0 * 86_400_000.0)
        },
        1,
        &PROJECTS,
    );
    out.extend(fake_requests(40, "merged", day, 100, &PROJECTS));
    out
}

const CLOCK: &str = "2026-11-04T12:00:00Z";

fn host_of(provider: &str) -> &'static str {
    if provider == "gitlab" {
        "gitlab.example.org"
    } else {
        "github.com"
    }
}

fn host_settings(provider: &str) -> Obj {
    settings(json!({"hosts": [{"host": host_of(provider), "provider": provider}]}))
}

fn own_inbox(
    forge: &Arc<OwnForge>,
    provider: &str,
    now: Arc<Mutex<f64>>,
) -> (tempfile::TempDir, MrInbox) {
    let (dir, shared_store) = store();
    let inbox = inbox_of(
        forge.clone(),
        fixed(&host_settings(provider)),
        &shared_store,
        Some(now),
    );
    (dir, inbox)
}

fn authored(inbox: &MrInbox, provider: &str) -> Vec<Obj> {
    section(inbox, &host_settings(provider), "authored")
}

fn detail_numbers(calls: &[super::own_forge::FakeCall]) -> Vec<u64> {
    calls
        .iter()
        .filter(|c| c.kind == "details")
        .flat_map(|c| c.numbers.clone())
        .collect()
}

async fn all_open_show(provider: &'static str) {
    let forge = OwnForge::new(
        provider,
        host_of(provider),
        old_open_new_merged(),
        ForgeOptions::default(),
    );
    let (_dir, inbox) = own_inbox(&forge, provider, clock(CLOCK));
    inbox.refresh().await;
    let mine = authored(&inbox, provider);
    let mut open: Vec<u64> = mine
        .iter()
        .filter(|e| e["state"] == json!("open"))
        .map(number)
        .collect();
    open.sort();
    assert_eq!(open, (1..=26).collect::<Vec<u64>>());
    // A small page of the latest settled, for the closed-review retention.
    let settled = mine.iter().filter(|e| e["state"] != json!("open")).count();
    assert!(settled > 0 && settled <= 20);
    // Every row has its details.
    assert!(
        mine.iter()
            .filter(|e| e["state"] == json!("open"))
            .all(|e| truthy_field(e, "own") && truthy_field(e, "pipeline"))
    );
}

fn truthy_field(entry: &Obj, name: &str) -> bool {
    super::truthy(entry.get(name))
}

#[tokio::test]
async fn twenty_six_open_requests_older_than_forty_merged_ones_all_show() {
    all_open_show("gitlab").await;
    all_open_show("github").await;
}

async fn only_the_changed_one(provider: &'static str) {
    let forge = OwnForge::new(
        provider,
        host_of(provider),
        old_open_new_merged(),
        ForgeOptions::default(),
    );
    let (_dir, inbox) = own_inbox(&forge, provider, clock(CLOCK));
    inbox.refresh().await;
    forge.take();
    forge.update(|list| {
        list.into_iter()
            .map(|r| {
                if r.number == 4 {
                    FakeRequest {
                        updated_at: "2026-11-04T11:30:00Z".into(),
                        pipeline: Some("failed"),
                        approved_by: vec!["bob".into()],
                        ..r
                    }
                } else {
                    r
                }
            })
            .collect()
    });
    inbox.refresh().await;
    let calls = forge.take();
    let details: Vec<Vec<u64>> = calls
        .iter()
        .filter(|c| c.kind == "details")
        .map(|c| c.numbers.clone())
        .collect();
    assert_eq!(details, [vec![4]]);
    assert_eq!(calls.iter().filter(|c| c.kind == "list").count(), 1);
    let four = by_number(&authored(&inbox, provider), 4);
    assert_eq!(four["pipeline"], json!("failed"));
    assert_eq!(four["own"]["approvedBy"], json!(["bob"]));
    // The others kept their details.
    assert!(
        authored(&inbox, provider)
            .iter()
            .all(|e| truthy_field(e, "own"))
    );
    // Nothing changed: no details at all.
    inbox.refresh().await;
    assert!(detail_numbers(&forge.take()).is_empty());
}

#[tokio::test]
async fn a_second_refresh_reads_the_details_of_the_one_that_changed_only() {
    only_the_changed_one("gitlab").await;
    only_the_changed_one("github").await;
}

async fn running_read_again(provider: &'static str) {
    let requests: Vec<FakeRequest> = old_open_new_merged()
        .into_iter()
        .map(|r| {
            if r.number == 2 {
                FakeRequest {
                    pipeline: Some("running"),
                    ..r
                }
            } else {
                r
            }
        })
        .collect();
    let forge = OwnForge::new(
        provider,
        host_of(provider),
        requests,
        ForgeOptions::default(),
    );
    let (_dir, inbox) = own_inbox(&forge, provider, clock(CLOCK));
    inbox.refresh().await;
    forge.take();
    forge.update(|list| {
        list.into_iter()
            .map(|r| {
                if r.number == 2 {
                    FakeRequest {
                        pipeline: Some("success"),
                        ..r
                    }
                } else {
                    r
                }
            })
            .collect()
    });
    inbox.refresh().await;
    assert_eq!(detail_numbers(&forge.take()), [2]);
    assert_eq!(
        by_number(&authored(&inbox, provider), 2)["pipeline"],
        json!("success")
    );
    inbox.refresh().await;
    assert!(detail_numbers(&forge.take()).is_empty());
}

#[tokio::test]
async fn a_running_pipeline_is_read_again_until_it_ends() {
    running_read_again("gitlab").await;
    running_read_again("github").await;
}

async fn aged_a_few_at_a_time(provider: &'static str) {
    let now = clock(CLOCK);
    let forge = OwnForge::new(
        provider,
        host_of(provider),
        old_open_new_merged(),
        ForgeOptions::default(),
    );
    let (_dir, inbox) = own_inbox(&forge, provider, now.clone());
    inbox.refresh().await;
    forge.take();
    *now.lock().unwrap() += OWN_DETAILS_TTL_MS;
    inbox.refresh().await;
    let read = detail_numbers(&forge.take());
    assert_eq!(read.len(), 10);
    assert!(read.iter().all(|n| *n <= 26));
}

#[tokio::test]
async fn unchanged_details_are_read_again_a_few_at_a_time_once_old() {
    aged_a_few_at_a_time("gitlab").await;
    aged_a_few_at_a_time("github").await;
}

async fn pages_to_the_cap(provider: &'static str) {
    let warned = Arc::new(Mutex::new(Vec::<String>::new()));
    let lines = warned.clone();
    let logger = Logger::with(LoggerOptions {
        stderr: Some(Arc::new(move |line: &str| {
            lines.lock().unwrap().push(line.to_owned())
        })),
        stdout: Some(Arc::new(|_: &str| {})),
        ..LoggerOptions::default()
    });
    let many = OWN_PAGE * OWN_MAX_PAGES + 5;
    let forge = OwnForge::new(
        provider,
        host_of(provider),
        fake_requests(
            many,
            "open",
            |index| js::iso(js::date_parse("2020-01-01T00:00:00Z") + index as f64 * 60_000.0),
            1,
            &PROJECTS,
        ),
        ForgeOptions::default(),
    );
    let (_dir, shared_store) = store();
    let mut deps = MrInboxDeps::new(forge.clone(), fixed(&host_settings(provider)), shared_store);
    let now = js::date_parse(CLOCK);
    deps.now = Arc::new(move || now);
    deps.logger = logger;
    let inbox = MrInbox::new(deps);
    inbox.refresh().await;
    assert_eq!(
        forge.calls().iter().filter(|c| c.kind == "list").count(),
        OWN_MAX_PAGES
    );
    assert_eq!(authored(&inbox, provider).len(), OWN_PAGE * OWN_MAX_PAGES);
    assert!(
        warned
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("own open requests cut at the page cap"))
    );
}

#[tokio::test]
async fn pages_to_the_end_and_stops_at_the_cap_with_a_log_line() {
    pages_to_the_cap("gitlab").await;
    pages_to_the_cap("github").await;
}
