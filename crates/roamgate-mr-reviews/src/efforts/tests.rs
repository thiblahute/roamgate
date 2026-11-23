//! `mr-reviews/efforts.test.ts`, on real git repositories.

use std::collections::{HashMap, HashSet};

use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};

use super::*;
use crate::connection::fixture::{GitFixture, LocalConnection};

fn effort_of(clone: &Path, feeders: &[&str]) -> Value {
    json!({"id": "e1", "group": "g1", "name": "Big", "clone": {"connectionId": "local", "path": clone.to_str().unwrap()},
        "source": "refs/heads/big", "target": {"remote": "origin", "branch": "main"}, "feeders": feeders})
}

fn store_of(g: &GitFixture) -> LedgerStore {
    let context = DataContext::new(g.root.join("home"), Platform::current(), None);
    LedgerStore::new(
        context.clone(),
        context.data_root().join("mr-reviews").join("efforts"),
    )
}

async fn derive(
    effort: &Value,
    connection: &LocalConnection,
    store: &LedgerStore,
    check_target: bool,
    force: bool,
) -> (Obj, bool) {
    derive_effort(DeriveInput {
        effort,
        connection,
        store,
        check_target,
        requests: Box::new(|_, _| Box::pin(async { Ok(vec![]) })),
        parts: vec![],
        elsewhere: vec![],
        now: js::now_ms(),
        force,
    })
    .await
}

fn commits(derived: &Obj) -> Vec<Value> {
    derived["commits"].as_array().cloned().unwrap()
}

fn author<'a>(by: &'a str, summary: &'a str) -> Author<'a> {
    Author {
        by,
        summary,
        now: js::now_ms(),
    }
}

#[tokio::test]
async fn a_ledger_upstream_by_patch_id_authored_dispositions_kept_across_a_reword_and_a_rebase_history_undo()
 {
    let g = GitFixture::new();
    let bare = g.project("media/engine");
    let clone = g.clone("media/engine", "engine");
    g.git(&clone, &["checkout", "-q", "-b", "big"]);
    g.commit(&clone, "pool/a.c", "a\n", "pool: add a", None);
    g.commit(&clone, "pool/b.c", "b\n", "pool: add b", None);
    g.commit(&clone, "docs/x.md", "x\n", "fixup! pool: add a", None);
    g.commit(&clone, "tests/t.c", "t\n", "Add a test", None);
    let up = g.clone("media/engine", "up");
    g.commit(&up, "pool/b.c", "b\n", "pool: add b (upstream)", None);
    g.git(&up, &["push", "-q", bare.to_str().unwrap(), "main"]);
    g.git(&clone, &["checkout", "-q", "-b", "feed"]);
    g.commit(&clone, "feed.c", "f\n", "Not on big yet", None);
    g.git(&clone, &["checkout", "-q", "big"]);
    let connection = g.connection(vec![], "local");
    let store = store_of(&g);
    let effort = effort_of(&clone, &["refs/heads/feed"]);
    let (mut derived, _) = derive(&effort, &connection, &store, true, false).await;
    let rows: Vec<(String, String, String)> = commits(&derived)
        .iter()
        .map(|c| {
            (
                s(c, &["subject"]).into(),
                s(c, &["disposition"]).into(),
                s(c, &["dir"]).into(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("pool: add a", "unsorted", "pool"),
            ("pool: add b", "upstream", "pool"),
            ("fixup! pool: add a", "unsorted", "docs"),
            ("Add a test", "unsorted", "tests"),
        ]
        .map(|(a, b, c)| (a.to_owned(), b.to_owned(), c.to_owned()))
    );
    let up_head = g.git(&up, &["rev-parse", "HEAD"]).trim().to_owned();
    assert_eq!(
        g.git(&clone, &["rev-parse", "refs/roamgate/upstream/origin/main"])
            .trim(),
        up_head
    );
    assert_ne!(g.git(&clone, &["rev-parse", "origin/main"]).trim(), up_head);
    let feeder = &derived["feeders"][0];
    assert_eq!(
        (
            feeder["ref"].clone(),
            feeder["notReady"].clone(),
            feeder["drift"].clone()
        ),
        (json!("refs/heads/feed"), json!(1), json!(0))
    );
    let before = connection.script_count();
    derive(&effort, &connection, &store, true, false).await;
    assert_eq!(connection.script_count(), before + 1);

    let test = commits(&derived)[3].clone();
    let done = set_dispositions(
        &store,
        &effort,
        &[js::head16(s(&test, &["sha"]), 10)],
        "not_for_upstream",
        Some("local only"),
        None,
        &author("agent", "test kept here"),
    )
    .unwrap();
    assert_eq!((done.0, done.1.len()), (1, 0));
    (derived, _) = derive(&effort, &connection, &store, true, false).await;
    assert_eq!(
        commits(&derived)[3]["disposition"],
        json!("not_for_upstream")
    );
    assert_eq!(commits(&derived)[3]["note"], json!("local only"));
    g.git(
        &clone,
        &[
            "commit",
            "-q",
            "--amend",
            "-m",
            "Add a test",
            "--allow-empty",
        ],
    );
    std::fs::write(clone.join("tests/t.c"), "t2\n").unwrap();
    g.git(&clone, &["add", "tests/t.c"]);
    g.git(&clone, &["commit", "-q", "--amend", "--no-edit"]);
    (derived, _) = derive(&effort, &connection, &store, true, false).await;
    let last = &commits(&derived)[3];
    assert_eq!(last["key"], test["key"]);
    assert_eq!(last["disposition"], json!("not_for_upstream"));
    assert_ne!(last["patchId"], test["patchId"]);
    assert_eq!(store.history("e1", Some(s(&test, &["key"]))).len(), 2);
    assert_eq!(
        store.ledger("e1")["aliases"][s(last, &["patchId"])],
        test["key"]
    );
    let refused = set_dispositions(
        &store,
        &effort,
        &[
            s(&commits(&derived)[0], &["sha"]).to_owned(),
            "deadbeef00".into(),
        ],
        "planned",
        None,
        None,
        &author("user", "x"),
    )
    .unwrap();
    assert_eq!((refused.0, refused.1), (0, vec!["deadbeef00".to_owned()]));
    assert_eq!(
        undo_ledger(&store, "e1", None).as_deref(),
        Some("test kept here")
    );
    (derived, _) = derive(&effort, &connection, &store, true, false).await;
    assert_eq!(commits(&derived)[3]["disposition"], json!("unsorted"));
    let unsorted: Vec<Value> = commits(&derived)
        .into_iter()
        .filter(|c| s(c, &["disposition"]) == "unsorted")
        .collect();
    let labels: Vec<String> = cluster_ledger(&unsorted)
        .iter()
        .map(|c| js::sv(c.get("label")).to_owned())
        .collect();
    assert_eq!(labels, ["tests", "pool pool:"]);
}

#[test]
fn overlaps_same_contains_partial() {
    let set = |items: &[&str]| {
        items
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<HashSet<String>>()
    };
    let a = set(&["1", "2", "3"]);
    let relation =
        |b: &[&str]| overlap_of(&a, &set(b), "B", "effort").map(|o| o["relation"].clone());
    assert_eq!(relation(&["1", "2", "3"]), Some(json!("same")));
    assert_eq!(relation(&["1"]), Some(json!("contains")));
    assert_eq!(relation(&["1", "2", "3", "4"]), Some(json!("contained")));
    let partial = overlap_of(&a, &set(&["3", "9"]), "B", "branch").unwrap();
    assert_eq!(
        (partial["relation"].clone(), partial["shared"].clone()),
        (json!("partial"), json!(1))
    );
    assert!(relation(&["9"]).is_none());
}

#[tokio::test]
async fn commits_880_derived_within_the_bound_then_nothing_run_while_the_heads_hold() {
    let g = GitFixture::new();
    g.project("media/engine");
    let clone = g.clone("media/engine", "engine");
    let base = g.git(&clone, &["rev-parse", "HEAD"]).trim().to_owned();
    let mut lines: Vec<String> = Vec::new();
    let mut add = |branch: &str, from: &str, mark: usize, i: usize| {
        let data = format!("line {i}\n");
        let message = format!("{branch} change {i}");
        lines.extend([
            format!("commit refs/heads/{branch}"),
            format!("mark :{mark}"),
            format!("author Test <test@example.org> {} +0000", 1_760_000_000 + i),
            format!(
                "committer Test <test@example.org> {} +0000",
                1_760_000_000 + i
            ),
            format!("data {}", message.len()),
            message,
            format!("from {from}"),
            format!("M 100644 inline dir{}/file{i}.c", i % 12),
            format!("data {}", data.len()),
            data,
        ]);
    };
    let mut from = base.clone();
    for i in 0..880 {
        add("big", &from, i + 1, i);
        from = format!(":{}", i + 1);
    }
    from = base;
    for i in (0..880).step_by(3) {
        add("newmain", &from, 10_000 + i, i);
        from = format!(":{}", 10_000 + i);
    }
    g.git_input(
        &clone,
        &["fast-import", "--quiet"],
        format!("{}\n", lines.join("\n")).as_bytes(),
    );
    g.git(
        &clone,
        &[
            "update-ref",
            "refs/remotes/origin/main",
            "refs/heads/newmain",
        ],
    );
    let connection = g.connection(vec![], "local");
    let store = store_of(&g);
    let effort = effort_of(&clone, &[]);
    let started = std::time::Instant::now();
    let (derived, _) = derive(&effort, &connection, &store, false, false).await;
    let took = started.elapsed();
    assert_eq!(commits(&derived).len(), 880);
    assert_eq!(
        commits(&derived)
            .iter()
            .filter(|c| s(c, &["disposition"]) == "upstream")
            .count(),
        294
    );
    assert!(took.as_secs() < 30);
    let scripts = connection.script_count();
    let (_, ran) = derive(&effort, &connection, &store, false, false).await;
    assert!(!ran);
    assert_eq!(connection.script_count(), scripts + 1);
}

#[tokio::test]
async fn fuzzy_proposals_from_upstream_confirmed_and_rejected_planned_requests_what_changed() {
    let g = GitFixture::new();
    let bare = g.project("media/engine");
    let clone = g.clone("media/engine", "engine");
    g.git(&clone, &["checkout", "-q", "-b", "big"]);
    g.commit(
        &clone,
        "gst/pool/pool.c",
        "a\nb\nc\n",
        "pool: allocate buffers lazily",
        None,
    );
    g.commit(
        &clone,
        "gst/pool/pool.h",
        "h\n",
        "pool: export the allocator",
        None,
    );
    g.commit(&clone, "tests/t.c", "t\n", "tests: cover the pool", None);
    g.commit(&clone, "docs/d.md", "d\n", "docs: describe the pool", None);
    let up = g.clone("media/engine", "up");
    g.commit(
        &up,
        "gst/pool/pool.c",
        "a\nb\nc changed\n",
        "bufferpool: allocate buffers lazily",
        None,
    );
    g.commit(&up, "other/x.c", "x\n", "other: unrelated work", None);
    g.git(&up, &["push", "-q", bare.to_str().unwrap(), "main"]);
    let connection = g.connection(vec![], "local");
    let store = store_of(&g);
    let effort = effort_of(&clone, &[]);
    let (mut derived, _) = derive(&effort, &connection, &store, true, true).await;
    let first = commits(&derived)[0].clone();
    let first_key = s(&first, &["key"]).to_owned();
    assert_eq!(first["disposition"], json!("unsorted"));
    assert_eq!(first["sizes"], json!([3]));
    let upstream_sha = g.git(&up, &["rev-parse", "HEAD~1"]).trim().to_owned();
    let proposal = &derived["proposals"][&first_key][0];
    assert_eq!(proposal["sha"], json!(upstream_sha));
    assert_eq!(
        proposal["subject"],
        json!("bufferpool: allocate buffers lazily")
    );
    assert!(
        derived["proposals"]
            .get(s(&commits(&derived)[2], &["key"]))
            .is_none()
    );
    let changes = changes_of(
        Some(&derived),
        &store.ledger("e1"),
        store.seen("e1").as_ref(),
    );
    assert_eq!(
        (changes["unsorted"].clone(), changes["landed"].clone()),
        (json!([]), json!([]))
    );
    assert_eq!(changes["proposals"], json!([first_key]));

    let decision = |commit: &str, matched: &str, accept: bool| Decision {
        commit: commit.into(),
        matched: matched.into(),
        accept,
    };
    let rejected = decide_matches(
        &store,
        &effort,
        &[decision(
            &js::head16(s(&first, &["sha"]), 8),
            &upstream_sha[..9],
            false,
        )],
        &author("agent", "no"),
    )
    .unwrap();
    assert_eq!((rejected.0, rejected.1), (0, 1));
    (derived, _) = derive(&effort, &connection, &store, true, true).await;
    assert!(derived["proposals"].get(&first_key).is_none());
    undo_ledger(&store, "e1", Some(rejected.2));
    (derived, _) = derive(&effort, &connection, &store, true, true).await;
    assert_eq!(
        derived["proposals"][&first_key][0]["sha"],
        json!(upstream_sha)
    );
    decide_matches(
        &store,
        &effort,
        &[decision(s(&first, &["sha"]), &upstream_sha, true)],
        &author("user", "yes"),
    )
    .unwrap();
    (derived, _) = derive(&effort, &connection, &store, true, true).await;
    assert_eq!(commits(&derived)[0]["disposition"], json!("upstream"));
    assert_eq!(commits(&derived)[0]["note"], json!(upstream_sha));
    let history: Vec<(Value, Value)> = store
        .history("e1", Some(&first_key))
        .iter()
        .map(|e| (e["where"].clone(), e["sha"].clone()))
        .collect();
    assert_eq!(
        history,
        [
            (json!("source"), first["sha"].clone()),
            (json!("upstream"), json!(upstream_sha))
        ]
    );
    let error = decide_matches(
        &store,
        &effort,
        &[decision(s(&first, &["sha"]), "deadbeef00", true)],
        &author("user", "x"),
    )
    .unwrap_err();
    assert!(error.contains("nothing changed"));

    let shas: Vec<String> = commits(&derived)
        .iter()
        .map(|c| s(c, &["sha"]).to_owned())
        .collect();
    let (header, tests, docs) = (&shas[1], &shas[2], &shas[3]);
    let none = HashMap::new();
    let (plan, _) = change_plans(
        &store,
        &effort,
        &json!({"action": "propose", "name": "Pool API", "commits": [docs, header, tests]}),
        &author("agent", "p"),
        &none,
    )
    .unwrap();
    let plan = plan.unwrap();
    assert_eq!(
        (plan["state"].clone(), plan["name"].clone()),
        (json!("proposed"), json!("Pool API"))
    );
    let keys: Vec<Value> = commits(&derived)[1..]
        .iter()
        .map(|c| c["key"].clone())
        .collect();
    assert_eq!(plan["commits"], Value::Array(keys));
    let error = change_plans(
        &store,
        &effort,
        &json!({"action": "propose", "name": "Other", "commits": [tests]}),
        &author("agent", "p"),
        &none,
    )
    .unwrap_err();
    assert!(
        error.contains("one planned request only") && error.contains("Pool API"),
        "{error}"
    );
    let taken: HashMap<String, String> = [(
        s(&commits(&derived)[2], &["patchId"]).to_owned(),
        "Elsewhere".to_owned(),
    )]
    .into();
    let error = change_plans(
        &store,
        &effort,
        &json!({"action": "edit", "plan": "Pool API", "add": [tests]}),
        &author("agent", "p"),
        &taken,
    )
    .unwrap_err();
    assert!(error.contains("in a part of Elsewhere"), "{error}");
    change_plans(
        &store,
        &effort,
        &json!({"action": "split", "plan": "Pool API", "commits": [docs], "name": "Pool docs"}),
        &author("user", "s"),
        &none,
    )
    .unwrap();
    change_plans(
        &store,
        &effort,
        &json!({"action": "accept", "plan": "pool api"}),
        &author("user", "a"),
        &none,
    )
    .unwrap();
    (derived, _) = derive(&effort, &connection, &store, true, true).await;
    let rows: Vec<(Value, Value)> = commits(&derived)
        .iter()
        .map(|c| (c["disposition"].clone(), c["note"].clone()))
        .collect();
    assert_eq!(
        rows,
        [
            (json!("upstream"), json!(upstream_sha)),
            (json!("planned"), json!("Pool API")),
            (json!("planned"), json!("Pool API")),
            (json!("planned"), json!("Pool docs")),
        ]
    );
    let plans: Vec<(Value, Value)> = store.ledger("e1")["plans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["name"].clone(), p["state"].clone()))
        .collect();
    assert_eq!(
        plans,
        [
            (json!("Pool API"), json!("accepted")),
            (json!("Pool docs"), json!("proposed"))
        ]
    );
    let (_, dropped) = change_plans(
        &store,
        &effort,
        &json!({"action": "drop", "plan": "Pool docs"}),
        &author("user", "d"),
        &none,
    )
    .unwrap();
    assert_eq!(store.ledger("e1")["plans"].as_array().unwrap().len(), 1);
    undo_ledger(&store, "e1", Some(dropped));
    assert_eq!(store.ledger("e1")["plans"].as_array().unwrap().len(), 2);

    let changes = changes_of(
        Some(&derived),
        &store.ledger("e1"),
        store.seen("e1").as_ref(),
    );
    assert_eq!(changes["landed"], json!([first_key]));
    assert_eq!(changes["proposals"], json!([]));
    store.write_seen(
        "e1",
        &snapshot_of(&derived, &store.ledger("e1"), js::now_ms()),
    );
    g.commit(&clone, "new.c", "n\n", "A new thing", None);
    (derived, _) = derive(&effort, &connection, &store, true, true).await;
    let after = changes_of(
        Some(&derived),
        &store.ledger("e1"),
        store.seen("e1").as_ref(),
    );
    assert_eq!(after["landed"], json!([]));
    assert_eq!(
        after["unsorted"],
        json!([commits(&derived).last().unwrap()["key"]])
    );
}

#[test]
fn ledger_files_bun_wrote_read_and_write_back_byte_for_byte() {
    // Forward and backward: a ledger as Bun writes it (setDispositions,
    // then decideMatches, whose entries order their keys differently)
    // round trips unchanged; one from before matches and plans gains them.
    let dir = tempfile::tempdir().unwrap();
    let context = DataContext::new(dir.path(), Platform::current(), None);
    let store = LedgerStore::new(
        context.clone(),
        context.data_root().join("mr-reviews/efforts"),
    );
    let text = concat!(
        r#"{"version":3,"entries":{"k1":{"disposition":"not_for_upstream","reason":"local","subject":"S","authorDate":1760000000,"sha":"abc","at":"2026-11-16T10:00:00.000Z","by":"agent"},"#,
        r#""k2":{"disposition":"upstream","pointer":"def","reason":"matched by hand","subject":"T","authorDate":1760000001,"sha":"bcd","at":"t","by":"user"}},"#,
        r#""aliases":{"p2":"k1"},"matches":{"k2":{"rejected":[],"at":"t","by":"user","accepted":"def"}},"plans":[],"#,
        r#""journal":[{"id":1,"at":"t","by":"agent","summary":"s","before":{"k1":null}}]}"#,
        "\n"
    );
    std::fs::create_dir_all(store.root.join("e1")).unwrap();
    std::fs::write(store.root.join("e1/ledger.json"), text).unwrap();
    let ledger = store.ledger("e1");
    store.write_ledger("e1", &ledger);
    assert_eq!(
        std::fs::read_to_string(store.root.join("e1/ledger.json")).unwrap(),
        text
    );
    std::fs::write(
        store.root.join("e1/ledger.json"),
        r#"{"version":1,"entries":{},"aliases":{},"journal":[]}"#,
    )
    .unwrap();
    assert_eq!(
        Value::Object(store.ledger("e1")),
        json!({"version": 1, "entries": {}, "aliases": {}, "matches": {}, "plans": [], "journal": []})
    );
}
